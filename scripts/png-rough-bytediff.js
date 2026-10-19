#!/usr/bin/env node
// PNG byte-level rough diff - NOT strict pixel diff
// Usage: node png-rough-bytediff.js <before.png> <after.png>
const fs = require('fs');
const zlib = require('zlib');

function readPNG(buf) {
  let off = 8, idat = [], width, height;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IHDR') { width = buf.readUInt32BE(off + 8); height = buf.readUInt32BE(off + 12); }
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { width, height, raw };
}

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('Usage: node png-rough-bytediff.js <before.png> <after.png>'); process.exit(1); }
const A = readPNG(fs.readFileSync(a));
const B = readPNG(fs.readFileSync(b));
if (A.width !== B.width || A.height !== B.height) { console.error('size mismatch'); process.exit(2); }
let diff = 0;
const n = Math.min(A.raw.length, B.raw.length);
for (let i = 0; i < n; i++) if (A.raw[i] !== B.raw[i]) diff++;
console.log(JSON.stringify({ width: A.width, height: A.height, diffBytes: diff, total: n, ratio: diff / n }));
