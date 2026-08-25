import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAY_MS,
  buildDailyAggregationSql,
  dayStartAtForCapturedAt
} from '../src/rankings-daily.js';

const DATABASE_NAME = 'hyb-card-rankings-db';

export function parseBackfillTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value || ''));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`invalid timestamp: ${value}`);
}

export function parseBackfillArgs(argv = []) {
  let fromValue = null;
  let untilValue = null;
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--from' || argument === '--until') {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--from') fromValue = value;
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
  if (!fromValue || !untilValue) throw new Error('--from and --until are required');
  if (!target) throw new Error('--remote or --local is required');
  const fromDay = dayStartAtForCapturedAt(parseBackfillTimestamp(fromValue));
  const untilDay = dayStartAtForCapturedAt(parseBackfillTimestamp(untilValue));
  if (fromDay == null || untilDay == null || fromDay >= untilDay) {
    throw new Error('--from must be earlier than --until');
  }
  return { fromDay, untilDay, target };
}

export function dayStartsInRange(fromDay, untilDay) {
  const days = [];
  for (let dayStartAt = Number(fromDay); dayStartAt < Number(untilDay); dayStartAt += DAY_MS) {
    days.push(dayStartAt);
  }
  return days;
}

export function buildBackfillSql(dayStartAt) {
  return buildDailyAggregationSql(dayStartAt);
}

export function wranglerBackfillArgs(dayStartAt, target) {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  return [
    'wrangler',
    'd1',
    'execute',
    DATABASE_NAME,
    targetFlag,
    `--command=${buildBackfillSql(dayStartAt)}`
  ];
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

export async function runBackfill(options, spawnProcess = runProcess) {
  for (const dayStartAt of dayStartsInRange(options.fromDay, options.untilDay)) {
    const result = await spawnProcess('npx', wranglerBackfillArgs(dayStartAt, options.target), { stdio: 'inherit' });
    if (result.code !== 0) {
      throw new Error(`backfill failed for ${dayStartAt} with exit code ${result.code}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBackfillArgs(argv);
  await runBackfill(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
