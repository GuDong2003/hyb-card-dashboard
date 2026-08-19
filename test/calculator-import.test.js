import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadProtocol() {
  const source = await readFile(new URL('../site/calculator-import.js', import.meta.url), 'utf8');
  const context = { window: {}, URLSearchParams };
  vm.runInNewContext(source, context, { filename: 'calculator-import.js' });
  return context.window.HYBCardCalculatorImport;
}

test('accepts a complete ranking row and defaults missing optional values', async () => {
  const protocol = await loadProtocol();
  const row = {
    epicTotal: 12,
    estimatedPulls: 2600.4,
    estimatedDays: 4,
    exchangeCount: null
  };

  assert.equal(protocol.canImportRow(row), true);
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.buildImportData(row))), {
    source: 'rankings',
    currentDay: 4,
    currentTotalDraws: 2600,
    currentCards: 12,
    currentUsableCards: 12,
    redeemedSets: 0,
    stardustBalance: 0
  });
});

test('rejects a ranking row when required data is incomplete', async () => {
  const protocol = await loadProtocol();
  const base = { epicTotal: 12, estimatedPulls: 2600, estimatedDays: 4 };

  assert.equal(protocol.canImportRow({ ...base, epicTotal: null }), false);
  assert.equal(protocol.canImportRow({ ...base, estimatedPulls: null }), false);
  assert.equal(protocol.canImportRow({ ...base, estimatedDays: null }), false);
  assert.equal(protocol.buildImportData({ ...base, estimatedPulls: null }), null);
  assert.equal(protocol.canImportRow({ ...base, estimateStatus: 'missing_current_epic', isPartial: true }), false);
  assert.equal(protocol.canImportRow({ ...base, estimateStatus: 'low_sample', isPartial: true }), false);
});

test('allows partial-day estimates and carries exchange count when present', async () => {
  const protocol = await loadProtocol();
  const data = protocol.buildImportData({
    epicTotal: 25,
    estimatedPulls: 800.8,
    estimatedDays: 2,
    exchangeCount: 3.9,
    estimateStatus: 'partial_day',
    isPartial: true
  });

  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    source: 'rankings',
    currentDay: 2,
    currentTotalDraws: 801,
    currentCards: 25,
    currentUsableCards: 7,
    redeemedSets: 3,
    stardustBalance: 0
  });
});

test('round-trips import data through the calculator query string', async () => {
  const protocol = await loadProtocol();
  const data = protocol.buildImportData({
    epicTotal: 25,
    estimatedPulls: 800,
    estimatedDays: 2,
    exchangeCount: 0
  });
  const query = protocol.buildQuery(data);

  assert.match(query, /^\?source=rankings&/);
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.readQuery(query))), JSON.parse(JSON.stringify(data)));
  assert.equal(protocol.readQuery('?source=rankings&currentDay=2'), null);
  assert.equal(protocol.readQuery('?source=other&currentDay=2&currentTotalDraws=800&currentCards=25&currentUsableCards=25&redeemedSets=0&stardustBalance=0'), null);
});

test('recalculates usable legendary cards after redeemed sets and ignores stale URL values', async () => {
  const protocol = await loadProtocol();
  const data = protocol.buildImportData({
    epicTotal: 54,
    estimatedPulls: 3900,
    estimatedDays: 6,
    exchangeCount: 6
  });

  assert.equal(data.currentCards, 54);
  assert.equal(data.redeemedSets, 6);
  assert.equal(data.currentUsableCards, 18);
  assert.equal(data.redeemedSets * 6 + data.currentUsableCards, data.currentCards);

  const query = protocol.buildQuery(data).replace('currentUsableCards=18', 'currentUsableCards=54');
  assert.match(query, /currentUsableCards=54/);
  const parsed = protocol.readQuery(query);
  assert.equal(parsed.currentUsableCards, 18);
  assert.equal(parsed.redeemedSets * 6 + parsed.currentUsableCards, parsed.currentCards);
});

test('captures and validates a one-level undo snapshot for a ranking import', async () => {
  const protocol = await loadProtocol();
  const values = {
    currentDay: '3',
    currentTotalDraws: '1950',
    currentCards: '7',
    currentUsableCards: '8',
    redeemedSets: '1',
    stardustBalance: '400',
    spPointCap: '17'
  };
  const snapshot = protocol.captureUndoState(
    values,
    '?source=manual',
    '?source=rankings&currentDay=4'
  );

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    version: 1,
    values,
    search: '?source=manual',
    targetSearch: '?source=rankings&currentDay=4'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.readUndoState(snapshot))), JSON.parse(JSON.stringify(snapshot)));
  assert.equal(protocol.readUndoState({ ...snapshot, targetSearch: '' }), null);
  assert.equal(protocol.readUndoState({ ...snapshot, values: { currentDay: '3' } }), null);
});
