# 榜单脚本安装与上传授权 Implementation Plan

> **For agentic workers:** Inline execution is selected for this task; execute the steps in this session with verification checkpoints.

**Goal:** 在榜单统计页增加常驻脚本安装入口，复刻 Farm Dashboard 的自动上传授权逻辑，并按同周期 userId 合并欧皇、消费、兑换榜，生成默认赛季用户总览表。

**Architecture:** `site/rankings.js` 负责本地上传偏好、桥接抓取、未上传快照的临时展示和用户总览表；`src/rankings-core.js` 与 `src/rankings-worker.js` 负责同周期 `userId` 合并、VIP 抽数反推、消费 USD 换算和不完整数据标记；油猴脚本在 Card/CDK 双域运行但只在 Card 页面提供桥接 UI。`site/index.html` 与 `site/rankings.css` 提供安装/授权/手动上传及周期/排序选择，URL 路由保持不变。

**Tech Stack:** 原生 JavaScript、HTML、CSS、localStorage、现有 Node test runner、Cloudflare Worker/D1。

---

### Task 1: Lock the upload gate with tests

**Files:**
- Modify: `test/rankings-view.test.js`
- Modify: `test/rankings-userscript.test.js`

- [ ] Add assertions for a permanent install link, the upload setting key/default, the manual upload action, and the guarded snapshots POST.
- [ ] Run `npm test`; the new assertions must fail before implementation because the current view hides the link and always POSTs after bridge capture.

### Task 2: Add local upload preference and temporary snapshot state

**Files:**
- Modify: `site/rankings.js`

- [ ] Add `SETTINGS_STORAGE_KEY`, `loadSettings()`, `saveSettings()`, and `state.localSnapshot` with `autoUpload` defaulting to `false`.
- [ ] Add a browser-side snapshot adapter that maps `leaderboards` rows to the existing table shape, estimates probability using each row's epic/spend totals, and marks rows as locally captured.
- [ ] Change the bridge flow so it always captures when D1 is missing/stale, but calls `/api/rankings/snapshots` only when `autoUpload` is enabled.
- [ ] When auto upload is disabled, render the local snapshot immediately and leave it available for manual upload.
- [ ] Add a manual upload handler that posts only the pending local snapshot, then reloads D1 and clears the pending state on success.
- [ ] Run the focused view tests, observe the expected green results, then run all tests.

### Task 3: Add the always-visible install and settings UI

**Files:**
- Modify: `site/index.html`
- Modify: `site/rankings.css`

- [ ] Replace the conditional-only install hint with a visible rankings setup card containing the script link, CDK login link, auto-upload toggle, and manual upload button.
- [ ] Keep the setup card compact and responsive, using the existing panel/button/toggle theme tokens.
- [ ] Update status text to distinguish “已抓取但未上传” from “已同步到云端”。
- [ ] Run `npm test` and `npm run build`.

### Task 4: Verify production assets and behavior

**Files:**
- Verify: `dist/index.html`, `dist/rankings.js`, `dist/rankings.css`, `dist/userscripts/hyb-card-dashboard-rankings.user.js`

- [ ] Run `node --check site/rankings.js`, `git diff --check`, and `npm test`.
- [ ] Run `npm run build` and verify the install script is still copied to the published assets.
- [ ] Deploy only after local checks pass, then verify the production page contains the setup card and `/api/rankings/latest` remains healthy.

### Task 5: Add full-period paired probability estimation

**Files:**
- Modify: `src/rankings-core.js`
- Modify: `src/rankings-worker.js`
- Modify: `site/rankings.js`
- Modify: `test/rankings-core.test.js`
- Modify: `test/rankings-worker.test.js`

- [ ] Add failing tests for raw spend-to-USD conversion, VIP/ordinary daily pull formulas, same-period pair selection, non-integer-day status, and missing paired rows.
- [ ] Replace total-only joins with `${board}_${period}` pair maps keyed by `userId`; never convert an absent top-100 row to zero.
- [ ] Return `estimatedDays`, `estimatedPulls`, `spendUsd`, `estimateStatus`, and `isPartial` in leaderboard rows.
- [ ] Mirror the same-period calculation for local unsent snapshots in `site/rankings.js`.

### Task 6: Make the userscript Farm-compatible without CDK UI

**Files:**
- Modify: `site/userscripts/hyb-card-dashboard-rankings.user.js`
- Modify: `test/rankings-userscript.test.js`

- [ ] Add the CDK `@match` and shared GM storage grants while keeping the Card-only visible bridge behavior.
- [ ] Ensure CDK pages do not inject buttons, alerts, or dashboard elements; retain one request per bridge cycle.
- [ ] Verify both metadata matches and the Card/CDK origin guard with `node --check` and tests.

### Task 7: Replace multi-board tabs with a user summary table

**Files:**
- Modify: `src/rankings-worker.js`
- Modify: `site/rankings.js`
- Modify: `site/index.html`
- Modify: `site/rankings.css`
- Modify: `test/rankings-worker.test.js`
- Modify: `test/rankings-view.test.js`

- [x] Merge `epic_${period}`, `spend_${period}` and `sets_${period}` by `userId`.
- [x] Return USD spend, estimated pulls, exchange count and estimated output probability in one row.
- [x] Keep missing values null in the API and blank in the table; default to the whole season.
- [x] Add period and sort selectors; omit the default user limit so new users can appear dynamically.
