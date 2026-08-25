# Card 榜单用户级增量存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Card 榜单从“每次保存完整快照”切换为“用户当前表 + 用户每日一行”的服务端增量 upsert，并让 Dashboard 只请求当前页或单个用户历史。

**Architecture:** 新 D1 只包含 `rank_seasons`、`rank_user_current` 和 `rank_user_days`。油猴脚本继续从 CDK 获取当前全量前 100/好友结果；Dashboard 在 POST 前移除 `raw` 字段，Worker 按用户和北京时间日合并输入，使用字段级条件 upsert，不保存快照、明细或 fingerprint。读取 API 使用 SQL keyset 分页，历史只读取一个用户的日行，GET 使用浏览器和 Worker 短缓存。

**Tech Stack:** Cloudflare Workers、D1/SQLite、Wrangler 4、原生 Node test runner、浏览器 Fetch/localStorage、现有 `rankings-core.js` 估算逻辑。

---

## 文件结构与职责

- Create: `migrations-v2/0001_compact_rankings.sql` — 新 D1 的唯一初始 schema；不复用会创建旧快照表的 `migrations/0001-0005`。
- Create: `src/rankings-user-store.js` — 12 个榜单字段的列映射、用户行合并、D1 upsert SQL、当前页/单用户日行查询和序列化。
- Create: `test/rankings-user-store.test.js` — 纯用户合并、字段时间、累计/周期值选择、SQL 不读 raw 的测试。
- Modify: `src/rankings-worker.js` — 删除旧快照写入和旧表读取路径，改接 compact store；保留 API 路径和响应兼容字段。
- Modify: `src/index.js` — Cron 改为 compact 表的赛季元数据和派生排序维护，不再调用旧 `rank_daily_metrics` 聚合。
- Modify: `site/rankings.js` — POST 前只保留规范化观察字段；当前榜单改为服务端分页；用户搜索和趋势按需读取；增加短时浏览器缓存。
- Modify: `site/index.html` — 移除“实际抓取”历史模式和“全部”分页选项，保留按日历史、上一页/下一页和当前用户搜索。
- Modify: `test/rankings-worker.test.js` — 用 compact fake D1 替换旧 raw fake D1，覆盖上传幂等、当前页、cursor、单用户历史和 no raw 查询。
- Modify: `test/rankings-view.test.js` — 覆盖服务端分页、按需 history、上传去 raw、浏览器缓存和按日趋势。
- Modify: `test/rankings-daily.test.js` — 改测新的 scheduled maintenance；旧 `aggregateRankingsDay` 仍可由旧库迁移脚本单独使用，不再由 Worker Cron 调用。
- Create: `scripts/backup-card-rankings.mjs` — 导出旧 D1、保存 metadata、gzip 和 SHA-256 manifest；只读，不删除旧数据。
- Create: `scripts/migrate-card-rankings-compact.mjs` — 按北京日从旧库的 daily/raw 必要列迁入新库，并把旧 `rank_user_metrics` 转换为 current；支持单日重跑。
- Create: `scripts/verify-card-rankings-compact.mjs` — 比较旧/新库的日数、用户数、当前字段和指定用户样本。
- Modify: `test/rankings-operations.test.js` — 覆盖 backup/migration 参数、SQL 无 raw、无 delete/drop 和单日范围。
- Modify: `docs/rankings-operations.md` — 更新备份、新库 schema、回填、切换、缓存和回滚命令。
- Modify: `.gitignore` — 忽略仓库外/本地 `backups/` 目录，避免把 D1 导出提交到 Git。
- Modify: `wrangler.jsonc` — 远程验证通过后才替换 `RANKINGS_DB.database_id` 为新库 ID；Cron 保留 UTC `20:05`。

## Task 1: Define compact schema and user-row merge contract

**Files:**
- Create: `migrations-v2/0001_compact_rankings.sql`
- Create: `src/rankings-user-store.js`
- Create: `test/rankings-user-store.test.js`

- [ ] **Step 1: Write failing tests for one user/day row and per-board timestamps.**

在 `test/rankings-user-store.test.js` 建立规范化输入，并测试下列具体行为：

```js
test('merges global and friends observations into one user-day record', () => {
  const rows = mergeUserObservations([
    normalizedSnapshot('global', 10_000, [
      entry('epic_total', 'u1', 10, 2),
      entry('spend_total', 'u1', 500_000, 3)
    ]),
    normalizedSnapshot('friends', 11_000, [
      entry('epic_total', 'u1', 12, 1),
      entry('sets_today', 'u1', 4, 8)
    ])
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'u1');
  assert.equal(rows[0].epic_total_value, 12);
  assert.equal(rows[0].epic_total_rank, 1);
  assert.equal(rows[0].spend_total_value, 500_000);
  assert.equal(rows[0].sets_today_value, 4);
  assert.equal(rows[0].source_scopes, 'global,friends');
  assert.equal(rows[0].epic_total_observed_at, 11_000);
});

test('same-day repeated values are marked unchanged without using captured time alone', () => {
  const existing = compactRow({ epic_total_value: 12, epic_total_rank: 1, epic_total_observed_at: 10_000 });
  const incoming = compactRow({ epic_total_value: 12, epic_total_rank: 1, epic_total_observed_at: 11_000 });
  assert.equal(hasMeaningfulUserChange(existing, incoming), false);
});

test('cumulative value keeps the maximum while rank uses the newer observation', () => {
  const merged = mergeMetricField({ value: 10, rank: 4, observedAt: 10_000 },
    { value: 12, rank: 2, observedAt: 11_000 }, true);
  assert.deepEqual(merged, { value: 12, rank: 2, observedAt: 11_000 });
});

test('period value rejects an older observation', () => {
  const merged = mergeMetricField({ value: 20, rank: 3, observedAt: 12_000 },
    { value: 18, rank: 1, observedAt: 11_000 }, false);
  assert.deepEqual(merged, { value: 20, rank: 3, observedAt: 12_000 });
});
```

