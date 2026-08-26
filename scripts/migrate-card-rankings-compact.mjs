import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseWranglerJson } from './backup-card-rankings.mjs';
import {
  COMPACT_BOARD_KEYS,
  USER_CURRENT_COLUMNS,
  USER_DAY_COLUMNS,
  currentSortValues,
  mergeUserObservations
} from '../src/rankings-user-store.js';
import {
  DAY_BOUNDARY_OFFSET_MS,
  DAY_MS,
  dayStartAtForCapturedAt
} from '../src/rankings-daily.js';

const MIGRATION_WRITE_BATCH_SIZE = 50;

const LEGACY_SEASONS_QUERY = `
  SELECT season_id, MAX(season_name) AS season_name,
    MAX(captured_at) AS last_observed_at,
    MAX(CAST((captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${DAY_BOUNDARY_OFFSET_MS}) AS last_day_start_at,
    MAX(captured_at) AS updated_at
  FROM rank_snapshots
  WHERE accepted = 1
  GROUP BY season_id
  ORDER BY season_id
`;

const LEGACY_CURRENT_QUERY = `
  SELECT season_id, user_id, board_key, user_name, avatar_url, value, rank,
    is_vip, active_name_decoration, name_display_preference,
    value_captured_at, last_captured_at, first_captured_at, source_scopes
  FROM rank_user_metrics
  ORDER BY season_id, user_id, board_key
`;

const LEGACY_INGEST_STATE_QUERY = `
  SELECT season_id, scope, MAX(captured_at) AS last_captured_at
  FROM rank_snapshots
  WHERE accepted = 1
  GROUP BY season_id, scope
  ORDER BY season_id, scope
`;

export function parseCompactMigrationArgs(argv = []) {
  let source = null;
  let targetDatabase = null;
  let fromValue = null;
  let untilValue = null;
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source' || argument === '--target' || argument === '--from' || argument === '--until') {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--source') source = value;
      else if (argument === '--target') targetDatabase = value;
      else if (argument === '--from') fromValue = value;
      else untilValue = value;
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
  if (fromDay == null || untilDay == null || fromDay >= untilDay) {
    throw new Error('--from must be earlier than --until');
  }
  return { source, targetDatabase, fromDay, untilDay, target };
}

export function buildCompactSourceQuery(fromDay, untilDay) {
  assertDayRange(fromDay, untilDay);
  return `
    WITH candidates AS (
      SELECT d.season_id, d.day_start_at, d.user_id, d.board_key,
        d.user_name, d.avatar_url, d.value, d.rank, d.is_vip,
        d.active_name_decoration, d.name_display_preference,
        d.snapshot_id, d.scope, d.captured_at
      FROM rank_daily_metrics d
      WHERE d.day_start_at >= ? AND d.day_start_at < ?
      UNION ALL
      SELECT s.season_id,
        CAST((s.captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${DAY_BOUNDARY_OFFSET_MS} AS day_start_at,
        e.user_id, e.board_key, e.user_name, e.avatar_url, e.value, e.rank,
        e.is_vip, e.active_name_decoration, e.name_display_preference,
        s.id AS snapshot_id, s.scope, s.captured_at
      FROM rank_entries e
      JOIN rank_snapshots s ON s.id = e.snapshot_id
      WHERE s.accepted = 1
        AND s.captured_at >= ? AND s.captured_at < ?
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY season_id, day_start_at, user_id, board_key
          ORDER BY captured_at DESC, value DESC, rank ASC, snapshot_id DESC
        ) AS day_order
      FROM candidates
    )
    SELECT season_id, day_start_at, user_id, board_key,
      user_name, avatar_url, value, rank, is_vip,
      active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at
    FROM ranked
    WHERE day_order = 1
    ORDER BY season_id, day_start_at, user_id, board_key
  `;
}

export function dayStartsInRange(fromDay, untilDay) {
  assertDayRange(fromDay, untilDay);
  const days = [];
  for (let dayStartAt = Number(fromDay); dayStartAt < Number(untilDay); dayStartAt += DAY_MS) {
    days.push(dayStartAt);
  }
  return days;
}

