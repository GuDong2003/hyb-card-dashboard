import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('SP cap sync distinguishes left-side recalculation from manual cap input', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  assert.match(
    html,
    /function calculate\(autoAllocateSPPoints = false, syncSPPointCap = true\)/,
    'calculate should expose an explicit SP-cap synchronization flag'
  );
  assert.match(
    html,
    /function handleSPPointCapInput\(\)[\s\S]*?calculate\(true, false\);/,
    'manual SP-cap input should preserve the value entered by the user'
  );
  assert.match(
    html,
    /const spPointCap = resolveSPPointCap\(/,
    'calculation should resolve the cap through the shared synchronization rule'
  );
  assert.match(
    html,
    /lastPreliminaryRow\.usableCards,\s*syncSPPointCap\n\s*\);/,
    'left-side recalculation should derive the cap from the latest available legendary total'
  );

  const toolbarStart = html.indexOf('<div class="sp-toolbar">');
  const statsStart = html.indexOf('<div class="sp-stats" id="spStats">', toolbarStart);
  const capFieldStart = html.indexOf('<label class="sp-cap-field"', toolbarStart);
  assert.ok(toolbarStart >= 0 && statsStart >= 0 && capFieldStart >= 0, 'the SP toolbar markup should be present');
  assert.ok(
    statsStart < capFieldStart,
    'dynamic SP statistics should appear before the cap input so its position stays fixed'
  );

  const functionSource = html.match(
    /    function resolveSPPointCap\(currentValue, availableLegendaryCards, syncSPPointCap\) \{[\s\S]*?\n    \}/
  )?.[0];
  assert.ok(functionSource, 'the SP-cap resolver should be present in the page script');

  const context = {};
  vm.runInNewContext(`${functionSource}\nthis.resolveSPPointCap = resolveSPPointCap;`, context);
  assert.equal(context.resolveSPPointCap('17', 425, true), 42);
  assert.equal(context.resolveSPPointCap('17', 425, false), 17);
  assert.equal(context.resolveSPPointCap('', 425, false), 42);
});

test('calculator keeps cashflow columns fixed and anchors SP stats near the cap input', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../site/calculator-ui.css', import.meta.url), 'utf8');

  assert.match(
    html,
    /<table class="simulation-table">\s*<colgroup>[\s\S]*?simulation-col-day[\s\S]*?simulation-col-profit[\s\S]*?<\/colgroup>/,
    'cashflow table should define explicit columns for fixed sizing'
  );
  assert.match(
    css,
    /table\.simulation-table\s*\{[\s\S]*?table-layout:\s*fixed;/,
    'cashflow table should use fixed table layout'
  );
  assert.match(
    css,
    /table\.simulation-table th,[\s\S]*?table\.simulation-table td\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/,
    'fixed columns should clip long content without changing their widths'
  );
  assert.match(css, /\.sp-stats\s*\{[\s\S]*?justify-self:\s*end;/, 'SP stats should align toward the cap input');
  assert.match(css, /\.sp-stats\s*\{[\s\S]*?text-align:\s*right;/, 'SP stats should be right-aligned');
});
