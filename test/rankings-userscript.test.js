import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SCRIPT_PATH = new URL('../site/userscripts/hyb-card-dashboard-rankings.user.js', import.meta.url);

test('userscript matches Card and CDK while keeping the bridge UI on Card', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(source, /@match\s+https:\/\/card\.gudong226\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/cdk\.hybgzs\.com\/\*/);
  assert.match(source, /@connect\s+cdk\.hybgzs\.com/);
  assert.match(source, /@version\s+1\.4\.0/);
  assert.match(source, /@updateURL\s+https:\/\/card\.gudong226\.com\/userscripts\/hyb-card-dashboard-rankings\.user\.js/);
  assert.match(source, /@downloadURL\s+https:\/\/card\.gudong226\.com\/userscripts\/hyb-card-dashboard-rankings\.user\.js/);
  assert.match(source, /GM_addValueChangeListener/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
  assert.match(source, /https:\/\/cdk\.hybgzs\.com\/api\/cards\/leaderboard\?scope=global/);
  assert.match(source, /https:\/\/cdk\.hybgzs\.com\/api\/cards\/leaderboard\?scope=friends/);
  assert.match(source, /snapshots/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /HYB_CARD_RANKINGS_BRIDGE_READY/);
  assert.match(source, /HYB_CARD_RANKINGS_REQUEST/);
  assert.match(source, /HYB_CARD_RANKINGS_RESPONSE/);
  assert.match(source, /hyb-card-rankings-relay-claim-v1/);
  assert.match(source, /function normalizeCapturedAt/);
  assert.match(source, /lastUpdatedAt/);
  assert.match(source, /finalSets/);
  assert.match(source, /setsFinalRetry/);
  assert.match(source, /REQUEST_COOLDOWN_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /RETRY_COOLDOWN_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /PROTECTED_COOLDOWN_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /looksLikeProtectionPage/);
  assert.match(source, /parseJsonPayload/);
  assert.match(source, /scriptVersion: SCRIPT_VERSION/);
});

test('userscript labels missing upstream timestamps as observations instead of fake source versions', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const harness = createUserscriptContext(source, {}, {
    status: 200,
    payload: {
      season: { id: 'season-1', name: 'Season 1' },
      leaderboards: { epic_total: [] }
    }
  });
  const response = await harness.request(true);
  assert.equal(response.ok, true);
  assert.equal(response.snapshots.length, 2);
  assert.equal(response.snapshots[0].capturedAt, null);
  assert.equal(response.snapshots[0].capturedAtSource, 'observed');
  assert.ok(Number(response.snapshots[0].observedAt) > 0);
  harness.dispose();
});

test('userscript separates manual refreshes from automatic cooldowns and retries', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');

  assert.match(source, /function claimSourceRequest\(options = \{\}\)/);
  assert.match(source, /const manual = Boolean\(options\.manual\)/);
  assert.match(source, /if \(Number\(state\.blockedUntil\) > now\) throw sourceCooldownError\(state, now\)/);
  assert.match(source, /if \(!manual && !bypassOrdinaryCooldown && Number\(state\.nextAllowedAt\) > now\)\s*\{\s*throw sourceCooldownError\(state, now\)/);
  assert.match(source, /function recordSourceFailure\(error, options = \{\}\)/);
  const protectedBranch = source.indexOf('if (protectedFailure) {');
  const manualFailureBranch = source.indexOf('if (manual) {', protectedBranch);
  assert.ok(protectedBranch >= 0 && manualFailureBranch > protectedBranch, 'manual failures must be handled after protection failures');
  assert.match(source, /async function loadSnapshot\(options = \{\}\)/);
  assert.match(source, /claimSourceRequest\(\{ manual, finalSets, setsFinalRetry \}\)/);
  assert.match(source, /recordSourceOutcome\(bundle, \{ manual, finalSets, setsFinalRetry \}\)/);
  assert.match(source, /recordSourceFailure\(error, \{ manual, finalSets, setsFinalRetry \}\)/);
  assert.match(source, /loadSnapshot\(\{\s*manual: Boolean\(data\.manual\),\s*finalSets: Boolean\(data\.finalSets\),\s*setsFinalRetry: Boolean\(data\.setsFinalRetry\)\s*\}\)/);
});

function createUserscriptContext(source, initialState, requestResult) {
  const storage = new Map([['hyb-card-rankings-source-state-v1', { ...initialState }]]);
  const listeners = [];
  const postedMessages = [];
  const requestCalls = [];
  const timers = new Set();
  const window = {
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener() {},
    postMessage(message) {
      postedMessages.push(message);
    },
    setTimeout(callback, delay) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };
  const context = {
    window,
    location: { origin: 'https://card.gudong226.com' },
    console,
    setTimeout,
    clearTimeout,
    GM_getValue(key, fallback) {
      return storage.has(key) ? storage.get(key) : fallback;
    },
    GM_setValue(key, value) {
      storage.set(key, value);
    },
    GM_addValueChangeListener() {},
    GM_xmlhttpRequest(options) {
      requestCalls.push(options.url);
      if (requestResult.status >= 200 && requestResult.status < 300) {
        const payload = requestResult.payload || { capturedAt: Date.now() };
        options.onload({
          status: requestResult.status,
          response: payload,
          responseText: JSON.stringify(payload),
          responseHeaders: 'content-type: application/json'
        });
      } else {
        options.onload({
          status: requestResult.status,
          response: requestResult.body || '',
          responseText: requestResult.body || '',
          responseHeaders: 'content-type: application/json'
        });
      }
    }
  };
  vm.runInNewContext(source, context, { filename: 'hyb-card-dashboard-rankings.user.js' });
  return {
    storage,
    listeners,
    postedMessages,
    requestCalls,
    async request(manual, options = {}) {
      const request = {
        origin: 'https://card.gudong226.com',
        data: {
          type: 'HYB_CARD_RANKINGS_REQUEST',
          requestId: `test-${Date.now()}`,
          manual,
          ...options
        }
      };
      await listeners[0](request);
      return postedMessages.at(-1);
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
    }
  };
}

