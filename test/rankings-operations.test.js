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
import {
  backupWranglerArgs,
  parseBackupArgs
} from '../scripts/backup-card-rankings.mjs';
import {
  buildCompactSourceQuery,
  parseCompactMigrationArgs
} from '../scripts/migrate-card-rankings-compact.mjs';
import {
  parseCompactVerifyArgs,
  verifyWranglerArgs
} from '../scripts/verify-card-rankings-compact.mjs';
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

test('backup command is remote export and never deletes', () => {
  const args = backupWranglerArgs('hyb-card-rankings-db', '/tmp/card.sql');
  assert.deepEqual(args, [
    'wrangler', 'd1', 'export', 'hyb-card-rankings-db', '--remote',
    '--output=/tmp/card.sql', '--skip-confirmation'
  ]);
  assert.doesNotMatch(args.join(' '), /delete|drop|reset/i);
  assert.equal(parseBackupArgs(['--database', 'old', '--output', '/tmp/card', '--remote']).target, 'remote');
  assert.throws(() => parseBackupArgs(['--database', 'old', '--output', '/tmp/card']), /--remote or --local/);
});

test('compact migration query is day-bounded and excludes raw_json', () => {
  const sql = buildCompactSourceQuery(FIRST_DAY, FIRST_DAY + DAY_MS);
  assert.match(sql, /captured_at\s*>=\s*\?/i);
  assert.match(sql, /captured_at\s*<\s*\?/i);
  assert.match(sql, /rank_daily_metrics|rank_entries/i);
  assert.doesNotMatch(sql, /raw_json|\bdelete\b|\bdrop table\b/i);
  assert.throws(
    () => parseCompactMigrationArgs(['--source', 'old', '--target', 'new', '--remote']),
    /--from and --until are required/
  );
  const parsed = parseCompactMigrationArgs([
    '--source', 'old', '--target', 'new',
    '--from', '2026-08-24T04:00:00+08:00',
    '--until', '2026-08-25T04:00:00+08:00',
    '--remote'
  ]);
  assert.equal(parsed.source, 'old');
  assert.equal(parsed.targetDatabase, 'new');
  assert.equal(parsed.target, 'remote');
});

test('snapshot migration adds the accepted read-path index', async () => {
  const migration = await readFile(new URL('../migrations/0004_rank_daily_metrics.sql', import.meta.url), 'utf8');
  assert.match(migration, /alter table rank_snapshots\s+add column accepted integer not null default 1/i);
  assert.match(migration, /create index if not exists idx_rank_snapshots_accepted_captured_id[\s\S]*on rank_snapshots \(accepted, captured_at desc, id desc\)/i);
});

test('compact schema has no legacy tables, raw payload, or fingerprint columns', async () => {
  const schema = await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8');
  assert.match(schema, /create table if not exists rank_user_days/i);
  assert.match(schema, /create table if not exists rank_user_current/i);
  assert.doesNotMatch(schema, /rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics|raw_json|fingerprint/i);
});

test('compact verification is bounded and read-only', () => {
  const args = parseCompactVerifyArgs([
    '--source', 'old', '--target', 'new',
    '--from', '2026-08-24T04:00:00+08:00',
    '--until', '2026-08-25T04:00:00+08:00',
    '--remote', '--user', 'u-1'
  ]);
  assert.equal(args.source, 'old');
  assert.equal(args.targetDatabase, 'new');
  assert.equal(args.userId, 'u-1');
  const command = verifyWranglerArgs('new', 'remote', 'SELECT 1');
  assert.deepEqual(command.slice(0, 6), ['wrangler', 'd1', 'execute', 'new', '--remote', '--json']);
  assert.doesNotMatch(command.join(' '), /delete|drop|reset/i);
});
