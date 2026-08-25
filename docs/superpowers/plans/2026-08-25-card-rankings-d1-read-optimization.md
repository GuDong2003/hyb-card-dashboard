# Card 榜单 D1 读放大优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Card 榜单的历史读取改为按日物化、上传改为无整表读取的 SQL upsert，并补齐历史分页、缓存、限流和每日 Cron 聚合，降低 D1 rows read。

**Architecture:** 保留 `rank_snapshots`/`rank_entries` 原始只增数据；新增 `rank_daily_metrics`，由北京时间每天 04:05 的 scheduled handler 聚合前一完整北京日。`rank_user_metrics` 由上传中的单行 `ON CONFLICT` upsert 维护，GET 历史默认读取日聚合，只有 `mode=snapshot` 才读取限定窗口的原始明细。Worker GET 使用短 TTL，POST 和错误保持 `no-store`。

**Tech Stack:** Cloudflare Workers、D1/SQLite、Wrangler Cron/Rate Limiting binding、原生 Node test runner、浏览器端原生 Fetch。

---

## 文件结构

- Create: `migrations/0004_rank_daily_metrics.sql` — 日聚合表及实际访问路径索引。
- Create: `src/rankings-daily.js` — 北京日边界、日代表行查询、幂等 upsert、scheduled 聚合入口。
- Create: `scripts/backfill-rank-daily.mjs` — 按北京日调用 Wrangler D1 execute 的历史回填工具，不触碰原始表。
- Create: `scripts/check-rankings-signatures.mjs` — 建唯一索引前只读检查现有重复签名。
- Modify: `src/index.js` — 注册 `scheduled` handler。
- Modify: `src/rankings-worker.js` — 上传前拦截、无整表 metrics upsert、日聚合查询、history 分页、events/users 查询、缓存响应。
- Modify: `site/rankings.js` — GET 缓存策略、主动刷新 revalidation、趋势历史懒加载和分页。
- Modify: `wrangler.jsonc` — Cron 与 `RANKINGS_WRITE_LIMITER` 配置。
- Modify: `test/rankings-worker.test.js` — 更新 Fake D1，覆盖新 SQL 路径和 API 行为。
- Create: `test/rankings-daily.test.js` — 日边界、代表行、重复聚合和 SQL 读取列契约。
- Modify: `test/rankings-view.test.js` — Dashboard 启动不读 history、history 请求参数和缓存契约。
- Modify: `docs/rankings-operations.md` — migration、backfill、Cron、缓存和 D1 验收说明。

## Task 1: Add the daily aggregate schema and pure aggregation boundary

**Files:**
- Create: `migrations/0004_rank_daily_metrics.sql`
- Create: `src/rankings-daily.js`
- Create: `test/rankings-daily.test.js`

- [ ] **Step 1: Write failing tests for Beijing-day selection and idempotent aggregation.**

Add tests that use a small fake D1 and assert:

```js
test('maps captures to a Beijing day starting at 04:00', () => {
  assert.equal(dayStartAtForCapturedAt(Date.parse('2026-08-25T03:59:59+08:00')), Date.parse('2026-08-24T04:00:00+08:00'));
  assert.equal(dayStartAtForCapturedAt(Date.parse('2026-08-25T04:00:00+08:00')), Date.parse('2026-08-25T04:00:00+08:00'));
});

test('aggregateRankingsDay writes one representative per season/day/user/board and can repeat', async () => {
  const db = fakeDailyDb([
    snapshot(1, 's1', Date.parse('2026-08-24T05:00:00+08:00'), 10),
    snapshot(2, 's1', Date.parse('2026-08-24T06:00:00+08:00'), 11)
  ], [
    entry(1, 'epic_total', 'u1', 10, 2),
    entry(2, 'epic_total', 'u1', 12, 1)
  ]);
  const day = Date.parse('2026-08-24T04:00:00+08:00');
  await aggregateRankingsDay(db, day);
  await aggregateRankingsDay(db, day);
  assert.equal(db.daily.length, 1);
  assert.equal(db.daily[0].value, 12);
  assert.equal(db.daily[0].snapshot_id, 2);
});

test('daily aggregation SQL never selects raw_json and is bounded to one day', async () => {
  const db = fakeDailyDb();
  await aggregateRankingsDay(db, Date.parse('2026-08-24T04:00:00+08:00'));
  assert.doesNotMatch(db.queries[0].sql, /raw_json/);
  assert.match(db.queries[0].sql, /captured_at\s*>=\s*\?/);
  assert.match(db.queries[0].sql, /captured_at\s*<\s*\?/);
});
```

