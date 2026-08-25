import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseWranglerJson } from './backup-card-rankings.mjs';
import {
  DAY_BOUNDARY_OFFSET_MS,
  DAY_MS,
  dayStartAtForCapturedAt
} from '../src/rankings-daily.js';

export function parseCompactVerifyArgs(argv = []) {
  let source = null;
  let targetDatabase = null;
  let fromValue = null;
  let untilValue = null;
  let target = null;
  let userId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--source', '--target', '--from', '--until', '--user'].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--source') source = value;
      else if (argument === '--target') targetDatabase = value;
      else if (argument === '--from') fromValue = value;
      else if (argument === '--until') untilValue = value;
      else userId = value;
      continue;
    }
    if (argument === '--remote' || argument === '--local') {
      if (target) throw new Error('choose only one of --remote or --local');
      target = argument.slice(2);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!source) throw new Error('--source is required');
  if (!targetDatabase) throw new Error('--target is required');
  if (source === targetDatabase) throw new Error('--source and --target must differ');
  if (!fromValue || !untilValue) throw new Error('--from and --until are required');
  if (!target) throw new Error('--remote or --local is required');
  const fromDay = dayStartAtForCapturedAt(parseTimestamp(fromValue));
  const untilDay = dayStartAtForCapturedAt(parseTimestamp(untilValue));
  if (fromDay == null || untilDay == null || fromDay >= untilDay) throw new Error('--from must be earlier than --until');
  return { source, targetDatabase, fromDay, untilDay, target, userId };
}

export function verifyWranglerArgs(database, target, command) {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  return ['wrangler', 'd1', 'execute', String(database), targetFlag, '--json', `--command=${command}`];
}

export async function runCompactVerification(options, run = runCommand) {
  const oldSeasons = rowsFrom(await runQuery(options.source, options.target, `SELECT season_id, MAX(season_name) AS season_name FROM rank_snapshots WHERE accepted = 1 GROUP BY season_id ORDER BY season_id`, run));
  const newSeasons = rowsFrom(await runQuery(options.targetDatabase, options.target, `SELECT season_id, season_name FROM rank_seasons ORDER BY season_id`, run));
  const oldDaily = rowsFrom(await runQuery(options.source, options.target, buildDailyCountQuery(options.fromDay, options.untilDay), run));
  const newDaily = rowsFrom(await runQuery(options.targetDatabase, options.target, buildCompactDailyCountQuery(options.fromDay, options.untilDay), run));
  const oldCurrent = rowsFrom(await runQuery(options.source, options.target, `SELECT season_id, COUNT(DISTINCT user_id) AS user_count FROM rank_user_metrics GROUP BY season_id ORDER BY season_id`, run));
  const newCurrent = rowsFrom(await runQuery(options.targetDatabase, options.target, `SELECT season_id, COUNT(*) AS user_count FROM rank_user_current GROUP BY season_id ORDER BY season_id`, run));
  const schema = rowsFrom(await runQuery(options.targetDatabase, options.target, `SELECT type, name, sql FROM sqlite_master ORDER BY type, name`, run));

  const userSample = options.userId
    ? {
      old: rowsFrom(await runQuery(options.source, options.target, buildUserSampleQuery(options.fromDay, options.untilDay, options.userId), run)),
      new: rowsFrom(await runQuery(options.targetDatabase, options.target, buildCompactUserSampleQuery(options.fromDay, options.untilDay, options.userId), run))
    }
    : null;
  const report = {
    seasons: { old: oldSeasons, new: newSeasons, matches: sameSeasonIds(oldSeasons, newSeasons) },
    dailyUserCounts: { old: oldDaily, new: newDaily, matches: sameCounts(oldDaily, newDaily) },
    currentUsers: { old: oldCurrent, new: newCurrent, matches: sameCounts(oldCurrent, newCurrent, 'user_count') },
    schema: {
      legacyObjects: schema.filter((row) => /rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics|raw_json|fingerprint/i.test(`${row.name || ''} ${row.sql || ''}`)),
      matches: !schema.some((row) => /rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics|raw_json|fingerprint/i.test(`${row.name || ''} ${row.sql || ''}`))
    },
    userSample
  };
  report.matches = report.seasons.matches && report.dailyUserCounts.matches && report.currentUsers.matches && report.schema.matches;
  return report;
}

