# Legend Inventory Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit redeemed-set baseline so the calculator can reconstruct total legendary production from current remaining inventory without undercounting previously redeemed cards.

**Architecture:** Keep the calculation page as the integration layer, but move the pure inventory arithmetic into `site/stardust-rules.js` so it can be tested independently. Add one persisted numeric input (`redeemedSets`), preserve old snapshots with a zero default, and seed projected cumulative sets with the redeemed baseline while keeping random pulls and SP generation based on drawn legendary cards only.

**Tech Stack:** Static HTML/CSS/JavaScript, Node.js built-in test runner, Wrangler build/deploy.

---

### Task 1: Add failing inventory arithmetic tests

**Files:**
- Create: `test/legend-inventory.test.js`
- Modify: `site/stardust-rules.js`

- [ ] **Step 1: Write the failing test**

Add a Node test that loads `site/stardust-rules.js` in a VM and asserts:

```js
const summary = context.StardustRules.getLegendInventorySummary({
  drawnLegendaryCards: 40,
  heldLegendaryCards: 33,
  redeemedSets: 2
});
assert.deepEqual(summary, {
  totalAcquiredCards: 45,
  previousCraftedCards: 5,
  totalSets: 7,
  redeemableHeldSets: 5
});
```

Also cover `heldLegendaryCards: 3, redeemedSets: 2` (total sets `2`), negative/invalid inputs clamping to zero, and old-style omission of `redeemedSets` defaulting to zero.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test test/legend-inventory.test.js
```

Expected: FAIL because `getLegendInventorySummary` does not exist yet.

- [ ] **Step 3: Implement the pure helper**

Add `getLegendInventorySummary({ drawnLegendaryCards, heldLegendaryCards, redeemedSets })` to `site/stardust-rules.js`:

```js
const drawn = Math.max(0, Number(drawnLegendaryCards) || 0);
const held = Math.max(0, Number(heldLegendaryCards) || 0);
const redeemed = Math.max(0, Math.floor(Number(redeemedSets) || 0));
const totalAcquiredCards = held + redeemed * 6;
return {
  totalAcquiredCards,
  previousCraftedCards: Math.max(0, totalAcquiredCards - drawn),
  totalSets: redeemed + Math.floor(held / 6),
  redeemableHeldSets: Math.floor(held / 6)
};
```

Export it on the frozen `StardustRules` object without removing existing exports.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `node --test test/legend-inventory.test.js`; expected: PASS.

- [ ] **Step 5: Commit the pure helper and tests**

```bash
git add site/stardust-rules.js test/legend-inventory.test.js
git commit -m "feat: add legend inventory calibration rules"
```

### Task 2: Add the redeemed-set input and snapshot compatibility

**Files:**
- Modify: `site/index.html:500-535` for the form markup
- Modify: `site/index.html:830-930` for snapshot fields and restore behavior
- Modify: `test/legend-inventory.test.js` for markup and persistence assertions

- [ ] **Step 1: Extend the failing test**

Assert that the inventory form contains a `redeemedSets` number input labeled `已兑换套数`, that `currentUsableCards` is labeled `当前持有传说` with an `未兑换` hint, and that `redeemedSets` is included in `SNAPSHOT_VALUE_FIELDS`.

Extract `restoreSnapshot` dependencies only as text-level assertions; assert the source contains a compatibility fallback equivalent to `saved.values.redeemedSets === undefined` becoming `0`.

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run `node --test test/legend-inventory.test.js`; expected: FAIL on the new markup and snapshot assertions.

- [ ] **Step 3: Implement the form and persistence changes**

Change the inventory grid to three controls:

```html
<div class="form-grid three">
  <div class="form-group">
    <label for="redeemedSets">已兑换套数 <span class="field-hint">已提交卡组</span></label>
    <input type="number" id="redeemedSets" min="0" value="0" inputmode="numeric" oninput="calculate()">
  </div>
  <div class="form-group">
    <label for="currentUsableCards">当前持有传说 <span class="field-hint">未兑换，含合成</span></label>
    <input type="number" id="currentUsableCards" min="0" value="7" inputmode="numeric" oninput="calculate()">
  </div>
  <div class="form-group">
    <label for="stardustBalance">当前星尘余额</label>
    <input type="number" id="stardustBalance" min="0" value="0" inputmode="numeric" oninput="calculate()">
  </div>
