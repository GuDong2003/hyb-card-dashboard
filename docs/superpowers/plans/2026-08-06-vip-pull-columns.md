# VIP-aware paid and free pull columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split derived pulls into paid/free columns and calculate probability only for current same-batch dual-board users meeting the VIP-aware minimum sample.

**Architecture:** Centralize VIP/ordinary pull math in `src/rankings-core.js`, reuse it in Worker and browser client, and pass current snapshot/batch identity into user summarization so stale metric rows cannot form pairs. Update table columns and tests without changing raw snapshot retention.

**Tech Stack:** Cloudflare Worker, D1, vanilla JavaScript, Node test runner, static HTML/CSS.

---

### Task 1: Shared VIP-aware pull calculation

**Files:** `src/rankings-core.js`, `test/rankings-core.test.js`

- [ ] Add failing tests for VIP `$24,000` → 2,400 paid / 200 free / 2,600 total; VIP `$500` → 50 paid / 50 free / low sample; ordinary `$4,000` → 400 paid / 30 free / 430 total; missing spend nulls.
- [ ] Replace the linear formula with paid pulls = spend USD × 100, effective days = `ceil(paid / daily paid limit)`, free pulls = effective days × daily quota, and total pulls = paid + free.
- [ ] Return `paidPulls`, `freePulls`, `estimatedPulls`, and statuses while preserving null handling.
- [ ] Run focused tests and commit `feat: calculate vip-aware paid and free pulls`.

### Task 2: Current-batch dual-board eligibility in Worker

**Files:** `src/rankings-worker.js`, `test/rankings-worker.test.js`

- [ ] Add tests proving an old spend metric plus current epic row cannot calculate, while current epic+spend exposes paid/free/total/probability.
- [ ] Pass the latest snapshot/bucket into summarization and filter epic/spend metrics to that batch.
- [ ] Require both current rows and the VIP-aware minimum spend before derived fields are populated; preserve raw values and mark missing/low-sample statuses otherwise.
- [ ] Expose paid/free fields and keep sorting/trend totals based on `estimatedPulls`.
- [ ] Run Worker tests and commit `fix: require current dual-board metrics for pulls`.

### Task 3: Local browser snapshot parity

**Files:** `site/rankings.js`, `test/rankings-view.test.js`

- [ ] Add assertions for paid/free fields, current-batch matching, and low-sample blanking.
- [ ] Apply the same VIP-aware formula and dual-board eligibility to local snapshots.
- [ ] Keep raw fields visible for incomplete users; derived fields become null. Update trend finalization and summaries to use total pulls.
- [ ] Run view tests and commit `fix: align local ranking calculations`.

### Task 4: Table columns

**Files:** `site/index.html`, `site/rankings.js`, `test/rankings-view.test.js`

- [ ] Replace the single `抽卡次数` header with `付费抽数` and `免费抽数`.
- [ ] Render paid/free cells, retain total pulls for trends, and update widths/colspans/tests.
- [ ] Run all tests and build, then commit `feat: show paid and free pull columns`.

### Task 5: Verify and deploy

- [ ] Run `npm test`, `npm run build`, and `git diff --check`.
- [ ] Review raw-field retention and current-batch filtering.
- [ ] Run `npm run deploy`; verify HTTP 200 and online paid/free column fields.
