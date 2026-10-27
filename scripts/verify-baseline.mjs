import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sharkPoolRoot = 'C:\\Users\\hacke\\Desktop\\ProxyPM\\SharkPool\\ProxyClaude-main';
const baseline = JSON.parse(readFileSync('source-baseline.json', 'utf8'));
let allMatch = true;

for (const [relPath, expectedHash] of Object.entries(baseline)) {
  const fullPath = path.join(sharkPoolRoot, relPath);
  const data = readFileSync(fullPath);
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== expectedHash) {
    console.error(`MISMATCH on: ${relPath}\n  expected: ${expectedHash}\n  got:      ${hash}`);
    allMatch = false;
  }
}

if (allMatch) {
  console.log('✅ ALL SHARKPOOL SOURCE FILES VERIFIED UNTOUCHED (100% READ-ONLY COMPLIANCE)');
} else {
  process.exit(1);
}
