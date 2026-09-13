import {
  estimateLegendProbability,
  estimatePullsFromSpend,
  normalizeSnapshotBundle
} from './rankings-core.js';
import {
  DAY_MS,
  dayStartAtForCapturedAt,
  metricPairObservation
} from './rankings-daily.js';
import {
  COMPACT_BOARD_KEYS,
  compactHistoryRows,
  decodeCurrentCursor,
  queryCurrentBoard,
  queryPinnedUsers,
  storeUserObservations
} from './rankings-user-store.js';

const BOARD_GROUPS = new Set(['users', 'epic', 'spend', 'sets', 'luck']);
const PERIODS = new Set(['today', 'week', 'month', 'total']);
const HISTORY_MODES = new Set(['daily']);
const HISTORY_DEFAULT_WINDOW_MS = 30 * DAY_MS;
const HISTORY_DEFAULT_LIMIT = 30;
const HISTORY_MAX_LIMIT = 90;
const HISTORY_MAX_WINDOW_MS = 90 * DAY_MS;
const EVENTS_DEFAULT_WINDOW_MS = 7 * DAY_MS;
const PAGE_DEFAULT_LIMIT = 50;
const PAGE_MAX_LIMIT = 100;
const MAX_EVENT_ROWS = 200;
const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const PUBLISHED_HOME_CACHE_KEY = 'rankings:published-home:v1';
// Kept as a migration reference for existing KV data; visitor traffic no longer reads or writes it.
export const RANKINGS_USAGE_COUNT_KEY = 'rankings:usage:visitors:v1';
const USAGE_VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const VISITOR_COUNTER_NAME = 'global';
const VISITOR_COUNTER_COUNT_KEY = 'count';
const VISITOR_COUNTER_VISITOR_PREFIX = 'visitor:';
const VISITOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ADMIN_AUTH_NAME = 'global';
const ADMIN_COOKIE_NAME = '__Host-hyb-card-admin';
const ADMIN_CSRF_HEADER = 'x-hyb-admin-csrf';
const ADMIN_FAILURE_PREFIX = 'admin-failure:';
const ADMIN_SESSION_PREFIX = 'admin-session:';
const ADMIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_FAILURE_THRESHOLD = 5;
const ADMIN_LOCK_DURATIONS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];
const ADMIN_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;
const ADMIN_SESSION_MAX_MS = 2 * 60 * 60 * 1000;
export const ADMIN_SITE_CONFIG_KEY = 'admin:site-config:v1';
export const DEFAULT_SITE_CONFIG = Object.freeze({
  siteEnabled: true,
  rankingCaptureEnabled: false,
  cloudUploadEnabled: false,
  maintenanceMessage: '',
  updatedAt: 0
});
const CACHE_HEADERS = Object.freeze({
  home: { 'cache-control': 'public, max-age=300, stale-while-revalidate=1800' },
  latest: { 'cache-control': 'public, max-age=60, stale-while-revalidate=120' },
  leaderboard: { 'cache-control': 'public, max-age=900, stale-while-revalidate=1800' },
  history: { 'cache-control': 'public, max-age=3600, stale-while-revalidate=7200' },
  historyClosed: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
  users: { 'cache-control': 'public, max-age=1800, stale-while-revalidate=3600' },
  events: { 'cache-control': 'public, max-age=1800, stale-while-revalidate=3600' },
  eventsClosed: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
  usage: { 'cache-control': 'no-store' }
});

export async function handleRankingsRequest(request, env, executionContext = null) {
  const url = new URL(request.url);

  try {
    if (url.pathname === '/api/rankings/home' && request.method === 'GET') {
      return await getPublishedHome(request, env, executionContext);
    }
    if (url.pathname === '/api/rankings/latest' && request.method === 'GET') return await getLatest(env);
    if (url.pathname === '/api/rankings/usage' && request.method === 'GET') return await getUsage(env);
    if (url.pathname === '/api/rankings/usage' && request.method === 'POST') return await postUsage(request, env);
    if (url.pathname === '/api/site-config' && request.method === 'GET') return await getSiteConfig(env);
    if (url.pathname === '/api/admin/login' && request.method === 'POST') return await loginAdmin(request, env);
    if (url.pathname === '/api/admin/session' && request.method === 'GET') return await getAdminSession(request, env);
    if (url.pathname === '/api/admin/config' && request.method === 'POST') return await updateAdminConfig(request, env);
    if (url.pathname === '/api/admin/logout' && request.method === 'POST') return await logoutAdmin(request, env);
    if (url.pathname === '/api/rankings/snapshots' && request.method === 'POST') {
      return await postSnapshot(request, env, executionContext);
    }
    if (!env || !env.RANKINGS_DB) return databaseUnavailable(url);
    if (url.pathname === '/api/rankings/leaderboard' && request.method === 'GET') return await getLeaderboard(url, env);
    if (url.pathname === '/api/rankings/history' && request.method === 'GET') return await getHistory(url, env);
    if (url.pathname === '/api/rankings/users' && request.method === 'GET') return await getUsers(url, env);
    if (url.pathname === '/api/rankings/events' && request.method === 'GET') return await getEvents(url, env);
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    const readRequest = request.method === 'GET' && url.pathname.startsWith('/api/rankings/');
    if (readRequest) {
      console.error('rankings_read_failed', {
        path: url.pathname,
        message: String(error && error.message || error).slice(0, 240)
      });
    }
    return jsonResponse({
      ok: false,
      error: readRequest ? 'rankings_read_unavailable' : 'database_error',
      message: readRequest ? '榜单读取暂时繁忙，请稍后重试' : String(error && error.message || error).slice(0, 240),
      endpoint: url.pathname,
      retryable: readRequest
    }, readRequest ? 503 : 500);
  }
}

async function getUsage(env) {
  const counter = visitorCounterStub(env);
  if (!counter) return visitorCounterUnavailableResponse();

  try {
    const response = await counter.fetch(new Request('https://visitor-counter/read', { method: 'GET' }));
    const data = await response.json().catch(() => ({}));
    const count = normalizeVisitorCount(data && data.visitors);
    if (!response.ok || !data || data.ok === false || count === null) {
      throw new Error('invalid_counter_response');
    }
    return jsonResponse({ ok: true, visitors: count }, 200, CACHE_HEADERS.usage);
  } catch (error) {
    console.error('rankings_usage_counter_read_failed', {
      message: String(error && error.message || error).slice(0, 240)
    });
    return visitorCounterUnavailableResponse();
  }
}

