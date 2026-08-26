# Card 榜单上传缓存优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留每天最新用户数据的前提下，减少重复自动上传、D1 元数据无效写入和公开榜单 GET 对 D1 的重复读取。

**Architecture:** Worker fetch 层为公开 rankings GET 增加可失效的短 TTL `caches.default` 包装；Dashboard 只在来源 `capturedAt` 前进且不在短时门槛内时 POST，并把极小的来源水位保存到 `localStorage`；compact D1 用户 upsert 保持现有字段级幂等，只在用户行实际变化时更新赛季元数据。

**Tech Stack:** Cloudflare Workers Cache API, Cloudflare D1, browser `localStorage`, Node.js built-in test runner, existing static build script.

---

### Task 1: Add and integrate the Worker edge-cache wrapper

**Files:**
- Create: `src/rankings-cache.js`
- Modify: `src/index.js:1-32`
- Test: `test/rankings-cache.test.js`

- [ ] **Step 1: Write the failing cache behavior tests**

Create a fake Cache API and test the public contract of `fetchWithRankingsCache(request, env, ctx, handler, cacheApi)`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRankingsCache } from '../src/rankings-cache.js';

class FakeCache {
  constructor() { this.entries = new Map(); this.deleted = []; }
  async match(request) { return this.entries.get(new URL(request.url).href)?.clone() || undefined; }
  async put(request, response) { this.entries.set(new URL(request.url).href, response.clone()); }
  async delete(request) {
    const key = new URL(request.url).href;
    this.deleted.push(key);
    return this.entries.delete(key);
  }
}

function context() {
  const cache = new FakeCache();
  const waits = [];
  return { cache, api: { default: cache }, ctx: { waitUntil(promise) { waits.push(promise); } }, waits };
}

test('cache hit bypasses the handler and preserves query-specific keys', async () => {
  const { api, ctx, cache } = context();
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return new Response(JSON.stringify({ calls }), { headers: { 'cache-control': 'public, max-age=30' } });
  };
  const request = new Request('https://card.test/api/rankings/leaderboard?board=users&limit=50');
  const first = await fetchWithRankingsCache(request, {}, ctx, handler, api);
  await Promise.all(ctx.waits);
  const second = await fetchWithRankingsCache(request, {}, ctx, handler, api);
  assert.equal(calls, 1);
  assert.deepEqual(await second.json(), { calls: 1 });
  assert.equal(cache.entries.size, 1);
});

test('fresh requests delete the exact query key, call the handler, and repopulate it', async () => {
  const { api, ctx, cache } = context();
  let calls = 0;
  const handler = async () => new Response(JSON.stringify({ calls: ++calls }), {
    headers: { 'cache-control': 'public, max-age=30' }
  });
  const url = 'https://card.test/api/rankings/history?userId=u1&since=1&until=2&limit=30';
  await fetchWithRankingsCache(new Request(url), {}, ctx, handler, api);
  await Promise.all(ctx.waits);
  const fresh = await fetchWithRankingsCache(new Request(url, { headers: { 'cache-control': 'no-cache' } }), {}, ctx, handler, api);
  await Promise.all(ctx.waits);
  assert.deepEqual(await fresh.json(), { calls: 2 });
  assert.equal(calls, 2);
  assert.equal(cache.deleted.at(-1), url);
});