Run: `node --test test/rankings-daily.test.js`

Expected: FAIL because `src/rankings-daily.js` does not exist.

- [ ] **Step 2: Implement the daily module with the minimal bounded query and upsert.**

Export the following functions and constants:

```js
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RESET_HOUR_MS = 4 * 60 * 60 * 1000;

export function dayStartAtForCapturedAt(capturedAt) {
  const value = Number(capturedAt);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor((value - RESET_HOUR_MS) / DAY_MS) * DAY_MS + RESET_HOUR_MS;
}

export async function aggregateRankingsDay(db, dayStartAt) {
  const dayEndAt = Number(dayStartAt) + DAY_MS;
  const result = await db.prepare(`
    WITH candidates AS (
      SELECT s.season_id, s.id AS snapshot_id,
        CAST((s.captured_at - ${RESET_HOUR_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${RESET_HOUR_MS} AS day_start_at,
        e.board_key, e.user_id, e.user_name, e.avatar_url, e.value, e.rank,
        e.is_vip, e.active_name_decoration, e.name_display_preference,
        s.scope, s.captured_at
      FROM rank_entries e
      JOIN rank_snapshots s ON s.id = e.snapshot_id
      WHERE s.captured_at >= ? AND s.captured_at < ?
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY season_id, day_start_at, user_id, board_key
          ORDER BY captured_at DESC, value DESC, snapshot_id DESC, rank ASC
        ) AS day_order
      FROM candidates
    )
    SELECT season_id, day_start_at, user_id, board_key, user_name, avatar_url,
      value, rank, is_vip, active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at
    FROM ranked
    WHERE day_order = 1
  `).bind(Number(dayStartAt), dayEndAt).all();

  const rows = result.results || [];
  for (const chunk of chunks(rows, 50)) {
    await db.batch(chunk.map((row) => db.prepare(`
      INSERT INTO rank_daily_metrics (
        season_id, day_start_at, user_id, board_key, user_name, avatar_url,
        value, rank, is_vip, active_name_decoration, name_display_preference,
        snapshot_id, scope, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (season_id, day_start_at, user_id, board_key) DO UPDATE SET
        user_name = excluded.user_name,
        avatar_url = excluded.avatar_url,
        value = excluded.value,
        rank = excluded.rank,
        is_vip = excluded.is_vip,
        active_name_decoration = excluded.active_name_decoration,
        name_display_preference = excluded.name_display_preference,
        snapshot_id = excluded.snapshot_id,
        scope = excluded.scope,
        captured_at = excluded.captured_at
    `).bind(
      row.season_id, row.day_start_at, row.user_id, row.board_key,
      row.user_name, row.avatar_url, row.value, row.rank, row.is_vip,
      row.active_name_decoration, row.name_display_preference,
      row.snapshot_id, row.scope, row.captured_at
    )));
  }
  return { dayStartAt: Number(dayStartAt), dayEndAt, rows: rows.length };
}
```

Keep `chunks()` local to this module. The query must not select `raw_json`, and all calls must bind an exact `[dayStartAt, dayStartAt + DAY_MS)` interval.

Run: `node --test test/rankings-daily.test.js`

Expected: PASS.

- [ ] **Step 3: Add the migration and verify its SQL contract.**

Add `accepted INTEGER NOT NULL DEFAULT 1` to `rank_snapshots`, then create `rank_daily_metrics` with the composite primary key from the design. Add indexes for `(season_id, board_key, day_start_at, rank)` and `(season_id, user_id, board_key, day_start_at)`, plus `(accepted, captured_at DESC, id DESC)`, the other snapshot/latest/user lookup indexes, and the unique `(season_id, signature)` index. All read and aggregation SQL must filter `accepted = 1`. Do not add any delete, retention, or cleanup statement.

The migration must not silently repair duplicate signatures. Before applying it remotely, run the read-only check from Task 4; if it reports rows, stop and preserve the migration failure for manual review.

Run: `git diff --check && node --test test/rankings-daily.test.js`

Expected: PASS; `rg -n "DELETE|DROP TABLE|90" migrations/0004_rank_daily_metrics.sql` returns no matches.

- [ ] **Step 4: Commit the schema and aggregation boundary.**

```bash
git add migrations/0004_rank_daily_metrics.sql src/rankings-daily.js test/rankings-daily.test.js
git commit -m "feat: add daily rankings aggregation"
```

## Task 2: Remove upload read amplification and add write protection

**Files:**
- Modify: `src/rankings-worker.js:86-340`
- Modify: `src/rankings-merge.js` only if shared normalization is needed
- Modify: `test/rankings-worker.test.js`
- Modify: `wrangler.jsonc`

- [ ] **Step 1: Add failing tests for pre-insert stale/duplicate handling, SQL upsert, and rate limiting.**

Extend the Fake D1 so it records inserted snapshot rows and supports `meta.changes`. Add tests with these assertions:

```js
const snapshotAt = (capturedAt) => ({
  season: { id: 'season-write-test', name: '写入测试' },
  scope: 'global',
  capturedAt,
  leaderboards: {
    epic_total: [{ userId: 'u1', userName: '用户一', value: 10, rank: 1, isVip: false }]
  }
});
const postSnapshot = (environment, body) => handleRankingsRequest(request('/api/rankings/snapshots', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
}), environment);

test('rejects stale snapshots before INSERT and leaves raw tables unchanged', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(10_000));
  const before = environment.RANKINGS_DB.snapshots.length;
  const response = await postSnapshot(environment, snapshotAt(9_000));
  assert.equal((await response.json()).status, 'rejected');
  assert.equal(environment.RANKINGS_DB.snapshots.length, before);
});

test('does not select the whole rank_user_metrics table during upload', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(10_000));
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /select \* from rank_user_metrics/.test(sql)), false);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /insert into rank_user_metrics/.test(sql)), true);
});

test('returns 429 before parsing or writing when the limiter rejects the source', async () => {
  const environment = env({ RANKINGS_WRITE_LIMITER: { limit: async () => true } });
  const response = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: '{'
  }), environment);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'rate_limited');
});
```

Run: `node --test test/rankings-worker.test.js`

Expected: FAIL because stale rows are currently inserted, upload reads all metrics, and no limiter path exists.

- [ ] **Step 2: Add the rate-limit binding and check it before `request.json()`.**

In `postSnapshot()` call `limitSnapshotWrites(request, env)` before parsing JSON:

```js
async function limitSnapshotWrites(request, env) {
  const limiter = env.RANKINGS_WRITE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const key = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'anonymous';
  const result = await limiter.limit({ key: String(key).slice(0, 128) });
  return result && result.success === false
    ? jsonResponse({ ok: false, error: 'rate_limited', retryable: true }, 429, { 'retry-after': '60' })
    : null;
}
```

Return the non-null response immediately. Add `ratelimits` to `wrangler.jsonc` with `RANKINGS_WRITE_LIMITER`, namespace `1001`, and simple limit 10/period 60. Local tests without this binding continue to work; production configuration carries the binding.

- [ ] **Step 3: Move stale checks before INSERT and make signature uniqueness race-safe.**

In `storeNormalizedSnapshot()` retain the signature query, add a latest-same-scope query:

```sql
SELECT id, captured_at
FROM rank_snapshots
WHERE season_id = ? AND scope = ?
ORDER BY captured_at DESC, id DESC
LIMIT 1
```

Return `{ stale: true }` when `latest && normalized.capturedAt <= latest.captured_at`. Change the INSERT to `ON CONFLICT (season_id, signature) DO NOTHING`; treat `meta.changes === 0` as `{ duplicate: true }`. Count stale snapshots in `postSnapshot()` and return `status: 'rejected'`, `reason: 'stale_or_existing_data'` when no snapshot was stored because of staleness. Keep duplicate responses backward-compatible.

- [ ] **Step 4: Replace `mergeSnapshotMetrics()` with per-entry SQL upserts.**

Delete the `SELECT * FROM rank_user_metrics WHERE season_id = ?` path. For every normalized entry issue an upsert with the existing metric semantics:

```sql
INSERT INTO rank_user_metrics (
  season_id, user_id, board_key, user_name, avatar_url, value, rank,
  is_vip, active_name_decoration, name_display_preference,
  value_snapshot_id, value_scope, value_captured_at,
  last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (season_id, user_id, board_key) DO UPDATE SET
  value = CASE WHEN ${valueReplacementSql} THEN excluded.value ELSE rank_user_metrics.value END,
  value_snapshot_id = CASE WHEN ${valueReplacementSql} THEN excluded.value_snapshot_id ELSE rank_user_metrics.value_snapshot_id END,
  value_scope = CASE WHEN ${valueReplacementSql} THEN excluded.value_scope ELSE rank_user_metrics.value_scope END,
  value_captured_at = CASE WHEN ${valueReplacementSql} THEN excluded.value_captured_at ELSE rank_user_metrics.value_captured_at END,
  user_name = CASE WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at AND excluded.user_name <> '' THEN excluded.user_name ELSE rank_user_metrics.user_name END,
  avatar_url = CASE WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at AND excluded.avatar_url <> '' THEN excluded.avatar_url ELSE rank_user_metrics.avatar_url END,
  is_vip = MAX(rank_user_metrics.is_vip, excluded.is_vip),
  first_captured_at = MIN(rank_user_metrics.first_captured_at, excluded.first_captured_at),
  last_snapshot_id = CASE WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at THEN excluded.last_snapshot_id ELSE rank_user_metrics.last_snapshot_id END,
  last_scope = CASE WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at THEN excluded.last_scope ELSE rank_user_metrics.last_scope END,
  last_captured_at = MAX(rank_user_metrics.last_captured_at, excluded.last_captured_at),
  source_scopes = CASE
    WHEN (
      instr(',' || rank_user_metrics.source_scopes || ',', ',global,') > 0
      OR instr(',' || excluded.source_scopes || ',', ',global,') > 0
    ) AND (
      instr(',' || rank_user_metrics.source_scopes || ',', ',friends,') > 0
      OR instr(',' || excluded.source_scopes || ',', ',friends,') > 0
    ) THEN 'global,friends'
    WHEN rank_user_metrics.source_scopes <> '' THEN rank_user_metrics.source_scopes
    ELSE excluded.source_scopes
  END
```

Build the SQL in JavaScript with this exact predicate before interpolating it three times:

```js
const valueReplacementSql = `(
  (excluded.board_key LIKE '%_total' AND (
    excluded.value > rank_user_metrics.value
    OR (excluded.value = rank_user_metrics.value
      AND excluded.value_captured_at >= rank_user_metrics.value_captured_at)
  ))
  OR (excluded.board_key NOT LIKE '%_total' AND (
    excluded.value_captured_at > rank_user_metrics.value_captured_at
    OR (excluded.value_captured_at = rank_user_metrics.value_captured_at
      AND excluded.value >= rank_user_metrics.value)
  ))
)`;
```

SQLite therefore receives a concrete `CASE` expression for `source_scopes`, returning `global,friends` when both have been observed and otherwise preserving the existing non-empty scope. Do not issue a read before this upsert.

- [ ] **Step 5: Run upload tests and commit.**

Run: `node --test test/rankings-worker.test.js`

Expected: PASS, including existing duplicate, cross-scope merge, partial upload, and metric semantics tests.

```bash
git add src/rankings-worker.js wrangler.jsonc test/rankings-worker.test.js
git commit -m "feat: protect and streamline rankings uploads"
```

## Task 3: Switch user summaries and history to bounded daily reads

**Files:**
- Modify: `src/rankings-worker.js:404-1057`
- Modify: `test/rankings-worker.test.js`

- [ ] **Step 1: Add failing tests for daily metrics, history parameters, and keyset cursors.**

Replace assertions that look for `WITH daily_rows` over `rank_entries` with assertions that the user leaderboard reads `rank_daily_metrics` and at most one bounded current-day raw query. Add:

```js
test('daily user metrics use the materialized table and only bounded current-day raw rows', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(Date.now() - 1000));
  await handleRankingsRequest(request('/api/rankings/leaderboard?board=users&period=total'), environment);
  const queries = environment.RANKINGS_DB.queries;
  assert.ok(queries.some(({ sql }) => sql.includes('from rank_daily_metrics')));
  assert.equal(queries.some(({ sql }) => sql.includes('with daily_rows')), false);
  const currentTail = queries.find(({ sql }) => sql.includes('from rank_entries e') && sql.includes('captured_at >= ?') && sql.includes('captured_at < ?'));
  assert.ok(currentTail);
});

test('history defaults to 30 days and returns a stable next cursor', async () => {
  const environment = env();
  const response = await handleRankingsRequest(request('/api/rankings/history?userId=u1&limit=1'), environment);
  const payload = await response.json();
  assert.equal(payload.mode, 'daily');
  assert.equal(payload.limit, 1);
  assert.equal(payload.hasMore, true);
  assert.ok(payload.nextCursor);
});

test('snapshot history is opt-in and always has a bounded captured_at predicate', async () => {
  const environment = env();
  const response = await handleRankingsRequest(request('/api/rankings/history?userId=u1&mode=snapshot&since=1&until=2'), environment);
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('from rank_entries e') && sql.includes('captured_at >= ?'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /select e\.\*,/);
});
```

Run: `node --test test/rankings-worker.test.js`

Expected: FAIL because `dailyMetricsForPeriod()` scans raw history and `getHistory()` has no pagination/mode.

- [ ] **Step 2: Add shared time, limit, and cursor parsing helpers.**

Implement `parseHistoryTimestamp()`, `normalizeHistoryLimit()`, `encodeHistoryCursor()`, and `decodeHistoryCursor()`. Use Unix milliseconds or `Date.parse`; reject malformed values with 400. Default `until` to `latest.captured_at`, default `since` to `until - 30 * DAY_MS`, clamp `until` to latest capture, and cap limit at 500 (default 200). Cursor payloads must include `mode` and the ordered key fields; reject a cursor for another mode.

- [ ] **Step 3: Implement materialized daily reads plus a current-day tail.**

Create `dailyMetricsFromTable()` selecting only the fourteen aggregate columns, with `season_id`, `user_id`, board keys, and `[since, until]` predicates. Create `currentDayMetrics()` with a CTE and `ROW_NUMBER()` over `user_id, board_key`, restricted to `currentDayStartAt <= captured_at < currentDayStartAt + DAY_MS`, and select no `raw_json`.

Refactor `dailyMetricsForPeriod()` to:

1. Read closed days from `rank_daily_metrics`.
2. Read the current-day tail only when the period contains the current Beijing day.
3. Return the concatenated rows in the same raw-row shape consumed by `collectDailyUsers()`.

Preserve the existing complete-day pairing and total metric semantics.

- [ ] **Step 4: Implement `getHistory()` daily/snapshot modes with keyset pagination.**

For `mode=daily`, read `rank_daily_metrics` by user, board, day range and cursor, then append the bounded current-day row(s), sort by `(dayStartAt, capturedAt, snapshotId, boardKey)`, return `limit` rows plus `nextCursor`/`hasMore`. For `mode=snapshot`, use a CTE over `rank_entries JOIN rank_snapshots`, partition by `board_key,captured_bucket` to preserve `dedupeHistoryRows()` semantics, apply `since/until` and cursor before `LIMIT limit + 1`, and select only history columns.

The response must retain `season`, `elapsedDays`, `rows`, and `events`, while adding `mode`, `since`, `until`, `limit`, `nextCursor`, and `hasMore`. Return an empty paginated shape when no latest snapshot exists.

- [ ] **Step 5: Bound `getUsers()` and replace the events full-season loop.**

Use SQL `LIKE ? COLLATE NOCASE` predicates and `GROUP BY user_id` with `LIMIT 20` in `getUsers()`. For `getEvents()`, default to the latest seven days, read `rank_daily_metrics` for `${board}_total`, group by day in Worker, compare adjacent day maps with `diffBoardRows()`, and cap at `MAX_EVENT_ROWS`. Do not query every adjacent raw snapshot in the default path.

- [ ] **Step 6: Run the worker suite and commit the bounded read path.**

Run: `node --test test/rankings-worker.test.js`

Expected: PASS; no query recorded by the Fake D1 contains an unbounded `WITH daily_rows` or `SELECT * FROM rank_user_metrics`.

```bash
git add src/rankings-worker.js test/rankings-worker.test.js
git commit -m "feat: read rankings history from daily aggregates"
```

## Task 4: Add Worker caching and scheduled/backfill operations

**Files:**
- Modify: `src/index.js`
- Modify: `src/rankings-worker.js`
- Modify: `wrangler.jsonc`
- Create: `scripts/backfill-rank-daily.mjs`
- Create: `scripts/check-rankings-signatures.mjs`
- Modify: `test/rankings-daily.test.js`
- Modify: `docs/rankings-operations.md`

- [ ] **Step 1: Add failing tests for cache headers and scheduled target day.**

Assert that:

```js
assert.match((await latestResponse.headers.get('cache-control')), /public, max-age=15/);
assert.match((await leaderboardResponse.headers.get('cache-control')), /public, max-age=30/);
assert.equal((await postResponse.headers.get('cache-control')), 'no-store');
assert.equal(previousBeijingDayStart(Date.parse('2026-08-25T05:00:00+08:00')), Date.parse('2026-08-24T04:00:00+08:00'));
```

Run: `node --test test/rankings-worker.test.js test/rankings-daily.test.js`

Expected: FAIL because all JSON responses currently use `no-store` and no scheduled function exists.

- [ ] **Step 2: Implement response cache policy.**

Keep `jsonResponse()` defaulting to `cache-control: no-store`. Pass these headers from successful GET handlers:

```js
const CACHE_HEADERS = {
  latest: { 'cache-control': 'public, max-age=15, stale-while-revalidate=30' },
  leaderboard: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
  history: { 'cache-control': 'public, max-age=60, stale-while-revalidate=120' },
  users: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
  events: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' }
};
```

Never attach public caching headers to 4xx/5xx or POST responses.

- [ ] **Step 3: Register the daily Cron and run the previous Beijing day.**

In `src/index.js` add:

```js
import { aggregateRankingsDay, previousBeijingDayStart } from './rankings-daily.js';

async scheduled(controller, env) {
  const dayStartAt = previousBeijingDayStart(Date.now());
  const result = await aggregateRankingsDay(env.RANKINGS_DB, dayStartAt);
  console.log('rankings_daily_aggregated', result);
}
```

Use `"triggers": { "crons": ["5 20 * * *"] }` in `wrangler.jsonc` (UTC 20:05 is Beijing 04:05). A repeat run uses the same primary key upsert and never deletes raw data.

- [ ] **Step 4: Add the explicit historical backfill script.**

Implement `scripts/backfill-rank-daily.mjs` with required `--from` and `--until` arguments, parse ISO or Unix milliseconds, iterate `[fromDay, untilDay)` one Beijing day at a time, and invoke:

```js
spawn('npx', [
  'wrangler', 'd1', 'execute', 'hyb-card-rankings-db', '--remote',
  `--command=${buildBackfillSql(dayStartAt)}`
], { stdio: 'inherit' });
```

`buildBackfillSql()` must use the same bounded `WITH candidates/ranked` SQL and daily upsert as `src/rankings-daily.js`; it must not contain `DELETE`, `DROP`, or `raw_json`. The script must refuse a missing range rather than defaulting to an entire database.

- [ ] **Step 5: Add the pre-migration duplicate-signature check.**

Implement `scripts/check-rankings-signatures.mjs` as a read-only Wrangler invocation with no default database mutation:

```js
const sql = `
  SELECT season_id, signature, COUNT(*) AS duplicate_count,
    GROUP_CONCAT(id) AS snapshot_ids
  FROM rank_snapshots
  GROUP BY season_id, signature
  HAVING COUNT(*) > 1
  ORDER BY duplicate_count DESC, season_id, signature
`;
```

Require an explicit `--remote` or `--local` argument, run `npx wrangler d1 execute hyb-card-rankings-db` with `--command=${sql}`, print the result, and exit with status 1 when any duplicate group exists. Do not delete or update rows.

- [ ] **Step 6: Update operations documentation and commit.**

Document migration application, duplicate-signature precheck, first-time backfill, Cron time zone, no-cleanup guarantee, cache TTLs, and D1 Analytics checks in `docs/rankings-operations.md`.

Run: `node --test test/rankings-worker.test.js test/rankings-daily.test.js && git diff --check`

Expected: PASS.

```bash
git add src/index.js src/rankings-worker.js wrangler.jsonc scripts/backfill-rank-daily.mjs scripts/check-rankings-signatures.mjs test/rankings-daily.test.js docs/rankings-operations.md
git commit -m "feat: schedule and cache rankings aggregates"
```

## Task 5: Make the browser history truly lazy and cache-aware

**Files:**
- Modify: `site/rankings.js`
- Modify: `test/rankings-view.test.js`

- [ ] **Step 1: Add failing source-contract tests.**

Add assertions that `apiGet()` does not set `cache: 'no-store'` by default, that `loadLatestSnapshot({ fresh: true })` passes `cache: 'reload'`, and that `refreshTrendHistories()` creates a URL containing `mode=daily`, `since=`, `until=`, `limit=`, and optional `cursor=`. Also assert that `loadRankingsView()` does not call history when `selectedIds` is non-empty unless the trend modal is open.

Run: `node --test test/rankings-view.test.js`

Expected: FAIL because the current client always uses `no-store` and refreshes selected trend histories during normal leaderboard loading.

- [ ] **Step 2: Make GET caching opt-in to revalidation, not opt-out to all caching.**

Change the client helper to:

```js
async function apiGet(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    method: 'GET',
    credentials: 'same-origin',
    cache: options.cache || 'default',
    headers: { accept: 'application/json' }
  });
  // retain the existing JSON/error handling
}
```

Use `{ cache: 'reload' }` for `loadLatestSnapshot()` and `loadLeaderboard()` immediately after a successful POST/manual refresh. Leave normal leaderboard reads on the browser default cache.

- [ ] **Step 3: Restrict history requests to the trend modal and page them.**

Track `state.trend.modalOpen`, `state.trend.histories` records with `nextCursor` and `hasMore`, and a daily history window derived from `state.trend.period` (total = latest 30 days by default, today/week/month = matching window). `openTrendModal()` sets `modalOpen = true` before fetching; `closeTrendModal()` sets it false. Remove unconditional `refreshTrendHistories()` calls from `loadRankingsView()` and upload refresh paths.

Build each request as:

```js
const params = new URLSearchParams({
  userId,
  mode: 'daily',
  since: String(historySince),
  until: String(historyUntil),
  limit: '200'
});
if (record.nextCursor) params.set('cursor', record.nextCursor);
const payload = await apiGet(`/api/rankings/history?${params}`);
```

On first load replace rows; on `loadMore` append rows and update `nextCursor`. The chart continues to consume the same `rows` field, so no full-season client aggregation is required for daily mode.

- [ ] **Step 4: Run front-end tests and commit.**

Run: `node --test test/rankings-view.test.js`

Expected: PASS; the initial Dashboard request set contains no `/api/rankings/history` URL, while opening a trend modal does.

```bash
git add site/rankings.js test/rankings-view.test.js
git commit -m "feat: lazy-load and cache rankings history"
```

## Task 6: Full verification and handoff

**Files:** No new source files; verify all changed files.

- [ ] **Step 1: Run the complete test suite.**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Build static assets and inspect the generated diff.**

Run: `npm run build && git status --short && git diff --check`

Expected: build succeeds; generated `dist/` remains ignored/untracked according to repository conventions; no whitespace errors.

- [ ] **Step 3: Run focused SQL contract scans.**

Run:

```bash
rg -n "SELECT \* FROM rank_user_metrics|WITH daily_rows|DELETE FROM|DROP TABLE|raw_json" src migrations scripts
```

Expected: no production read path contains the removed whole-table metrics query or unbounded daily scan; `raw_json` remains only in raw snapshot storage paths, never in daily aggregation SELECTs; no cleanup SQL is introduced.

- [ ] **Step 4: Review the final diff and report deployment prerequisites.**

Verify `git diff HEAD~6..HEAD --stat`, migration order, Cron expression, Rate Limiting binding name, API compatibility, and that no remote D1 migration/deploy/backfill command was executed without explicit deployment authorization. Report the local commit list, test/build results, and the exact remote steps the user must approve separately.
