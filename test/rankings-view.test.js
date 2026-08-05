import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index contains an in-page rankings view without a new URL route', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="rankings"/);
  assert.match(html, /id="calculatorView"/);
  assert.match(html, /id="rankingsView"/);
  assert.match(html, /rankings\.js/);
  assert.match(html, /rankings\.css/);
  assert.doesNotMatch(html, /href="\/rankings"/);
});

test('rankings client uses same-origin Worker APIs and the Card bridge events', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/rankings\/latest/);
  assert.match(source, /\/api\/rankings\/leaderboard/);
  assert.match(source, /\/api\/rankings\/snapshots/);
  assert.match(source, /HYB_CARD_RANKINGS_REQUEST/);
  assert.match(source, /HYB_CARD_RANKINGS_RESPONSE/);
  assert.match(source, /HYB_CARD_RANKINGS_BRIDGE_READY/);
  assert.match(source, /估算传说概率/);
});
