import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  handleRankingsRequest,
  RANKINGS_USAGE_COUNT_KEY,
  VisitorCounter
} from '../src/rankings-worker.js';

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.puts = [];
    this.gets = 0;
  }

  async get(key) {
    this.gets += 1;
    return this.values.get(String(key)) ?? null;
  }

  async put(key, value) {
    this.puts.push({ key: String(key), value: String(value) });
    this.values.set(String(key), String(value));
  }

  getCount() {
    return this.gets;
  }
}

function createMemoryDurableObjectStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    async get(key) {
      await Promise.resolve();
      return values.has(String(key)) ? values.get(String(key)) : undefined;
    },
    async put(key, value) {
      await Promise.resolve();
      if (key instanceof Map) {
        for (const [entryKey, entryValue] of key.entries()) values.set(String(entryKey), entryValue);
        return;
      }
      if (key && typeof key === 'object') {
        for (const [entryKey, entryValue] of Object.entries(key)) values.set(String(entryKey), entryValue);
        return;
      }
      values.set(String(key), value);
    }
  };
}

function createVisitorCounterNamespace(env, entries = {}, storage = null) {
  storage = storage || createMemoryDurableObjectStorage(entries);
  const object = new VisitorCounter({ storage }, env);
  return {
    storage,
    idFromName(name) { return `visitor-counter:${name}`; },
    get() { return { fetch: (request) => object.fetch(request) }; }
  };
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

test('first visitor registration increments through the durable counter without reading D1', async () => {
  const environment = usageEnvironment();
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment);
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
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment);
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

test('durable visitor counter serializes concurrent registrations without losing increments', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '2' });
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment);

  const uniqueResults = await Promise.all([
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-cccccccccccccccc' }), environment),
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-dddddddddddddddd' }), environment),
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-eeeeeeeeeeeeeeee' }), environment)
  ]);
  const uniqueBodies = await Promise.all(uniqueResults.map((response) => response.json()));
  assert.deepEqual(uniqueBodies.map((body) => body.visitors).sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(uniqueBodies.filter((body) => body.counted).length, 3);

  const duplicateResults = await Promise.all([
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-ffffffffffffffff' }), environment),
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-ffffffffffffffff' }), environment)
  ]);
  const duplicateBodies = await Promise.all(duplicateResults.map((response) => response.json()));
  assert.equal(duplicateBodies.filter((body) => body.counted).length, 1);
  assert.equal(duplicateBodies.filter((body) => !body.counted).length, 1);

  const current = await handleRankingsRequest(usageRequest('GET'), environment);
  assert.deepEqual(await current.json(), { ok: true, visitors: 6 });
  assert.equal(environment.RANKINGS_HOME_CACHE.values.get(RANKINGS_USAGE_COUNT_KEY), '6');
});

test('durable visitor counter reads the legacy count only during initialization', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '2' });
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment);

  const first = await handleRankingsRequest(usageRequest('GET'), environment);
  assert.deepEqual(await first.json(), { ok: true, visitors: 2 });

  environment.RANKINGS_HOME_CACHE.values.set(RANKINGS_USAGE_COUNT_KEY, '5');
  const second = await handleRankingsRequest(usageRequest('GET'), environment);
  assert.deepEqual(await second.json(), { ok: true, visitors: 2 });
  assert.equal(environment.RANKINGS_HOME_CACHE.getCount(), 1, 'legacy count is read once per durable counter');
});

test('durable counter binding failures do not fall back to unsafe KV increments', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '4' });
  environment.VISITOR_COUNTER = {
    idFromName() { return 'visitor-counter:global'; },
    get() { throw new Error('counter unavailable'); }
  };

  const response = await handleRankingsRequest(
    usageRequest('POST', { visitorId: 'visitor-gggggggggggggggg' }),
    environment
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'visitor_counter_unavailable',
    visitors: 4,
    counted: false
  });
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 0);
});

test('missing durable counter binding never performs a KV read-modify-write', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '4' });
  const responses = await Promise.all([
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-hhhhhhhhhhhhhhhh' }), environment),
    handleRankingsRequest(usageRequest('POST', { visitorId: 'visitor-iiiiiiiiiiiiiiii' }), environment)
  ]);

  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'visitor_counter_unavailable',
      visitors: 4,
      counted: false
    });
  }
  assert.equal(environment.RANKINGS_HOME_CACHE.values.get(RANKINGS_USAGE_COUNT_KEY), '4');
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 0);
});

test('durable counter read failures return 503 with a retry hint', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '4' });
  const response = await handleRankingsRequest(usageRequest('GET'), environment);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'visitor_counter_unavailable',
    visitors: 4,
    counted: false
  });
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(environment.RANKINGS_HOME_CACHE.puts.length, 0);
});

test('durable counter registration keeps count and marker atomic when storage fails', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '7' });
  const storage = createMemoryDurableObjectStorage({ count: '7' });
  const originalPut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    const keys = key instanceof Map
      ? [...key.keys()]
      : key && typeof key === 'object'
        ? Object.keys(key)
        : [key];
    if (keys.some((entryKey) => String(entryKey).startsWith('visitor:'))) {
      throw new Error('marker write failed');
    }
    return originalPut(key, value);
  };
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment, {}, storage);

  const originalConsoleError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await handleRankingsRequest(
      usageRequest('POST', { visitorId: 'visitor-jjjjjjjjjjjjjjjj' }),
      environment
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'visitor_counter_unavailable',
    visitors: 7,
    counted: false
  });
  assert.equal(storage.values.get('count'), '7');
  assert.equal([...storage.values.keys()].some((key) => String(key).startsWith('visitor:')), false);
});

test('durable visitor counter keeps its count when the legacy KV read is unavailable', async () => {
  const environment = {
    RANKINGS_HOME_CACHE: {
      async get() { throw new Error('legacy KV unavailable'); },
      async put() { throw new Error('legacy KV unavailable'); }
    }
  };
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment, { count: '4' });

  const response = await handleRankingsRequest(usageRequest('GET'), environment);

  assert.deepEqual(await response.json(), { ok: true, visitors: 4 });
});

test('usage GET reads the durable counter without edge caching or D1 dependency', async () => {
  const environment = usageEnvironment({ [RANKINGS_USAGE_COUNT_KEY]: '37' });
  environment.VISITOR_COUNTER = createVisitorCounterNamespace(environment);
  const first = await handleRankingsRequest(usageRequest('GET'), environment);
  const second = await handleRankingsRequest(usageRequest('GET'), environment);

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, visitors: 37 });
  assert.deepEqual(await second.json(), { ok: true, visitors: 37 });
  assert.equal(first.headers.get('cache-control'), 'no-store');
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

test('wrangler config binds and migrates the visitor counter durable object', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const entrypoint = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.deepEqual(config.durable_objects.bindings, [{
    name: 'VISITOR_COUNTER',
    class_name: 'VisitorCounter'
  }]);
  assert.ok(config.migrations.some((migration) => (
    migration.new_sqlite_classes || []).includes('VisitorCounter')));
  assert.match(entrypoint, /export \{ VisitorCounter \}/);
});
