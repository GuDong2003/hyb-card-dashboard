import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadRules() {
  const source = await readFile(new URL('../site/stardust-rules.js', import.meta.url), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  return context.StardustRules;
}

test('calibrates legendary inventory with redeemed sets and held cards', async () => {
  const rules = await loadRules();
  const summary = rules.getLegendInventorySummary({
    drawnLegendaryCards: 40,
    heldLegendaryCards: 33,
    redeemedSets: 2
  });

  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    totalAcquiredCards: 45,
    previousCraftedCards: 5,
    totalSets: 7,
    redeemableHeldSets: 5
  });
});

test('keeps redeemed set history when fewer than six legendary cards remain', async () => {
  const rules = await loadRules();
  const summary = rules.getLegendInventorySummary({
    drawnLegendaryCards: 40,
    heldLegendaryCards: 3,
    redeemedSets: 2
  });

  assert.equal(summary.totalAcquiredCards, 15);
  assert.equal(summary.previousCraftedCards, 0);
  assert.equal(summary.totalSets, 2);
  assert.equal(summary.redeemableHeldSets, 0);
});

test('clamps invalid inventory values and defaults missing redeemed sets to zero', async () => {
  const rules = await loadRules();
  const summary = rules.getLegendInventorySummary({
    drawnLegendaryCards: 'invalid',
    heldLegendaryCards: -3,
    redeemedSets: undefined
  });

  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    totalAcquiredCards: 0,
    previousCraftedCards: 0,
    totalSets: 0,
    redeemableHeldSets: 0
  });
});

test('exposes redeemed sets and renames the held legendary inventory field', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  assert.match(html, /<label for="redeemedSets">已兑换套数/);
  assert.match(html, /<input type="number" id="redeemedSets"[^>]*value=""/);
  assert.match(html, /<label for="currentUsableCards">当前可用传说[\s\S]*含合成/);
  assert.match(html, /const SNAPSHOT_VALUE_FIELDS = \[[\s\S]*['"]redeemedSets['"]/);
  assert.match(html, /saved\.values\.redeemedSets === undefined/);
});

test('top summary reports cumulative legendary acquisition including redeemed sets', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  assert.match(html, /<span class="metric-label">预计累计获取传说<\/span>/);
  assert.match(html, /const totalAcquiredCards\s*=\s*lastRow\.usableCards\s*\+\s*redeemedSets\s*\*\s*6/);
  assert.match(html, /const drawnAcquiredCards\s*=\s*lastRow\.cumulativeDrawn/);
  assert.match(html, /const craftedAcquiredCards\s*=\s*totalAcquiredCards\s*-\s*drawnAcquiredCards/);
  assert.match(html, /drawnAcquiredCards\s*\+\s*" \+ "\s*\+\s*craftedAcquiredCards/);
  assert.match(html, /<th>可用传说总量<\/th>/);
});

test('seeds projected sets from redeemed history without inflating drawn cards or SP', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  assert.match(html, /const redeemedSets = Math\.max\(0, Number\.parseInt\(document\.getElementById\('redeemedSets'\)\.value, 10\) \|\| 0\)/);
  assert.match(html, /StardustRules\.getLegendInventorySummary\(\{[\s\S]*redeemedSets[\s\S]*\}\)/);
  assert.match(html, /id="totalAcquiredCardsText"/);
  assert.match(html, /id="previousCraftedCardsText"/);
  assert.match(html, /id="currentTotalSetsText"/);
  assert.match(html, /<th>此前合成传说<\/th>/);
  assert.match(html, /const redeemedSetBaseline = day < currentDay \? 0 : redeemedSets/);
  assert.match(html, /const cumulativeSets = redeemedSetBaseline \+ Math\.floor\(usableCards \/ 6\)/);
  assert.match(html, /const earnedSP = Math\.floor\(cumulativeDrawn \* 0\.1\)/);
  assert.match(html, /StardustRules\.getForgeProjection\(\{[\s\S]*currentStardust: startingStardust/);
  assert.match(html, /const projectedCraftedCards = Math\.max\(0, craftedCards - historicalCraftedCards\)/);
  assert.match(html, /const usableCards = baseUsableCards \+ projectedCraftedCards/);
});

test('leaves manual inventory inputs blank for new users while keeping the saved snapshot key', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  assert.match(html, /<label for="currentCards">抽出传说\s*<span class="field-hint">不含合成<\/span><\/label>/);
  assert.match(html, /<input type="number" id="currentCards"[^>]*value=""/);
  assert.match(html, /<label for="currentUsableCards">当前可用传说\s*<span class="field-hint">含合成<\/span><\/label>/);
  assert.match(html, /<input type="number" id="currentUsableCards"[^>]*value=""/);
  assert.match(html, /<input type="number" id="redeemedSets"[^>]*value=""/);
  assert.match(html, /<input type="number" id="stardustBalance"[^>]*value=""/);
  assert.match(html, /const SNAPSHOT_STORAGE_KEY = 'legend-card-calculator-snapshot-v1'/);
});

test('keeps the inventory section labels on one line in the compact layout', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/calculator-ui.css', import.meta.url), 'utf8');

  assert.match(html, /<div class="input-section inventory-section">[\s\S]*<h3 class="input-section-title">库存与星尘<\/h3>/);
  assert.match(css, /\.inventory-section \.form-group label[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /\.inventory-section \.field-hint[\s\S]*white-space:\s*nowrap/);
});

test('exposes the limited-time pull doubling controls and persists their settings', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/calculator-ui.css', import.meta.url), 'utf8');

  assert.match(html, /id="boostEventCard"/);
  assert.match(html, /id="enableBoost"[^>]*checked/);
  assert.match(html, /id="boostEndMode"/);
  assert.match(html, /<option value="season">赛季末<\/option>/);
  assert.match(html, /<option value="days">自定义持续天数<\/option>/);
  assert.match(html, /id="boostDurationDays"[^>]*max="72"/);
  assert.match(html, /id="boostEventDayText"/);
  assert.match(html, /const SNAPSHOT_CHECKBOX_FIELDS = \[[\s\S]*['"]enableBoost['"]/);
  assert.match(html, /const BOOST_SETTING_FIELDS = \[[\s\S]*['"]boostDurationDays['"]/);
  assert.match(html, /function getCumulativePullsThroughCurrentDay\(/);
  assert.match(html, /StardustRules\.getDailyQuotaForSeasonDay\(/);
  assert.match(css, /\.boost-event-card\s*\{/);
});
