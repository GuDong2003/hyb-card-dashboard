import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, '..');
const siteDirectory = resolve(projectDirectory, 'site');
const outputDirectory = resolve(projectDirectory, 'dist');

async function copyAsset(relativePath) {
    const sourcePath = resolve(siteDirectory, relativePath);
    const targetPath = resolve(outputDirectory, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
    copyAsset('index.html'),
    copyAsset('calculator-ui.css'),
    copyAsset('calculator-import.js'),
    copyAsset('profit-metrics.js'),
    copyAsset('rankings.css'),
    copyAsset('rankings.js'),
    copyAsset('stardust-rules.js'),
    copyAsset('og.png'),
    copyAsset('farm-icon.svg'),
    copyAsset('legend-card-icon.svg'),
    copyAsset('userscripts/hyb-card-dashboard-rankings.user.js')
]);

console.log('Built static assets in card-dashboard/dist');
