// ==UserScript==
// @name         HYB Card Dashboard 榜单同步
// @namespace    https://card.gudong226.com/
// @version      1.2.0
// @description  在 Card Dashboard 页面按需读取 CDK 卡牌榜单并回传给榜单统计视图。
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
  const RELAY_OWNER_ID = randomId('cdk-tab');

  let inFlight = null;
  const relayPending = new Map();

  function randomId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function friendlyError(error) {
    const status = Number(error && error.status);
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
    return {
      ...source,
      scope: String(source.scope || scopeHint || '').trim(),
      capturedAt: normalizeCapturedAt(source.capturedAt, null)
        || normalizeCapturedAt(source.lastUpdatedAt, null)
        || Date.now()
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
      partial: Boolean(bundle && bundle.partial)
    };
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
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            finish(reject, error);
            return;
          }
          try {
            finish(resolve, normalizeSnapshot(response.response || JSON.parse(response.responseText || '{}'), scope));
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror() {
          finish(reject, new Error('网络请求失败'));
        },
        ontimeout() {
          const error = new Error('请求超时');
          error.name = 'AbortError';
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
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return normalizeSnapshot(await response.json(), scope);
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
        errors.push({
          scope: SOURCE_ENTRIES[index].scope,
          status: Number(error && error.status) || 0,
          error: friendlyError(error)
        });
      }
    });
    if (!snapshots.length) {
      const firstError = errors[0] || {};
      const error = new Error(firstError.error || '两个榜单来源都请求失败');
      error.status = firstError.status;
      throw error;
    }
    return { snapshots, errors, partial: errors.length > 0 };
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
      else pending.reject(Object.assign(new Error(value.error || 'CDK 榜单请求失败'), { status: value.status }));
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

  async function loadSnapshot() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const relay = requestWithCdkRelay();
      if (relay) return relay;
      return requestAllSources((url, scope) => (
        typeof GM_xmlhttpRequest === 'function'
          ? requestWithGm(url, scope)
          : requestWithFetch(url, scope)
      ));
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
        const bundle = await loadSnapshot();
        window.postMessage({
          type: BRIDGE_RESPONSE,
          requestId: data.requestId,
          ok: true,
          snapshots: bundle.snapshots,
          errors: bundle.errors,
          partial: bundle.partial
        }, CARD_ORIGIN);
      } catch (error) {
        window.postMessage({
          type: BRIDGE_RESPONSE,
          requestId: data.requestId,
          ok: false,
          error: friendlyError(error)
        }, CARD_ORIGIN);
      }
    });
    window.postMessage({ type: BRIDGE_READY }, CARD_ORIGIN);
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
          else errors.push({
            scope: sources[index].scope,
            status: Number(result.reason && result.reason.status) || 0,
            error: friendlyError(result.reason)
          });
        });
        if (!snapshots.length) throw Object.assign(new Error(errors[0]?.error || '两个榜单来源都请求失败'), { status: errors[0]?.status });
        GM_setValue(RELAY_RESPONSE_KEY, {
          requestId: value.requestId,
          ok: true,
          snapshots,
          errors,
          partial: errors.length > 0,
          respondedAt: Date.now()
        });
      } catch (error) {
        GM_setValue(RELAY_RESPONSE_KEY, {
          requestId: value.requestId,
          ok: false,
          status: Number(error && error.status) || 0,
          error: friendlyError(error),
          respondedAt: Date.now()
        });
      }
    });
    GM_setValue(RELAY_READY_KEY, { readyAt: Date.now(), origin: CDK_ORIGIN });
  }

  if (location.origin === CARD_ORIGIN) startCardBridge();
  else if (location.origin === CDK_ORIGIN) startCdkRelay();
})();
