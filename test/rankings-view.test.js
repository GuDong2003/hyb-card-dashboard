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
  assert.match(html, /传说卡数量/);
  assert.match(html, /id="rankingsPartialNotice"/);
});

test('places view navigation beside the title like Farm Dashboard', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const titleIndex = html.indexOf('<div class="topbar-title">');
  const navIndex = html.indexOf('<nav class="topbar-nav"');
  const actionsIndex = html.indexOf('<nav class="topbar-actions"');
  assert.ok(titleIndex >= 0);
  assert.ok(navIndex > titleIndex);
  assert.ok(actionsIndex > navIndex);
  assert.match(html.slice(navIndex, actionsIndex), /data-view="calculator"/);
  assert.match(html.slice(navIndex, actionsIndex), /data-view="rankings"/);
});

test('rankings view keeps script setup and upload consent controls visible', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="rankingsSetup"/);
  assert.match(html, /id="rankingsInstallLink"/);
  assert.match(html, /id="rankingsAutoUpload"/);
  assert.match(html, /id="rankingsUploadButton"/);
  assert.match(html, /自动上传/);
  assert.doesNotMatch(html, /id="rankingsInstallHint"[^>]*is-hidden/);
  assert.ok(html.includes('class="rankings-primary-actions"'));
  assert.ok(html.includes('class="rankings-secondary-actions"'));
  assert.equal(html.includes('class="rankings-toolbar"'), false);
  assert.equal(html.includes('id="rankingsTitle"'), false);
  assert.ok(html.indexOf('id="rankingsRefreshButton"') < html.indexOf('id="rankingsAutoUpload"'));
  assert.ok(
    html.indexOf('id="rankingsUserSearch"') > html.indexOf('class="rankings-table-panel"')
      && html.indexOf('id="rankingsUserSearch"') < html.indexOf('id="rankingsBoardTitle"'),
    '用户搜索框应位于用户总览标题上方'
  );
  assert.equal(html.includes('用户历史'), false);
  assert.equal(html.includes('id="rankingsUserDetail"'), false);
});

test('rankings setup separates refresh/upload actions from script controls', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const primaryStart = html.indexOf('class="rankings-primary-actions"');
  const secondaryStart = html.indexOf('class="rankings-secondary-actions"');
  assert.ok(primaryStart >= 0);
  assert.ok(secondaryStart > primaryStart);
  const primary = html.slice(primaryStart, secondaryStart);
  const secondary = html.slice(secondaryStart);
  assert.match(primary, /id="rankingsRefreshButton"[^>]*>↻ 立即刷新</);
  assert.match(primary, /id="rankingsUploadButton"[^>]*>上传云端</);
  assert.match(secondary, /id="rankingsAutoUpload"/);
  assert.match(secondary, /id="rankingsInstallLink"[^>]*>安装用户脚本</);
  assert.match(secondary, /href="https:\/\/cdk\.hybgzs\.com\/"[^>]*>打开 CDK</);
  assert.doesNotMatch(html, />检查更新</);
  assert.doesNotMatch(html, />安装同步脚本</);
});

test('user overview shows ranking and all core metrics', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const tableStart = html.indexOf('<table class="rankings-table">');
  const tableEnd = html.indexOf('</table>', tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const table = html.slice(tableStart, tableEnd);
  assert.match(table, />排名</);
  for (const label of ['用户', 'VIP', '传说卡数量', '消费金额', '抽卡次数', '兑换次数', '出卡率', '状态']) {
    assert.match(table, new RegExp(`>${label}<`));
  }
  assert.match(table, /colspan="9"/);
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
  assert.match(source, /row\.epicTotal/);
  assert.match(source, /rank-legend/);
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
  assert.match(source, /function normalizeCapturedAt/);
  assert.match(source, /lastUpdatedAt/);
  assert.match(source, /function normalizeSnapshotForUpload/);
  assert.match(source, /normalizeSnapshotForUpload\(snapshot\)/);
  assert.match(source, /userQuery/);
  assert.match(source, /filterUserRows/);
  assert.doesNotMatch(source, /\/api\/rankings\/users\?query=/);
  assert.doesNotMatch(source, /\/api\/rankings\/history\?userId=/);
  assert.doesNotMatch(source, /function loadUserHistory/);
});

test('rankings client uses refresh and cloud upload labels', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /↻ 立即刷新/);
  assert.match(source, /上传云端/);
  assert.match(source, /state\.busy \? '↻ 同步中…' : '↻ 立即刷新'/);
});
