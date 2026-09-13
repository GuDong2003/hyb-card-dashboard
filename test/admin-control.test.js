import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker from '../src/index.js';
import {
  ADMIN_SITE_CONFIG_KEY,
  DEFAULT_SITE_CONFIG,
  handleRankingsRequest,
  AdminAuth
} from '../src/rankings-worker.js';

function createStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : undefined;
    },
    async put(key, value) {
      if (key && typeof key === 'object' && !Array.isArray(key)) {
        for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
        return;
      }
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    }
  };
}

function createAdminNamespace(password = 'test-secret') {
  const storage = createStorage();
  const object = new AdminAuth({ storage }, { ADMIN_PASSWORD: password });
  return {
    storage,
    idFromName(name) { return `admin-auth:${name}`; },
    get() { return { fetch: (request) => object.fetch(request) }; }
  };
}

function createKv(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    async get(key, options = {}) {
      const value = values.get(String(key));
      if (value == null) return null;
      return options.type === 'json' && typeof value === 'string' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(String(key), String(value));
    }
  };
}

function request(path, body, { cookie = '', origin = 'https://card.test', csrf = '' } = {}) {
  const headers = { origin };
  if (body != null) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-hyb-admin-csrf'] = csrf;
  return new Request(`https://card.test${path}`, {
    method: path === '/api/admin/session' ? 'GET' : body == null ? 'POST' : 'POST',
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
}

async function loginFixture(env) {
  const response = await handleRankingsRequest(
    request('/api/admin/login', { password: 'test-secret' }),
    env
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  return {
    cookie: (response.headers.get('set-cookie') || '').split(';', 1)[0],
    csrf: body.csrfToken
  };
}

function enabledConfig() {
  return JSON.stringify({
    ...DEFAULT_SITE_CONFIG,
    rankingCaptureEnabled: true,
    cloudUploadEnabled: true
  });
}

test('admin route is isolated from the normal homepage and serves only /admin', async () => {
  const assets = {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      return new Response(pathname === '/admin.html' ? 'ADMIN_PAGE' : 'HOME_PAGE');
    }
  };

  const admin = await worker.fetch(new Request('https://card.test/admin'), { ASSETS: assets });
  const adminSlash = await worker.fetch(new Request('https://card.test/admin/'), { ASSETS: assets });
  const home = await worker.fetch(new Request('https://card.test/'), { ASSETS: assets });

  assert.equal(await admin.text(), 'ADMIN_PAGE');
  assert.equal(await adminSlash.text(), 'ADMIN_PAGE');
  assert.equal(await home.text(), 'HOME_PAGE');
});

test('static admin aliases run through the worker before SPA fallback', async () => {
  const wrangler = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(wrangler.assets.run_worker_first, [
    '/api/*',
    '/admin',
    '/admin/',
    '/admin.html'
  ]);
});

test('worker routes site configuration APIs before the asset SPA fallback', async () => {
  let assetCalls = 0;
  const response = await worker.fetch(new Request('https://card.test/api/site-config'), {
    RANKINGS_HOME_CACHE: {
      async get() {
        return JSON.stringify({ ...DEFAULT_SITE_CONFIG, rankingCaptureEnabled: false, cloudUploadEnabled: false });
      }
    },
    ASSETS: {
      async fetch() {
        assetCalls += 1;
        return new Response('ASSET_FALLBACK');
      }
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).config, {
    ...DEFAULT_SITE_CONFIG,
    rankingCaptureEnabled: false,
    cloudUploadEnabled: false
  });
  assert.equal(assetCalls, 0);
});

test('build includes the isolated admin page assets', async () => {
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /copyAsset\('admin\.html'\)/);
  assert.match(build, /copyAsset\('admin\.js'\)/);
  assert.match(build, /copyAsset\('admin\.css'\)/);
});

test('ranking capture controls use the runtime site config instead of a permanent source-code ban', async () => {
  const rankings = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const userscript = await readFile(new URL('../site/userscripts/hyb-card-dashboard-rankings.user.js', import.meta.url), 'utf8');
  assert.match(rankings, /api\/site-config/);
  assert.match(rankings, /rankingCaptureEnabled/);
  assert.match(rankings, /cloudUploadEnabled/);
  assert.match(userscript, /api\/site-config/);
  assert.doesNotMatch(userscript, /SCRIPT_DISABLED\s*=\s*true/);
});

test('malformed public config falls back to a safe disabled-sync default', async () => {
  const response = await handleRankingsRequest(new Request('https://card.test/api/site-config'), {
    RANKINGS_HOME_CACHE: { async get() { return '{bad'; } }
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).config, DEFAULT_SITE_CONFIG);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('admin login creates a protected cookie session and saves config through csrf validation', async () => {
  const adminAuth = createAdminNamespace();
  const kv = createKv();
  const env = { ADMIN_AUTH: adminAuth, ADMIN_PASSWORD: 'test-secret', RANKINGS_HOME_CACHE: kv };
  const session = await loginFixture(env);
  const response = await handleRankingsRequest(request('/api/admin/config', {
    siteEnabled: false,
    rankingCaptureEnabled: true,
    cloudUploadEnabled: true,
    maintenanceMessage: '维护中'
  }, session), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.config, {
    ...DEFAULT_SITE_CONFIG,
    siteEnabled: false,
    rankingCaptureEnabled: true,
    cloudUploadEnabled: true,
    maintenanceMessage: '维护中',
    updatedAt: body.config.updatedAt
  });
  assert.deepEqual(JSON.parse(kv.values.get(ADMIN_SITE_CONFIG_KEY)), body.config);
  assert.match((await handleRankingsRequest(request('/api/admin/login', { password: 'test-secret' }), env)).headers.get('set-cookie') || '', /__Host-hyb-card-admin=/);
});

test('disabled cloud upload rejects before parsing or touching D1', async () => {
  let d1Calls = 0;
  let bodyParsed = false;
  const environment = {
    RANKINGS_HOME_CACHE: createKv({
      [ADMIN_SITE_CONFIG_KEY]: JSON.stringify({ ...DEFAULT_SITE_CONFIG, rankingCaptureEnabled: true, cloudUploadEnabled: false })
    }),
    RANKINGS_DB: { prepare() { d1Calls += 1; throw new Error('D1 must not be touched'); } }
  };
  const upload = new Request('https://card.test/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid'
  });
  upload.json = async () => {
    bodyParsed = true;
    throw new Error('body must not be parsed');
  };

  const response = await handleRankingsRequest(upload, environment);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'cloud_upload_disabled');
  assert.equal(bodyParsed, false);
  assert.equal(d1Calls, 0);
});

test('paused ranking capture rejects uploads even when a stale cloud-upload flag remains enabled', async () => {
  let d1Calls = 0;
  const environment = {
    RANKINGS_HOME_CACHE: createKv({
      [ADMIN_SITE_CONFIG_KEY]: JSON.stringify({ ...DEFAULT_SITE_CONFIG, rankingCaptureEnabled: false, cloudUploadEnabled: true })
    }),
    RANKINGS_DB: { prepare() { d1Calls += 1; throw new Error('D1 must not be touched'); } }
  };
  const upload = new Request('https://card.test/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid'
  });
  upload.json = async () => {
    throw new Error('body must not be parsed');
  };

  const response = await handleRankingsRequest(upload, environment);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'sync_disabled');
  assert.equal(d1Calls, 0);
});

