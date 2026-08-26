import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRankingsCache } from '../src/rankings-cache.js';

class FakeCache {
  constructor() {
    this.entries = new Map();
    this.deleted = [];
  }

  async match(request) {
    return this.entries.get(new URL(request.url).href)?.clone();
  }

  async put(request, response) {
    this.entries.set(new URL(request.url).href, response.clone());
  }

  async delete(request) {
    const key = new URL(request.url).href;
    this.deleted.push(key);
    return this.entries.delete(key);
  }
}

function context() {
  const cache = new FakeCache();
  const waits = [];
  return {
    cache,
    api: { default: cache },
    ctx: { waitUntil(promise) { waits.push(promise); } },
    waits
  };
}

test('cache hit bypasses the handler and preserves query-specific keys', async () => {
  const { api, ctx, cache, waits } = context();
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return new Response(JSON.stringify({ calls }), {
      headers: { 'cache-control': 'public, max-age=30' }
    });
  };
  const request = new Request('https://card.test/api/rankings/leaderboard?board=users&limit=50');
  await fetchWithRankingsCache(request, {}, ctx, handler, api);
  await Promise.all(waits);
  const second = await fetchWithRankingsCache(request, {}, ctx, handler, api);
  assert.equal(calls, 1);
  assert.deepEqual(await second.json(), { calls: 1 });
  assert.equal(cache.entries.size, 1);
});

test('fresh requests delete the exact query key, call the handler, and repopulate it', async () => {
  const { api, ctx, cache, waits } = context();
  let calls = 0;
  const handler = async () => new Response(JSON.stringify({ calls: ++calls }), {
    headers: { 'cache-control': 'public, max-age=30' }
  });
  const url = 'https://card.test/api/rankings/history?userId=u1&since=1&until=2&limit=30';
  await fetchWithRankingsCache(new Request(url), {}, ctx, handler, api);
  await Promise.all(waits);
  const fresh = await fetchWithRankingsCache(new Request(url, {
    headers: { 'cache-control': 'no-cache' }
  }), {}, ctx, handler, api);
  await Promise.all(waits);
  assert.deepEqual(await fresh.json(), { calls: 2 });
  assert.equal(calls, 2);
  assert.equal(cache.deleted.at(-1), url);
});

test('private or non-rankings requests never enter the public cache', async () => {
  const { api, ctx, cache } = context();
  let calls = 0;
  const handler = async () => new Response('ok', {
    headers: { 'cache-control': 'public, max-age=30' }
  });
  for (const request of [
    new Request('https://card.test/api/rankings/latest', { headers: { cookie: 'session=x' } }),
    new Request('https://card.test/api/other')
  ]) {
    await fetchWithRankingsCache(request, {}, ctx, () => {
      calls += 1;
      return handler();
    }, api);
  }
  assert.equal(calls, 2);
  assert.equal(cache.entries.size, 0);
});
