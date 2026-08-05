import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, '..');
const siteDirectory = resolve(projectDirectory, 'site');
const outputDirectory = resolve(projectDirectory, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(
    resolve(siteDirectory, 'index.html'),
    resolve(outputDirectory, 'index.html')
);
await copyFile(
    resolve(siteDirectory, 'calculator-ui.css'),
    resolve(outputDirectory, 'calculator-ui.css')
);
await copyFile(
    resolve(siteDirectory, 'stardust-rules.js'),
    resolve(outputDirectory, 'stardust-rules.js')
);
await copyFile(
    resolve(siteDirectory, 'og.png'),
    resolve(outputDirectory, 'og.png')
);
await copyFile(
    resolve(siteDirectory, 'farm-icon.svg'),
    resolve(outputDirectory, 'farm-icon.svg')
);
await copyFile(
    resolve(siteDirectory, 'legend-card-icon.svg'),
    resolve(outputDirectory, 'legend-card-icon.svg')
);

console.log('Built static assets in card-dashboard/dist');