运行：`node --test test/rankings-user-store.test.js`。

预期：FAIL，因为 compact store 尚未存在。

- [ ] **Step 2: Add the explicit compact schema.**

在 `migrations-v2/0001_compact_rankings.sql` 创建三张表：

```sql
CREATE TABLE IF NOT EXISTS rank_seasons (
  season_id TEXT PRIMARY KEY,
  season_name TEXT NOT NULL,
  last_observed_at INTEGER NOT NULL,
  last_day_start_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rank_user_days (
  season_id TEXT NOT NULL,
  day_start_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  observed_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',
  sets_total_value INTEGER, sets_total_rank INTEGER, sets_total_observed_at INTEGER,
  sets_month_value INTEGER, sets_month_rank INTEGER, sets_month_observed_at INTEGER,
  sets_week_value INTEGER, sets_week_rank INTEGER, sets_week_observed_at INTEGER,
  sets_today_value INTEGER, sets_today_rank INTEGER, sets_today_observed_at INTEGER,
  epic_total_value INTEGER, epic_total_rank INTEGER, epic_total_observed_at INTEGER,
  epic_month_value INTEGER, epic_month_rank INTEGER, epic_month_observed_at INTEGER,
  epic_week_value INTEGER, epic_week_rank INTEGER, epic_week_observed_at INTEGER,
  epic_today_value INTEGER, epic_today_rank INTEGER, epic_today_observed_at INTEGER,
  spend_total_value INTEGER, spend_total_rank INTEGER, spend_total_observed_at INTEGER,
  spend_month_value INTEGER, spend_month_rank INTEGER, spend_month_observed_at INTEGER,
  spend_week_value INTEGER, spend_week_rank INTEGER, spend_week_observed_at INTEGER,
  spend_today_value INTEGER, spend_today_rank INTEGER, spend_today_observed_at INTEGER,
  PRIMARY KEY (season_id, day_start_at, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_user_days_user_day
  ON rank_user_days (season_id, user_id, day_start_at);
CREATE INDEX IF NOT EXISTS idx_rank_user_days_day_user
  ON rank_user_days (season_id, day_start_at, user_id);

CREATE TABLE IF NOT EXISTS rank_user_current (
  season_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',
  sets_total_value INTEGER, sets_total_rank INTEGER, sets_total_observed_at INTEGER,
  sets_month_value INTEGER, sets_month_rank INTEGER, sets_month_observed_at INTEGER,
  sets_week_value INTEGER, sets_week_rank INTEGER, sets_week_observed_at INTEGER,
  sets_today_value INTEGER, sets_today_rank INTEGER, sets_today_observed_at INTEGER,
  epic_total_value INTEGER, epic_total_rank INTEGER, epic_total_observed_at INTEGER,
  epic_month_value INTEGER, epic_month_rank INTEGER, epic_month_observed_at INTEGER,
  epic_week_value INTEGER, epic_week_rank INTEGER, epic_week_observed_at INTEGER,
  epic_today_value INTEGER, epic_today_rank INTEGER, epic_today_observed_at INTEGER,
  spend_total_value INTEGER, spend_total_rank INTEGER, spend_total_observed_at INTEGER,
  spend_month_value INTEGER, spend_month_rank INTEGER, spend_month_observed_at INTEGER,
  spend_week_value INTEGER, spend_week_rank INTEGER, spend_week_observed_at INTEGER,
  spend_today_value INTEGER, spend_today_rank INTEGER, spend_today_observed_at INTEGER,
  sort_legend_value REAL,
  sort_spend_usd REAL,
  sort_estimated_pulls REAL,
  sort_exchange_count REAL,
  sort_probability REAL,
  PRIMARY KEY (season_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_user_current_last_user
  ON rank_user_current (season_id, last_observed_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_legend
  ON rank_user_current (season_id, sort_legend_value DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_spend
  ON rank_user_current (season_id, sort_spend_usd DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_pulls
  ON rank_user_current (season_id, sort_estimated_pulls DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_sets
  ON rank_user_current (season_id, sort_exchange_count DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_probability
  ON rank_user_current (season_id, sort_probability DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_name
  ON rank_user_current (season_id, user_name COLLATE NOCASE, user_id);
```

不在该文件中创建 `rank_snapshots`、`rank_entries`、`rank_user_metrics`、`rank_daily_metrics` 或任何 raw/fingerprint 表。

