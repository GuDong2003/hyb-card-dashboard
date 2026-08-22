import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('index contains an in-page rankings view without a new URL route', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="rankings"/);
  assert.match(html, /data-view="calculator"/);
  assert.match(html, /id="calculatorView"/);
  assert.match(html, /id="rankingsView"/);
  assert.match(html, /class="topbar-view-btn(?: is-active)?"[^>]*id="rankingsNavButton"/);
  assert.doesNotMatch(html, /class="topbar-view-btn is-hidden"[^>]*id="rankingsNavButton"/);
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
  assert.match(html.slice(navIndex, actionsIndex), /id="rankingsNavButton"[^>]*data-view="rankings"/);
  assert.match(html.slice(navIndex, actionsIndex), /id="rankingsNavButton"[\s\S]*data-view="calculator"/);
});

test('adds the simplified profit link beside the profit table button', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const navStart = html.indexOf('<nav class="topbar-nav"');
  const navEnd = html.indexOf('</nav>', navStart);
  assert.ok(navStart >= 0 && navEnd > navStart);
  const nav = html.slice(navStart, navEnd);
  assert.match(nav, /<a class="topbar-view-btn" href="https:\/\/gd3210\.ccwu\.cc\/" target="_blank" rel="noopener noreferrer"[^>]*>收益-简化<\/a>/);
});

test('keeps the rankings entry visible and defaults to the rankings view', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /rankingsEntryUnlocked/);
  assert.doesNotMatch(source, /new URLSearchParams\(window\.location\.search\)/);
  assert.doesNotMatch(source, /rankingsNavButton\.classList\.toggle\('is-hidden'/);
  assert.match(source, /setDashboardView\('rankings'\)/);
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
  assert.match(header, /rankings-period-control[\s\S]*rankings-overview-search/);
  assert.match(header, /rankings-overview-search[\s\S]*id="rankingsUpdatedAt"/);
  assert.match(header, /id="rankingsSearchToggle"/);
  assert.doesNotMatch(header, /id="rankingsSortSelect"/);
});

test('keeps the rankings search collapsed to an icon until interaction', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /class="rankings-search-toggle"[^>]*id="rankingsSearchToggle"/);
  assert.match(source, /rankingsSearchToggle/);
  assert.match(source, /is-expanded/);
  assert.match(css, /\.rankings-overview-search\s*\{[\s\S]*justify-self:\s*end/);
  assert.match(css, /\.rankings-overview-search:hover,\s*\.rankings-overview-search:focus-within,\s*\.rankings-overview-search\.is-expanded/);
  assert.match(css, /\.rankings-search-toggle\s*\{[\s\S]*width:\s*34px/);
  const viewButtonStart = css.indexOf('.topbar-view-btn {');
  const viewButtonEnd = css.indexOf('}', viewButtonStart) + 1;
  assert.ok(viewButtonStart >= 0 && viewButtonEnd > viewButtonStart);
  assert.match(css.slice(viewButtonStart, viewButtonEnd), /font-size:\s*inherit/);
});