test('private or non-rankings requests never enter the public cache', async () => {
  const { api, ctx, cache } = context();
  let calls = 0;
  const handler = async () => new Response('ok', { headers: { 'cache-control': 'public, max-age=30' } });
  for (const request of [
    new Request('https://card.test/api/rankings/latest', { headers: { cookie: 'session=x' } }),
    new Request('https://card.test/api/other')
  ]) await fetchWithRankingsCache(request, {}, ctx, () => { calls += 1; return handler(); }, api);
  assert.equal(calls, 2);
  assert.equal(cache.entries.size, 0);
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing module**

Run: `node --test test/rankings-cache.test.js`

Expected: FAIL with a module-not-found or missing-export error for `src/rankings-cache.js`.

- [ ] **Step 3: Implement the minimal cache wrapper**

Create `src/rankings-cache.js` with these rules:

```js
const CACHEABLE_PATHS = new Set([
  '/api/rankings/latest',
  '/api/rankings/leaderboard',
  '/api/rankings/history',
  '/api/rankings/users',
  '/api/rankings/events'
]);

export async function fetchWithRankingsCache(request, env, executionContext, handler, cacheApi = globalThis.caches) {
  const cache = cacheApi && cacheApi.default;
  if (!cache || !isCacheableRequest(request)) return handler(request, env);

  const key = new Request(new URL(request.url).href, { method: 'GET' });
  const bypass = shouldRevalidate(request);
  if (bypass && typeof cache.delete === 'function') await cache.delete(key);
  if (!bypass) {
    const hit = await cache.match(key);
    if (hit) return withCacheStatus(hit, 'HIT');
  }

  const response = await handler(request, env);
  if (response.status === 200 && isPublicResponse(response)) {
    const pending = cache.put(key, response.clone());
    if (executionContext && typeof executionContext.waitUntil === 'function') executionContext.waitUntil(pending);
    else await pending;
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
  return /(?:^|,|\s)(?:no-cache|no-store|max-age=0)(?:$|,|\s)/i.test(request.headers.get('cache-control') || '');
}

function isPublicResponse(response) {
  const cacheControl = response.headers.get('cache-control') || '';
  return /\bpublic\b/i.test(cacheControl) && !/\bno-store\b/i.test(cacheControl);
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set('x-rankings-cache', status);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
```

Keep the wrapper tolerant of missing Cache API so local tests and fallback runtimes still use the existing handler.

- [ ] **Step 4: Route production fetches through the wrapper**

Modify `src/index.js` to import `fetchWithRankingsCache` and pass the Worker execution context:

```js
import { fetchWithRankingsCache } from './rankings-cache.js';

// inside worker.fetch
if (url.pathname.startsWith('/api/rankings/')) {
  return fetchWithRankingsCache(request, env, ctx, handleRankingsRequest);
}
```

Change the method signature to `async fetch(request, env, ctx)`; leave scheduled maintenance and asset fallback unchanged.

- [ ] **Step 5: Run the focused cache tests**

Run: `node --test test/rankings-cache.test.js`

Expected: PASS with 3 tests and 0 failures.

- [ ] **Step 6: Commit the cache layer**

```bash
git add src/rankings-cache.js src/index.js test/rankings-cache.test.js
git commit -m "perf: cache public rankings reads at the edge"
```

### Task 2: Avoid metadata writes when compact user rows are unchanged

**Files:**
- Modify: `src/rankings-user-store.js:684-724,607-616`
- Test: `test/rankings-compact-worker.test.js:219-227`

- [ ] **Step 1: Add a failing regression test for unchanged metadata**

Append this test near the existing repeated-value test:

```js
test('does not update season metadata when a newer capture changes no user fields', async () => {
  const environment = compactEnv();
  await postSnapshot(environment, snapshotAt(10_000, { epic: 10, spend: 500_000 }));
  const before = environment.RANKINGS_DB.queries.length;
  await postSnapshot(environment, snapshotAt(11_000, { epic: 10, spend: 500_000 }));
  const queries = environment.RANKINGS_DB.queries.slice(before).map(({ sql }) => sql);
  assert.equal(queries.some((sql) => /insert into rank_seasons/i.test(sql)), false);
  assert.equal(environment.RANKINGS_DB.userDays.length, 1);
  assert.equal(environment.RANKINGS_DB.currentUsers.length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `node --test test/rankings-compact-worker.test.js`

Expected: FAIL because the current store always executes `SEASON_UPSERT_SQL` after a newer source capture.

- [ ] **Step 3: Track changes per season group and gate the season upsert**

In `storeUserObservations`, initialize `let groupChangedUsers = 0` before the chunks loop. After each batch, calculate the changed-user count once, add it to both `groupChangedUsers` and the global `result.changedUsers`, then execute the season upsert only when `groupChangedUsers > 0`:

```js
let groupChangedUsers = 0;
for (const chunk of chunks(rows, 50)) {
  // build and run the existing day/current statements
  const changedInChunk = chunk.filter((_, index) => changes[index] || changes[chunk.length + index]).length;
  groupChangedUsers += changedInChunk;
  result.changedUsers += changedInChunk;
}

if (groupChangedUsers > 0) {
  const latestDayStartAt = rows.reduce((max, row) => Math.max(max, Number(row.day_start_at)), 0);
  await db.prepare(SEASON_UPSERT_SQL).bind(
    group.seasonId,
    group.seasonName,
    group.snapshots.reduce((max, snapshot) => Math.max(max, Number(snapshot.capturedAt) || 0), 0),
    latestDayStartAt,
    now
  ).run();
}
```

Do not remove the `rank_ingest_state` upsert: its source watermark is required to skip replayed captures.

- [ ] **Step 4: Add a defensive no-op condition to the season SQL**

Append this condition to `SEASON_UPSERT_SQL` so a repeated metadata value cannot update `updated_at` by itself:

```sql
WHERE excluded.season_name <> rank_seasons.season_name
   OR excluded.last_observed_at > rank_seasons.last_observed_at
   OR excluded.last_day_start_at > rank_seasons.last_day_start_at
```

- [ ] **Step 5: Run the compact worker tests**

Run: `node --test test/rankings-compact-worker.test.js`

Expected: PASS, including the new unchanged-metadata test and all existing compact storage tests.

- [ ] **Step 6: Commit the metadata gate**

```bash
git add src/rankings-user-store.js test/rankings-compact-worker.test.js
git commit -m "perf: skip unchanged rankings metadata writes"
```

### Task 3: Add client-side source watermark gating without fingerprints

**Files:**
- Modify: `site/rankings.js:4-46,171-200,2112-2125,2154-2171,2303-2318`
- Test: `test/rankings-view.test.js:485-525`

- [ ] **Step 1: Add failing source-watermark assertions**

Add assertions to the client caching/upload test:

```js
test('rankings client skips already uploaded automatic captures without storing a fingerprint', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /hyb-card-rankings-upload-state-v1/);
  assert.match(source, /AUTO_UPLOAD_MIN_INTERVAL_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /function shouldSkipUpload/);
  assert.match(source, /skippedUpload/);
  assert.match(source, /options\.manual/);
  assert.match(source, /rememberUploadedSnapshots/);
  assert.doesNotMatch(source, /fingerprint\s*:/);
});