- [ ] **Step 3: Implement column mapping and pure merge helpers.**

在 `src/rankings-user-store.js` 导出以下稳定接口：

```js
export const COMPACT_BOARD_KEYS = Object.freeze([
  'sets_total', 'sets_month', 'sets_week', 'sets_today',
  'epic_total', 'epic_month', 'epic_week', 'epic_today',
  'spend_total', 'spend_month', 'spend_week', 'spend_today'
]);

export function mergeUserObservations(normalizedSnapshots) {}
export function mergeMetricField(existing, incoming, cumulative) {}
export function hasMeaningfulUserChange(existing, incoming) {}
export function compactHistoryRows(row, boardKey = '') {}
export function currentSortValues(row, capturedAt) {}
```

实现要求：

- 输入只取 `normalized.entries` 的规范化字段，永远不读取或传递 `entry.raw`。
- 以 `user_id` 分组；多个 scope 合并为稳定的 `global,friends` 顺序。
- 每个 board key 填入 `<board>_value`、`<board>_rank`、`<board>_observed_at`。
- `_total` value 取最大值，rank/资料取较新观测；其他 board key 按较新 `observed_at`，同时间按较大 value、较小 rank 决定。
- `hasMeaningfulUserChange` 忽略仅改变 `observed_at` 的重复提交，保证同一 payload 重放不会产生无意义更新。
- `currentSortValues` 复用 `estimatePullsFromSpend` 和 `estimateLegendProbability`，返回 `sort_legend_value`、`sort_spend_usd`、`sort_estimated_pulls`、`sort_exchange_count`、`sort_probability`。

- [ ] **Step 4: Run the focused tests and commit the schema/store contract.**

运行：`node --test test/rankings-user-store.test.js`。

预期：PASS。

提交：

```bash
git add migrations-v2/0001_compact_rankings.sql src/rankings-user-store.js test/rankings-user-store.test.js
git commit -m "feat: add compact user rankings schema"
```

## Task 2: Replace POST snapshot storage with server-side user upsert

**Files:**
- Modify: `src/rankings-worker.js`
- Modify: `src/rankings-user-store.js`
- Modify: `test/rankings-worker.test.js`
- Modify: `test/rankings-view.test.js`

- [ ] **Step 1: Replace raw fake D1 assertions with failing compact upload tests.**

将 worker fake D1 的可观察状态改为 `seasons`、`userDays`、`currentUsers` 和 `queries`，并新增这些测试：

```js
test('stores one user-day row without snapshots, entries, raw_json, or fingerprint', async () => {
  const environment = compactEnv();
  const first = await postSnapshot(environment, snapshotAt(10_000));
  const second = await postSnapshot(environment, snapshotAt(10_000));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(environment.RANKINGS_DB.userDays.length, 1);
  assert.equal(environment.RANKINGS_DB.currentUsers.length, 1);
  assert.equal(environment.RANKINGS_DB.userDays[0].raw_json, undefined);
  assert.equal(environment.RANKINGS_DB.userDays[0].fingerprint, undefined);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /rank_snapshots|rank_entries|raw_json|fingerprint/i.test(sql)), false);
});

test('updates only changed fields and preserves a single row on a new capture', async () => {
  const environment = compactEnv();
  await postSnapshot(environment, snapshotAt(10_000, { epic: 10, spend: 500_000 }));
  await postSnapshot(environment, snapshotAt(11_000, { epic: 12, spend: 500_000 }));
  assert.equal(environment.RANKINGS_DB.userDays.length, 1);
  assert.equal(environment.RANKINGS_DB.userDays[0].epic_total_value, 12);
  assert.equal(environment.RANKINGS_DB.userDays[0].spend_total_value, 500_000);
  assert.equal(environment.RANKINGS_DB.userDays[0].spend_total_observed_at, 10_000);
});

test('creates a second daily row only after the Beijing 04:00 boundary', async () => {
  const environment = compactEnv();
  await postSnapshot(environment, snapshotAt(Date.parse('2026-08-25T03:59:00+08:00')));
  await postSnapshot(environment, snapshotAt(Date.parse('2026-08-25T04:01:00+08:00')));
  assert.equal(environment.RANKINGS_DB.userDays.length, 2);
});
```

运行：`node --test test/rankings-worker.test.js`。

预期：FAIL，因为 `postSnapshot` 仍写入旧 raw 表。

- [ ] **Step 2: Implement compact batch upserts.**

在 `src/rankings-user-store.js` 增加：

```js
export async function storeUserObservations(db, normalizedSnapshots, source, now) {}
```

同时导出由 schema 列顺序生成的 `USER_DAY_UPSERT_SQL` 和 `USER_CURRENT_UPSERT_SQL`；两条 SQL 的 bind 顺序必须与 `rank_user_days` 和 `rank_user_current` 的列数组完全一致，并由测试用固定用户输入验证。

`storeUserObservations` 必须：

