# 榜单用户合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将全服榜和好友榜按赛季 `userId` 合并为全量用户数据，同时保留全部原始快照并修复趋势图数据点悬浮提示。

**Architecture:** `rank_snapshots` 与 `rank_entries` 继续作为不可变原始层；新增 `rank_user_metrics` 作为按赛季、用户和榜单键维护的当前聚合层。用户脚本一次抓取两个来源，前端/Worker 接受快照 bundle；用户总览从聚合层读取，趋势从原始层读取并按用户、榜单和时间桶去重。

**Tech Stack:** Cloudflare Worker、D1/SQLite migration、浏览器油猴 userscript、原生 JavaScript/SVG、Node.js `node:test`。

---

### Task 1: 建立纯函数合并规则测试

**Files:**
- Create: `src/rankings-merge.js`
- Create: `test/rankings-merge.test.js`

- [ ] **Step 1: Write failing tests for user-key and metric merge behavior**

Add tests covering: different users append; same user is one row; total boards keep the larger value; period boards prefer the newer capture; missing fields do not erase existing values; `global` and `friends` become one source set; VIP is sticky true.

```js
test('merges two scopes by user and does not add duplicate values', () => {
  const existing = metric({ userId: 'u1', boardKey: 'epic_total', value: 10, capturedAt: 1000, scope: 'global' });
  const merged = mergeMetric(existing, metric({ userId: 'u1', boardKey: 'epic_total', value: 12, capturedAt: 1000, scope: 'friends' }));
  assert.equal(merged.value, 12);
  assert.equal(merged.sourceScopes, 'global,friends');
});

test('does not overwrite existing users when a later upload is partial', () => {
  const rows = mergeMetricRows([
    metric({ userId: 'u1', boardKey: 'epic_total', value: 8, capturedAt: 1000 })
  ], [metric({ userId: 'u2', boardKey: 'epic_total', value: 3, capturedAt: 2000 })]);
  assert.deepEqual(rows.map((row) => row.userId).sort(), ['u1', 'u2']);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `node --test test/rankings-merge.test.js`

Expected: FAIL because `src/rankings-merge.js` does not yet export the merge functions.

- [ ] **Step 3: Implement the minimal pure merge module**

Implement `mergeMetric(existing, incoming)` and `mergeMetricRows(existingRows, incomingRows)` with these exact rules:

```js
const isTotalBoard = (boardKey) => String(boardKey).endsWith('_total');
const shouldReplaceValue = (existing, incoming) => {
  if (!existing) return true;
  if (isTotalBoard(incoming.boardKey)) {
    return incoming.value > existing.value
      || (incoming.value === existing.value && incoming.capturedAt >= existing.valueCapturedAt);
  }
  return incoming.capturedAt > existing.valueCapturedAt
    || (incoming.capturedAt === existing.valueCapturedAt && incoming.value >= existing.value);
};
```

The returned row must retain `firstCapturedAt`, update `lastCapturedAt`, OR `isVip`, preserve the latest non-empty profile fields, and union scopes in the stable order `global,friends`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/rankings-merge.test.js`

Expected: PASS.

### Task 2: Add the D1 aggregate table and backfill existing snapshots

**Files:**
- Create: `migrations/0003_rankings_user_metrics.sql`
- Modify: `docs/rankings-operations.md`

- [ ] **Step 1: Add the migration schema and backfill SQL**

Create `rank_user_metrics` with primary key `(season_id, user_id, board_key)`, profile fields, `value`, `rank`, value provenance (`value_snapshot_id`, `value_scope`, `value_captured_at`), observation provenance (`last_snapshot_id`, `last_scope`, `last_captured_at`), `first_captured_at`, and `source_scopes`.

Backfill from existing `rank_entries JOIN rank_snapshots` using window functions: for `*_total` choose the highest value (then newest capture); for other board keys choose the newest capture. Do not delete or update `rank_snapshots` or `rank_entries`.

- [ ] **Step 2: Add indexes and migration documentation**

Add indexes on `(season_id, board_key, value)` and `(season_id, user_id)`. Document that the aggregate table is rebuildable and raw snapshots are retained indefinitely.

- [ ] **Step 3: Apply the migration locally and verify row counts**

