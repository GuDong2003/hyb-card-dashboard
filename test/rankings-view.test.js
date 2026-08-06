import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('index contains an in-page rankings view without a new URL route', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="rankings"/);
  assert.match(html, /data-view="calculator"/);
  assert.match(html, /id="calculatorView"/);
  assert.match(html, /id="rankingsView"/);
  assert.match(html, /class="topbar-view-btn is-hidden"[^>]*id="rankingsNavButton"/);
  assert.match(html, /rankings\.js/);
  assert.match(html, /rankings\.css/);
  assert.doesNotMatch(html, /href="\/rankings"/);
  assert.match(html, /id="rankingsPeriodSelect"/);
  assert.doesNotMatch(html, /id="rankingsSortSelect"/);
  assert.match(html, /data-rank-sort="probability"/);
  assert.match(html, /data-rank-sort="legend"[^>]*aria-sort="descending"/);
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
  assert.match(html.slice(navIndex, actionsIndex), /id="rankingsNavButton"[^>]*data-view="rankings"/);
});

test('unlocks the hidden rankings entry only with the view query parameter', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(source, /get\('view'\) === 'rankings'/);
  assert.match(source, /rankingsNavButton/);
  assert.match(source, /setDashboardView\(rankingsUnlocked \? 'rankings' : 'calculator'\)/);
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
  assert.equal(html.includes('class="rankings-switcher panel"'), false);
  assert.equal(html.includes('class="rankings-table-intro"'), false);
  assert.equal(html.includes('用户历史'), false);
  assert.equal(html.includes('id="rankingsUserDetail"'), false);
});

test('rankings table header keeps title, period, search and updated time in one toolbar', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const headerStart = html.indexOf('<div class="panel-header rankings-panel-header">');
  const headerEnd = html.indexOf('</div>', html.indexOf('id="rankingsUpdatedAt"', headerStart)) + '</div>'.length;
  assert.ok(headerStart >= 0 && headerEnd > headerStart);
  const header = html.slice(headerStart, headerEnd);
  const positions = [
    header.indexOf('id="rankingsBoardTitle"'),
    header.indexOf('id="rankingsPeriodSelect"'),
    header.indexOf('id="rankingsUserSearch"'),
    header.indexOf('id="rankingsUpdatedAt"')
  ];
  assert.ok(positions.every((position) => position >= 0), '工具栏应包含标题、周期、搜索和更新时间');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '工具栏顺序应为标题、周期、搜索、更新时间');
  assert.doesNotMatch(header, /id="rankingsSortSelect"/);
});

test('rankings table does not create an independent vertical scroll container', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const tableWrapStart = css.indexOf('.rankings-table-wrap {');
  const tableWrapEnd = css.indexOf('}', tableWrapStart) + 1;
  assert.ok(tableWrapStart >= 0 && tableWrapEnd > tableWrapStart);
  const tableWrap = css.slice(tableWrapStart, tableWrapEnd);
  assert.doesNotMatch(tableWrap, /max-height\s*:/);
  assert.match(tableWrap, /overflow-x\s*:\s*auto/);
  assert.match(tableWrap, /overflow-y\s*:\s*(?:visible|clip)/);
});

test('rankings sync controls rely on the shared section gap', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const setupStart = css.indexOf('.rankings-setup {');
  const setupEnd = css.indexOf('}', setupStart) + 1;
  assert.ok(setupStart >= 0 && setupEnd > setupStart);
  const setup = css.slice(setupStart, setupEnd);
  assert.match(setup, /margin-bottom\s*:\s*0/);
});

test('rankings sections share one vertical rhythm and keep clear right inset', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const viewStart = css.indexOf('.rankings-view {');
  const viewEnd = css.indexOf('}', viewStart) + 1;
  assert.ok(viewStart >= 0 && viewEnd > viewStart);
  const view = css.slice(viewStart, viewEnd);
  assert.match(view, /display\s*:\s*flex/);
  assert.match(view, /gap\s*:\s*var\(--rankings-section-gap\)/);
  assert.match(view, /(?:padding-right\s*:\s*1[468]px|padding\s*:\s*0\s+1[468]px\s+16px\s+0)/);
  assert.match(css, /--rankings-section-gap\s*:\s*12px/);
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
  assert.match(secondary, /id="rankingsHourlyRefresh"/);
  assert.ok(
    secondary.indexOf('id="rankingsHourlyRefresh"') < secondary.indexOf('id="rankingsAutoUpload"'),
    '每小时刷新开关应位于自动上传左侧'
  );
  assert.match(secondary, /id="rankingsInstallLink"[^>]*>安装用户脚本</);
  assert.match(secondary, /href="https:\/\/cdk\.hybgzs\.com\/"[^>]*>打开 CDK</);
  assert.doesNotMatch(html, />检查更新</);
  assert.doesNotMatch(html, />安装同步脚本</);
});

