// ==UserScript==
// @name         HYB Card Dashboard 榜单同步
// @namespace    https://card.gudong226.com/
// @version      1.3.3
// @description  在 Card Dashboard 页面按需读取 CDK 卡牌榜单并回传给榜单统计视图。
// @updateURL    https://card.gudong226.com/userscripts/hyb-card-dashboard-rankings.user.js
// @downloadURL  https://card.gudong226.com/userscripts/hyb-card-dashboard-rankings.user.js
// @match        https://card.gudong226.com/*
// @match        https://cdk.hybgzs.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      cdk.hybgzs.com
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '1.3.3';
  const CARD_ORIGIN = 'https://card.gudong226.com';
  const CDK_ORIGIN = 'https://cdk.hybgzs.com';
  const SOURCE_APIS = Object.freeze({
    global: 'https://cdk.hybgzs.com/api/cards/leaderboard?scope=global',
    friends: 'https://cdk.hybgzs.com/api/cards/leaderboard?scope=friends'
  });
  const SOURCE_ENTRIES = Object.freeze(Object.entries(SOURCE_APIS).map(([scope, url]) => ({ scope, url })));
  const SOURCE_API = SOURCE_APIS.global;
  const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
  const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
  const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
  const RELAY_REQUEST_KEY = 'hyb-card-rankings-relay-request-v1';
  const RELAY_RESPONSE_KEY = 'hyb-card-rankings-relay-response-v1';
  const RELAY_READY_KEY = 'hyb-card-rankings-cdk-ready-v1';
  const RELAY_CLAIM_KEY = 'hyb-card-rankings-relay-claim-v1';
  const REQUEST_TIMEOUT_MS = 20000;
  const RELAY_TIMEOUT_MS = 15000;
  const RELAY_READY_TTL_MS = 30000;
  const SOURCE_STATE_KEY = 'hyb-card-rankings-source-state-v1';
  const REQUEST_COOLDOWN_MS = 3 * 60 * 60 * 1000;
  const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
  const PROTECTED_COOLDOWN_MS = 3 * 60 * 60 * 1000;
  const REQUEST_LOCK_MS = 90 * 1000;
  const RELAY_OWNER_ID = randomId('cdk-tab');

  let inFlight = null;
  const relayPending = new Map();

  function randomId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function makeError(message, details = {}) {
    const error = new Error(message);
    Object.assign(error, details);
    return error;
  }

  function readHeaderValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
    if (typeof headers === 'object' && !Array.isArray(headers)) {
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key ? String(headers[key] || '') : '';
    }
    const line = String(headers).split(/\r?\n/).find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
  }

  function parseRetryAfterMs(value) {
    if (value == null || value === '') return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
    const timestamp = Date.parse(String(value));
    return Number.isFinite(timestamp) ? Math.max(0, Math.min(timestamp - Date.now(), 24 * 60 * 60 * 1000)) : 0;
  }

  function looksLikeProtectionPage(value, contentType = '') {
    const text = String(value || '').trim();
    if (/text\/html/i.test(String(contentType || ''))) return true;
    return /^<!doctype\s+html|^<html[\s>]/i.test(text)
      || /(cf-chl-|challenge-platform|captcha|verify you are human|access denied)/i.test(text.slice(0, 4000));
  }

  function httpError(status, headers = '', body = '') {
    const numericStatus = Number(status) || 0;
    const retryAfterMs = parseRetryAfterMs(readHeaderValue(headers, 'retry-after'));
    const protectedResponse = numericStatus === 403 || numericStatus === 429 || looksLikeProtectionPage(body, readHeaderValue(headers, 'content-type'));
    return makeError(`HTTP ${numericStatus}`, {
      status: numericStatus,
      kind: protectedResponse ? 'protected' : 'http',
      blocked: protectedResponse,
      retryable: !protectedResponse && numericStatus >= 500,
      retryAfterMs
    });
  }

  function parseJsonPayload(payload, responseText, contentType, scope) {
    if (looksLikeProtectionPage(responseText || payload, contentType)) {
      throw makeError('CDK 返回了网页验证页或盾页', {
        kind: 'protected',
        blocked: true,
        retryable: false
      });
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return normalizeSnapshot(payload, scope);
    }
    const text = String(responseText || payload || '').trim();
    try {
      return normalizeSnapshot(JSON.parse(text), scope);
    } catch (_) {
      throw makeError('CDK 返回的数据不是有效 JSON', {
        kind: 'protected',
        blocked: true,
        retryable: false
      });
    }
  }

  function friendlyError(error) {
    const status = Number(error && error.status);
    if (error && error.name === 'SourceCooldown') return 'CDK 请求处于冷却期，请稍后再试';
    if (error && (error.blocked || error.kind === 'protected')) return 'CDK 返回限制页或盾页，已暂停自动请求';
    if (status === 401 || status === 403) return '请先登录 cdk.hybgzs.com 后再获取榜单';
    if (status === 429) return 'CDK 服务器限制刷新频率，请稍后再试';
    if (error && error.name === 'RelayTimeout') return '未检测到已打开的 CDK 榜单页面';
    if (error && error.name === 'AbortError') return '榜单请求超时';
    return String(error && error.message || error || '榜单请求失败');
  }

  function normalizeCapturedAt(value, fallback = Date.now()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
    if (value != null && value !== '') {
      const parsed = Date.parse(String(value));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const fallbackNumeric = Number(fallback);
    return Number.isFinite(fallbackNumeric) && fallbackNumeric > 0
      ? Math.floor(fallbackNumeric)
      : null;
  }

  function normalizeSnapshot(snapshot, scopeHint = '') {
    const source = snapshot && snapshot.data && snapshot.data.leaderboards
      ? snapshot.data
      : snapshot;
    if (!source || typeof source !== 'object') return snapshot;
    const capturedAt = normalizeCapturedAt(source.capturedAt, null)
      || normalizeCapturedAt(source.lastUpdatedAt, null);
    const observedAt = normalizeCapturedAt(source.observedAt, null) || Date.now();
    return {
      ...source,
      scope: String(source.scope || scopeHint || '').trim(),
      capturedAt,
      observedAt,
      capturedAtSource: capturedAt ? 'upstream' : 'observed'
    };
  }

  function normalizeSnapshotBundle(bundle) {
    const snapshots = Array.isArray(bundle && bundle.snapshots)
      ? bundle.snapshots
      : bundle && bundle.snapshot
        ? [bundle.snapshot]
        : [bundle];
    return {
      snapshots: snapshots.filter(Boolean).map((snapshot) => normalizeSnapshot(snapshot, snapshot && snapshot.scope)),
      errors: Array.isArray(bundle && bundle.errors) ? bundle.errors : [],
      partial: Boolean(bundle && bundle.partial),
      blocked: Boolean(bundle && bundle.blocked),
      retryable: Boolean(bundle && bundle.retryable),
      scriptVersion: String(bundle && bundle.scriptVersion || '')
    };
  }

  function sharedStorageAvailable() {
    return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  }

  function readSourceState() {
    if (!sharedStorageAvailable()) return {};
    try {
      return GM_getValue(SOURCE_STATE_KEY, {}) || {};
    } catch (_) {
      return {};
    }
  }

  function writeSourceState(state) {
    if (!sharedStorageAvailable()) return;
    try {
      GM_setValue(SOURCE_STATE_KEY, state);
    } catch (_) {
      // Storage restrictions must not break the fallback request path.
    }
  }

  function sourceCooldownError(state, now = Date.now()) {
    const retryAt = Math.max(
      Number(state.nextAllowedAt) || 0,
      Number(state.blockedUntil) || 0,
      Number(state.lockUntil) || 0
    );
    return makeError('CDK 请求处于冷却期', {
      name: 'SourceCooldown',
      retryable: false,
      cooldown: true,
      blocked: Boolean(state.blockedUntil && Number(state.blockedUntil) > now),
      retryAt
    });
  }

  function claimSourceRequest(options = {}) {
    if (!sharedStorageAvailable()) return;
    const manual = Boolean(options.manual);
    const now = Date.now();
    const state = readSourceState();
    if (Number(state.lockUntil) > now && state.ownerId !== RELAY_OWNER_ID) throw sourceCooldownError(state, now);
    if (Number(state.blockedUntil) > now) throw sourceCooldownError(state, now);
    if (!manual && Number(state.nextAllowedAt) > now) throw sourceCooldownError(state, now);
    const candidate = {
      ...state,
      ownerId: RELAY_OWNER_ID,
      lockUntil: now + REQUEST_LOCK_MS,
      lastAttemptAt: now
    };
    writeSourceState(candidate);
    const confirmed = readSourceState();
    if (confirmed.ownerId !== RELAY_OWNER_ID) throw sourceCooldownError(confirmed, now);
  }

  function releaseSourceRequest(patch) {
    if (!sharedStorageAvailable()) return;
    const state = readSourceState();
    if (state.ownerId && state.ownerId !== RELAY_OWNER_ID) return;
    writeSourceState({
      ...state,
      ...patch,
      ownerId: null,
      lockUntil: 0,
      updatedAt: Date.now()
    });
  }

  function recordSourceSuccess() {
    const now = Date.now();
    releaseSourceRequest({
      lastSuccessAt: now,
      nextAllowedAt: now + REQUEST_COOLDOWN_MS,
      retryCount: 0,
      blockedUntil: 0,
      mode: 'success'
    });
  }

  function recordSourceFailure(error, options = {}) {
    if (!sharedStorageAvailable() || (error && (error.name === 'SourceCooldown' || error.name === 'ScriptUpdateRequired'))) return;
    const manual = Boolean(options.manual);
    const now = Date.now();
    const state = readSourceState();
    const protectedFailure = Boolean(error && (error.blocked || error.kind === 'protected' || Number(error.status) === 403 || Number(error.status) === 429));
    const retryable = !protectedFailure && (!error || error.retryable !== false);
    const retryAfterMs = Math.max(0, Number(error && error.retryAfterMs) || 0);
    if (protectedFailure) {
      const nextAllowedAt = now + Math.max(PROTECTED_COOLDOWN_MS, retryAfterMs);
      releaseSourceRequest({ nextAllowedAt, retryCount: 0, blockedUntil: nextAllowedAt, mode: 'protected' });
      return;
    }
    if (manual) {
      releaseSourceRequest({ mode: 'manual-failed' });
      return;
    }
    if (retryable && Number(state.retryCount) < 1) {
      releaseSourceRequest({
        nextAllowedAt: now + RETRY_COOLDOWN_MS,
        retryCount: 1,
        blockedUntil: 0,
        mode: 'retry-wait'
      });
      return;
    }
    releaseSourceRequest({
      nextAllowedAt: now + REQUEST_COOLDOWN_MS,
      retryCount: 0,
      blockedUntil: 0,
      mode: retryable ? 'retry-exhausted' : 'paused'
    });
  }

  function sourceErrorRecord(scope, error) {
    return {
      scope,
      status: Number(error && error.status) || 0,
      error: friendlyError(error),
      kind: String(error && error.kind || ''),
      blocked: Boolean(error && error.blocked),
      retryable: !error || error.retryable !== false,
      retryAt: Number(error && error.retryAt) || 0
    };
  }

  function bundleFromResults(snapshots, errors) {
    const blocked = errors.some((error) => error.blocked);
    const retryable = errors.some((error) => error.retryable && !error.blocked);
    return { snapshots, errors, partial: errors.length > 0, blocked, retryable };
  }

  function recordSourceOutcome(bundle, options = {}) {
    const errors = Array.isArray(bundle && bundle.errors) ? bundle.errors : [];
    if (!errors.length) {
      recordSourceSuccess(options);
      return;
    }
    const blockedError = errors.find((error) => error.blocked || Number(error.status) === 403 || Number(error.status) === 429);
    if (blockedError) {
      recordSourceFailure(Object.assign(new Error(blockedError.error || 'CDK 请求被限制'), blockedError, { blocked: true, kind: 'protected' }), options);
      return;
    }
    const retryableError = errors.find((error) => error.retryable);
    if (retryableError) {
      recordSourceFailure(Object.assign(new Error(retryableError.error || 'CDK 请求失败'), retryableError), options);
      return;
    }
    recordSourceFailure(Object.assign(new Error(errors[0].error || 'CDK 请求失败'), errors[0], { retryable: false }), options);
  }

  function requestWithGm(url, scope) {
    if (typeof GM_xmlhttpRequest !== 'function') return null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { accept: 'application/json' },
        responseType: 'json',
        anonymous: false,
        withCredentials: true,
        timeout: REQUEST_TIMEOUT_MS,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            finish(reject, httpError(response.status, response.responseHeaders, response.responseText));
            return;
          }
          try {
            finish(resolve, parseJsonPayload(response.response, response.responseText, response.responseHeaders, scope));
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror() {
          finish(reject, makeError('网络请求失败', { retryable: true, kind: 'network' }));
        },
        ontimeout() {
          const error = makeError('请求超时', { name: 'AbortError', retryable: true, kind: 'network' });
          finish(reject, error);
        }
      });
    });
  }

  async function requestWithFetch(url, scope) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    });
    const body = await response.text();
    if (!response.ok) {
      throw httpError(response.status, response.headers, body);
    }
    return parseJsonPayload(body, body, response.headers, scope);
  }

  async function requestAllSources(requester) {
    const results = await Promise.allSettled(SOURCE_ENTRIES.map(({ scope, url }) => requester(url, scope)));
    const snapshots = [];
    const errors = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        snapshots.push(normalizeSnapshot(result.value, SOURCE_ENTRIES[index].scope));
      } else {
        const error = result.reason || new Error('榜单请求失败');
        errors.push(sourceErrorRecord(SOURCE_ENTRIES[index].scope, error));
      }
    });
    if (!snapshots.length) {
      const firstError = errors[0] || {};
      const error = makeError(firstError.error || '两个榜单来源都请求失败', firstError);
      throw error;
    }
    return bundleFromResults(snapshots, errors);
  }

  function setupRelayResponseListener() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    GM_addValueChangeListener(RELAY_RESPONSE_KEY, (_key, _oldValue, value) => {
      if (!value || !value.requestId) return;
      const pending = relayPending.get(value.requestId);
      if (!pending) return;
      relayPending.delete(value.requestId);
      window.clearTimeout(pending.timeoutId);
      if (value.ok && (Array.isArray(value.snapshots) || value.snapshot)) {
        pending.resolve(normalizeSnapshotBundle(value));
      }
      else pending.reject(Object.assign(new Error(value.error || 'CDK 榜单请求失败'), {
        status: value.status,
        scriptVersion: String(value.scriptVersion || ''),
        blocked: Boolean(value.blocked),
        cooldown: Boolean(value.cooldown),
        retryable: value.retryable !== false,
        retryAt: Number(value.retryAt) || 0
      }));
    });
  }

  function requestWithCdkRelay() {
    if (typeof GM_setValue !== 'function' || typeof GM_addValueChangeListener !== 'function') return null;
    if (typeof GM_getValue === 'function') {
      const ready = GM_getValue(RELAY_READY_KEY, null);
      if (!ready || Number(ready.readyAt) + RELAY_READY_TTL_MS < Date.now()) return null;
    }
    const requestId = randomId('rankings-relay');
    const promise = new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        relayPending.delete(requestId);
        const error = new Error('CDK relay timeout');
        error.name = 'RelayTimeout';
        reject(error);
      }, RELAY_TIMEOUT_MS);
      relayPending.set(requestId, { resolve, reject, timeoutId });
      GM_setValue(RELAY_REQUEST_KEY, {
        requestId,
        requestedAt: Date.now(),
        source: CARD_ORIGIN,
        sources: SOURCE_ENTRIES
      });
    });
    return promise;
  }

  async function loadSnapshot(options = {}) {
    if (inFlight) return inFlight;
    const manual = Boolean(options.manual);
    inFlight = (async () => {
      claimSourceRequest({ manual });
      try {
        const relay = requestWithCdkRelay();
        const bundle = relay
          ? await relay
          : await requestAllSources((url, scope) => (
              typeof GM_xmlhttpRequest === 'function'
                ? requestWithGm(url, scope)
                : requestWithFetch(url, scope)
            ));
        recordSourceOutcome(bundle, { manual });
        return bundle;
      } catch (error) {
        recordSourceFailure(error, { manual });
        throw error;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function startCardBridge() {
    setupRelayResponseListener();
    window.addEventListener('message', async (event) => {
      if (event.origin !== CARD_ORIGIN) return;
      const data = event.data;
      if (!data || data.type !== BRIDGE_REQUEST || !data.requestId) return;
      try {
        const bundle = await loadSnapshot({ manual: Boolean(data.manual) });
        window.postMessage({
          type: BRIDGE_RESPONSE,
          requestId: data.requestId,
          ok: true,
          scriptVersion: SCRIPT_VERSION,
          snapshots: bundle.snapshots,
          errors: bundle.errors,
          partial: bundle.partial,
          blocked: bundle.blocked,
          retryable: bundle.retryable
        }, CARD_ORIGIN);
      } catch (error) {
        window.postMessage({
          type: BRIDGE_RESPONSE,
          requestId: data.requestId,
          ok: false,
          scriptVersion: SCRIPT_VERSION,
          status: Number(error && error.status) || 0,
          blocked: Boolean(error && error.blocked),
          cooldown: Boolean(error && error.cooldown),
          retryable: !error || error.retryable !== false,
          retryAt: Number(error && error.retryAt) || 0,
          error: friendlyError(error)
        }, CARD_ORIGIN);
      }
    });
    window.postMessage({ type: BRIDGE_READY, scriptVersion: SCRIPT_VERSION }, CARD_ORIGIN);
  }

  function startCdkRelay() {
    if (typeof GM_addValueChangeListener !== 'function' || typeof GM_setValue !== 'function') return;
    GM_addValueChangeListener(RELAY_REQUEST_KEY, async (_key, _oldValue, value) => {
      if (!value || !value.requestId) return;
      const existingClaim = typeof GM_getValue === 'function' ? GM_getValue(RELAY_CLAIM_KEY, null) : null;
      if (existingClaim && existingClaim.requestId === value.requestId && existingClaim.ownerId !== RELAY_OWNER_ID) return;
      GM_setValue(RELAY_CLAIM_KEY, { requestId: value.requestId, ownerId: RELAY_OWNER_ID, claimedAt: Date.now() });
      const confirmedClaim = typeof GM_getValue === 'function' ? GM_getValue(RELAY_CLAIM_KEY, null) : null;
      if (confirmedClaim && confirmedClaim.requestId === value.requestId && confirmedClaim.ownerId !== RELAY_OWNER_ID) return;
      try {
        const sources = Array.isArray(value.sources) && value.sources.length
          ? value.sources
          : SOURCE_ENTRIES;
        const results = await Promise.allSettled(sources.map(({ url, scope }) => requestWithFetch(url, scope)));
        const snapshots = [];
        const errors = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value) snapshots.push(normalizeSnapshot(result.value, sources[index].scope));
          else errors.push(sourceErrorRecord(sources[index].scope, result.reason));
        });
        if (!snapshots.length) throw Object.assign(new Error(errors[0]?.error || '两个榜单来源都请求失败'), errors[0]);
        GM_setValue(RELAY_RESPONSE_KEY, {
          requestId: value.requestId,
          ok: true,
          scriptVersion: SCRIPT_VERSION,
          snapshots,
          errors,
          partial: errors.length > 0,
          blocked: errors.some((error) => error.blocked),
          retryable: errors.some((error) => error.retryable && !error.blocked),
          respondedAt: Date.now()
        });
      } catch (error) {
        GM_setValue(RELAY_RESPONSE_KEY, {
          requestId: value.requestId,
          ok: false,
          scriptVersion: SCRIPT_VERSION,
          status: Number(error && error.status) || 0,
          error: friendlyError(error),
          blocked: Boolean(error && error.blocked),
          cooldown: Boolean(error && error.cooldown),
          retryable: !error || error.retryable !== false,
          retryAt: Number(error && error.retryAt) || 0,
          respondedAt: Date.now()
        });
      }
    });
    GM_setValue(RELAY_READY_KEY, { readyAt: Date.now(), origin: CDK_ORIGIN, scriptVersion: SCRIPT_VERSION });
  }

  if (location.origin === CARD_ORIGIN) startCardBridge();
  else if (location.origin === CDK_ORIGIN) startCdkRelay();
})();