test('fresh rankings GET sends explicit revalidation to the Worker cache layer', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const apiGet = extractFunction(source, 'apiGet');
  assert.match(apiGet, /cache-control/);
  assert.match(apiGet, /no-cache/);
});
```

- [ ] **Step 2: Run the focused view tests and verify they fail**

Run: `node --test test/rankings-view.test.js`

Expected: FAIL because the upload-state key, gate functions and explicit revalidation header do not exist yet.

- [ ] **Step 3: Add the small local state helpers**

Near the existing storage constants, add:

```js
const UPLOAD_STATE_STORAGE_KEY = 'hyb-card-rankings-upload-state-v1';
const AUTO_UPLOAD_MIN_INTERVAL_MS = 15 * 60 * 1000;

function readUploadState() {
  try {
    const value = JSON.parse(window.localStorage.getItem(UPLOAD_STATE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    try { window.localStorage.removeItem(UPLOAD_STATE_STORAGE_KEY); } catch (_) { /* ignore storage failures */ }
    return {};
  }
}

function writeUploadState(state) {
  try { window.localStorage.setItem(UPLOAD_STATE_STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* ignore storage failures */ }
}

function uploadStateKey(snapshot) {
  return `${String(snapshot.season.id || '').trim()}\u0000${String(snapshot.scope || '').trim()}`;
}

function shouldSkipUpload(snapshots, options = {}) {
  if (options.manual || !snapshots.length) return false;
  const now = Number(options.now) || Date.now();
  const state = readUploadState();
  return snapshots.every((snapshot) => {
    const previous = state[uploadStateKey(snapshot)];
    if (!previous) return false;
    const capturedAt = Number(snapshot.capturedAt);
    return Number(previous.capturedAt) >= capturedAt
      || now - Number(previous.uploadedAt || 0) < AUTO_UPLOAD_MIN_INTERVAL_MS;
  });
}

function rememberUploadedSnapshots(snapshots, now = Date.now()) {
  const state = readUploadState();
  snapshots.forEach((snapshot) => {
    const key = uploadStateKey(snapshot);
    const previous = state[key];
    state[key] = {
      capturedAt: Math.max(Number(previous && previous.capturedAt) || 0, Number(snapshot.capturedAt) || 0),
      uploadedAt: now
    };
  });
  writeUploadState(state);
}
```

These helpers store only source time watermarks and never serialize the upload body.

- [ ] **Step 4: Gate automatic upload and record successful watermarks**

Change `uploadSnapshot(snapshot, options = {})` to call `shouldSkipUpload(compactSnapshots, options)` after compact validation. Return `{ ok: true, status: 'unchanged', skippedUpload: true }` when it returns true. After `apiPost` succeeds, call `rememberUploadedSnapshots(compactSnapshots)` before invalidating the GET cache.

Pass `{ manual }` from `ensureFreshSnapshot` and `{ manual: true }` from `uploadPendingSnapshot`. When `ensureFreshSnapshot` receives `skippedUpload`, clear the local bundle and return the already loaded `latest` response without issuing the two post-upload fresh GETs.

- [ ] **Step 5: Send explicit revalidation for fresh GETs**

In `apiGet`, build headers as follows:

```js
const headers = { accept: 'application/json' };
if (fresh) headers['cache-control'] = 'no-cache';
const response = await fetch(apiUrl(path), {
  method: 'GET',
  credentials: 'same-origin',
  cache: options.cache || 'default',
  headers
});
```

- [ ] **Step 6: Run the focused client tests**

Run: `node --test test/rankings-view.test.js`

Expected: PASS with all existing view assertions and the two new tests.

- [ ] **Step 7: Commit the client upload gate**

```bash
git add site/rankings.js test/rankings-view.test.js
git commit -m "perf: skip duplicate automatic ranking uploads"
```

### Task 4: Run the complete verification suite

**Files:**
- Modify: none
- Test: all existing tests and generated build output

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: `135+` tests pass, 0 failures, 0 skipped. The exact total may increase by the new cache, metadata and client assertions.

- [ ] **Step 2: Build the deployable static assets**

Run: `npm run build`

Expected: exit code 0 and `dist/` contains the updated `rankings.js`, `index.html`, and Worker-served assets.

- [ ] **Step 3: Check syntax and whitespace**

Run: `node --check src/index.js && node --check src/rankings-cache.js && node --check src/rankings-worker.js && git diff --check`

Expected: all commands exit 0 with no whitespace errors.

- [ ] **Step 4: Review the final diff and status**

Run: `git diff main...HEAD --stat && git status --short`

Expected: only the design/plan documents, cache wrapper, metadata gate, client gate and their tests/build-related tracked changes are present; no migrations, deletion scripts, remote database commands, or deployment changes were executed.

- [ ] **Step 5: Commit any final documentation-only correction if required**

If the prior checks identify only a documentation mismatch, fix it and run `git diff --check` again before committing:

```bash
git add docs/superpowers/plans/2026-08-26-card-rankings-upload-cache-optimization.md
git commit -m "docs: refine rankings upload cache plan"
```