1. 调用 `mergeUserObservations`，以用户为单位而不是以 snapshot/entry 为单位分组。
2. 计算每个用户的 `day_start_at`，按 50 个用户一批调用 D1 `batch`。
3. 先 upsert `rank_user_days`，再 upsert `rank_user_current`，两者都使用同一个用户键和同一套字段时间规则。
4. `ON CONFLICT` 的更新子句带变化条件，只在 profile、scope、VIP、指标 value/rank 或有效观测字段发生变化时更新；只有时间变化不能触发更新。
5. `_total` 使用最大值，其他周期使用较新的字段；旧字段不被 null incoming 清空。
6. 更新 `rank_seasons` 的 `season_name/last_observed_at/last_day_start_at`，并用 `MAX`/`CASE` 防止旧请求回退最新时间。
7. 返回 `{ users, changedUsers, changedDays, changedFields }`，供 POST 响应显示 `unchanged` 数量。

在 `src/rankings-worker.js` 中：

- 删除 `computeSnapshotSignature`、`snapshotSignatureInput`、`storeNormalizedSnapshot`、`mergeSnapshotMetrics` 和所有 `rank_snapshots/rank_entries` INSERT。
- `postSnapshot` 仍解析 `snapshots` 外层，以兼容现有页面和旧 userscript；规范化后直接调用 `storeUserObservations`。
- 保留 Rate Limiting binding，并在 JSON 解析前限流。
- 不把 `source`、raw response 或 fingerprint 写入 D1。
- POST 成功返回 `storedSnapshots` 兼容字段，但增加 `changedUsers`、`changedFields`、`unchangedUsers`；同一 payload 重放返回 200，不返回数据库错误。

- [ ] **Step 3: Add front-end raw stripping test before implementation.**

在 `test/rankings-view.test.js` 增加断言：

```js
test('ranking upload keeps current observations but strips raw payload fields', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /function compactSnapshotForUpload/);
  assert.match(source, /leaderboards/);
  assert.match(source, /userId/);
  assert.doesNotMatch(source, /raw:s*row/);
});
```

`site/rankings.js` 的 `uploadSnapshot` 改为通过 `compactSnapshotForUpload` 构造：只保留 `season`、`scope`、`capturedAt` 和每个 row 的 `userId/userName/avatar/value/rank/isVip/activeNameDecoration/nameDisplayPreference`。不存指纹，不改 userscript 的 GM 状态。

- [ ] **Step 4: Run focused upload tests and commit.**

运行：

```bash
node --test test/rankings-user-store.test.js test/rankings-worker.test.js test/rankings-view.test.js
```

预期：PASS；查询记录中不出现新上传路径对旧表、`raw_json` 或 fingerprint 的依赖。

提交：

```bash
git add src/rankings-user-store.js src/rankings-worker.js site/rankings.js test/rankings-user-store.test.js test/rankings-worker.test.js test/rankings-view.test.js
git commit -m "feat: store rankings as user observations"
```

## Task 3: Move all GET APIs to current/day tables and keyset pagination

**Files:**
- Modify: `src/rankings-worker.js`
- Modify: `src/rankings-user-store.js`
- Modify: `test/rankings-worker.test.js`

- [ ] **Step 1: Add failing compact read-contract tests.**

测试以下查询边界：

```js
test('latest reads only rank_seasons', async () => {
  const environment = compactEnvWithData();
  const response = await get('/api/rankings/latest', environment);
  assert.equal(response.status, 200);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /rank_user_days|rank_user_current/i.test(sql)), false);
  assert.ok(environment.RANKINGS_DB.queries.some(({ sql }) => /from rank_seasons/i.test(sql)));
});

test('leaderboard returns one page and an opaque cursor', async () => {
  const environment = compactEnvWithUsers(120);
  const first = await get('/api/rankings/leaderboard?board=users&period=total&limit=50', environment);
  const firstBody = await first.json();
  assert.equal(firstBody.rows.length, 50);
  assert.equal(firstBody.hasMore, true);
  assert.ok(firstBody.nextCursor);
  assert.match(environment.RANKINGS_DB.queries.at(-1).sql, /limit \?/i);

  const second = await get(`/api/rankings/leaderboard?board=users&period=total&limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`, environment);
  assert.equal((await second.json()).rows[0].userId, 'u-50');
});

test('history reads only one user day row per requested day', async () => {
  const environment = compactEnvWithHistory('u-1', 90);
  const response = await get('/api/rankings/history?userId=u-1&board=epic&since=1&until=9999999999999&limit=30', environment);
  const body = await response.json();
  assert.equal(body.rows.length, 30 * 4);
  assert.equal(body.hasMore, true);
  assert.ok(body.nextCursor);
  assert.match(environment.RANKINGS_DB.queries.find(({ sql }) => /from rank_user_days/i.test(sql)).sql, /user_id = \?/i);
  assert.doesNotMatch(environment.RANKINGS_DB.queries.at(-1).sql, /rank_snapshots|rank_entries|raw_json/i);
});
```

运行：`node --test test/rankings-worker.test.js`。

预期：FAIL，现有 worker 仍依赖旧表和 Worker 内存分页。

- [ ] **Step 2: Implement compact latest and snapshot-compatible metadata.**

将 `latestSnapshot` 改为 `latestSeason`，查询：

```sql
SELECT season_id, season_name, last_observed_at, last_day_start_at
FROM rank_seasons
ORDER BY last_observed_at DESC, season_id DESC
LIMIT 1
```