export async function runCompactMigration(options, run = runCommand) {
  const source = String(options.source);
  const targetDatabase = String(options.targetDatabase);
  const target = options.target;
  const seasons = rowsFrom(await runD1Query(source, target, LEGACY_SEASONS_QUERY, run));
  const currentMetrics = rowsFrom(await runD1Query(source, target, LEGACY_CURRENT_QUERY, run));
  const ingestStates = rowsFrom(await runD1Query(source, target, LEGACY_INGEST_STATE_QUERY, run));

  await writeRows(targetDatabase, target, 'rank_seasons', [
    ...seasons.map((row) => ({
      season_id: String(row.season_id || ''),
      season_name: String(row.season_name || ''),
      last_observed_at: integerOrNull(row.last_observed_at) || 0,
      last_day_start_at: integerOrNull(row.last_day_start_at) || 0,
      updated_at: integerOrNull(row.updated_at) || 0
    }))
  ], ['season_id'], ['season_name', 'last_observed_at', 'last_day_start_at', 'updated_at'], run);

  const currentRows = compactCurrentRows(currentMetrics);
  await writeRows(targetDatabase, target, 'rank_user_current', currentRows, ['season_id', 'user_id'], USER_CURRENT_COLUMNS.filter((column) => !['season_id', 'user_id'].includes(column)), run);

  await writeRows(targetDatabase, target, 'rank_ingest_state', ingestStates.map((row) => ({
    season_id: String(row.season_id || ''),
    scope: String(row.scope || ''),
    last_captured_at: integerOrNull(row.last_captured_at) || 0,
    updated_at: integerOrNull(row.last_captured_at) || 0
  })), ['season_id', 'scope'], ['last_captured_at', 'updated_at'], run);

  const seasonNames = new Map(seasons.map((row) => [String(row.season_id), String(row.season_name || '')]));
  for (const dayStartAt of dayStartsInRange(options.fromDay, options.untilDay)) {
    const sourceSql = bindRange(buildCompactSourceQuery(dayStartAt, dayStartAt + DAY_MS), [dayStartAt, dayStartAt + DAY_MS, dayStartAt, dayStartAt + DAY_MS]);
    const sourceRows = rowsFrom(await runD1Query(source, target, sourceSql, run));
    const userDayRows = compactDayRows(sourceRows, seasonNames);
    await writeRows(targetDatabase, target, 'rank_user_days', userDayRows, ['season_id', 'day_start_at', 'user_id'], USER_DAY_COLUMNS.filter((column) => !['season_id', 'day_start_at', 'user_id'].includes(column)), run);
    const countResult = rowsFrom(await runD1Query(targetDatabase, target, `SELECT COUNT(*) AS row_count FROM rank_user_days WHERE day_start_at >= ${dayStartAt} AND day_start_at < ${dayStartAt + DAY_MS}`, run));
    const result = {
      dayStartAt,
      sourceRows: sourceRows.length,
      targetRows: Number(countResult[0] && countResult[0].row_count || 0),
      users: userDayRows.length
    };
    console.log(JSON.stringify(result));
  }

  return {
    seasons: seasons.length,
    currentUsers: currentRows.length,
    fromDay: options.fromDay,
    untilDay: options.untilDay
  };
}

function compactDayRows(sourceRows, seasonNames) {
  const snapshots = sourceRows.map((row) => ({
    seasonId: String(row.season_id || ''),
    seasonName: seasonNames.get(String(row.season_id || '')) || '',
    scope: String(row.scope || 'global'),
    capturedAt: Number(row.captured_at),
    entries: [{
      boardKey: String(row.board_key || ''),
      userId: String(row.user_id || ''),
      userName: String(row.user_name || ''),
      avatar: String(row.avatar_url || ''),
      value: row.value,
      rank: row.rank,
      isVip: Boolean(row.is_vip),
      activeNameDecoration: row.active_name_decoration,
      nameDisplayPreference: row.name_display_preference
    }]
  }));
  return mergeUserObservations(snapshots).map((row) => {
    const result = {};
    for (const column of USER_DAY_COLUMNS) result[column] = row[column] ?? null;
    return result;
  });
}