async function postUsage(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const visitorId = normalizeUsageVisitorId(body && body.visitorId);
  if (!visitorId) return jsonResponse({ ok: false, error: 'invalid_visitor_id' }, 400);

  const counter = visitorCounterStub(env);
  if (!counter) return visitorCounterUnavailableResponse();

  try {
    const visitorHash = await hashUsageVisitorId(visitorId);
    const response = await counter.fetch(new Request('https://visitor-counter/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorHash })
    }));
    const data = await response.json().catch(() => ({}));
    const count = normalizeVisitorCount(data && data.visitors);
    if (!response.ok || !data || data.ok === false || count === null) {
      throw new Error('invalid_counter_response');
    }
    return jsonResponse({
      ok: true,
      visitors: count,
      counted: Boolean(data.counted)
    }, 200, CACHE_HEADERS.usage);
  } catch (error) {
    console.error('rankings_usage_counter_write_failed', {
      message: String(error && error.message || error).slice(0, 240)
    });
    return visitorCounterUnavailableResponse();
  }
}

async function visitorCounterUnavailableResponse() {
  return jsonResponse({
    ok: false,
    error: 'visitor_counter_unavailable',
    visitors: null,
    counted: false
  }, 503, {
    ...CACHE_HEADERS.usage,
    'retry-after': '60'
  });
}

function normalizeVisitorCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function normalizeUsageVisitorId(value) {
  const visitorId = String(value == null ? '' : value).trim();
  return USAGE_VISITOR_ID_PATTERN.test(visitorId) ? visitorId : '';
}

async function hashUsageVisitorId(visitorId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(visitorId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function visitorCounterStub(env) {
  const namespace = env && env.VISITOR_COUNTER;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') return null;
  try {
    return namespace.get(namespace.idFromName(VISITOR_COUNTER_NAME));
  } catch (_) {
    return null;
  }
}

export class VisitorCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.operation = Promise.resolve();
  }

  fetch(request) {
    const operation = this.operation.then(
      () => this.handle(request),
      () => this.handle(request)
    );
    this.operation = operation.catch(() => {});
    return operation;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/read') {
      return jsonResponse({ ok: true, visitors: await this.readCount() }, 200, CACHE_HEADERS.usage);
    }

    if (request.method !== 'POST' || url.pathname !== '/record') {
      return jsonResponse({ ok: false, error: 'not_found' }, 404, CACHE_HEADERS.usage);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400, CACHE_HEADERS.usage);
    }

    const visitorHash = String(body && body.visitorHash || '').trim();
    if (!VISITOR_HASH_PATTERN.test(visitorHash)) {
      return jsonResponse({ ok: false, error: 'invalid_visitor_hash' }, 400, CACHE_HEADERS.usage);
    }

    const count = await this.readCount();
    const markerKey = `${VISITOR_COUNTER_VISITOR_PREFIX}${visitorHash}`;
    if (await this.state.storage.get(markerKey) != null) {
      return jsonResponse({ ok: true, visitors: count, counted: false }, 200, CACHE_HEADERS.usage);
    }

    const next = count + 1;
    await this.state.storage.put({
      [VISITOR_COUNTER_COUNT_KEY]: String(next),
      [markerKey]: '1'
    });
    return jsonResponse({ ok: true, visitors: next, counted: true }, 200, CACHE_HEADERS.usage);
  }

  async readCount() {
    return normalizeVisitorCount(await this.state.storage.get(VISITOR_COUNTER_COUNT_KEY)) ?? 0;
  }
}

async function getSiteConfig(env) {
  return jsonResponse({ ok: true, config: await loadSiteConfig(env) }, 200, { 'cache-control': 'no-store' });
}