保留对前端的 `snapshot` 响应形状，但使用 `id: null`、`scope: 'global,friends'`、`capturedAt: last_observed_at` 和空 `signature`。`latest` 不再查询 distinct boards，固定返回已知的 `COMPACT_BOARD_KEYS`。

- [ ] **Step 3: Implement current leaderboard SQL pagination.**

在 `rankings-user-store.js` 导出：

```js
export async function queryCurrentUsers(db, options) {}
export async function queryCurrentBoard(db, options) {}
export async function queryPinnedUsers(db, options) {}
export function encodeCurrentCursor(sort, direction, row) {}
export function decodeCurrentCursor(value, sort, direction) {}
```

具体规则：

- `limit` 默认 50，最大 100；实际 SQL 使用 `LIMIT limit + 1`。
- `sort` 映射到固定白名单列：`user -> user_name COLLATE NOCASE`、`legend -> sort_legend_value`、`spend -> sort_spend_usd`、`pulls -> sort_estimated_pulls`、`sets -> sort_exchange_count`、`probability -> sort_probability`。
- cursor 包含 `seasonId/sort/direction/value/userId` 的 base64url JSON，排序改变或查询条件改变时拒绝旧 cursor。
- 空值统一排在末尾，userId 作为稳定 tie-breaker；SQL 只选择当前页字段。
- `board=users` 从当前行构造现有 `epicTotal/spendUsd/paidPulls/freePulls/exchangeCount/estimatedLegendProbability` 响应。
- `board=epic/spend/sets/luck` 读取当前行对应 period 字段；luck 只使用当前页可排序的 `sort_probability`，不读取全部用户到 Worker。
- `q` 传入时在 SQL 里对 `user_id/user_name` 做 `LIKE`，只返回匹配页。
- `ids` 传入时最多 20 个，供置顶用户单独读取，不扩大主榜页。

`getLeaderboard`、`getUsers`、`getEvents` 全部切换到这些查询。事件只比较当前页 userId 与最近一个已完成北京日的 `rank_user_days`，默认最近 7 日，最多读取当前页用户对应的有限行。

- [ ] **Step 4: Implement one-user daily history.**

在 `getHistory` 中：

- `userId` 必填；`since/until` 默认最近 30 个北京日，最大 90 日。
- `mode` 只接受 `daily`；传 `snapshot` 时兼容返回 `mode: daily`，绝不访问旧 raw 表。
- `rank_user_days` 按 `season_id/user_id/day_start_at` 做 keyset 查询，取 `limit + 1` 个日行。
- `compactHistoryRows` 将一行的 12 个 board 字段展开为现有前端兼容的 `boardKey/value/rank/capturedAt/userId/userName/avatar` rows；请求 `board` 时只展开对应前缀。
- cursor 只包含 `until/dayStartAt`，不会跨用户、season 或 range 复用。
- 响应 `nextCursor` 指向最后一个日行，`events` 只由这次用户的日 rows 生成。

- [ ] **Step 5: Run read tests and commit.**

运行：`node --test test/rankings-worker.test.js`。

预期：PASS；`rg -n "rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics" src/rankings-worker.js` 不再有生产 GET/POST 路径引用。

提交：

```bash
git add src/rankings-worker.js src/rankings-user-store.js test/rankings-worker.test.js
git commit -m "feat: paginate compact rankings reads"
```

## Task 4: Make Dashboard page-aware and history-on-demand

**Files:**
- Modify: `site/rankings.js`
- Modify: `site/index.html`
- Modify: `test/rankings-view.test.js`

- [ ] **Step 1: Add failing source-contract tests for remote pages.**

在 `test/rankings-view.test.js` 增加：

```js
test('dashboard requests only the current leaderboard page', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(source, /limit/);
  assert.match(source, /nextCursor/);
  assert.match(source, /leaderboard.*cursor|cursor.*leaderboard/i);
  assert.doesNotMatch(html, /<option value="all">全部<\/option>/);
});

test('trend mode stays daily and each selected user keeps an independent history request', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(source, /userId/);
  assert.match(source, //api\/rankings\/history\?/);
  assert.match(source, /nextCursor/);
  assert.doesNotMatch(html, /id="rankingsTrendModeSnapshot"/);
});
```

运行：`node --test test/rankings-view.test.js`。

预期：FAIL，因为前端仍然把全部 rows 下载后在浏览器 offset 分页，并保留 snapshot 趋势按钮。

- [ ] **Step 2: Replace client offset pagination with cursor state.**

将 `state` 中分页字段改为：

```js
leaderboard: {
  cursor: null,
  nextCursor: null,
  previousCursors: [],
  hasMore: false,
  limit: 50
}
```

`loadLeaderboard` 构造 `board/period/sort/limit/cursor/q` query；下一页把当前 `nextCursor` 放入 `previousCursors` 后请求，上一页弹出上一 cursor；排序、周期、搜索、手动刷新时清空 cursor 栈。`renderRankingsTableRows` 不再对全量 rows `slice(offset)`，只渲染当前 response rows。分页摘要改为“第 N 页”，下一页由 `hasMore` 控制，不显示总用户数。

