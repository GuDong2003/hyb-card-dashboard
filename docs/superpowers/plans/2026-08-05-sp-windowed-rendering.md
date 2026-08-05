# SP Windowed Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SP allocation panel keep a two-row viewport with one buffered row before and after it, preserve full scrolling, and automatically jump to the first row that contains an SP allocation after optimal allocation.

**Architecture:** Keep the existing reward, projection, and SP allocation algorithms unchanged. Replace the full-card DOM loop with a window renderer that uses explicit CSS grid row tracks and places only the viewport plus one-row buffers into those tracks; scroll position determines which four-row window is materialized. Add a focus guard so smooth auto-navigation is not reset by intermediate scroll events, plus a finite-value guard for invalid projections.

**Tech Stack:** Vanilla JavaScript in `site/index.html`, existing CSS in `site/calculator-ui.css`, static Cloudflare Assets build.

---

### Task 1: Add SP window state and grid metrics

**Files:**
- Modify: `site/index.html` near `spAllocation` and the current SP helper functions.

- [ ] **Step 1: Add explicit window state.**

Add a module-level state object containing `totalSets`, `columns`, `totalRows`, `firstRow`, `visibleRows: 2`, `rowStep`, `frameId`, and `bound`. This state must be independent from `spAllocation` so manual allocation remains unchanged when the viewport moves.

- [ ] **Step 2: Add bounded metric helpers.**

Implement helpers with these contracts:

```js
function getSPGridColumnCount(grid) {
    const columns = getComputedStyle(grid).gridTemplateColumns
        .split(/\s+/)
        .filter(Boolean).length;
    return Math.max(1, columns || 1);
}

function getSPRowStep(grid) {
    const styles = getComputedStyle(grid);
    const height = Number.parseFloat(styles.getPropertyValue('--sp-row-height')) || 104;
    const gap = Number.parseFloat(styles.rowGap || styles.gap) || 8;
    return height + gap;
}

function normalizeSPWindowTotalSets(totalSets) {
    const parsed = Number(totalSets);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}
```

- [ ] **Step 3: Run the existing build before behavior changes.**

Run: `npm run build`

Expected: `Built static assets in card-dashboard/dist` and exit code 0.

### Task 2: Replace full SP rendering with a buffered window

**Files:**
- Modify: `site/index.html` in `renderSPPanel` and the SP card creation area.

- [ ] **Step 1: Add a single-card factory.**

Extract the current card markup into `createSPRoundCard(round, points, canIncrease)`. The factory must retain the current `sp-round`, `is-peak`, `has-points` classes, labels, and `adjustSP` handlers, while assigning explicit `gridRow` and `gridColumn` values from the window renderer.

- [ ] **Step 2: Implement `renderSPWindow`.**

The renderer must:

```js
const totalRows = Math.ceil(totalSets / columns);
const maxFirstRow = Math.max(0, totalRows - windowState.visibleRows);
const firstRow = Math.max(0, Math.min(windowState.firstRow, maxFirstRow));
grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
grid.style.gridTemplateRows = `repeat(${Math.max(1, totalRows)}, var(--sp-row-height))`;
grid.replaceChildren();

const firstRenderedRow = Math.max(0, firstRow - 1);
const lastRenderedRow = Math.min(totalRows, firstRow + windowState.visibleRows + 1);
for (let row = firstRenderedRow; row < lastRenderedRow; row += 1) {
    const firstRound = row * columns + 1;
    const lastRound = Math.min(totalSets, firstRound + columns - 1);
    for (let round = firstRound; round <= lastRound; round += 1) {
        // Create only this visible card and place it at its explicit grid cell.
    }
}
grid.scrollTop = firstRow * windowState.rowStep;
```

Only the current viewport and its adjacent one-row buffers may be appended to `#spAllocationGrid`; do not iterate over every round to create DOM nodes. The explicit grid tracks preserve the full scroll range without spacer-card nodes.

- [ ] **Step 3: Preserve the current panel summary and allocation normalization.**

Keep `spStats`, `normalizeSPAllocation`, and the current calculated reward values unchanged. `renderSPPanel` should update summary text, validate `totalSets`, configure the window state, and call `renderSPWindow`.

### Task 3: Add scroll-driven window updates and invalid-state handling

