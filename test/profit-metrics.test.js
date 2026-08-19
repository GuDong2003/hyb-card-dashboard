import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadProfitMetrics() {
  const source = await readFile(new URL('../site/profit-metrics.js', import.meta.url), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: 'profit-metrics.js' });
  return context.window.HYBCardProfitMetrics;
}

test('formats a profit metric with day, exchange set, and amount', async () => {
  const metrics = await loadProfitMetrics();
  assert.equal(
    metrics.formatProfitMetric(90, 103, '+$429,460.30'),
    '第90天 · 第103套 · +$429,460.30'
  );
});

test('splits a profit metric into context and amount lines', async () => {
  const metrics = await loadProfitMetrics();
  assert.deepEqual(JSON.parse(JSON.stringify(metrics.getProfitMetricParts(19, 21, '−$59,661.50'))), {
    context: '第19天 · 第21套',
    amount: '−$59,661.50'
  });
});

test('maps summary cards to their corresponding simulation days', async () => {
  const metrics = await loadProfitMetrics();
  const days = {
    lastDay: 90,
    breakevenDay: 35,
    drawdownDay: 19,
    maxProfitDay: 86
  };

  assert.equal(metrics.getSummaryJumpDay('last', days), 90);
  assert.equal(metrics.getSummaryJumpDay('breakeven', days), 35);
  assert.equal(metrics.getSummaryJumpDay('drawdown', days), 19);
  assert.equal(metrics.getSummaryJumpDay('max-profit', days), 86);
  assert.equal(metrics.getSummaryJumpDay('breakeven', { ...days, breakevenDay: -1 }), null);
});

test('keeps the six summary cards in the requested order', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const summaryStart = html.indexOf('<section class="summary-grid"');
  const summaryEnd = html.indexOf('</section>', summaryStart);
  const summary = html.slice(summaryStart, summaryEnd);
  const ids = ['sumCards', 'sumSets', 'sumBreakEven', 'sumDrawdown', 'sumMaxProfit', 'sumProfit'];
  const positions = ids.map((id) => summary.indexOf(`id="${id}"`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('marks summary cards and simulation rows for click-to-jump behavior', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/class="metric-card[^>]*summary-jump-card/g) || []).length, 6);
  assert.match(html, /data-summary-target="breakeven"/);
  assert.match(html, /data-simulation-day/);
  assert.match(html, /function scrollToSummaryDay/);
  assert.match(html, /row-summary-target/);
  assert.match(html, /renderProfitMetric\(\s*sumProfitElement/);
});

test('puts monetary metric context beside its hint and amount on its own line', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  for (const id of ['sumDrawdown', 'sumMaxProfit', 'sumProfit']) {
    assert.match(html, new RegExp(`id="${id}Context"`));
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="metric-heading"/);
  assert.match(html, /element\.textContent = parts\.amount/);
});