test('user overview shows ranking and all core metrics', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const tableStart = html.indexOf('<table class="rankings-table">');
  const tableEnd = html.indexOf('</table>', tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const table = html.slice(tableStart, tableEnd);
  assert.match(table, /<colgroup>[\s\S]*class="rankings-col-rank"[\s\S]*class="rankings-col-vip"[\s\S]*class="rankings-col-user"/);
  assert.ok(table.indexOf('>排名') < table.indexOf('>VIP'));
  assert.ok(table.indexOf('>VIP') < table.indexOf('>用户'));
  assert.match(table, />趋势</);
  assert.match(source, /data-trend-user/);
  assert.match(table, />排名</);
  for (const label of ['用户', 'VIP', '传说卡数量', '消费金额', '抽卡次数', '兑换次数', '出卡率', '状态', '趋势']) {
    assert.match(table, new RegExp(`>${label}`));
  }
  for (const sortKey of ['user', 'legend', 'spend', 'pulls', 'sets', 'probability']) {
    assert.match(table, new RegExp(`data-rank-sort="${sortKey}"`));
  }
  assert.match(table, /colspan="10"/);
  assert.match(css, /\.rankings-table\s*\{[\s\S]*table-layout\s*:\s*fixed/);
  assert.match(css, /\.rankings-col-rank\s*\{[\s\S]*width\s*:\s*5%/);
  assert.match(css, /\.rankings-col-vip\s*\{[\s\S]*width\s*:\s*6%/);
  assert.match(css, /\.rankings-col-user\s*\{[\s\S]*width\s*:\s*18%/);
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
  assert.doesNotMatch(source, /rankingsSortSelect/);
  assert.match(source, /sort:\s*'legend'/);
  assert.match(source, /sortDirection\s*:\s*'desc'/);
  assert.match(source, /function sortRowsForDisplay/);
  assert.match(source, /function renderSortHeaders/);
  assert.match(source, /SPEND_VALUE_PER_USD\s*=\s*500000/);
  assert.match(source, /运气榜/);
  assert.match(source, /partialRows/);
});

test('rankings view provides daily and raw-capture user trend controls', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /id="rankingsTrendPanel"/);
  assert.match(html, /id="rankingsTrendModeDaily"/);
  assert.match(html, /id="rankingsTrendModeSnapshot"/);
  assert.match(html, /id="rankingsTrendPeriodSelect"/);
  assert.match(html, /id="rankingsTrendMetric"/);
  assert.match(html, /id="rankingsTrendUserSearch"/);
  assert.match(html, /id="rankingsTrendChart"/);
  assert.match(html, /id="rankingsTrendBackdrop"/);
  assert.match(html, /id="rankingsTrendCloseButton"/);
  assert.match(source, /function getTrendDayKey/);
  assert.match(source, /function aggregateTrendRows/);
  assert.match(source, /state\.trend\.period\s*=\s*state\.period/);
  assert.match(source, /function renderTrendPeriodControl/);
  assert.match(source, /endsWith\(`_\$\{period\}`\)/);
  assert.match(source, /function openTrendModal/);
  assert.match(source, /function closeTrendModal/);
  assert.match(source, /\/api\/rankings\/history\?userId=/);
  assert.match(source, /function renderTrendChart/);
  assert.match(source, /function niceTrendAxis/);
  assert.match(source, /function trendAxisPrecision/);
  assert.match(source, /function formatTrendAxisValue\(value, metric, precision\)/);
  assert.match(source, /formatTrendValue\(value, state\.trend\.metric\)/);
  assert.match(source, /class="trend-point"[\s\S]*?<title>/);
  assert.match(source, /Asia\/Shanghai/);
  assert.match(source, /#rankingsTrendMetric/);
  assert.match(source, /data-trend-mode/);
  assert.match(source, /#rankingsTrendAddButton/);
  assert.match(source, /renderTrendUserOptions\(\)/);
  assert.match(source, /renderTrendSelection\(\)/);
  assert.match(source, /renderTrendChart\(\)/);
  assert.match(css, /\.rankings-trend-panel\s*\{/);
  assert.match(css, /\.rankings-trend-chart-wrap\s*\{/);
  assert.match(css, /\.rankings-trend-backdrop\s*\{/);
  assert.match(css, /\.rankings-trend-modal\s*\{/);
  assert.match(css, /\.trend-point:hover/);
  assert.match(source, /trend-point-wrap/);
  assert.match(source, /trend-point-tooltip/);

  const helperNames = ['formatDecimal', 'formatUsd', 'formatProbability', 'formatTrendValue', 'formatTrendAxisValue'];
  const helperSources = helperNames.map((name) => source.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    \\}`))?.[0]);
  assert.ok(helperSources.every(Boolean), 'trend format helpers should be present');
  const context = { state: { trend: { metric: 'epicTotal' } } };
  vm.runInNewContext(`${helperSources.join('\n')}\nthis.formatTrendValue = formatTrendValue;\nthis.formatTrendAxisValue = formatTrendAxisValue;`, context);
  assert.equal(context.formatTrendValue(0.00731, 'estimatedLegendProbability'), '0.731%');
  assert.equal(context.formatTrendAxisValue(5.4, 'epicTotal', 0), '5');
  assert.equal(context.formatTrendAxisValue(0.731, 'estimatedLegendProbability', 3), '0.731%');
});

test('rankings client accepts a multi-source local bundle before upload', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /localSnapshots/);
  assert.match(source, /Array\.isArray\([\s\S]*snapshots/);
  assert.match(source, /scope[\s\S]*friends/);
  assert.match(source, /merge[\s\S]*leaderboards/i);
});

test('rankings client persists upload consent and gates snapshot uploads', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /hyb-card-rankings-settings-v1/);
  assert.match(source, /autoUpload\s*:\s*false/);
  assert.match(source, /hourlyRefresh\s*:\s*false/);
  assert.match(source, /HOURLY_REFRESH_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
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
  assert.match(source, /\/api\/rankings\/history\?userId=/);
  assert.doesNotMatch(source, /function loadUserHistory/);
});

test('rankings client uses refresh and cloud upload labels', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(source, /↻ 立即刷新/);
  assert.match(source, /上传云端/);
  assert.match(source, /state\.busy \? '↻ 同步中…' : '↻ 立即刷新'/);
});

test('rankings refresh bypasses fresh snapshots and exposes running status', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  assert.match(source, /if \(!force && latest\.snapshot && !latest\.stale\)/);
  assert.match(source, /正在检查云端榜单/);
  assert.match(source, /正在等待用户脚本连接/);
  assert.match(source, /正在请求最新榜单/);
  assert.match(source, /!state\.loaded/);
  assert.match(source, /loadRankingsView\(\{ refresh: true \}\)/);
  assert.match(source, /is-busy/);
  assert.match(css, /\.rankings-source-status\.is-busy/);
  assert.match(css, /\.rankings-source-status\.is-busy::before/);
});

test('renders pinned users directly below the sticky table header', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /id="rankingsPinnedBody"/);
  assert.match(html, /id="rankingsPinnedBody"[\s\S]*id="rankingsTableBody"/);
  assert.doesNotMatch(html, /id="rankingsPinnedStrip"/);
  assert.doesNotMatch(html, /id="rankingsPinnedList"/);
  assert.match(source, /PINS_STORAGE_KEY/);
  assert.match(source, /pinnedUserIds/);
  assert.match(source, /data-pin-user/);
  assert.match(source, /function togglePinnedUser/);
  assert.match(source, /function renderRankingsTableRows/);
  assert.match(source, /rankingsPinnedBody/);
  assert.match(source, /is-pinned-row/);
  assert.match(css, /\.rankings-table th\s*\{[\s\S]*position\s*:\s*sticky/);
  assert.match(css, /\.rankings-pinned-row td\s*\{[\s\S]*position\s*:\s*sticky/);
  assert.match(css, /\.rankings-pin-button/);
});