**Files:**
- Modify: `site/index.html` near the SP rendering helpers.
- Modify: `site/calculator-ui.css` for the empty/error state.

- [ ] **Step 1: Bind the grid scroll listener once.**

Add `bindSPGridScroll()` that registers one passive `scroll` listener. The listener schedules one `requestAnimationFrame`, computes:

```js
const nextFirstRow = Math.max(
    0,
    Math.min(
        Math.round(grid.scrollTop / windowState.rowStep),
        Math.max(0, windowState.totalRows - windowState.visibleRows)
    )
);
```

When the row changes, update `windowState.firstRow` and call `renderSPWindow`; otherwise do nothing. While `focusTargetRow` is active, ignore intermediate animation positions and only release the guard when the target row is reached or the short safety timer expires. Restore `scrollTop` after replacement so rerendering does not jump to the top.

- [ ] **Step 2: Keep the two-row snap behavior.**

Retain the existing `scroll-snap-type`, `scroll-snap-stop`, `scroll-behavior`, and `overscroll-behavior-y` rules. Set the grid's scroll position using the same `rowStep` used by the listener so the visual snap and logical window stay aligned.

- [ ] **Step 3: Handle invalid and empty projections without loops.**

For `totalSets === null`, clear the grid, reset its inline row styles, and append one `.sp-window-message` element with the text `预测套数异常，暂无法显示 SP 分配`. For `totalSets === 0`, show `暂无可分配轮次`. Neither branch may create SP cards or enter a round loop.

- [ ] **Step 4: Add styles for the messages and containment.**

Add styles in `site/calculator-ui.css` for `.sp-window-message` so it spans the grid width, is centered, and uses the existing muted text variables. Add `contain: layout paint` to the scroll grid without changing its two-row height or existing theme colors.

### Task 4: Focus the first allocated row after optimal allocation

**Files:**
- Modify: `site/index.html` in `autoAllocateSP` and new focus helpers.

- [ ] **Step 1: Select the focus row from the resulting allocation.**

Implement `getFirstSPFocusRound(allocation)` by finding the smallest round number whose allocated SP is greater than zero. Return `null` when the allocation is empty.

- [ ] **Step 2: Add smooth row focusing.**

Implement `focusSPRound(round)` to calculate the target row, set `windowState.firstRow` so the target is inside the two-row viewport, render the viewport plus buffers, and then call:

```js
grid.scrollTo({ top: targetRow * windowState.rowStep, behavior: 'smooth' });
```

- [ ] **Step 3: Call focus after `calculate()`.**

In `autoAllocateSP`, compute the optimal Map as today, capture the first allocated focus round, call `calculate()`, and then call `focusSPRound(focusRound)`. If no points are allocated, skip focusing. Manual +/- actions and `clearSPAllocation` must not call the focus helper.

### Task 5: Build and browser smoke verification

**Files:**
- Verify: `site/index.html`
- Verify: `site/calculator-ui.css`
- Verify: generated `dist/index.html` and `dist/calculator-ui.css`

- [ ] **Step 1: Check formatting and build output.**

Run:

```bash
git diff --check
npm run build
```

Expected: no diff-check errors and a successful static build.

- [ ] **Step 2: Verify normal DOM size.**

With the current 80-set projection, inspect the page and verify that `#spAllocationGrid .sp-round` is no more than `columns × 4` (fewer only at the season boundaries), while the grid's computed `grid-template-rows` still represents all rows.

- [ ] **Step 3: Verify large projection safety.**

In a temporary browser state, set the usable legend count high enough to produce tens of thousands of sets and call the existing calculation. Verify that page interaction remains responsive, that the number of `.sp-round` elements remains at most `columns × 4`, and that scrolling through the window does not expose blank intermediate rows.

- [ ] **Step 4: Verify scrolling and focus behavior.**

Scroll the SP panel and confirm it settles on complete rows. Click “一键最优分配” and confirm the panel scrolls to the first row containing an allocated SP, with the earliest highlighted card inside the viewport. Verify manual +/- and clearing do not cause an unexpected jump.

- [ ] **Step 5: Review the final diff.**

Run `git status --short` and inspect that only the intended HTML, CSS, generated build files, and plan/spec documents are changed. Do not deploy until the user explicitly requests deployment.