</div>
```

Add `redeemedSets` to `SNAPSHOT_VALUE_FIELDS`. In `restoreSnapshot`, if the saved object is valid but does not contain the new field, set the input to `0` before calculation. Keep all existing dynamic-default behavior unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `node --test test/legend-inventory.test.js`; expected: PASS.

- [ ] **Step 5: Commit the input and snapshot changes**

```bash
git add site/index.html test/legend-inventory.test.js
git commit -m "feat: persist redeemed set baseline"
```

### Task 3: Calibrate projection totals and displayed derived stats

**Files:**
- Modify: `site/index.html:520-530` for derived statistics
- Modify: `site/index.html:1340-1515` for calculation initialization, projection rows, and summary metrics
- Modify: `test/legend-inventory.test.js` for source-level projection assertions

- [ ] **Step 1: Write the failing projection assertions**

Assert that `calculate()` reads `redeemedSets`, calls `StardustRules.getLegendInventorySummary`, displays `totalAcquiredCards`, and initializes the projected cumulative-set baseline from the redeemed count. Assert that the table row exposes the baseline and that SP still uses `cumulativeDrawn` rather than synthesized cards.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `node --test test/legend-inventory.test.js`; expected: FAIL because the current source does not read or use `redeemedSets`.

- [ ] **Step 3: Implement the calculation changes**

At the start of `calculate()` read the new input and compute:

```js
const redeemedSets = Math.max(0, Number.parseInt(document.getElementById('redeemedSets').value, 10) || 0);
const inventorySummary = StardustRules.getLegendInventorySummary({
  drawnLegendaryCards: currentCards,
  heldLegendaryCards: currentUsableCards,
  redeemedSets
});
```

Replace the old `getPreviousAdditionalCards` call and render:

- `此前合成传说` from `inventorySummary.previousCraftedCards`;
- `已获得传说（含合成）` from `inventorySummary.totalAcquiredCards`;
- a current total-set hint from `inventorySummary.totalSets`.

When building `tableData`, treat the held-card forecast as remaining inventory and seed cumulative sets with `redeemedSets`:

```js
const cumulativeSets = redeemedSets + Math.floor(usableCards / 6);
```

Keep `cumulativeDrawn` and `earnedSP = Math.floor(cumulativeDrawn * 0.1)` unchanged so synthesis does not inflate random legendary probability or SP. Preserve the existing table shape: rename the fourth table header from `此前额外传说` to `此前合成传说`, rename the corresponding row property to `previousCraftedCards`, and keep the historical dash/current calibrated value behavior. Do not add a new cashflow column; the calibrated total is represented by `可用传说总量` plus the seeded `累计成套` value.

Update final summary values to use the calibrated `lastRow.cumulativeSets` and `lastRow.usableCards`; do not add redeemed sets a second time.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `node --test test/legend-inventory.test.js`; expected: PASS.

- [ ] **Step 5: Commit the projection changes**

```bash
git add site/index.html test/legend-inventory.test.js
git commit -m "fix: include redeemed sets in card projections"
```

### Task 4: Full verification and release

**Files:**
- Verify: `site/index.html`, `site/stardust-rules.js`, `test/legend-inventory.test.js`
- Update if needed: `README.md` or user-facing docs only if labels are documented there

- [ ] **Step 1: Run all tests**

Run:

```bash
npm test
```

Expected: all existing tests plus the new inventory tests pass.

- [ ] **Step 2: Build the site**

Run `npm run build`; expected: successful static build with no syntax errors.

- [ ] **Step 3: Inspect the diff and verify compatibility**

Run `git diff HEAD~3..HEAD -- site/index.html site/stardust-rules.js test/legend-inventory.test.js` and confirm no field was removed, old snapshots default to zero, and the SP calculation still uses drawn cards only.

- [ ] **Step 4: Commit any final documentation or test corrections**

```bash
git status --short
git log -4 --oneline
```

Only commit if the verification step required a correction; use a focused message such as `test: cover legacy inventory snapshots`.

- [ ] **Step 5: Deploy only after verification succeeds**

Run `npm run deploy` from `/Volumes/Samsung980PRO/CODE/LINUXDO-js/hyb-card-dashboard` and record the deployed result. Do not claim deployment until the command succeeds.