删除 `pageSize=all` 分支。页面只允许 50/100 两种大小。

- [ ] **Step 3: Make search and pinned users targeted.**

用户搜索输入使用 250ms debounce，请求 `/api/rankings/users?q=alice&limit=20&board=users&period=total`；不再在 `state.rows` 上过滤全量用户。置顶用户使用 `/api/rankings/users?ids=u1,u2&limit=20&board=users&period=total` 单独读取，置顶数据不改变主榜页 cursor。

趋势“添加用户”在当前页找不到时先调用用户搜索；选择成功后只调用该 userId 的 history。移除用户时只删除其内存 history，不触发其他用户请求。

- [ ] **Step 4: Remove snapshot trend UI and add browser cache.**

在 `site/index.html` 删除 `rankingsTrendModeSnapshot` 按钮；在 `site/rankings.js` 固定 `state.trend.mode = 'daily'`，删除 snapshot 聚合分支和“实际抓取”文案。

在 `apiGet` 上增加内存 TTL cache：

```js
const API_CACHE_TTL = Object.freeze({
  latest: 15_000,
  leaderboard: 30_000,
  users: 30_000,
  history: 60_000,
  events: 30_000
});
```

缓存 key 使用完整 path/query；请求 `fresh` 时跳过并删除对应 key。缓存只保存当前页、搜索结果和单用户历史，不保存全量榜单。

- [ ] **Step 5: Run front-end contract tests and commit.**

运行：

```bash
node --test test/rankings-view.test.js test/rankings-userscript.test.js
npm run build
```

预期：PASS，`dist/` 生成成功，userscript 的 CDK 请求/relay 行为未改变。

提交：

```bash
git add site/rankings.js site/index.html test/rankings-view.test.js
git commit -m "feat: load rankings pages and user history on demand"
```

## Task 5: Replace Cron aggregation with compact maintenance

**Files:**
- Create: `src/rankings-maintenance.js`
- Modify: `src/index.js`
- Modify: `test/rankings-daily.test.js`
- Modify: `test/rankings-worker.test.js`

- [ ] **Step 1: Write failing maintenance tests.**

测试 scheduled 使用 compact 表：

```js
test('scheduled maintenance never queries legacy ranking tables', async () => {
  const db = new CompactMaintenanceDb([
    { season_id: 's1', user_id: 'u1', spend_total_value: 500000, is_vip: 0, last_observed_at: 10000 }
  ]);
  await scheduled({ scheduledTime: Date.parse('2026-08-25T04:05:00+08:00') }, { RANKINGS_DB: db });
  assert.ok(db.queries.some(({ sql }) => /rank_user_current/i.test(sql)));
  assert.equal(db.queries.some(({ sql }) => /rank_snapshots|rank_entries|rank_daily_metrics|raw_json/i.test(sql)), false);
});
```

运行：`node --test test/rankings-daily.test.js`。

预期：FAIL，因为 `scheduled` 仍调用旧的 `aggregateRankingsDay`。

- [ ] **Step 2: Implement bounded compact maintenance.**

`src/rankings-maintenance.js` 导出：

```js
export async function refreshCompactRankings(db, now = Date.now()) {}
```

实现：

- 读取 `rank_user_current` 的必要原始指标列和 `is_vip`，不读 raw/旧表。
- 使用 `currentSortValues(row, now)` 计算派生排序字段，按 50 行一批更新同一 current row；相同派生值不更新。
- 更新 `rank_seasons.last_day_start_at`，不新增历史记录。
- 返回 `{ usersScanned, usersChanged, dayStartAt }`，日志使用 `rankings_compact_maintenance` 前缀。

`src/index.js` 的 `scheduled` 改为调用 `refreshCompactRankings`，Cron 仍为 `5 20 * * *`。不再导入或执行旧 `aggregateRankingsDay`。

- [ ] **Step 3: Run maintenance tests and commit.**

运行：`node --test test/rankings-daily.test.js test/rankings-worker.test.js`。

预期：PASS。

提交：

```bash
git add src/rankings-maintenance.js src/index.js test/rankings-daily.test.js test/rankings-worker.test.js
git commit -m "feat: maintain compact rankings on schedule"
```

## Task 6: Add backup, migration, verification, and operations commands

**Files:**
- Create: `scripts/backup-card-rankings.mjs`
- Create: `scripts/migrate-card-rankings-compact.mjs`
- Create: `scripts/verify-card-rankings-compact.mjs`
- Modify: `test/rankings-operations.test.js`
- Modify: `docs/rankings-operations.md`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests for safe command construction.**

在 `test/rankings-operations.test.js` 测试：

