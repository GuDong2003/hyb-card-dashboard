// ==UserScript==
// @name         HYB Card Dashboard 榜单同步
// @namespace    https://card.gudong226.com/
// @version      1.1.0
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
  const SOURCE_API = 'https://cdk.hybgzs.com/api/cards/leaderboard?scope=global';
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

  function requestWithGm() {
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
        url: SOURCE_API,
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
            finish(resolve, response.response || JSON.parse(response.responseText || '{}'));
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

  async function requestWithFetch() {
    const response = await fetch(SOURCE_API, {
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
    return response.json();
  }

  function setupRelayResponseListener() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    GM_addValueChangeListener(RELAY_RESPONSE_KEY, (_key, _oldValue, value) => {
      if (!value || !value.requestId) return;
      const pending = relayPending.get(value.requestId);
      if (!pending) return;
      relayPending.delete(value.requestId);
      window.clearTimeout(pending.timeoutId);
      if (value.ok && value.snapshot) pending.resolve(value.snapshot);
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
        source: CARD_ORIGIN
      });
    });
    return promise;
  }

  async function loadSnapshot() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const relay = requestWithCdkRelay();
      if (relay) return relay;
      return requestWithGm() || requestWithFetch();
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
        const snapshot = await loadSnapshot();
        window.postMessage({
          type: BRIDGE_RESPONSE,
          requestId: data.requestId,
          ok: true,
          snapshot
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
        const snapshot = await requestWithFetch();
        GM_setValue(RELAY_RESPONSE_KEY, {
          requestId: value.requestId,
          ok: true,
          snapshot,
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