test('userscript allows the fixed sets final request to bypass the ordinary three-hour source cooldown', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const now = Date.now();
  const harness = createUserscriptContext(source, {
    ownerId: null,
    lockUntil: 0,
    nextAllowedAt: now + 3 * 60 * 60 * 1000,
    blockedUntil: 0,
    retryCount: 0
  }, { status: 200 });

  const response = await harness.request(false, { finalSets: true });
  assert.equal(response.ok, true);
  assert.equal(harness.requestCalls.length, 2);
  harness.dispose();
});

test('userscript keeps one final retry available after an earlier ordinary failure', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const now = Date.now();
  const harness = createUserscriptContext(source, {
    ownerId: null,
    lockUntil: 0,
    nextAllowedAt: now,
    blockedUntil: 0,
    retryCount: 1
  }, { status: 503, body: 'temporary failure' });

  const response = await harness.request(false, { finalSets: true });
  const state = harness.storage.get('hyb-card-rankings-source-state-v1');
  assert.equal(response.ok, false);
  assert.equal(state.mode, 'final-retry-wait');
  assert.equal(state.retryCount, 1);
  assert.ok(state.nextAllowedAt >= now + 60 * 60 * 1000 - 100);
  assert.equal(state.blockedUntil, 0);
  harness.dispose();
});

test('userscript lets a manual request bypass ordinary cooldown while retaining the cooldown afterward', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const now = Date.now();
  const harness = createUserscriptContext(source, {
    ownerId: null,
    lockUntil: 0,
    nextAllowedAt: now + 3 * 60 * 60 * 1000,
    blockedUntil: 0,
    retryCount: 1
  }, { status: 200 });

  const response = await harness.request(true);
  const state = harness.storage.get('hyb-card-rankings-source-state-v1');
  assert.equal(response.ok, true);
  assert.equal(harness.requestCalls.length, 2);
  assert.ok(state.nextAllowedAt > Date.now());
  assert.equal(state.retryCount, 0);
  harness.dispose();
});

test('userscript keeps protection cooldown and request lock in force for manual requests', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const now = Date.now();
  const protectedHarness = createUserscriptContext(source, {
    ownerId: null,
    lockUntil: 0,
    nextAllowedAt: 0,
    blockedUntil: now + 3 * 60 * 60 * 1000
  }, { status: 200 });
  const protectedResponse = await protectedHarness.request(true);
  assert.equal(protectedResponse.ok, false);
  assert.equal(protectedResponse.blocked, true);
  assert.equal(protectedHarness.requestCalls.length, 0);
  protectedHarness.dispose();

  const lockHarness = createUserscriptContext(source, {
    ownerId: 'another-tab',
    lockUntil: now + 90 * 1000,
    nextAllowedAt: 0,
    blockedUntil: 0
  }, { status: 200 });
  const lockResponse = await lockHarness.request(true);
  assert.equal(lockResponse.ok, false);
  assert.equal(lockHarness.requestCalls.length, 0);
  lockHarness.dispose();
});

test('userscript does not schedule automatic retry state after a manual ordinary failure', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const now = Date.now();
  const harness = createUserscriptContext(source, {
    ownerId: null,
    lockUntil: 0,
    nextAllowedAt: now + 3 * 60 * 60 * 1000,
    blockedUntil: 0,
    retryCount: 0
  }, { status: 503, body: 'temporary failure' });

  const response = await harness.request(true);
  const state = harness.storage.get('hyb-card-rankings-source-state-v1');
  assert.equal(response.ok, false);
  assert.equal(state.retryCount, 0);
  assert.equal(state.mode, 'manual-failed');
  assert.equal(state.nextAllowedAt, now + 3 * 60 * 60 * 1000);
  assert.equal(state.lockUntil, 0);
  harness.dispose();
});

test('userscript update state changes the install link after a refresh response', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(html, /id="rankingsInstallLink"[^>]*>安装用户脚本</);
  assert.doesNotMatch(html, /rankingsScriptUpdateNotice|rankingsScriptUpdateLink/);
  assert.match(source, /markUserscriptVersion\(data\.scriptVersion\)/);
  assert.match(source, /userscriptUpdateError\(data\.scriptVersion\)/);
  assert.match(source, /function renderUserscriptLink/);
  assert.match(source, /link\.textContent = state\.scriptUpdateRequired \? '更新脚本' : '安装用户脚本'/);
  assert.match(source, /link\.classList\.toggle\('is-update-required', state\.scriptUpdateRequired\)/);
  assert.match(source, /code = 'userscript_missing'/);
  assert.doesNotMatch(source, /type === BRIDGE_READY\)[\s\S]*markUserscriptVersion/);
});