async function loginAdmin(request, env) {
  if (!isSecureRequest(request) || !hasSameOrigin(request)) return adminAuthFailureResponse(403, 'admin_login_failed');

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return adminAuthFailureResponse(401, 'admin_login_failed');
  }
  const password = String(body && body.password != null ? body.password : '');
  const stub = adminAuthStub(env);
  if (!stub) return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });

  try {
    const response = await stub.fetch(new Request('https://admin-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        password,
        ip: String(request.headers.get('cf-connecting-ip') || 'unknown')
      })
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const headers = { 'cache-control': 'no-store' };
      if (response.status === 429 && Number(data.retryAfter) > 0) headers['retry-after'] = String(Math.ceil(Number(data.retryAfter)));
      return jsonResponse({ ok: false, error: 'admin_login_failed' }, response.status === 429 ? 429 : 401, headers);
    }
    return jsonResponse({ ok: true, csrfToken: data.csrfToken, expiresAt: data.expiresAt }, 200, {
      'cache-control': 'no-store',
      'set-cookie': adminSessionCookie(data.token)
    });
  } catch (error) {
    console.error('rankings_admin_login_failed', { message: String(error && error.message || error).slice(0, 160) });
    return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

async function getAdminSession(request, env) {
  const token = readAdminCookie(request);
  if (!token) return jsonResponse({ ok: false, error: 'admin_auth_required' }, 401, { 'cache-control': 'no-store' });
  const stub = adminAuthStub(env);
  if (!stub) return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });

  try {
    const response = await stub.fetch(new Request('https://admin-auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    }));
    const data = await response.json().catch(() => ({}));
    return jsonResponse(
      data.ok
        ? { ok: true, csrfToken: data.csrfToken, expiresAt: data.expiresAt, config: await loadSiteConfig(env) }
        : { ok: false, error: 'admin_auth_required' },
      data.ok ? 200 : 401,
      { 'cache-control': 'no-store' }
    );
  } catch (error) {
    console.error('rankings_admin_session_failed', { message: String(error && error.message || error).slice(0, 160) });
    return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

async function updateAdminConfig(request, env) {
  const authorization = await verifyAdminMutation(request, env);
  if (authorization.response) return authorization.response;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400, { 'cache-control': 'no-store' });
  }
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const field of ['siteEnabled', 'rankingCaptureEnabled', 'cloudUploadEnabled']) {
    if (Object.prototype.hasOwnProperty.call(input, field) && typeof input[field] !== 'boolean') {
      return jsonResponse({ ok: false, error: 'invalid_site_config' }, 400, { 'cache-control': 'no-store' });
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'maintenanceMessage') && typeof input.maintenanceMessage !== 'string') {
    return jsonResponse({ ok: false, error: 'invalid_site_config' }, 400, { 'cache-control': 'no-store' });
  }

  const current = await loadSiteConfig(env);
  const config = normalizeSiteConfig({
    ...current,
    siteEnabled: Object.prototype.hasOwnProperty.call(input, 'siteEnabled') ? input.siteEnabled : current.siteEnabled,
    rankingCaptureEnabled: Object.prototype.hasOwnProperty.call(input, 'rankingCaptureEnabled') ? input.rankingCaptureEnabled : current.rankingCaptureEnabled,
    cloudUploadEnabled: Object.prototype.hasOwnProperty.call(input, 'cloudUploadEnabled') ? input.cloudUploadEnabled : current.cloudUploadEnabled,
    maintenanceMessage: Object.prototype.hasOwnProperty.call(input, 'maintenanceMessage') ? input.maintenanceMessage : current.maintenanceMessage,
    updatedAt: Date.now()
  });

  try {
    if (!env || !env.RANKINGS_HOME_CACHE || typeof env.RANKINGS_HOME_CACHE.put !== 'function') {
      throw new Error('RANKINGS_HOME_CACHE binding is not configured');
    }
    await env.RANKINGS_HOME_CACHE.put(ADMIN_SITE_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('rankings_admin_config_write_failed', { message: String(error && error.message || error).slice(0, 160) });
    return jsonResponse({ ok: false, error: 'site_config_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
  return jsonResponse({ ok: true, config }, 200, { 'cache-control': 'no-store' });
}

async function logoutAdmin(request, env) {
  const authorization = await verifyAdminMutation(request, env);
  if (authorization.response) return authorization.response;
  const token = readAdminCookie(request);
  const csrfToken = String(request.headers.get(ADMIN_CSRF_HEADER) || '');
  const stub = adminAuthStub(env);
  if (!stub) return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });

  try {
    const response = await stub.fetch(new Request('https://admin-auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, csrfToken })
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      return jsonResponse(
        { ok: false, error: data.error === 'admin_csrf_invalid' ? 'admin_csrf_invalid' : 'admin_auth_required' },
        response.status === 403 ? 403 : 401,
        { 'cache-control': 'no-store' }
      );
    }
    return jsonResponse({ ok: true }, 200, {
      'cache-control': 'no-store',
      'set-cookie': expiredAdminSessionCookie()
    });
  } catch (error) {
    console.error('rankings_admin_logout_failed', { message: String(error && error.message || error).slice(0, 160) });
    return jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

async function verifyAdminMutation(request, env) {
  if (!isSecureRequest(request) || !hasSameOrigin(request)) {
    return { response: jsonResponse({ ok: false, error: 'admin_origin_invalid' }, 403, { 'cache-control': 'no-store' }) };
  }
  const token = readAdminCookie(request);
  const csrfToken = String(request.headers.get(ADMIN_CSRF_HEADER) || '');
  if (!token || !csrfToken) {
    return { response: jsonResponse({ ok: false, error: 'admin_auth_required' }, 401, { 'cache-control': 'no-store' }) };
  }
  const stub = adminAuthStub(env);
  if (!stub) {
    return { response: jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' }) };
  }
  try {
    const response = await stub.fetch(new Request('https://admin-auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, csrfToken })
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      return {
        response: jsonResponse(
          { ok: false, error: data.error === 'admin_csrf_invalid' ? 'admin_csrf_invalid' : 'admin_auth_required' },
          response.status === 403 ? 403 : 401,
          { 'cache-control': 'no-store' }
        )
      };
    }
    return { ok: true, expiresAt: data.expiresAt };
  } catch (error) {
    console.error('rankings_admin_verify_failed', { message: String(error && error.message || error).slice(0, 160) });
    return { response: jsonResponse({ ok: false, error: 'admin_auth_unavailable' }, 503, { 'cache-control': 'no-store' }) };
  }
}

export async function loadSiteConfig(env) {
  if (!env || !env.RANKINGS_HOME_CACHE || typeof env.RANKINGS_HOME_CACHE.get !== 'function') return { ...DEFAULT_SITE_CONFIG };
  try {
    const raw = await env.RANKINGS_HOME_CACHE.get(ADMIN_SITE_CONFIG_KEY);
    return normalizeSiteConfig(raw);
  } catch (_) {
    return { ...DEFAULT_SITE_CONFIG };
  }
}

export function normalizeSiteConfig(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {
      source = null;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { ...DEFAULT_SITE_CONFIG };
  return {
    siteEnabled: typeof source.siteEnabled === 'boolean' ? source.siteEnabled : DEFAULT_SITE_CONFIG.siteEnabled,
    rankingCaptureEnabled: typeof source.rankingCaptureEnabled === 'boolean' ? source.rankingCaptureEnabled : DEFAULT_SITE_CONFIG.rankingCaptureEnabled,
    cloudUploadEnabled: typeof source.cloudUploadEnabled === 'boolean' ? source.cloudUploadEnabled : DEFAULT_SITE_CONFIG.cloudUploadEnabled,
    maintenanceMessage: typeof source.maintenanceMessage === 'string' ? source.maintenanceMessage.slice(0, 240) : DEFAULT_SITE_CONFIG.maintenanceMessage,
    updatedAt: Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0 ? Math.floor(Number(source.updatedAt)) : DEFAULT_SITE_CONFIG.updatedAt
  };
}

function adminAuthStub(env) {
  const namespace = env && env.ADMIN_AUTH;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') return null;
  try {
    return namespace.get(namespace.idFromName(ADMIN_AUTH_NAME));
  } catch (_) {
    return null;
  }
}

function isSecureRequest(request) {
  return new URL(request.url).protocol === 'https:';
}

function hasSameOrigin(request) {
  const url = new URL(request.url);
  return String(request.headers.get('origin') || '') === url.origin;
}

function readAdminCookie(request) {
  const cookie = String(request.headers.get('cookie') || '');
  const item = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`));
  return item ? item.slice(ADMIN_COOKIE_NAME.length + 1) : '';
}

function adminSessionCookie(token) {
  return `${ADMIN_COOKIE_NAME}=${token}; Max-Age=${Math.floor(ADMIN_SESSION_MAX_MS / 1000)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function expiredAdminSessionCookie() {
  return `${ADMIN_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function adminAuthFailureResponse(status, error) {
  return jsonResponse({ ok: false, error }, status, { 'cache-control': 'no-store' });
}

export class AdminAuth {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.operation = Promise.resolve();
  }

  fetch(request) {
    const operation = this.operation.then(
      () => this.handle(request),
      () => this.handle(request)
    );
    this.operation = operation.catch(() => {});
    return operation;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !['/login', '/session', '/verify', '/logout'].includes(url.pathname)) {
      return jsonResponse({ ok: false, error: 'not_found' }, 404, { 'cache-control': 'no-store' });
    }
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/login') return this.login(body);
    if (url.pathname === '/session') return this.session(body);
    if (url.pathname === '/verify') return this.verify(body);
    return this.logout(body);
  }

  async login(body) {
    const now = Date.now();
    const ipHash = await hashAdminValue(String(body && body.ip || 'unknown'));
    const failureKey = `${ADMIN_FAILURE_PREFIX}${ipHash}`;
    let failure = await this.state.storage.get(failureKey);
    if (failure && Number(failure.lockUntil) > now) {
      return jsonResponse({ ok: false, retryAfter: Math.ceil((Number(failure.lockUntil) - now) / 1000) }, 429, { 'cache-control': 'no-store' });
    }
    if (!failure || now - Number(failure.windowStartedAt) >= ADMIN_FAILURE_WINDOW_MS) {
      failure = {
        count: 0,
        windowStartedAt: now,
        lockLevel: failure && Number.isFinite(Number(failure.lockLevel)) ? Number(failure.lockLevel) : 0,
        lockUntil: 0
      };
    }

    const expected = String(this.env.ADMIN_PASSWORD == null ? '' : this.env.ADMIN_PASSWORD);
    const supplied = String(body && body.password != null ? body.password : '');
    if (!timingSafeStringEqual(supplied, expected) || !expected) {
      failure.count += 1;
      if (failure.count >= ADMIN_FAILURE_THRESHOLD) {
        const level = Math.max(0, Number(failure.lockLevel) || 0);
        const duration = level < ADMIN_LOCK_DURATIONS_MS.length
          ? ADMIN_LOCK_DURATIONS_MS[level]
          : ADMIN_MAX_LOCK_MS;
        failure.lockUntil = now + Math.min(duration, ADMIN_MAX_LOCK_MS);
        failure.lockLevel = Math.min(level + 1, ADMIN_LOCK_DURATIONS_MS.length);
        failure.count = 0;
        failure.windowStartedAt = now;
      }
      await this.state.storage.put(failureKey, failure);
      return jsonResponse({ ok: false, retryAfter: failure.lockUntil > now ? Math.ceil((failure.lockUntil - now) / 1000) : 0 }, 401, { 'cache-control': 'no-store' });
    }

    await this.state.storage.delete(failureKey);
    const token = crypto.randomUUID();
    const csrfToken = crypto.randomUUID();
    const tokenHash = await hashAdminValue(token);
    const csrfHash = await hashAdminValue(csrfToken);
    const expiresAt = now + ADMIN_SESSION_TTL_MS;
    await this.state.storage.put(`${ADMIN_SESSION_PREFIX}${tokenHash}`, {
      tokenHash,
      csrfHash,
      createdAt: now,
      expiresAt,
      absoluteExpiresAt: now + ADMIN_SESSION_MAX_MS
    });
    return jsonResponse({ ok: true, token, csrfToken, expiresAt }, 200, { 'cache-control': 'no-store' });
  }

  async session(body) {
    const session = await this.readSession(body && body.token);
    if (!session) return jsonResponse({ ok: false, error: 'admin_auth_required' }, 401, { 'cache-control': 'no-store' });
    const csrfToken = crypto.randomUUID();
    const now = Date.now();
    session.csrfHash = await hashAdminValue(csrfToken);
    session.expiresAt = Math.min(now + ADMIN_SESSION_TTL_MS, Number(session.absoluteExpiresAt));
    await this.state.storage.put(`${ADMIN_SESSION_PREFIX}${session.tokenHash}`, session);
    return jsonResponse({ ok: true, csrfToken, expiresAt: session.expiresAt }, 200, { 'cache-control': 'no-store' });
  }

  async verify(body) {
    const session = await this.readSession(body && body.token);
    if (!session) return jsonResponse({ ok: false, error: 'admin_auth_required' }, 401, { 'cache-control': 'no-store' });
    const csrfHash = await hashAdminValue(String(body && body.csrfToken || ''));
    if (!timingSafeStringEqual(csrfHash, String(session.csrfHash || ''))) {
      return jsonResponse({ ok: false, error: 'admin_csrf_invalid' }, 403, { 'cache-control': 'no-store' });
    }
    const now = Date.now();
    session.expiresAt = Math.min(now + ADMIN_SESSION_TTL_MS, Number(session.absoluteExpiresAt));
    await this.state.storage.put(`${ADMIN_SESSION_PREFIX}${session.tokenHash}`, session);
    return jsonResponse({ ok: true, expiresAt: session.expiresAt }, 200, { 'cache-control': 'no-store' });
  }

  async logout(body) {
    const session = await this.readSession(body && body.token);
    if (!session) return jsonResponse({ ok: false, error: 'admin_auth_required' }, 401, { 'cache-control': 'no-store' });
    const csrfHash = await hashAdminValue(String(body && body.csrfToken || ''));
    if (!timingSafeStringEqual(csrfHash, String(session.csrfHash || ''))) {
      return jsonResponse({ ok: false, error: 'admin_csrf_invalid' }, 403, { 'cache-control': 'no-store' });
    }
    await this.state.storage.delete(`${ADMIN_SESSION_PREFIX}${session.tokenHash}`);
    return jsonResponse({ ok: true }, 200, { 'cache-control': 'no-store' });
  }

  async readSession(token) {
    const normalized = String(token || '');
    if (!normalized) return null;
    const tokenHash = await hashAdminValue(normalized);
    const key = `${ADMIN_SESSION_PREFIX}${tokenHash}`;
    const session = await this.state.storage.get(key);
    if (!session || Number(session.expiresAt) <= Date.now() || Number(session.absoluteExpiresAt) <= Date.now()) {
      if (session) await this.state.storage.delete(key);
      return null;
    }
    return session;
  }
}

async function hashAdminValue(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeStringEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return difference === 0;
}

async function getLatest(env) {
  const published = await readPublishedHome(env);
  if (published && published.snapshot) {
    const capturedAt = Number(published.snapshot.capturedAt || 0);
    return jsonResponse({
      ok: true,
      snapshot: published.snapshot,
      stale: !capturedAt || Date.now() - capturedAt >= REFRESH_INTERVAL_MS,
      boards: [...COMPACT_BOARD_KEYS]
    }, 200, CACHE_HEADERS.latest);
  }
  if (!env || !env.RANKINGS_DB) return databaseUnavailable(new URL('https://card.internal/api/rankings/latest'));
  const season = await latestSeason(env, published);
  if (!season) return jsonResponse({ ok: true, snapshot: null, stale: true, boards: [] }, 200, CACHE_HEADERS.latest);
  return jsonResponse({
    ok: true,
    snapshot: serializeSeasonSnapshot(season),
    stale: Date.now() - Number(season.last_observed_at) >= REFRESH_INTERVAL_MS,
    boards: [...COMPACT_BOARD_KEYS]
  }, 200, CACHE_HEADERS.latest);
}

async function getPublishedHome(request, env, executionContext) {
  const published = await readPublishedHome(env);
  if (published) return jsonResponse(published, 200, CACHE_HEADERS.home);
  if (!env || !env.RANKINGS_DB) return databaseUnavailable(new URL(request.url));

  const fallbackUrl = new URL(request.url);
  fallbackUrl.pathname = '/api/rankings/leaderboard';
  fallbackUrl.search = new URLSearchParams({
    board: 'users',
    period: 'total',
    sort: 'legend',
    direction: 'desc',
    limit: String(PAGE_DEFAULT_LIMIT)
  }).toString();
  const response = await getLeaderboard(fallbackUrl, env);
  if (!response.ok) return response;
  const payload = await response.json();
  await schedulePublishedHome(env, payload, executionContext);
  return jsonResponse(payload, 200, CACHE_HEADERS.home);
}

async function readPublishedHome(env) {
  const cache = env && env.RANKINGS_HOME_CACHE;
  if (!cache || typeof cache.get !== 'function') return null;
  try {
    const payload = await cache.get(PUBLISHED_HOME_CACHE_KEY, { type: 'json' });
    return isPublishedHomePayload(payload) ? payload : null;
  } catch (_) {
    return null;
  }
}

function isPublishedHomePayload(payload) {
  return Boolean(payload
    && payload.ok === true
    && payload.board === 'users'
    && payload.period === 'total'
    && Array.isArray(payload.rows)
    && payload.snapshot
    && Number(payload.snapshot.capturedAt) > 0);
}

function schedulePublishedHome(env, payload, executionContext) {
  const cache = env && env.RANKINGS_HOME_CACHE;
  if (!cache || typeof cache.put !== 'function' || !isPublishedHomePayload(payload)) return;
  const pending = Promise.resolve()
    .then(() => cache.put(PUBLISHED_HOME_CACHE_KEY, JSON.stringify(payload)))
    .catch((error) => {
      console.error('rankings_home_cache_publish_failed', {
        message: String(error && error.message || error).slice(0, 240)
      });
    });
  if (executionContext && typeof executionContext.waitUntil === 'function') {
    executionContext.waitUntil(pending);
    return Promise.resolve();
  }
  return pending;
}

function databaseUnavailable(url) {
  return jsonResponse({
    ok: false,
    error: 'database_unavailable',
    message: '榜单数据库暂时不可用，请稍后重试',
    endpoint: url.pathname,
    retryable: true
  }, 503);
}

async function postSnapshot(request, env, executionContext = null) {
  const rateLimitResponse = await limitSnapshotWrites(request, env);
  if (rateLimitResponse) return rateLimitResponse;

  const siteConfig = await loadSiteConfig(env);
  if (!siteConfig.siteEnabled) {
    return jsonResponse({ ok: false, error: 'site_disabled', retryable: false }, 403, { 'cache-control': 'no-store' });
  }
  if (!siteConfig.rankingCaptureEnabled) {
    return jsonResponse({ ok: false, error: 'sync_disabled', retryable: false }, 403, { 'cache-control': 'no-store' });
  }
  if (!siteConfig.cloudUploadEnabled) {
    return jsonResponse({ ok: false, error: 'cloud_upload_disabled', retryable: false }, 403, { 'cache-control': 'no-store' });
  }
  if (!env || !env.RANKINGS_DB) return databaseUnavailable(new URL(request.url));

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }
  const now = Date.now();
  const bundle = normalizeSnapshotBundle(body, now);
  if (!bundle.snapshots.length) {
    return jsonResponse({
      ok: false,
      error: 'invalid_snapshot',
      reason: bundle.errors[0] && bundle.errors[0].reason || 'invalid_snapshot'
    }, 400);
  }

  const source = String(body && body.source || 'card-dashboard-userscript').slice(0, 64);
  const mode = body && body.mode === 'manual' ? 'manual' : 'automatic';
  let stored;
  try {
    stored = await storeUserObservations(env.RANKINGS_DB, bundle.snapshots, {
      source,
      mode,
      finalSets: body && body.finalSets === true,
      setsFinalRetry: body && body.setsFinalRetry === true
    }, now);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: 'database_error',
      reason: String(error && error.message || error).slice(0, 240),
      errors: bundle.errors
    }, 500);
  }

  if (stored.storedSnapshots > 0) {
    await scheduleLatestHomePublish(env, executionContext);
  }

  const errors = bundle.errors.slice();
  const skippedScopes = stored.skippedScopes || [];
  const skippedMetrics = stored.skippedMetrics || [];
  const storedSnapshots = Number.isFinite(Number(stored.storedSnapshots))
    ? Math.max(0, Number(stored.storedSnapshots))
    : Math.max(0, bundle.snapshots.length - skippedScopes.length);
  const storedEntries = Number.isFinite(Number(stored.storedEntries))
    ? Math.max(0, Number(stored.storedEntries))
    : bundle.snapshots
      .filter((normalized) => !skippedScopes.some((item) => item.seasonId === normalized.seasonId && item.scope === normalized.scope))
      .reduce((sum, normalized) => sum + normalized.entries.length, 0);
  const unchangedUsers = Math.max(0, stored.users - stored.changedUsers);
  const latest = bundle.snapshots[bundle.snapshots.length - 1];
  const snapshot = latest ? serializeObservedSnapshot(latest, now) : null;
  return jsonResponse({
    ok: true,
    status: errors.length || skippedScopes.length || skippedMetrics.length
      ? (storedSnapshots ? 'partial' : 'unchanged')
      : 'accepted',
    snapshot,
    snapshots: snapshot ? [snapshot] : [],
    storedSnapshots,
    duplicateSnapshots: 0,
    staleSnapshots: skippedScopes.length,
    storedEntries,
    changedUsers: stored.changedUsers,
    changedFields: stored.changedFields,
    unchangedUsers,
    skippedScopes,
    skippedMetrics,
    partial: errors.length > 0 || skippedScopes.length > 0 || skippedMetrics.length > 0,
    errors
  });
}

function scheduleLatestHomePublish(env, executionContext) {
  const cache = env && env.RANKINGS_HOME_CACHE;
  if (!cache || typeof cache.put !== 'function') return;
  const pending = publishLatestHome(env);
  if (executionContext && typeof executionContext.waitUntil === 'function') {
    executionContext.waitUntil(pending);
  }
  return pending;
}

async function publishLatestHome(env) {
  const cache = env && env.RANKINGS_HOME_CACHE;
  if (!cache || typeof cache.put !== 'function') return;
  try {
    const url = new URL('https://card.internal/api/rankings/leaderboard');
    url.search = new URLSearchParams({
      board: 'users',
      period: 'total',
      sort: 'legend',
      direction: 'desc',
      limit: String(PAGE_DEFAULT_LIMIT)
    }).toString();
    const season = await latestSeason(env, null, { preferDatabase: true });
    if (!season) return;
    const response = await getLeaderboard(url, env, { season });
    if (!response.ok) return;
    const payload = await response.json();
    await schedulePublishedHome(env, payload, null);
  } catch (error) {
    console.error('rankings_home_cache_publish_failed', {
      message: String(error && error.message || error).slice(0, 240)
    });
  }
}

async function limitSnapshotWrites(request, env) {
  const limiter = env.RANKINGS_WRITE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const key = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'anonymous';
  const result = await limiter.limit({ key: String(key).slice(0, 128) });
  if (!result || result.success !== false) return null;
  return jsonResponse({ ok: false, error: 'rate_limited', retryable: true }, 429, { 'retry-after': '60' });
}

async function getLeaderboard(url, env, options = {}) {
  const board = String(url.searchParams.get('board') || 'users').trim();
  const period = String(url.searchParams.get('period') || 'total').trim();
  if (!BOARD_GROUPS.has(board) || !PERIODS.has(period)) return jsonResponse({ ok: false, error: 'invalid_board_or_period' }, 400);
  const season = options.season || await latestSeason(env, null, options);
  if (!season) {
    return jsonResponse({
      ok: true,
      snapshot: null,
      rows: [],
      partialRows: [],
      pinnedRows: [],
      board,
      period,
      totalRows: 0,
      summary: null,
      hasMore: false,
      nextCursor: null
    }, 200, CACHE_HEADERS.leaderboard);
  }

  const limit = parsePageLimit(url.searchParams.get('limit'));
  const sort = board === 'users' ? normalizeUserSort(url.searchParams.get('sort')) : board === 'luck' ? 'probability' : 'legend';
  const direction = normalizeDirection(url.searchParams.get('direction'), sort === 'user' ? 'asc' : 'desc');
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 128);
  const pinnedIds = board === 'users'
    ? String(url.searchParams.get('pinned') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 20)
    : [];
  const cursorResult = decodeCurrentCursor(url.searchParams.get('cursor'), sort, direction, {
    seasonId: season.season_id,
    board,
    period,
    query
  });
  if (cursorResult.error) return jsonResponse({ ok: false, error: cursorResult.error }, 400);

  const page = await queryCurrentBoard(env.RANKINGS_DB, {
    seasonId: season.season_id,
    board,
    period,
    sort,
    direction,
    limit,
    q: query,
    includeTotal: true,
    pinnedIds,
    cursor: cursorResult.cursor
  });
  const capturedAt = Number(season.last_observed_at);
  const rows = page.rows.map((row, index) => buildLeaderboardRow(row, board, period, Number(row.current_rank) || index + 1, capturedAt));
  const pinnedRows = (page.pinnedRows || [])
    .map((row, index) => buildLeaderboardRow(row, board, period, Number(row.current_rank) || index + 1, capturedAt));
  return jsonResponse({
    ok: true,
    board,
    period,
    sort,
    boardKey: `${board}_${period}`,
    snapshot: serializeSeasonSnapshot(season),
    previousSnapshot: null,
    estimated: true,
    rows,
    partialRows: rows.filter((row) => row.isPartial),
    pinnedRows,
    totalRows: page.totalRows,
    summary: page.summary || null,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
  }, 200, CACHE_HEADERS.leaderboard);
}

async function getHistory(url, env) {
  const userId = String(url.searchParams.get('userId') || '').trim();
  if (!userId) return jsonResponse({ ok: false, error: 'user_id_required' }, 400);
  const board = String(url.searchParams.get('board') || '').trim();
  if (board && !BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  const requestedMode = String(url.searchParams.get('mode') || 'daily').trim().toLowerCase();
  if (!HISTORY_MODES.has(requestedMode)) return jsonResponse({ ok: false, error: 'invalid_history_mode' }, 400);
  const limitResult = parseHistoryLimit(url.searchParams.get('limit'));
  if (limitResult.error) return jsonResponse({ ok: false, error: limitResult.error }, 400);
  const season = await latestSeason(env);
  if (!season) {
    return jsonResponse({
      ok: true,
      userId,
      mode: 'daily',
      since: 0,
      until: 0,
      limit: limitResult.limit,
      rows: [],
      nextCursor: null,
      hasMore: false,
      events: []
    }, 200, CACHE_HEADERS.history);
  }

  const range = parseBoundedRange(url, Number(season.last_observed_at), HISTORY_DEFAULT_WINDOW_MS);
  if (range.error) return jsonResponse({ ok: false, error: range.error }, 400);
  const cursorResult = decodeHistoryCursor(url.searchParams.get('cursor'), {
    seasonId: season.season_id,
    userId,
    until: range.until
  });
  if (cursorResult.error) return jsonResponse({ ok: false, error: cursorResult.error }, 400);

  const params = [season.season_id, userId, range.since, range.until];
  let cursorClause = '';
  if (cursorResult.cursor) {
    cursorClause = ' AND day_start_at > ?';
    params.push(Number(cursorResult.cursor.dayStartAt));
  }
  params.push(limitResult.limit + 1);
  const result = await env.RANKINGS_DB.prepare(`
    SELECT *
    FROM rank_user_days
    WHERE season_id = ? AND user_id = ?
      AND day_start_at >= ? AND day_start_at <= ?${cursorClause}
    ORDER BY day_start_at ASC
    LIMIT ?
  `).bind(...params).all();
  const dayRows = result.results || [];
  const pageRows = dayRows.slice(0, limitResult.limit);
  const rows = pageRows
    .flatMap((row) => compactHistoryRows(row, board === 'users' ? '' : board))
    .map((row) => serializeHistoryRow(row, season.season_name));
  const nextCursor = dayRows.length > limitResult.limit && pageRows.length
    ? encodeHistoryCursor({
      seasonId: season.season_id,
      userId,
      until: range.until,
      dayStartAt: Number(pageRows[pageRows.length - 1].day_start_at)
    })
    : null;
  return jsonResponse({
    ok: true,
    userId,
    mode: 'daily',
    season: { id: season.season_id, name: season.season_name },
    elapsedDays: elapsedSeasonDays(Date.now(), season.last_observed_at),
    since: range.since,
    until: range.until,
    limit: limitResult.limit,
    rows,
    nextCursor,
    hasMore: Boolean(nextCursor),
    events: buildUserEvents(rows)
  }, 200, historyCacheHeaders(range, season.last_observed_at));
}

async function getUsers(url, env) {
  const query = String(url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const ids = String(url.searchParams.get('ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!query && !ids.length) return jsonResponse({ ok: true, users: [] }, 200, CACHE_HEADERS.users);
  const season = await latestSeason(env);
  if (!season) return jsonResponse({ ok: true, users: [] }, 200, CACHE_HEADERS.users);
  const page = ids.length
    ? await queryPinnedUsers(env.RANKINGS_DB, {
      seasonId: season.season_id,
      board: 'users',
      period: 'total',
      sort: 'user',
      direction: 'asc',
      ids,
      limit: 20
    })
    : await queryCurrentBoard(env.RANKINGS_DB, {
      seasonId: season.season_id,
      board: 'users',
      period: 'total',
      sort: 'user',
      direction: 'asc',
      q: query,
      limit: 20
    });
  const period = String(url.searchParams.get('period') || 'total');
  return jsonResponse({
    ok: true,
    users: page.rows.map((row) => ({
      ...buildUserRow(row, PERIODS.has(period) ? period : 'total', null, Number(season.last_observed_at)),
      lastSeenAt: Number(row.last_observed_at || 0)
    }))
  }, 200, CACHE_HEADERS.users);
}

async function getEvents(url, env) {
  const board = String(url.searchParams.get('board') || 'epic').trim();
  if (!BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  if (board === 'users') return jsonResponse({ ok: false, error: 'invalid_event_board' }, 400);
  const season = await latestSeason(env);
  if (!season) return jsonResponse({ ok: true, board, mode: 'daily', since: 0, until: 0, events: [] }, 200, CACHE_HEADERS.events);
  const range = parseBoundedRange(url, Number(season.last_observed_at), EVENTS_DEFAULT_WINDOW_MS);
  if (range.error) return jsonResponse({ ok: false, error: range.error }, 400);
  const ids = String(url.searchParams.get('ids') || url.searchParams.get('userId') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 100);
  const boardKey = board === 'luck' ? 'epic_total' : `${board}_total`;
  const params = [season.season_id, range.since, range.until];
  let userClause = '';
  if (ids.length) {
    userClause = ` AND user_id IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }
  params.push(MAX_EVENT_ROWS * 4);
  const result = await env.RANKINGS_DB.prepare(`
    SELECT day_start_at, user_id, user_name, avatar_url,
      ${boardKey}_value AS value, ${boardKey}_rank AS rank
    FROM rank_user_days
    WHERE season_id = ? AND ${boardKey}_value IS NOT NULL
      AND day_start_at >= ? AND day_start_at <= ?${userClause}
    ORDER BY user_id ASC, day_start_at ASC
    LIMIT ?
  `).bind(...params).all();
  const grouped = new Map();
  for (const row of result.results || []) {
    const list = grouped.get(row.user_id) || [];
    list.push(row);
    grouped.set(row.user_id, list);
  }
  const events = [];
  for (const rows of grouped.values()) {
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (Number(previous.value) === Number(current.value) && Number(previous.rank) === Number(current.rank)) continue;
      events.push({
        board,
        event: Number(previous.rank) === Number(current.rank) ? 'changed' : 'moved',
        userId: String(current.user_id),
        userName: String(current.user_name || ''),
        avatar: String(current.avatar_url || ''),
        previousRank: Number(previous.rank),
        currentRank: Number(current.rank),
        previousValue: Number(previous.value),
        currentValue: Number(current.value),
        rankDelta: Number(previous.rank) - Number(current.rank),
        valueDelta: Number(current.value) - Number(previous.value),
        capturedAt: Number(current.day_start_at)
      });
    }
  }
  return jsonResponse({
    ok: true,
    board,
    mode: 'daily',
    since: range.since,
    until: range.until,
    events: events.slice(-MAX_EVENT_ROWS)
  }, 200, eventCacheHeaders(range, season.last_observed_at));
}

function historyCacheHeaders(range, latestCapturedAt) {
  return isClosedRange(range, latestCapturedAt) ? CACHE_HEADERS.historyClosed : CACHE_HEADERS.history;
}

function eventCacheHeaders(range, latestCapturedAt) {
  return isClosedRange(range, latestCapturedAt) ? CACHE_HEADERS.eventsClosed : CACHE_HEADERS.events;
}

function isClosedRange(range, latestCapturedAt) {
  const latestDayStartAt = dayStartAtForCapturedAt(Number(latestCapturedAt));
  return latestDayStartAt != null
    && range
    && Number(range.until) < latestDayStartAt;
}

async function latestSeason(env, publishedHome = null, options = {}) {
  const published = options.preferDatabase === true
    ? null
    : publishedHome || await readPublishedHome(env);
  const snapshot = published && published.snapshot;
  const seasonId = String(snapshot && snapshot.seasonId || '').trim();
  const capturedAt = Number(snapshot && snapshot.capturedAt || 0);
  if (seasonId && Number.isFinite(capturedAt) && capturedAt > 0) {
    const lastDayStartAt = Number(snapshot.lastDayStartAt || 0) || dayStartAtForCapturedAt(capturedAt) || 0;
    return {
      season_id: seasonId,
      season_name: String(snapshot.seasonName || ''),
      last_observed_at: capturedAt,
      last_day_start_at: lastDayStartAt,
      updated_at: Number(snapshot.updatedAt || snapshot.createdAt || capturedAt) || capturedAt
    };
  }
  return env.RANKINGS_DB.prepare(`
    SELECT season_id, season_name, last_observed_at, last_day_start_at, updated_at
    FROM rank_seasons
    ORDER BY last_observed_at DESC, season_id DESC
    LIMIT 1
  `).first();
}

function buildLeaderboardRow(row, board, period, rank, capturedAt) {
  if (board === 'users') return buildUserRow(row, period, rank, capturedAt);
  const metricKey = board === 'luck' ? 'epic_total' : `${board}_${period}`;
  const epicKey = board === 'luck' ? 'epic_total' : `epic_${period}`;
  const spendKey = board === 'luck' ? 'spend_total' : `spend_${period}`;
  const setsKey = board === 'luck' ? 'sets_total' : `sets_${period}`;
  const epicValue = numericOrNull(row[`${epicKey}_value`]);
  const spendValue = numericOrNull(row[`${spendKey}_value`]);
  const setsValue = numericOrNull(row[`${setsKey}_value`]);
  const pair = metricPairObservation(
    epicValue,
    row[`${epicKey}_observed_at`],
    spendValue,
    row[`${spendKey}_observed_at`]
  );
  const estimate = estimatePullsFromSpend(spendValue, Boolean(row.is_vip), { capturedAt, period });
  const complete = pair.paired && estimate.estimateStatus === 'complete_days';
  const probability = complete
    ? estimateLegendProbability({ epicTotal: epicValue, spendValue, isVip: Boolean(row.is_vip), capturedAt, period })
    : null;
  const estimateStatus = pair.paired ? estimate.estimateStatus : pair.status;
  const value = numericOrNull(row[`${metricKey}_value`]);
  return {
    snapshotId: null,
    boardKey: `${board}_${period}`,
    userId: String(row.user_id || ''),
    userName: String(row.user_name || row.user_id || ''),
    avatar: String(row.avatar_url || ''),
    value,
    rank: numericOrNull(row[`${metricKey}_rank`]) ?? rank,
    isVip: Boolean(row.is_vip),
    epicTotal: epicValue,
    spendValue,
    spendTotal: spendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: pair.paired ? estimate.estimatedDays : null,
    paidPulls: pair.paired ? estimate.paidPulls : null,
    freePulls: pair.paired ? estimate.freePulls : null,
    estimatedPulls: pair.paired ? estimate.estimatedPulls : null,
    exchangeCount: setsValue,
    estimateStatus,
    estimateDayStartAt: pair.staleDayStartAt,
    estimateUsesHistoricalData: pair.staleDayStartAt != null,
    isPartial: !complete || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    previousValue: null,
    rankDelta: null,
    valueDelta: null,
    event: ''
  };
}

function buildUserRow(row, period, rank, capturedAt) {
  const epicKey = `epic_${period}`;
  const spendKey = `spend_${period}`;
  const setsKey = `sets_${period}`;
  const epicTotal = numericOrNull(row[`${epicKey}_value`]);
  const spendValue = numericOrNull(row[`${spendKey}_value`]);
  const exchangeCount = numericOrNull(row[`${setsKey}_value`]);
  const isVip = Boolean(row.is_vip);
  const pair = metricPairObservation(
    epicTotal,
    row[`${epicKey}_observed_at`],
    spendValue,
    row[`${spendKey}_observed_at`]
  );
  const estimate = estimatePullsFromSpend(spendValue, isVip, { capturedAt, period });
  const complete = pair.paired && estimate.estimateStatus === 'complete_days';
  const probability = complete
    ? estimateLegendProbability({ epicTotal, spendValue, isVip, capturedAt, period })
    : null;
  const estimateStatus = pair.paired ? estimate.estimateStatus : pair.status;
  const spendObservedAt = Number(row[`${spendKey}_observed_at`] || row.last_observed_at || capturedAt);
  return {
    snapshotId: null,
    boardKey: `users_${period}`,
    userId: String(row.user_id || ''),
    userName: String(row.user_name || row.user_id || ''),
    avatar: String(row.avatar_url || ''),
    value: spendValue ?? epicTotal ?? exchangeCount,
    rank,
    isVip,
    epicTotal,
    spendValue,
    spendTotal: spendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: pair.paired ? estimate.estimatedDays : null,
    paidPulls: pair.paired ? estimate.paidPulls : null,
    freePulls: pair.paired ? estimate.freePulls : null,
    estimatedPulls: pair.paired ? estimate.estimatedPulls : null,
    exchangeCount,
    estimateStatus,
    estimateDayStartAt: pair.staleDayStartAt ?? dayStartAtForCapturedAt(spendObservedAt),
    estimateUsesHistoricalData: pair.staleDayStartAt != null,
    isPartial: estimateStatus !== 'complete_days' || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    previousValue: null,
    rankDelta: null,
    valueDelta: null,
    event: ''
  };
}

function serializeSeasonSnapshot(row) {
  const capturedAt = Number(row.last_observed_at || 0);
  return {
    id: null,
    seasonId: String(row.season_id || ''),
    seasonName: String(row.season_name || ''),
    scope: 'global,friends',
    capturedAt,
    capturedBucket: null,
    source: 'compact-user-observation',
    signature: '',
    createdAt: Number(row.updated_at || 0),
    lastObservedAt: capturedAt,
    lastDayStartAt: Number(row.last_day_start_at || 0) || dayStartAtForCapturedAt(capturedAt) || 0,
    updatedAt: Number(row.updated_at || 0)
  };
}

function serializeObservedSnapshot(normalized, createdAt) {
  return {
    id: null,
    seasonId: normalized.seasonId,
    seasonName: normalized.seasonName,
    scope: normalized.scope,
    capturedAt: normalized.capturedAt,
    capturedBucket: normalized.capturedBucket ?? null,
    source: 'compact-user-observation',
    signature: '',
    createdAt
  };
}

function serializeHistoryRow(row, seasonName = '') {
  return {
    snapshotId: null,
    boardKey: String(row.board_key || ''),
    userId: String(row.user_id || ''),
    userName: String(row.user_name || ''),
    avatar: String(row.avatar_url || ''),
    value: numericOrNull(row.value),
    rank: numericOrNull(row.rank),
    isVip: Boolean(row.is_vip),
    activeNameDecoration: row.active_name_decoration == null ? null : String(row.active_name_decoration),
    nameDisplayPreference: row.name_display_preference == null ? null : String(row.name_display_preference),
    capturedAt: Number(row.captured_at || 0),
    dayStartAt: Number(row.day_start_at || 0),
    seasonName
  };
}

function buildUserEvents(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.boardKey) || [];
    list.push(row);
    grouped.set(row.boardKey, list);
  }
  const events = [];
  for (const [boardKey, list] of grouped) {
    list.sort((left, right) => Number(left.capturedAt) - Number(right.capturedAt));
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (previous.value === current.value && previous.rank === current.rank) continue;
      events.push({
        boardKey,
        capturedAt: current.capturedAt,
        rankDelta: Number(previous.rank) - Number(current.rank),
        valueDelta: Number(current.value) - Number(previous.value)
      });
    }
  }
  return events;
}

function parseBoundedRange(url, latestCapturedAt, defaultWindowMs) {
  const parsedSince = parseTimestamp(url.searchParams.get('since'));
  const parsedUntil = parseTimestamp(url.searchParams.get('until'));
  if (parsedSince.error) return parsedSince;
  if (parsedUntil.error) return parsedUntil;
  const latest = Number(latestCapturedAt);
  const latestDayStartAt = dayStartAtForCapturedAt(latest);
  if (latestDayStartAt == null) return { error: 'invalid_history_range' };
  const rawUntil = Math.min(parsedUntil.value == null ? latestDayStartAt : parsedUntil.value, latest);
  const until = dayStartAtForCapturedAt(rawUntil);
  if (until == null) return { error: 'invalid_history_range' };
  const defaultDays = Math.max(1, Math.round(defaultWindowMs / DAY_MS));
  let since = parsedSince.value == null
    ? until - (defaultDays - 1) * DAY_MS
    : dayStartAtForCapturedAt(parsedSince.value);
  if (since == null) return { error: 'invalid_history_range' };
  if (since > until) return { error: 'invalid_history_range' };
  const maxDays = Math.max(1, Math.round(HISTORY_MAX_WINDOW_MS / DAY_MS));
  if (until - since > (maxDays - 1) * DAY_MS) since = until - (maxDays - 1) * DAY_MS;
  return { since, until };
}

function parseTimestamp(value) {
  if (value == null || value === '') return { value: null };
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return { value: Math.floor(numeric) };
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? { value: parsed } : { error: 'invalid_history_timestamp' };
}

function parseHistoryLimit(value) {
  if (value == null || value === '') return { limit: HISTORY_DEFAULT_LIMIT };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return { error: 'invalid_history_limit' };
  return { limit: Math.min(HISTORY_MAX_LIMIT, Math.floor(number)) };
}

function parsePageLimit(value) {
  if (value == null || value === '') return PAGE_DEFAULT_LIMIT;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(PAGE_MAX_LIMIT, Math.floor(number)) : PAGE_DEFAULT_LIMIT;
}

function normalizeUserSort(value) {
  return new Set(['probability', 'legend', 'spend', 'pulls', 'sets', 'user']).has(value) ? value : 'legend';
}

function normalizeDirection(value, fallback = 'desc') {
  return value === 'asc' || value === 'desc' ? value : fallback;
}

function encodeHistoryCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify({ mode: 'daily', ...value }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeHistoryCursor(value, context) {
  if (value == null || value === '') return { cursor: null };
  try {
    const text = String(value);
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (text.length % 4)) % 4));
    const cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    if (!cursor || cursor.mode !== 'daily'
      || cursor.seasonId !== context.seasonId
      || cursor.userId !== context.userId
      || Number(cursor.until) !== Number(context.until)
      || !Number.isFinite(Number(cursor.dayStartAt))) return { error: 'invalid_history_cursor' };
    return { cursor };
  } catch (_) {
    return { error: 'invalid_history_cursor' };
  }
}

function elapsedSeasonDays(now, capturedAt) {
  const start = Date.parse('2026-08-02T04:00:00+08:00');
  return Math.max(1, Math.min(90, Math.floor((Number(now || capturedAt) - start) / DAY_MS) + 1));
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}
