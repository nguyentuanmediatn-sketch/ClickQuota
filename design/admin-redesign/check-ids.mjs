/* Static check: mọi id JS tham chiếu phải tồn tại trong shell markup
   hoặc trong template động (innerHTML) của chính assets. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const files = ['springs.js', 'virtual-list.js', 'mock-data.js', 'router.js', 'views-api.js', 'views-log.js', 'app.js'];

const htmlIds = new Set();
for (const m of shell.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]);
for (const f of files) {
  const src = fs.readFileSync(path.join(here, 'assets', f), 'utf8');
  for (const m of src.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]);
}

const used = new Map();
for (const f of files) {
  const src = fs.readFileSync(path.join(here, 'assets', f), 'utf8');
  for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) used.set(m[1], f);
  for (const m of src.matchAll(/querySelector\('#([a-zA-Z][\w-]+)'/g)) used.set(m[1], f);
}

let missing = 0;
for (const [id, file] of used) {
  if (!htmlIds.has(id) && !id.startsWith('cq-view-')) {
    console.log(`MISSING: #${id} (referenced in ${file})`);
    missing++;
  }
}
for (const v of ['dashboard', 'endpoints', 'credentials', 'sandbox', 'system', 'audit', 'alerts']) {
  if (!htmlIds.has('cq-view-' + v)) {
    console.log('MISSING view: cq-view-' + v);
    missing++;
  }
}
console.log(missing === 0 ? `ALL_IDS_OK (${used.size} references checked)` : `${missing} missing`);