test('keeps Farm-style header spacing and the rankings inset on narrow layouts', async () => {
  const calculatorCss = await readFile(new URL('../site/calculator-ui.css', import.meta.url), 'utf8');
  const rankingsCss = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  const titleStart = calculatorCss.indexOf('.topbar-title {');
  const titleEnd = calculatorCss.indexOf('}', titleStart) + 1;
  assert.ok(titleStart >= 0 && titleEnd > titleStart);
  assert.match(calculatorCss.slice(titleStart, titleEnd), /min-width:\s*220px/);

  const narrowStart = calculatorCss.indexOf('@media (max-width: 820px)');
  const narrowEnd = calculatorCss.indexOf('@media (max-width: 680px)', narrowStart);
  assert.ok(narrowStart >= 0 && narrowEnd > narrowStart);
  const narrow = calculatorCss.slice(narrowStart, narrowEnd);
  assert.match(narrow, /\.topbar\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(narrow, /\.topbar-title\s*\{[\s\S]*flex:\s*0 0 100%/);
  assert.match(calculatorCss, /@media \(max-width: 680px\)[\s\S]*\.topbar\s*\{[\s\S]*padding:\s*10px 13px/);

  const responsiveStart = calculatorCss.indexOf('@media (max-width: 1080px)');
  const responsiveEnd = calculatorCss.indexOf('@media (max-width: 820px)', responsiveStart);
  assert.ok(responsiveStart >= 0 && responsiveEnd > responsiveStart);
  assert.match(calculatorCss.slice(responsiveStart, responsiveEnd), /\.rankings-view\s*\{[\s\S]*margin-top:\s*10px/);
  assert.match(rankingsCss, /\.topbar-nav\s*\{[\s\S]*gap:\s*4px/);
});

test('user overview explains that free pulls are estimated from paid days', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const rankingsJs = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const noticeStart = html.indexOf('id="rankingsFreePullsNotice"');
  const noticeEnd = html.indexOf('</section>', noticeStart);
  assert.ok(noticeStart >= 0 && noticeEnd > noticeStart, '用户总览上方应有免费抽数说明框');
  const notice = html.slice(noticeStart, noticeEnd);
  assert.match(notice, /<strong>免费抽数按付费天数估算<\/strong>/);
  assert.match(notice, /class="rankings-free-pulls-notice-text" id="rankingsFreePullsNoticeText"/);
  assert.match(rankingsJs, /根据消费金额反推付费天数/);
  assert.match(rankingsJs, /翻倍开始/);
  assert.doesNotMatch(notice, /接口/);
  const styleStart = css.indexOf('.rankings-free-pulls-notice {');
  const styleEnd = css.indexOf('}', styleStart) + 1;
  assert.ok(styleStart >= 0 && styleEnd > styleStart);
  assert.match(css.slice(styleStart, styleEnd), /flex-wrap\s*:\s*nowrap/);
  assert.match(css, /\.rankings-free-pulls-notice-text\s*\{[\s\S]*?color:\s*var\(--amber\)/);
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
  for (const label of ['用户', 'VIP', '传说卡数量', '消费金额', '付费抽数', '免费抽数', '兑换次数', '出卡率', '状态', '趋势', '收益表']) {
    assert.match(table, new RegExp(`>${label}`));
  }
  for (const sortKey of ['user', 'legend', 'spend', 'pulls', 'sets', 'probability']) {
    assert.match(table, new RegExp(`data-rank-sort="${sortKey}"`));
  }
  assert.match(table, /colspan="12"/);
  assert.match(css, /\.rankings-table\s*\{[\s\S]*table-layout\s*:\s*fixed/);
  assert.match(css, /\.rankings-col-rank\s*\{[\s\S]*width\s*:\s*5%/);
  assert.match(css, /\.rankings-col-vip\s*\{[\s\S]*width\s*:\s*5%/);
  assert.match(css, /\.rankings-col-user\s*\{[\s\S]*width\s*:\s*16%/);
});

test('ranking rows provide a calculator import action only when data is complete', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /<script src="\/calculator-import\.js"><\/script>/);
  assert.match(html, /class="rankings-col-calculator"/);
  assert.match(html, /<th class="rank-calculator-header">收益表<\/th>/);
  assert.match(source, /buildImportData\(row\)/);
  assert.match(source, /data-calculator-import/);
  assert.match(source, /导入计算/);
  assert.match(source, /数据不完整，无法导入/);
  assert.match(source, /applyCalculatorImport\(data, \{ updateUrl: true, captureUndo: true \}\)/);
  assert.match(html, /window\.applyCalculatorImport\s*=/);
  assert.match(html, /applyCalculatorImportFromLocation\(\)/);
  assert.match(html, /撤销导入/);
  assert.match(css, /\.rank-calculator-header,\s*\.rank-calculator\s*\{[\s\S]*text-align:\s*center/);
});

test('calculator import undo stays beside the prediction basis title', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/calculator-ui.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');

  assert.match(html, /class="input-section-title-row"/);
  assert.match(html, /id="calculatorImportUndoButton"[^>]*hidden/);
  assert.match(html, /window\.undoCalculatorImport\s*=/);
  assert.match(source, /captureUndo: true/);
  assert.match(css, /\.input-section-title-row\s*\{/);
  assert.match(css, /\.calculator-import-undo\s*\{/);
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
  assert.match(source, /VIP_DAILY_PAID_PULLS\s*=\s*600/);
  assert.match(source, /VIP_DAILY_FREE_PULLS\s*=\s*50/);
  assert.match(source, /ORDINARY_DAILY_PAID_PULLS\s*=\s*400/);
  assert.match(source, /ORDINARY_DAILY_FREE_PULLS\s*=\s*30/);
  assert.match(source, /paidPulls/);
  assert.match(source, /freePulls/);
  assert.match(source, /low_sample/);
  assert.match(source, /estimateDayStartAt/);
  assert.match(source, /estimateUsesHistoricalData/);
  assert.match(source, /完整天数 · 按截至/);
  assert.match(source, /暂无完整共同日期/);
  assert.match(source, /missing_common_day/);
  assert.match(source, /dayStartAtForCapturedAt/);
  assert.match(source, /missing_epic/);
  assert.match(source, /paidPulls/);
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
  assert.match(html, /class="rankings-trend-chart-layout"/);
  assert.match(html, /id="rankingsTrendYAxis"/);
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
  assert.match(source, /const TREND_CHART_FIXED_AXIS_WIDTH = 86;/);
  assert.match(source, /number > 0 \? number : null/);
  assert.match(source, /function niceTrendAxis/);
  assert.match(source, /const candidateSteps = new Set/);
  assert.match(source, /const maximumTickCount = minimumTickCount \+ 3/);
  assert.match(source, /const axisWidth = TREND_CHART_FIXED_AXIS_WIDTH;/);
  assert.match(source, /rankingsTrendYAxis/);
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
  assert.match(css, /\.rankings-trend-chart-layout\s*\{/);
  assert.match(css, /\.rankings-trend-y-axis\s*\{/);
  assert.match(css, /\.rankings-trend-backdrop\s*\{/);
  assert.match(css, /\.rankings-trend-modal\s*\{/);
  assert.match(css, /\.trend-point:hover/);
  assert.match(source, /trend-point-wrap/);
  assert.match(source, /trend-point-tooltip/);
  const tooltipStart = css.indexOf('.trend-point-tooltip text {');
  const tooltipEnd = css.indexOf('}', tooltipStart) + 1;
  assert.ok(tooltipStart >= 0 && tooltipEnd > tooltipStart);
  assert.match(css.slice(tooltipStart, tooltipEnd), /fill\s*:\s*var\(--text\)/);
  assert.doesNotMatch(css.slice(tooltipStart, tooltipEnd), /var\(--ink\)/);

  const helperNames = ['formatDecimal', 'formatUsd', 'formatProbability', 'formatNumber', 'trendMetricFormat', 'trendMetricValue', 'formatTrendValue', 'formatTrendAxisValue'];
  const helperSources = helperNames.map((name) => source.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    \\}`))?.[0]);
  assert.ok(helperSources.every(Boolean), 'trend format helpers should be present');
  const context = { state: { trend: { metric: 'epicTotal' } } };
  vm.runInNewContext(`const TREND_METRIC_FORMATS = {
    epicTotal: { value: 'integer', axis: 'integer' },
    spendUsd: { value: 'currency', axis: 'integer' },
    estimatedPulls: { value: 'integer', axis: 'integer' },
    exchangeCount: { value: 'integer', axis: 'integer' },
    estimatedLegendProbability: { value: 'probability', axis: 'decimal', scale: 100, suffix: '%', axisMaxFractionDigits: 5 }
  };\n${helperSources.join('\n')}\nthis.trendMetricValue = trendMetricValue;\nthis.formatTrendValue = formatTrendValue;\nthis.formatTrendAxisValue = formatTrendAxisValue;`, context);
  assert.equal(context.trendMetricValue({ epicTotal: 42.6 }, 'epicTotal'), 43);
  assert.equal(context.trendMetricValue({ estimatedPulls: 42.6 }, 'estimatedPulls'), 43);
  assert.equal(context.trendMetricValue({ estimatedLegendProbability: 0.00731 }, 'estimatedLegendProbability'), 0.00731);
  assert.equal(context.formatTrendValue(42.6, 'epicTotal'), '43');
  assert.equal(context.formatTrendValue(42.6, 'estimatedPulls'), '43');
  assert.equal(context.formatTrendValue(3.25, 'exchangeCount'), '3');
  assert.equal(context.formatTrendValue(0.00731, 'estimatedLegendProbability'), '0.731%');
  assert.equal(context.formatTrendAxisValue(5.4, 'epicTotal', 0), '5');
  assert.equal(context.formatTrendAxisValue(0.731, 'estimatedLegendProbability', 3), '0.731%');
});

test('trend chart keeps the y-axis focused on the visible data range', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const helperNames = [
    'trendAxisValue',
    'trendMetricFormat',
    'niceTrendStep',
    'nextNiceTrendStep',
    'niceTrendAxis',
    'trendAxisDomain'
  ];
  const helperSources = helperNames.map((name) => extractFunction(source, name));
  const context = { state: { trend: { metric: 'epicTotal' } } };
  vm.runInNewContext(`const TREND_CHART_AXIS_PADDING_RATIO = 0.03;
const TREND_METRIC_FORMATS = {
  epicTotal: { value: 'integer', axis: 'integer' },
  estimatedLegendProbability: { value: 'probability', axis: 'decimal', scale: 100, suffix: '%', axisMaxFractionDigits: 5 }
};
${helperSources.join('\n')}\nthis.trendAxisDomain = trendAxisDomain;`, context);

  const focused = context.trendAxisDomain([32, 94], 'epicTotal');
  assert.ok(focused.min > 0, 'ordinary trend metrics should not fall back to a zero baseline');
  assert.ok(focused.min >= 30 && focused.min <= 32, 'integer axes should start close to the visible minimum');
  assert.ok(focused.max >= 94 && focused.max <= 100, 'integer axes should end close to the visible maximum');
  assert.ok(focused.max - focused.min <= 70, 'the axis should be materially tighter than 0–125');

  const flat = context.trendAxisDomain([42, 42], 'epicTotal');
  assert.ok(flat.min < 42 && flat.max > 42, 'flat data should receive a usable breathing range');

  const probability = context.trendAxisDomain([0.00731, 0.00731], 'estimatedLegendProbability');
  assert.ok(probability.min >= 0, 'percentage axes should never dip below zero');

  assert.match(html, /preserveAspectRatio="none"/);
  assert.match(source, /stroke-width="2\.4"/);
  assert.match(css, /\.trend-point\s*\{[\s\S]*opacity:\s*\.16/);
  const gridStart = css.indexOf('.trend-grid-line {');
  const gridEnd = css.indexOf('}', gridStart) + 1;
  assert.match(css.slice(gridStart, gridEnd), /stroke:\s*var\(--line-soft\)/);
  assert.doesNotMatch(css.slice(gridStart, gridEnd), /stroke-dasharray/);
});

test('trend user search keeps the add-user label on one line', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');
  const searchStart = css.indexOf('.rankings-trend-search {');
  const searchEnd = css.indexOf('}', searchStart) + 1;
  assert.ok(searchStart >= 0 && searchEnd > searchStart);
  const searchStyle = css.slice(searchStart, searchEnd);
  assert.match(searchStyle, /min-width\s*:\s*min\(\s*420px\s*,\s*100%\s*\)/);

  const labelStart = css.indexOf('.rankings-trend-search > span {');
  const labelEnd = css.indexOf('}', labelStart) + 1;
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  assert.match(css.slice(labelStart, labelEnd), /white-space\s*:\s*nowrap/);
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
  assert.match(source, /AUTO_REFRESH_INTERVAL_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /CAPTURE_BUCKET_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /function scheduleHourlyRefresh/);
  assert.match(source, /function runHourlyRefresh/);
  assert.match(source, /configureHourlyRefresh\(\{ runNow: state\.settings\.hourlyRefresh \}\)/);
  assert.match(source, /configureHourlyRefresh\(\{ runNow: true, delayMs: 600 \}\)/);
  assert.doesNotMatch(source, /state\.view !== 'rankings' \|\| state\.busy/);
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
  assert.match(source, /if \(!force && !retry && latest\.snapshot && !latest\.stale\)/);
  assert.match(source, /正在检查云端榜单/);
  assert.match(source, /正在检查榜单新鲜度/);
  assert.match(source, /正在等待用户脚本连接/);
  assert.match(source, /正在请求最新榜单/);
  assert.match(source, /!state\.loaded/);
  assert.match(source, /loadRankingsView\(\{ refresh: true \}\)/);
  assert.match(source, /loadRankingsView\(\{ autoRefresh: true \}\)/);
  assert.match(source, /if \(refresh \|\| autoRefresh\)/);
  assert.match(source, /is-busy/);
  assert.match(css, /\.rankings-source-status\.is-busy/);
  assert.match(css, /\.rankings-source-status\.is-busy::before/);
});

test('rankings retries failed bridge requests like Farm Dashboard', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');

  assert.match(source, /RANKINGS_RETRY_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /function scheduleRankingsRetry/);
  assert.match(source, /1小时后最多自动重试1次/);
  assert.match(source, /MAX_AUTO_RETRIES\s*=\s*1/);
  assert.match(source, /errorCanAutoRetry/);
  assert.match(source, /userscript_missing/);
  assert.match(source, /scriptUpdateRequired/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /pageshow/);
  assert.match(source, /online/);
  assert.match(source, /function runRankingsRetryNow/);
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

test('shows the pin button when hovering anywhere on a ranking row', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(css, /\.rankings-table tbody tr:hover \.rankings-pin-button/);
  assert.doesNotMatch(css, /\.rank-user-button:hover \.rankings-pin-button/);
});

test('centers ranking columns except money and pull-count columns', async () => {
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(source, /<td class="rank-vip-cell">/);
  assert.match(css, /\.rankings-table th\s*\{[\s\S]*text-align:\s*center/);
  assert.match(css, /\.rank-number,\s*\.rank-vip-cell,\s*\.rank-legend,\s*\.rank-sets,\s*\.rank-probability,\s*\.rank-status,\s*\.rank-trend/);
  assert.match(css, /\.rank-user-cell\s*\{[\s\S]*text-align:\s*left/);
  assert.match(css, /\.rank-user-button\s*\{[\s\S]*justify-content:\s*flex-start/);
  assert.match(css, /\.rank-user-button\s*\{[\s\S]*text-align:\s*left/);
  assert.match(css, /\.rankings-table th:nth-child\(3\),\s*\.rankings-table th:nth-child\(5\),\s*\.rankings-table th:nth-child\(6\),\s*\.rankings-table th:nth-child\(7\)\s*\{[\s\S]*text-align:\s*left/);
  assert.doesNotMatch(css, /\.rank-spend,\s*\.rank-paid-pulls,\s*\.rank-free-pulls\s*\{[\s\S]*text-align:\s*center/);
});

test('uses readable Farm-style typography for the rankings table', async () => {
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(css, /\.rankings-table\s*\{[\s\S]*font-size:\s*\.9rem/);
  assert.match(css, /\.rankings-table th\s*\{[\s\S]*font-size:\s*\.8rem/);
  assert.match(css, /\.rank-vip\s*\{[\s\S]*font-size:\s*\.72rem/);
  assert.match(css, /\.rank-status\s*\{[\s\S]*font-size:\s*\.8rem/);
  assert.match(css, /\.rankings-calculator-button\s*\{[\s\S]*font-size:\s*\.78rem/);
});

test('renders right-aligned pagination controls below the rankings table', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /id="rankingsPagination"/);
  assert.match(html, /id="rankingsPaginationSummary"/);
  assert.match(html, /id="rankingsPageSize"/);
  assert.match(html, /id="rankingsPaginationControls"/);
  assert.match(html, /id="rankingsPreviousPage"/);
  assert.match(html, /id="rankingsPageIndicator"/);
  assert.match(html, /id="rankingsNextPage"/);
  assert.match(source, /pageSize:\s*50/);
  assert.match(source, /function renderRankingsPagination/);
  assert.match(source, /normalRows\.slice\(/);
  assert.match(source, /rankingsPageSize/);
  assert.match(css, /\.rankings-table-footer\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /\.rankings-pagination-controls\s*\{[\s\S]*margin-left:\s*auto/);
});

test('adds a complete-days filter to the status header', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/rankings.css', import.meta.url), 'utf8');

  assert.match(html, /id="rankingsCompleteDaysOnly"/);
  assert.match(html, /仅完整/);
  assert.match(source, /onlyCompleteDays:\s*false/);
  assert.match(source, /function isCompleteDayRow/);
  assert.match(source, /state\.onlyCompleteDays/);
  assert.match(source, /rankingsCompleteDaysOnly/);
  assert.match(css, /\.rank-status-filter\s*\{[\s\S]*display:\s*inline-flex/);
});
