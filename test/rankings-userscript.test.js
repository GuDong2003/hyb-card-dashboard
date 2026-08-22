import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SCRIPT_PATH = new URL('../site/userscripts/hyb-card-dashboard-rankings.user.js', import.meta.url);

test('userscript matches Card and CDK while keeping the bridge UI on Card', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(source, /@match\s+https:\/\/card\.gudong226\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/cdk\.hybgzs\.com\/\*/);
  assert.match(source, /@connect\s+cdk\.hybgzs\.com/);
  assert.match(source, /@version\s+1\.3\.1/);
  assert.match(source, /@updateURL\s+https:\/\/card\.gudong226\.com\/userscripts\/hyb-card-dashboard-rankings\.user\.js/);
  assert.match(source, /@downloadURL\s+https:\/\/card\.gudong226\.com\/userscripts\/hyb-card-dashboard-rankings\.user\.js/);
  assert.match(source, /GM_addValueChangeListener/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
  assert.match(source, /https:\/\/cdk\.hybgzs\.com\/api\/cards\/leaderboard\?scope=global/);
  assert.match(source, /https:\/\/cdk\.hybgzs\.com\/api\/cards\/leaderboard\?scope=friends/);
  assert.match(source, /snapshots/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /HYB_CARD_RANKINGS_BRIDGE_READY/);
  assert.match(source, /HYB_CARD_RANKINGS_REQUEST/);
  assert.match(source, /HYB_CARD_RANKINGS_RESPONSE/);
  assert.match(source, /hyb-card-rankings-relay-claim-v1/);
  assert.match(source, /function normalizeCapturedAt/);
  assert.match(source, /lastUpdatedAt/);
  assert.match(source, /REQUEST_COOLDOWN_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /RETRY_COOLDOWN_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /PROTECTED_COOLDOWN_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /looksLikeProtectionPage/);
  assert.match(source, /parseJsonPayload/);
  assert.match(source, /scriptVersion: SCRIPT_VERSION/);
});

test('userscript update notice is hidden until a refresh response reports an old script', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../site/rankings.js', import.meta.url), 'utf8');
  assert.match(html, /class="rankings-script-update-notice is-hidden"/);
  assert.match(html, /id="rankingsScriptUpdateLink"[^>]*>更新同步脚本</);
  assert.match(source, /markUserscriptVersion\(data\.scriptVersion\)/);
  assert.match(source, /userscriptUpdateError\(data\.scriptVersion\)/);
  assert.match(source, /code = 'userscript_missing'/);
  assert.doesNotMatch(source, /type === BRIDGE_READY\)[\s\S]*markUserscriptVersion/);
});
