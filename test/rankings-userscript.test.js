import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SCRIPT_PATH = new URL('../site/userscripts/hyb-card-dashboard-rankings.user.js', import.meta.url);

test('userscript is installed only on Card Dashboard and connects to the CDK API', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  assert.match(source, /@match\s+https:\/\/card\.gudong226\.com\/\*/);
  assert.match(source, /@connect\s+cdk\.hybgzs\.com/);
  assert.match(source, /https:\/\/cdk\.hybgzs\.com\/api\/cards\/leaderboard\?scope=global/);
  assert.doesNotMatch(source, /@match\s+https:\/\/cdk\.hybgzs\.com/);
  assert.match(source, /HYB_CARD_RANKINGS_BRIDGE_READY/);
  assert.match(source, /HYB_CARD_RANKINGS_REQUEST/);
  assert.match(source, /HYB_CARD_RANKINGS_RESPONSE/);
});
