// ==UserScript==
// @name         HYB Card Dashboard 榜单同步
// @namespace    https://card.gudong226.com/
// @version      1.0.0
// @description  在 Card Dashboard 页面按需读取 CDK 卡牌榜单并回传给榜单统计视图。
// @match        https://card.gudong226.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      cdk.hybgzs.com
// ==/UserScript==

(function () {
  'use strict';

  const CARD_ORIGIN = 'https://card.gudong226.com';
  const SOURCE_API = 'https://cdk.hybgzs.com/api/cards/leaderboard?scope=global';
  const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
  const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
  const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
  const REQUEST_TIMEOUT_MS = 20000;

  let inFlight = null;

  if (location.origin !== CARD_ORIGIN) return;

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

  async function loadSnapshot() {
    if (inFlight) return inFlight;
    inFlight = (requestWithGm() || requestWithFetch()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function friendlyError(error) {
    const status = Number(error && error.status);
    if (status === 401 || status === 403) return '请先登录 cdk.hybgzs.com 后再获取榜单';
    if (status === 429) return 'CDK 服务器限制刷新频率，请稍后再试';
    if (error && error.name === 'AbortError') return '榜单请求超时';
    return String(error && error.message || error || '榜单请求失败');
  }

  window.addEventListener('message', async (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== BRIDGE_REQUEST || !data.requestId) return;
    try {
      const snapshot = await loadSnapshot();
      window.postMessage({
        type: BRIDGE_RESPONSE,
        requestId: data.requestId,
        ok: true,
        snapshot
      }, location.origin);
    } catch (error) {
      window.postMessage({
        type: BRIDGE_RESPONSE,
        requestId: data.requestId,
        ok: false,
        error: friendlyError(error)
      }, location.origin);
    }
  });

  window.postMessage({ type: BRIDGE_READY }, location.origin);
})();