```js
test('backup command is remote export and never deletes', () => {
  const args = backupWranglerArgs('hyb-card-rankings-db', '/tmp/card.sql');
  assert.deepEqual(args, [
    'wrangler', 'd1', 'export', 'hyb-card-rankings-db', '--remote',
    '--output=/tmp/card.sql', '--skip-confirmation'
  ]);
  assert.doesNotMatch(args.join(' '), /delete|drop|reset/i);
});

test('compact migration SQL is day-bounded and excludes raw_json', () => {
  const sql = buildCompactSourceQuery(FIRST_DAY, FIRST_DAY + DAY_MS);
  assert.match(sql, /captured_at >= \?/i);
  assert.match(sql, /captured_at < \?/i);
  assert.doesNotMatch(sql, /raw_json|delete|drop table/i);
});

test('compact schema has no legacy tables or fingerprint columns', async () => {
  const schema = await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8');
  assert.match(schema, /create table if not exists rank_user_days/i);
  assert.match(schema, /create table if not exists rank_user_current/i);
  assert.doesNotMatch(schema, /rank_snapshots|rank_entries|raw_json|fingerprint/i);
});
```

运行：`node --test test/rankings-operations.test.js`。

预期：FAIL，因为新脚本和 schema 尚未实现。

- [ ] **Step 2: Implement old D1 backup script.**

`backup-card-rankings.mjs` 的 CLI 固定为：

```text
node scripts/backup-card-rankings.mjs \
  --database hyb-card-rankings-db \
  --output backups/card-rankings-2026-08-26 \
  --remote
```

脚本执行顺序：

1. 创建指定目录，不覆盖已有目录。
2. 调用 `npx wrangler d1 export <database> --remote --output=<dir>/database.sql --skip-confirmation`。
3. 调用 `npx wrangler d1 execute <database> --remote --json --command="SELECT type,name,sql FROM sqlite_master ORDER BY type,name"` 保存 schema metadata，并分别执行 `SELECT COUNT(*)` 查询保存三张业务表的行数。
4. 生成 `database.sql.gz` 和包含 SHA-256、字节数、时间、数据库名的 `manifest.json`。
5. 读取 gzip 解压后的前后文件长度，验证导出非空后退出 0。

脚本不执行任何 delete/drop/reset；目录存在时退出并要求新的输出目录。

- [ ] **Step 3: Implement bounded old-to-new migration.**

`migrate-card-rankings-compact.mjs` CLI：

```text
node scripts/migrate-card-rankings-compact.mjs \
  --source hyb-card-rankings-db \
  --target hyb-card-rankings-v2-db \
  --from 2026-08-02T04:00:00+08:00 \
  --until 2026-08-26T04:00:00+08:00 \
  --remote
```

实现规则：

- 必须明确 source、target、from、until 和 remote/local，缺一项退出 1。
- 每次只查询一个北京日：优先读旧 `rank_daily_metrics`，同时从旧 `rank_entries JOIN rank_snapshots` 读取必要列补齐/校正；查询列只包含用户资料、value、rank、scope、captured_at 和必要 ID，不能选择 `raw_json`。
- 在 Node 内按 `season_id/day_start_at/user_id` 合并为 compact user-day SQL literal/batch，写入目标 `rank_user_days`；SQL 使用安全的 SQLite literal escape，不拼接未转义用户数据。
- 读取旧 `rank_user_metrics` 一次并转换到 `rank_user_current`，累计榜取旧 value，period 榜取旧最新值；随后由 `refreshCompactRankings` 计算 sort 字段。
- 迁移每一天后输出 `{ dayStartAt, sourceRows, targetRows, users }`，失败停止在当前日；重新执行同一天不会产生重复主键。
- 不更新、不删除旧库任何表；目标库写入只使用 compact 三张表。

- [ ] **Step 4: Implement verification script and update operations docs.**

`verify-card-rankings-compact.mjs` 比较：

- old/new 赛季 ID 和名称；
- 每个北京日的用户日行数；
- current 用户数；
- 指定 `--user` 时的 90 日 `epic_total/spend_total/sets_total` 样本；
- 目标 schema 中没有旧表/raw/fingerprint。

`docs/rankings-operations.md` 写明以下顺序和回滚方式：

1. backup；
2. `npx wrangler d1 create hyb-card-rankings-v2-db`；
3. `npx wrangler d1 execute hyb-card-rankings-v2-db --remote --file=migrations-v2/0001_compact_rankings.sql`；
4. 单日迁移和验证；
5. 修改 `wrangler.jsonc` binding 后部署；
6. 新库异常时恢复旧 `database_id`，部署旧 Worker commit；
7. 新库稳定后继续按日补齐旧库缺失日期，旧库和备份暂不删除。

在 `.gitignore` 添加：

```text
backups/
```

- [ ] **Step 5: Run operations tests and commit.**

运行：`node --test test/rankings-operations.test.js`。

预期：PASS；文档中的所有命令都包含明确 source/target/range，且没有清理命令。

提交：

```bash
git add scripts/backup-card-rankings.mjs scripts/migrate-card-rankings-compact.mjs scripts/verify-card-rankings-compact.mjs test/rankings-operations.test.js docs/rankings-operations.md .gitignore
git commit -m "ops: add compact rankings backup and migration"
```

## Task 7: Full local verification and rollout gate

**Files:**
- Modify: `wrangler.jsonc` only when the new remote database ID is available.
- Modify: `test/*.test.js` only for failures caused by the compact contract.

- [ ] **Step 1: Run the complete local test suite before any remote write.**

运行：

```bash
npm test
npm run build
git diff --check HEAD~1
```

