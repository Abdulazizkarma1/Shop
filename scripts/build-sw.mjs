import fs from 'node:fs';
import { createHash } from 'node:crypto';
const files = ['/', '/index.html', '/rice-sacks.svg', '/manifest.webmanifest', ...fs.readdirSync('dist/assets').map(file => `/assets/${file}`)];
const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
const source = fs.readFileSync('public/sw.js', 'utf8').replace("const CACHE = 'grainkeeper-shell-v3';", `const CACHE = 'grainkeeper-shell-${version}';`).replace(/const PRECACHE = .*?;/, `const PRECACHE = ${JSON.stringify(files)};`);
fs.writeFileSync('dist/sw.js', source);
console.log(`Offline shell: ${files.length} assets precached (${version})`);
