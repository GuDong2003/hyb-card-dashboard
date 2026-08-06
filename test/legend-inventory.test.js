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