Run:

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --local
npx wrangler d1 execute hyb-card-rankings-db --local --command="SELECT COUNT(*) AS metrics FROM rank_user_metrics"
```

Expected: migration succeeds and the count is non-negative; existing snapshot tables remain present.

### Task 3: Extend core validation and add bundle normalization

**Files:**
- Modify: `src/rankings-core.js`
- Modify: `test/rankings-core.test.js`

- [ ] **Step 1: Add failing tests for `friends` scope and bundle input**

Test that a normalized snapshot with `scope: 'friends'` is accepted, and that unsupported scopes are rejected. Keep the existing global validation tests unchanged.

- [ ] **Step 2: Run the focused core tests and verify failure**

Run: `node --test test/rankings-core.test.js`

Expected: FAIL at the friends-scope assertion because normalization currently hard-codes `global`.

- [ ] **Step 3: Implement scope normalization without changing raw scope**

Accept exactly `global` and `friends`, return the actual normalized scope, and keep the source payload unchanged in `raw`. Export a small `normalizeSnapshotBundle(payload, now)` helper that accepts either the legacy single snapshot or `{ snapshots: [...] }` and returns `{ ok, snapshots, errors }`.

- [ ] **Step 4: Run all core tests**

Run: `node --test test/rankings-core.test.js test/rankings-merge.test.js`

Expected: PASS.

### Task 4: Make Worker uploads append raw snapshots and update user metrics

**Files:**
- Modify: `src/rankings-worker.js`
- Modify: `test/rankings-worker.test.js`

- [ ] **Step 1: Add failing Worker tests for bundle uploads and incremental merge**

Add tests that POST two bundles: first a global snapshot with `u1` and `u2`, then a friends snapshot with an updated `u1` and new `u3`. Assert that:

```js
assert.equal(environment.RANKINGS_DB.snapshots.length, 2);
assert.deepEqual(userRows.map((row) => row.userId).sort(), ['u1', 'u2', 'u3']);
assert.equal(userRows.find((row) => row.userId === 'u1').epicTotal, 12);
```

Also assert that reposting the same signature returns a duplicate result without adding a third raw snapshot.

- [ ] **Step 2: Run the focused Worker tests and verify failure**

Run: `node --test test/rankings-worker.test.js`

Expected: FAIL because the Worker currently accepts only one global snapshot and reads users from the latest raw snapshot.

- [ ] **Step 3: Implement bundle parsing and idempotent raw insertion**

Accept `{ snapshots: [...] }` and legacy `{ snapshot: {...} }`. Normalize each snapshot, check `(season_id, signature)` before insertion, insert the raw snapshot and all `rank_entries`, then merge entries into `rank_user_metrics` using the pure merge module. Return `storedSnapshots`, `storedEntries`, `duplicateSnapshots`, and `partial` fields.

- [ ] **Step 4: Read user overview and search from the aggregate layer**

Change `getUsersLeaderboard` and `getUsers` to query `rank_user_metrics` for the selected season and period. Convert aggregate rows to the existing `summarizeUsers` input shape so spending, pulls, exchanges, VIP, missing fields, and probability calculation remain unchanged.

- [ ] **Step 5: Keep trend/history reads on raw snapshots and deduplicate per time bucket**

Update `getHistory` to group rows by `boardKey + capturedBucket`, merge duplicate global/friends observations by `userId`, and keep the existing event payload. No raw snapshot or raw entry may be deleted.

- [ ] **Step 6: Run Worker tests and the full test suite**

Run:

```bash
node --test test/rankings-worker.test.js
npm test
```

Expected: all tests PASS, including existing single-global upload compatibility tests.

### Task 5: Capture and upload both sources from the userscript

**Files:**
- Modify: `site/userscripts/hyb-card-dashboard-rankings.user.js`
- Modify: `test/rankings-userscript.test.js`
- Modify: `docs/rankings-operations.md`

- [ ] **Step 1: Confirm the logged-in CDK friend scope parameter**

Use the logged-in CDK leaderboard page network requests to identify the exact friend request URL. The implementation must use the server-observed parameter, not assume `friend` or `friends` without confirmation.

- [ ] **Step 2: Add failing source-bundle assertions**

Assert that the script defines two source URLs, requests both scopes once per refresh, returns `snapshots`, and keeps the Card bridge on `card.gudong226.com`.

- [ ] **Step 3: Implement two-source loading and relay**

Parameterize GM/fetch requests by source URL. The CDK relay handles one relay request containing both source URLs and returns all successful snapshots. The Card bridge returns `{ snapshots: [...] }`; if one source fails it returns the successful source plus an error status.

- [ ] **Step 4: Keep the upload path backward compatible**

The Card page uploads `{ snapshots: [...] }`; existing single-snapshot local state is normalized to a one-item array. No global/friends UI switch is added.

- [ ] **Step 5: Run userscript and full tests**

Run: `npm test`

Expected: all userscript, core, Worker, and view tests PASS.

### Task 6: Merge local unsent snapshots and fix SVG trend tooltips

**Files:**
- Modify: `site/rankings.js`
- Modify: `site/rankings.css`
- Modify: `test/rankings-view.test.js`

- [ ] **Step 1: Add failing view tests**

Test that local bundle data produces one user row when the same user appears in both sources, and that the trend SVG contains a hit target plus a tooltip group with the user, timestamp, metric, and value.

- [ ] **Step 2: Run the focused view tests and verify failure**

Run: `node --test test/rankings-view.test.js`

Expected: FAIL because local state currently accepts one snapshot and trend points only contain an SVG `<title>`.

- [ ] **Step 3: Implement bundle-aware local state**

Replace singular local snapshot handling with a normalized snapshot array. Before upload, merge leaderboards by `userId` and board key using the same total/newest rules, then feed the existing local table renderer.

- [ ] **Step 4: Implement visible SVG hover/focus tooltips**

Render each point as an SVG group containing a transparent hit circle, visible point, and hidden tooltip group. Use `:hover` and `:focus-within` CSS; keep `title` and `aria-label` for accessibility. Tooltip text must include user, date, metric label, and formatted value.

- [ ] **Step 5: Run view tests and full verification**

Run:

```bash
node --test test/rankings-view.test.js
npm test
npm run build
git diff --check
```

Expected: all tests pass, build succeeds, and `git diff --check` is clean.

### Task 7: Deploy and verify production behavior

**Files:**
- Modify: `README.md` only if the final endpoint or installation instructions changed.

- [ ] **Step 1: Apply the new migration remotely after verifying the binding**

Run: `npx wrangler d1 migrations apply hyb-card-rankings-db --remote` and verify that `rank_snapshots`, `rank_entries`, and `rank_user_metrics` exist.

- [ ] **Step 2: Build and deploy the Worker/assets**

Run: `npm run deploy`.

- [ ] **Step 3: Smoke-test the public API**

Run:

```bash
curl -sS https://card.gudong226.com/api/rankings/latest
curl -sS 'https://card.gudong226.com/api/rankings/leaderboard?board=users&period=total'
```

Verify that existing users remain visible and the API reports the merged user view.

- [ ] **Step 4: Report the deployment and retained snapshot guarantee**

Include the deployed version, migration result, test count, and explicit confirmation that no existing raw snapshot or entry was removed.
