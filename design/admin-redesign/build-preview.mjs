/* Bundle design/admin-redesign thành 1 fragment HTML tự chứa để preview inline.
   Dùng: node design/admin-redesign/build-preview.mjs [output] */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fallback = path.join(os.homedir(), '.zcode', 'v2', 'visualizations',
  '2be4af26eacb77b8f15f3eee71151d07e360fc35675e9bb97df1aaabbdc705e4', 'cq-admin-redesign.html');
const out = process.argv[2] || fallback;

const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');

/* Shell markup: bỏ phần <script src> (bundle nối tay phía sau). */
const shell = read('index.html').replace(/\s*<script src="assets\/[^"]+"><\/script>/g, '');

const css = read('styles/admin.css');
const js = [
  'assets/springs.js',
  'assets/virtual-list.js',
  'assets/mock-data.js',
  'assets/router.js',
  'assets/views-api.js',
  'assets/views-log.js',
  'assets/app.js',
].map((f) => `/* ── ${f} ── */\n` + read(f)).join('\n\n');

const fragment = `${shell}
<style>
${css}
</style>
<script>
${js}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, fragment, 'utf8');
console.log('BUNDLED ->', out, `(${(fragment.length / 1024).toFixed(1)} KB)`);
