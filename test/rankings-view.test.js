import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index contains an in-page rankings view without a new URL route', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="rankings"/);
  assert.match(html, /data-view="calculator"/);
  assert.match(html, /id="calculatorView"/);
  assert.match(html, /id="rankingsView"/);
  assert.match(html, /rankings\.js/);
  assert.match(html, /rankings\.css/);
  assert.doesNotMatch(html, /href="\/rankings"/);
  assert.match(html, /id="rankingsPeriodSelect"/);
  assert.match(html, /id="rankingsSortSelect"/);
  assert.match(html, /消费金额/);
  assert.match(html, /id="rankingsPartialNotice"/);
});

test('rankings view keeps script setup and upload consent controls visible', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="rankingsSetup"/);
  assert.match(html, /id="rankingsInstallLink"/);
  assert.match(html, /id="rankingsAutoUpload"/);
  assert.match(html, /id="rankingsUploadButton"/);
  assert.match(html, /自动上传/);
  assert.doesNotMatch(html, /id="rankingsInstallHint"[^>]*is-hidden/);
});

test('rankings client uses same-origin Worker APIs and the Card bridge events', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/rankings\/latest/);
  assert.match(source, /\/api\/rankings\/leaderboard/);
  assert.match(source, /\/api\/rankings\/snapshots/);
  assert.match(source, /HYB_CARD_RANKINGS_REQUEST/);
  assert.match(source, /HYB_CARD_RANKINGS_RESPONSE/);
  assert.match(source, /HYB_CARD_RANKINGS_BRIDGE_READY/);
  assert.match(source, /用户总览/);
  assert.match(source, /formatOptionalUsd/);
  assert.match(source, /rankingsPeriodSelect/);
  assert.match(source, /rankingsSortSelect/);
  assert.match(source, /SPEND_VALUE_PER_USD\s*=\s*500000/);
  assert.match(source, /运气榜/);
  assert.match(source, /partialRows/);
});

test('rankings client persists upload consent and gates snapshot uploads', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /hyb-card-rankings-settings-v1/);
  assert.match(source, /autoUpload\s*:\s*false/);
  assert.match(source, /rankingsUploadButton/);
  assert.match(source, /state\.settings\.autoUpload/);
  assert.match(source, /apiPost\('\/api\/rankings\/snapshots'/);
});
