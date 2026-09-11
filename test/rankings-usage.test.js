import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRankingsRequest, RANKINGS_USAGE_COUNT_KEY } from '../src/rankings-worker.js';

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.puts = [];
  }

  async get(key) {
    return this.values.get(String(key)) ?? null;
  }

  async put(key, value) {
    this.puts.push({ key: String(key), value: String(value) });
    this.values.set(String(key), String(value));
  }
}

function usageEnvironment(entries = {}) {
  return {
    RANKINGS_HOME_CACHE: new MemoryKv(entries),
    RANKINGS_DB: {
      prepare() {
        throw new Error('visitor usage must not access D1');
      }
    }
  };
}

function usageRequest(method, body) {
  return new Request('https://card.test/api/rankings/usage', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
}

test('first visitor registration increments KV without reading D1', async () => {
  const environment = usageEnvironment();
  const response = await handleRankingsRequest(
    usageRequest('POST', { visitorId: 'visitor-aaaaaaaaaaaaaaaa' }),
    environment
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    visitors: 1,
    counted: true
  });
  assert.equal(environment.RANKINGS_HOME_CACHE.values.get(RANKINGS_USAGE_COUNT_KEY), '1');
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 2);
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.some(({ key }) => key.includes('visitor-')), false);
});

test('the same visitor registration does not increment the count twice', async () => {
  const environment = usageEnvironment();
  const first = await handleRankingsRequest(
    usageRequest('POST', { visitorId: 'visitor-bbbbbbbbbbbbbbbb' }),
    environment
  );
  const second = await handleRankingsRequest(
    usageRequest('POST', { visitorId: 'visitor-bbbbbbbbbbbbbbbb' }),
    environment
  );

  assert.equal((await first.json()).visitors, 1);
  assert.deepEqual(await second.json(), {
    ok: true,
    visitors: 1,
    counted: false
  });
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 2);
});

test('usage GET returns the count with public cache headers and no D1 dependency', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '37' });
  const response = await handleRankingsRequest(usageRequest('GET'), environment);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, visitors: 37 });
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=600, stale-while-revalidate=3600'
  );
});

test('missing or malformed visitor ids are rejected before KV writes', async () => {
  const environment = usageEnvironment();
  for (const body of [{}, { visitorId: 'too-short' }]) {
    const response = await handleRankingsRequest(usageRequest('POST', body), environment);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_visitor_id');
  }
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 0);
});