function compactCurrentRows(metrics) {
  const grouped = new Map();
  for (const metric of metrics) {
    const seasonId = String(metric.season_id || '').trim();
    const userId = String(metric.user_id || '').trim();
    const boardKey = String(metric.board_key || '').trim();
    if (!seasonId || !userId || !COMPACT_BOARD_KEYS.includes(boardKey)) continue;
    const key = `${seasonId}\u0000${userId}`;
    let row = grouped.get(key);
    if (!row) {
      row = emptyCurrentRow(seasonId, userId);
      grouped.set(key, row);
    }
    const lastCapturedAt = integerOrNull(metric.last_captured_at) || 0;
    const firstCapturedAt = integerOrNull(metric.first_captured_at) || lastCapturedAt;
    row.first_observed_at = Math.min(row.first_observed_at || firstCapturedAt, firstCapturedAt);
    row.last_observed_at = Math.max(row.last_observed_at || 0, lastCapturedAt);
    row.is_vip = Math.max(row.is_vip, Number(metric.is_vip || 0) ? 1 : 0);
    row.source_scopes = mergeScopes(row.source_scopes, metric.source_scopes);
    const profileAt = Number(row.profile_observed_at || 0);
    if (lastCapturedAt >= profileAt) {
      row.user_name = String(metric.user_name || row.user_name || '');
      row.avatar_url = String(metric.avatar_url || row.avatar_url || '');
      row.active_name_decoration = metric.active_name_decoration ?? row.active_name_decoration;
      row.name_display_preference = metric.name_display_preference ?? row.name_display_preference;
      row.profile_observed_at = lastCapturedAt;
    }
    row[`${boardKey}_value`] = integerOrNull(metric.value);
    row[`${boardKey}_rank`] = integerOrNull(metric.rank);
    row[`${boardKey}_observed_at`] = integerOrNull(metric.value_captured_at) || lastCapturedAt;
  }

  return Array.from(grouped.values()).map((row) => {
    const sortValues = currentSortValues(row, row.last_observed_at || Date.now());
    const result = { ...row, ...sortValues };
    delete result.profile_observed_at;
    return Object.fromEntries(USER_CURRENT_COLUMNS.map((column) => [column, result[column] ?? null]));
  });
}

function emptyCurrentRow(seasonId, userId) {
  const row = {
    season_id: seasonId,
    user_id: userId,
    user_name: '',
    avatar_url: '',
    is_vip: 0,
    active_name_decoration: null,
    name_display_preference: null,
    first_observed_at: 0,
    last_observed_at: 0,
    source_scopes: '',
    profile_observed_at: 0
  };
  for (const boardKey of COMPACT_BOARD_KEYS) {
    row[`${boardKey}_value`] = null;
    row[`${boardKey}_rank`] = null;
    row[`${boardKey}_observed_at`] = null;
  }
  return row;
}

async function writeRows(database, target, tableName, rows, keyColumns, updateColumns, run) {
  for (const chunk of chunks(rows, MIGRATION_WRITE_BATCH_SIZE)) {
    if (!chunk.length) continue;
    const sql = buildInsertSql(tableName, keyColumns, updateColumns, chunk);
    const result = await runD1Command(database, target, sql, run);
    if (result.code !== 0) throw new Error(`${tableName} write failed with exit code ${result.code}`);
  }
}

export function buildInsertSql(tableName, keyColumns, updateColumns, rows) {
  if (!rows.length) return '';
  const columns = [...keyColumns, ...updateColumns];
  const values = rows.map((row) => `(${columns.map((column) => sqlLiteral(row[column])).join(', ')})`).join(',\n');
  return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${values}\nON CONFLICT (${keyColumns.join(', ')}) DO UPDATE SET\n  ${updateColumns.map((column) => `${column} = excluded.${column}`).join(',\n  ')}`;
}

async function runD1Query(database, target, sql, run) {
  const result = await runD1Command(database, target, sql, run, true);
  if (result.code !== 0) throw new Error(`query failed with exit code ${result.code}`);
  return parseWranglerJson(result.stdout || '');
}

async function runD1Command(database, target, sql, run, json = false) {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  const args = ['wrangler', 'd1', 'execute', String(database), targetFlag, '--yes'];
  if (json) args.push('--json');
  args.push(`--command=${sql}`);
  return run('npx', args, { stdio: ['inherit', 'pipe', 'pipe'] });
}

export function bindRange(sql, values) {
  let index = 0;
  return String(sql).replace(/\?/g, () => {
    if (index >= values.length) throw new Error('too many query placeholders');
    const value = values[index++];
    if (!Number.isFinite(Number(value))) throw new Error('range values must be numeric');
    return String(Math.floor(Number(value)));
  });
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
  const from = dayStartAtForCapturedAt(fromDay);
  const until = dayStartAtForCapturedAt(untilDay);
  if (from == null || until == null || from !== Number(fromDay) || until !== Number(untilDay) || from >= until) {
    throw new Error('invalid day range');
  }
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function sqlLiteral(value) {
  if (value == null || value === '') return value === '' ? "''" : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) {
    const number = Number(value);
    if (Number.isFinite(number)) return String(number);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function mergeScopes(existing, incoming) {
  const scopes = new Set(`${existing || ''},${incoming || ''}`.split(',').map((value) => value.trim()).filter(Boolean));
  return ['global', 'friends', ...Array.from(scopes).filter((value) => !['global', 'friends'].includes(value)).sort()]
    .filter((value, index, values) => scopes.has(value) && values.indexOf(value) === index)
    .join(',');
}

function chunks(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) result.push(array.slice(index, index + size));
  return result;
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
  const options = parseCompactMigrationArgs(argv);
  const result = await runCompactMigration(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
