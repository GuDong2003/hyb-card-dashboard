import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATABASE_NAME = 'hyb-card-rankings-db';

export const DUPLICATE_SIGNATURE_SQL = `
  SELECT season_id, signature, COUNT(*) AS duplicate_count,
    GROUP_CONCAT(id) AS snapshot_ids
  FROM rank_snapshots
  GROUP BY season_id, signature
  HAVING COUNT(*) > 1
  ORDER BY duplicate_count DESC, season_id, signature
`;

export function parseSignatureCheckArgs(argv = []) {
  let target = null;
  for (const argument of argv) {
    if (argument !== '--remote' && argument !== '--local') {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (target) throw new Error('choose only one of --remote or --local');
    target = argument.slice(2);
  }
  if (!target) throw new Error('--remote or --local is required');
  return { target };
}

export function hasDuplicateSignatures(value) {
  if (Array.isArray(value)) return value.some(hasDuplicateSignatures);
  if (!value || typeof value !== 'object') return false;
  if (Number(value.duplicate_count) > 1) return true;
  return Object.values(value).some(hasDuplicateSignatures);
}

export function wranglerSignatureCheckArgs(target) {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  return [
    'wrangler',
    'd1',
    'execute',
    DATABASE_NAME,
    targetFlag,
    '--json',
    `--command=${DUPLICATE_SIGNATURE_SQL}`
  ];
}

function runSignatureProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout }));
  });
}

export async function runSignatureCheck(target, runProcess = runSignatureProcess) {
  const result = await runProcess('npx', wranglerSignatureCheckArgs(target));
  if (result.code !== 0) throw new Error(`signature check command failed with exit code ${result.code}`);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    // Wrangler may include human-readable lines around JSON; the command output
    // remains visible and a non-JSON result is treated as an empty report.
  }
  return hasDuplicateSignatures(parsed);
}

export async function main(argv = process.argv.slice(2)) {
  const { target } = parseSignatureCheckArgs(argv);
  const hasDuplicates = await runSignatureCheck(target);
  if (hasDuplicates) {
    console.error('duplicate season_id + signature rows found; do not apply the unique index yet');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
