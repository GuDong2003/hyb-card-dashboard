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

test('keeps the five-card daily cap while backfilling forge history from current dust', async () => {
  const rules = await loadRules();
  const projection = rules.getForgeProjection({
    currentDay: 7,
    currentStardust: 0,
    seasonDays: 10
  });

  assert.equal(rules.MAX_CRAFT_PER_DAY, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(projection.craftedByDay.slice(1, 8))), [1, 1, 2, 3, 3, 4, 5]);
  assert.equal(projection.dustByDay[7], 0);
  assert.equal(projection.dustByDay[6], 600);
  assert.equal(projection.craftedByDay[8], 5);
  assert.equal(projection.craftedByDay[9], 6);
});

test('models the Aug 20 limited-time pull doubling with a season-end default', async () => {
  const rules = await loadRules();
  const beforeBoost = rules.getDailyQuotaForSeasonDay(18);
  const firstBoostDay = rules.getDailyQuotaForSeasonDay(19);
  const oneDayBoost = rules.getDailyQuotaForSeasonDay(20, { durationDays: 1 });
  const activeStatus = rules.getBoostStatus(Date.parse('2026-08-20T05:00:00+08:00'));

  assert.equal(rules.BOOST_DEFAULT_DURATION_DAYS, 72);
  assert.deepEqual(JSON.parse(JSON.stringify(beforeBoost)), {
    seasonDay: 18,
    boosted: false,
    freePulls: 50,
    paidPulls: 600,
    totalPulls: 650,
    paidCost: 6000
  });
  assert.deepEqual(JSON.parse(JSON.stringify(firstBoostDay)), {
    seasonDay: 19,
    boosted: true,
    freePulls: 80,
    paidPulls: 1000,
    totalPulls: 1080,
    paidCost: 10000
  });
  assert.equal(oneDayBoost.boosted, false);
  assert.equal(rules.getCumulativePullsThroughDay(19), 12780);
  assert.deepEqual(JSON.parse(JSON.stringify(activeStatus)), {
    state: 'active',
    day: 1,
    durationDays: 72,
    startAt: rules.BOOST_START_AT,
    endAt: rules.BOOST_DEFAULT_END_AT,
    active: true
  });
});
