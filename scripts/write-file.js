const fs = require('fs');
const target = process.argv[2];
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => { fs.writeFileSync(target, data, 'utf8'); console.log('Wrote ' + target + ' (' + data.length + ' bytes)'); });
