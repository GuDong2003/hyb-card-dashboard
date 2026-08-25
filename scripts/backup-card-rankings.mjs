import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function parseBackupArgs(argv = []) {
  let database = null;
  let output = null;
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database' || argument === '--output') {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--database') database = value;
      else output = value;
      continue;
    }
    if (argument === '--remote' || argument === '--local') {
      if (target) throw new Error('choose only one of --remote or --local');
      target = argument.slice(2);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!database) throw new Error('--database is required');
  if (!output) throw new Error('--output is required');
  if (!target) throw new Error('--remote or --local is required');
  return { database, output: path.resolve(output), target };
}

export function backupWranglerArgs(database, outputPath, target = 'remote') {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  return [
    'wrangler', 'd1', 'export', String(database), targetFlag,
    `--output=${String(outputPath)}`, '--skip-confirmation'
  ];
}

export function metadataWranglerArgs(database, target, command) {
  const targetFlag = target === 'remote' ? '--remote' : '--local';
  return ['wrangler', 'd1', 'execute', String(database), targetFlag, '--json', `--command=${command}`];
}

export async function createBackup(options, run = runCommand) {
  const outputDir = path.resolve(options.output);
  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(outputDir);

  const databaseSqlPath = path.join(outputDir, 'database.sql');
  const compressedSqlPath = path.join(outputDir, 'database.sql.gz');
  const metadataPath = path.join(outputDir, 'metadata.json');
  const manifestPath = path.join(outputDir, 'manifest.json');

  await run('npx', backupWranglerArgs(options.database, databaseSqlPath, options.target), { stdio: 'inherit' });
  const databaseSql = await readFile(databaseSqlPath);
  if (!databaseSql.length) throw new Error('database export is empty');

  const schemaCommand = `SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
  const countsCommand = `SELECT 'rank_snapshots' AS table_name, COUNT(*) AS row_count FROM rank_snapshots UNION ALL SELECT 'rank_entries', COUNT(*) FROM rank_entries UNION ALL SELECT 'rank_daily_metrics', COUNT(*) FROM rank_daily_metrics UNION ALL SELECT 'rank_user_metrics', COUNT(*) FROM rank_user_metrics`;
  const schema = await runJsonCommand(options.database, options.target, schemaCommand, run);
  const counts = await runJsonCommand(options.database, options.target, countsCommand, run);
  const metadata = {
    database: options.database,
    target: options.target,
    exportedAt: new Date().toISOString(),
    schema,
    counts
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const compressed = await gzipAsync(databaseSql);
  await writeFile(compressedSqlPath, compressed);
  const restored = await gunzipAsync(compressed);
  if (restored.length !== databaseSql.length || !restored.equals(databaseSql)) {
    throw new Error('gzip export verification failed');
  }

  const files = {};
  for (const filename of ['database.sql', 'database.sql.gz', 'metadata.json']) {
    const filePath = path.join(outputDir, filename);
    const file = await readFile(filePath);
    files[filename] = {
      bytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex')
    };
  }
  const manifest = {
    database: options.database,
    target: options.target,
    output: outputDir,
    exportedAt: metadata.exportedAt,
    files
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const exportStats = await stat(databaseSqlPath);
  return { outputDir, databaseSqlPath, bytes: exportStats.size, manifest };
}

async function runJsonCommand(database, target, command, run) {
  const result = await run('npx', metadataWranglerArgs(database, target, command), {
    stdio: ['inherit', 'pipe', 'pipe']
  });
  if (result.code !== 0) throw new Error(`metadata query failed with exit code ${result.code}`);
  return parseWranglerJson(result.stdout || '');
}

export function parseWranglerJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && 'results' in parsed[0]) return parsed[0].results;
    if (parsed && !Array.isArray(parsed) && 'results' in parsed) return parsed.results;
    return parsed;
  } catch (_) {
    const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
    for (const start of starts.sort((left, right) => left - right)) {
      try {
        const parsed = JSON.parse(text.slice(start));
        if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && 'results' in parsed[0]) return parsed[0].results;
        if (parsed && !Array.isArray(parsed) && 'results' in parsed) return parsed.results;
        return parsed;
      } catch (_) {
        // Keep trying the next JSON boundary.
      }
    }
  }
  return { raw: text };
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
  const options = parseBackupArgs(argv);
  const result = await createBackup(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