export function buildDailyCountQuery(fromDay, untilDay) {
  assertDayRange(fromDay, untilDay);
  return `
    WITH old_users AS (
      SELECT season_id, day_start_at, user_id
      FROM rank_daily_metrics
      WHERE day_start_at >= ${fromDay} AND day_start_at < ${untilDay}
      UNION
      SELECT s.season_id,
        CAST((s.captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${DAY_BOUNDARY_OFFSET_MS},
        e.user_id
      FROM rank_entries e
      JOIN rank_snapshots s ON s.id = e.snapshot_id
      WHERE s.accepted = 1 AND s.captured_at >= ${fromDay} AND s.captured_at < ${untilDay}
    )
    SELECT season_id, day_start_at, COUNT(*) AS user_count
    FROM old_users
    GROUP BY season_id, day_start_at
    ORDER BY season_id, day_start_at
  `;
}

export function buildCompactDailyCountQuery(fromDay, untilDay) {
  assertDayRange(fromDay, untilDay);
  return `
    SELECT season_id, day_start_at, COUNT(*) AS user_count
    FROM rank_user_days
    WHERE day_start_at >= ${fromDay} AND day_start_at < ${untilDay}
    GROUP BY season_id, day_start_at
    ORDER BY season_id, day_start_at
  `;
}

function buildUserSampleQuery(fromDay, untilDay, userId) {
  return `
    SELECT day_start_at,
      MAX(CASE WHEN board_key = 'epic_total' THEN value END) AS epic_total_value,
      MAX(CASE WHEN board_key = 'spend_total' THEN value END) AS spend_total_value,
      MAX(CASE WHEN board_key = 'sets_total' THEN value END) AS sets_total_value
    FROM rank_daily_metrics
    WHERE user_id = '${sqlString(userId)}'
      AND day_start_at >= ${fromDay} AND day_start_at < ${untilDay}
    GROUP BY day_start_at
    ORDER BY day_start_at
  `;
}

function buildCompactUserSampleQuery(fromDay, untilDay, userId) {
  return `
    SELECT day_start_at, epic_total_value, spend_total_value, sets_total_value
    FROM rank_user_days
    WHERE user_id = '${sqlString(userId)}'
      AND day_start_at >= ${fromDay} AND day_start_at < ${untilDay}
    ORDER BY day_start_at
  `;
}

async function runQuery(database, target, sql, run) {
  const result = await run('npx', verifyWranglerArgs(database, target, sql), { stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.code !== 0) throw new Error(`verification query failed with exit code ${result.code}`);
  return parseWranglerJson(result.stdout || '');
}

function sameSeasonIds(oldRows, newRows) {
  const oldIds = oldRows.map((row) => String(row.season_id)).sort();
  const newIds = newRows.map((row) => String(row.season_id)).sort();
  return JSON.stringify(oldIds) === JSON.stringify(newIds);
}

function sameCounts(oldRows, newRows, valueColumn = 'user_count') {
  const toMap = (rows) => new Map(rows.map((row) => [
    `${row.season_id || ''}\u0000${row.day_start_at || ''}`,
    Number(row[valueColumn] ?? row.user_count ?? 0)
  ]));
  const left = toMap(oldRows);
  const right = toMap(newRows);
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function parseTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid timestamp: ${value}`);
  return parsed;
}

function assertDayRange(fromDay, untilDay) {
  if (dayStartAtForCapturedAt(fromDay) !== Number(fromDay)
    || dayStartAtForCapturedAt(untilDay) !== Number(untilDay)
    || Number(fromDay) >= Number(untilDay)) throw new Error('invalid day range');
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCompactVerifyArgs(argv);
  const report = await runCompactVerification(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.matches) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
