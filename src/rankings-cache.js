const CACHEABLE_PATHS = new Set([
  '/api/rankings/home',
  '/api/rankings/latest',
  '/api/rankings/leaderboard',
  '/api/rankings/history',
  '/api/rankings/users',
  '/api/rankings/events'
]);

const PURGE_BOARDS = Object.freeze(['users', 'epic', 'spend', 'sets', 'luck']);
const PURGE_PERIODS = Object.freeze(['today', 'week', 'month', 'total']);
const PURGE_LIMITS = Object.freeze([50, 100]);

export async function purgeRankingsResponseCaches(
  request,
  cacheApi = globalThis.caches
) {
  const cache = cacheApi && cacheApi.default;
  if (!cache || typeof cache.delete !== 'function') return;

  const origin = new URL(request.url).origin;
  const urls = [
    new URL('/api/rankings/home', origin).href,
    new URL('/api/rankings/latest', origin).href
  ];
  for (const board of PURGE_BOARDS) {
    for (const period of PURGE_PERIODS) {
      const sort = board === 'luck' ? 'probability' : 'legend';
      for (const limit of PURGE_LIMITS) {
        const url = new URL('/api/rankings/leaderboard', origin);
        url.search = new URLSearchParams({
          board,
          period,
          sort,
          direction: 'desc',
          limit: String(limit),
          pinned: ''
        }).toString();
        urls.push(url.href);
      }
    }
  }

  await Promise.all(urls.map(async (url) => {
    try {
      await cache.delete(new Request(url, { method: 'GET' }));
    } catch (_) {
      // Cache invalidation is best effort and must not fail an accepted upload.
    }
  }));
}

export async function fetchWithRankingsCache(
  request,
  env,
  executionContext,
  handler,
  cacheApi = globalThis.caches
) {
  const cache = cacheApi && cacheApi.default;
  if (!cache || typeof cache.match !== 'function' || !isCacheableRequest(request)) {
    return handler(request, env, executionContext);
  }

  const key = new Request(new URL(request.url).href, { method: 'GET' });
  const bypass = shouldRevalidate(request);
  if (bypass && typeof cache.delete === 'function') {
    try {
      await cache.delete(key);
    } catch (_) {
      // A cache failure must not block a fresh D1 read.
    }
  }

  if (!bypass) {
    try {
      const hit = await cache.match(key);
      if (hit) return withCacheStatus(hit, 'HIT');
    } catch (_) {
      // Fall through to the database-backed handler when the edge cache fails.
    }
  }

  const response = await handler(request, env, executionContext);
  if (response.status === 200 && isPublicResponse(response) && typeof cache.put === 'function') {
    const pending = cache.put(key, response.clone());
    if (executionContext && typeof executionContext.waitUntil === 'function') {
      executionContext.waitUntil(pending);
    } else {
      try {
        await pending;
      } catch (_) {
        // Cache population is an optimization and must not change the response.
      }
    }
  }
  return withCacheStatus(response, 'MISS');
}

function isCacheableRequest(request) {
  const url = new URL(request.url);
  return request.method === 'GET'
    && CACHEABLE_PATHS.has(url.pathname)
    && !request.headers.get('authorization')
    && !request.headers.get('cookie');
}

function shouldRevalidate(request) {
  return /(?:^|,|\s)(?:no-cache|no-store|max-age=0)(?:$|,|\s)/i.test(
    request.headers.get('cache-control') || ''
  );
}

function isPublicResponse(response) {
  const cacheControl = response.headers.get('cache-control') || '';
  return /\bpublic\b/i.test(cacheControl) && !/\bno-store\b/i.test(cacheControl);
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set('x-rankings-cache', status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