预期：所有测试通过，build 生成 `dist/`，没有 whitespace error。此时不得执行 new D1 create、remote schema、remote migration 或 deploy。

- [ ] **Step 2: Inspect the production SQL contract.**

运行：

```bash
rg -n "rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics|raw_json|fingerprint" src/rankings-worker.js src/rankings-user-store.js src/rankings-maintenance.js
```

预期：生产新增读写路径没有旧表/raw/fingerprint；旧表名只可出现在迁移脚本、旧兼容测试或文档中。

- [ ] **Step 3: Commit the verified application change.**

提交：

```bash
git status --short
git add src site migrations-v2 test scripts docs/rankings-operations.md wrangler.jsonc .gitignore
git commit -m "feat: migrate card rankings to compact user storage"
```

在这个 commit 之前不修改旧数据库，不删除旧 backup，不切换线上 binding。

## Task 8: Remote backup, new D1, migration, cutover, and deployment

**Files/remote state:**
- Old D1 `hyb-card-rankings-db` remains untouched and retained.
- New D1 `hyb-card-rankings-v2-db` is created and receives only compact schema/data.
- `wrangler.jsonc` receives the new D1 ID after verification.

- [ ] **Step 1: Export and verify the old database backup.**

运行 backup script，并确认：

- `database.sql`、`database.sql.gz`、`metadata.json`、`manifest.json` 都存在；
- manifest hash can be recomputed；
- old table counts match metadata；
- no command output indicates delete/drop/reset。

- [ ] **Step 2: Create and initialize the new D1.**

运行：

```bash
npx wrangler d1 create hyb-card-rankings-v2-db
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --file=migrations-v2/0001_compact_rankings.sql
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

预期表只有 `rank_seasons`、`rank_user_current`、`rank_user_days` 及 SQLite/Wrangler 元数据表。

- [ ] **Step 3: Migrate existing data in explicit day batches.**

先迁移已知数据范围，再对 8 月 17 日之后的缺失日期单独重跑：

```bash
node scripts/migrate-card-rankings-compact.mjs --source hyb-card-rankings-db --target hyb-card-rankings-v2-db --from 2026-08-02T04:00:00+08:00 --until 2026-08-26T04:00:00+08:00 --remote
```

每个日期完成后读取 target count；某日失败时只重新执行该日，不从旧库删除或改写任何数据。

- [ ] **Step 4: Verify before binding cutover.**

运行：

```bash
node scripts/verify-card-rankings-compact.mjs --source hyb-card-rankings-db --target hyb-card-rankings-v2-db --from 2026-08-02T04:00:00+08:00 --until 2026-08-26T04:00:00+08:00 --remote --user u-1
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rank_snapshots','rank_entries','rank_user_metrics','rank_daily_metrics')"
```

预期：抽样用户 daily/current 一致，旧表查询为空。

- [ ] **Step 5: Switch the binding and deploy.**

把新 D1 的真实 ID 写入 `wrangler.jsonc` 的 `RANKINGS_DB.database_id`，保留旧配置 commit/hash 作为 rollback reference，然后运行：

```bash
npm test
npm run build
npx wrangler deploy
```

记录 Worker deployment ID、new D1 ID、git commit 和 Cron `5 20 * * *`。

- [ ] **Step 6: Run production smoke checks and defer cleanup.**

检查：

```bash
curl -sS https://card.gudong226.com/api/rankings/latest
curl -sS 'https://card.gudong226.com/api/rankings/leaderboard?board=users&period=total&limit=50'
curl -sS 'https://card.gudong226.com/api/rankings/history?userId=u-1&since=1&until=9999999999999&limit=30'
```

然后用同一当前观察 payload 连续 POST 两次，确认新库 user-day 行数不增加；检查 D1 Analytics 没有旧 raw 查询。旧 D1、导出和 backup 目录均保留，不执行删除。

- [ ] **Step 7: Continue slow historical backfill and document rollback.**

逐日补齐 8 月 17 日之后缺失数据，优先一天一批、失败重跑当前天。若线上出现 schema/API 错误：

1. 将 `wrangler.jsonc` 的 `RANKINGS_DB.database_id` 恢复为旧 ID；
2. checkout/部署旧 Worker commit；
3. 保留新库用于诊断，不删除新库或旧库；
4. 记录故障请求、D1 query 和 deployment ID 后再修复新版本。

## Plan self-review checklist

- Spec coverage: schema、服务端增量 upsert、无 fingerprint、分页、单用户 history、缓存、备份、迁移、回填、部署和回滚分别由 Tasks 1–8 覆盖。
- No client fingerprint: userscript 不维护 diff 状态；只在 `site/rankings.js` 去掉 raw，Worker/D1 判断变化。
- No legacy production path: `src/rankings-worker.js` 和 `src/index.js` 切换到三张 compact 表；旧表只由迁移脚本读取。
- No destructive action: backup、migration、cutover 步骤都保留旧库和旧 binding，未包含 delete/drop/reset。
- Pagination consistency: current cursor 使用 `sort/direction/value/userId`，history cursor 使用 `until/dayStartAt`，前后端不会混用。
- Test coverage: 每个新增存储/查询/前端/运维边界先写失败测试，再实现和运行 focused/full suite。
