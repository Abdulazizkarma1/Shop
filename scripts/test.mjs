import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.checks', { recursive: true });
await build({ entryPoints: ['src/main.jsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: '.checks/ui.mjs', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' } });
const result = spawnSync(process.execPath, ['--test', 'tests/shop.test.mjs'], { stdio: 'inherit' });
process.exit(result.status || 0);
