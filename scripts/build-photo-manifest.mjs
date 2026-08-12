import { readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const photoDirectory = new URL('../photos/', import.meta.url);
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.svg']);
const entries = await readdir(photoDirectory, { withFileTypes: true });
const photos = entries.filter(entry => entry.isFile() && supported.has(extname(entry.name).toLowerCase())).map(entry => ({ name: entry.name, src: `photos/${encodeURIComponent(entry.name)}` })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
await writeFile(join(photoDirectory.pathname, 'manifest.json'), `${JSON.stringify(photos, null, 2)}\n`);
console.log(`Photo manifest updated: ${photos.length} image(s).`);