test('history reuses season metadata from the published home snapshot', async () => {
  const queries = [];
  const environment = {
    RANKINGS_HOME_CACHE: createKv({
      [PUBLISHED_HOME_CACHE_KEY]: JSON.stringify({
        ok: true,
        board: 'users',
        period: 'total',
        snapshot: {
          seasonId: 'season-1',
          seasonName: 'Season 1',
          capturedAt: Date.parse('2026-08-25T04:00:00+08:00')
        },
        rows: []
      })
    }),
    RANKINGS_DB: {
      prepare(sql) {
        queries.push(String(sql));
        if (/rank_user_days/i.test(sql)) {
          return { bind() { return { async all() { return { results: [] }; } }; } };
        }
        throw new Error('rank_seasons must not be read when home metadata is available');
      }
    }
  };

  const response = await handleRankingsRequest(new Request(
    'https://card.test/api/rankings/history?userId=u-1&limit=1'
  ), environment);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.season, { id: 'season-1', name: 'Season 1' });
  assert.equal(queries.filter((sql) => /rank_seasons/i.test(sql)).length, 0);
  assert.equal(queries.filter((sql) => /rank_user_days/i.test(sql)).length, 1);
});

const PUBLISHED_HOME_CACHE_KEY = 'rankings:published-home:v1';
