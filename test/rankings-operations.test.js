import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackfillSql,
  dayStartsInRange,
  parseBackfillArgs
} from '../scripts/backfill-rank-daily.mjs';
import {
  DUPLICATE_SIGNATURE_SQL,
  hasDuplicateSignatures,
  parseSignatureCheckArgs
} from '../scripts/check-rankings-signatures.mjs';
import { readFile } from 'node:fs/promises';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_DAY = Date.parse('2026-08-24T04:00:00+08:00');

test('backfill requires an explicit range and target', () => {
  assert.throws(
    () => parseBackfillArgs(['--from', '2026-08-24T04:00:00+08:00', '--until', '2026-08-25T04:00:00+08:00']),
    /--remote or --local/
  );
  const args = parseBackfillArgs([
    '--from', '2026-08-24T04:00:00+08:00',
    '--until', '2026-08-26T04:00:00+08:00',
    '--local'
  ]);
  assert.equal(args.target, 'local');
  assert.deepEqual(dayStartsInRange(args.fromDay, args.untilDay), [FIRST_DAY, FIRST_DAY + DAY_MS]);
});

test('backfill SQL is bounded to one day and never reads raw_json or cleans data', () => {
  const sql = buildBackfillSql(FIRST_DAY);
  assert.match(sql, new RegExp(`captured_at >= ${FIRST_DAY}`));
  assert.match(sql, new RegExp(`captured_at < ${FIRST_DAY + DAY_MS}`));
  assert.match(sql, /insert into rank_daily_metrics/i);
  assert.match(sql, /on conflict \(season_id, day_start_at, user_id, board_key\)/i);
  assert.doesNotMatch(sql, /raw_json|\bdelete\b|\bdrop table\b/i);
});

test('signature check is read-only and detects duplicate groups', () => {
  assert.throws(() => parseSignatureCheckArgs([]), /--remote or --local/);
  assert.equal(parseSignatureCheckArgs(['--remote']).target, 'remote');
  assert.match(DUPLICATE_SIGNATURE_SQL, /group by season_id, signature/i);
  assert.match(DUPLICATE_SIGNATURE_SQL, /having count\(\*\) > 1/i);
  assert.doesNotMatch(DUPLICATE_SIGNATURE_SQL, /\b(delete|update|insert|drop)\b/i);
  assert.equal(hasDuplicateSignatures({ results: [{ duplicate_count: 2 }] }), true);
  assert.equal(hasDuplicateSignatures({ results: [{ duplicate_count: 1 }] }), false);
});

test('snapshot migration adds the accepted read-path index', async () => {
  const migration = await readFile(new URL('../migrations/0004_rank_daily_metrics.sql', import.meta.url), 'utf8');
  assert.match(migration, /alter table rank_snapshots\s+add column accepted integer not null default 1/i);
  assert.match(migration, /create index if not exists idx_rank_snapshots_accepted_captured_id[\s\S]*on rank_snapshots \(accepted, captured_at desc, id desc\)/i);
});

test('duplicate repair keeps raw rows and scopes signature uniqueness to accepted snapshots', async () => {
  const migration = await readFile(new URL('../migrations/0004_rank_daily_metrics.sql', import.meta.url), 'utf8');
  const signatureMigration = await readFile(new URL('../migrations/0005_rankings_signature_index.sql', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/rankings-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /create unique index if not exists idx_rank_snapshots_season_signature/i);
  assert.match(signatureMigration, /create unique index if not exists idx_rank_snapshots_season_signature[\s\S]*where accepted = 1/i);
  assert.match(worker, /on conflict \(season_id, signature\) where accepted = 1 do nothing/i);
});
