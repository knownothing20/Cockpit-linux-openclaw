#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const screenshotsRoot = path.join(root, 'docs/_audit/screenshots');
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function positional() {
  return args.filter((arg) => !arg.startsWith('--'));
}

function listSmokeDirs() {
  if (!fs.existsSync(screenshotsRoot)) return [];
  return fs.readdirSync(screenshotsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^smoke-\d{8}$/.test(entry.name))
    .map((entry) => path.join(screenshotsRoot, entry.name))
    .sort();
}

function resolveDirs() {
  const pos = positional();
  if (pos.length >= 2) return [path.resolve(pos[0]), path.resolve(pos[1])];
  const envBaseline = process.env.COCKPIT_SCREENSHOT_BASELINE;
  const envCurrent = process.env.COCKPIT_SCREENSHOT_CURRENT;
  if (envBaseline && envCurrent) return [path.resolve(envBaseline), path.resolve(envCurrent)];
  const dirs = listSmokeDirs();
  const acceptedBaseline = path.join(screenshotsRoot, 'baseline-cockpit');
  if (fs.existsSync(acceptedBaseline) && dirs.length >= 1) {
    return [acceptedBaseline, dirs[dirs.length - 1]];
  }
  if (dirs.length < 2) {
    console.error('Need two smoke screenshot directories, or at least two docs/_audit/screenshots/smoke-YYYYMMDD directories.');
    process.exit(2);
  }
  return [dirs[dirs.length - 2], dirs[dirs.length - 1]];
}

function readPNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i += 1) {
    if (buf[i] !== sig[i]) throw new Error('Not a PNG file');
  }

  let off = 8;
  const idat = [];
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      bitDepth = buf.readUInt8(off + 16);
      colorType = buf.readUInt8(off + 17);
    } else if (type === 'IDAT') {
      idat.push(buf.slice(off + 8, off + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  let bpp;
  if (colorType === 0) bpp = Math.ceil(bitDepth / 8);
  else if (colorType === 2) bpp = Math.ceil(bitDepth / 8) * 3;
  else if (colorType === 3) bpp = 1;
  else if (colorType === 4) bpp = Math.ceil(bitDepth / 8) * 2;
  else if (colorType === 6) bpp = Math.ceil(bitDepth / 8) * 4;
  else throw new Error(`Unsupported PNG colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp + 1;
  const pixels = Buffer.alloc(width * height * bpp);

  for (let y = 0; y < height; y += 1) {
    const lineOff = y * stride;
    const filter = raw[lineOff];
    const inOff = lineOff + 1;
    const outOff = y * width * bpp;
    raw.copy(pixels, outOff, inOff, inOff + width * bpp);

    if (filter === 0) continue;
    if (filter === 1) {
      for (let x = bpp; x < width * bpp; x += 1) pixels[outOff + x] = (pixels[outOff + x] + pixels[outOff + x - bpp]) & 0xff;
    } else if (filter === 2) {
      if (y > 0) {
        const prev = (y - 1) * width * bpp;
        for (let x = 0; x < width * bpp; x += 1) pixels[outOff + x] = (pixels[outOff + x] + pixels[prev + x]) & 0xff;
      }
    } else if (filter === 3) {
      for (let x = 0; x < width * bpp; x += 1) {
        const left = x >= bpp ? pixels[outOff + x - bpp] : 0;
        const up = y > 0 ? pixels[(y - 1) * width * bpp + x] : 0;
        pixels[outOff + x] = (pixels[outOff + x] + Math.floor((left + up) / 2)) & 0xff;
      }
    } else if (filter === 4) {
      for (let x = 0; x < width * bpp; x += 1) {
        const left = x >= bpp ? pixels[outOff + x - bpp] : 0;
        const up = y > 0 ? pixels[(y - 1) * width * bpp + x] : 0;
        const upLeft = x >= bpp && y > 0 ? pixels[(y - 1) * width * bpp + x - bpp] : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
        pixels[outOff + x] = (pixels[outOff + x] + pred) & 0xff;
      }
    } else {
      throw new Error(`Unsupported PNG filter ${filter}`);
    }
  }

  return { width, height, bpp, pixels };
}

function compareImages(aPath, bPath) {
  const a = readPNG(fs.readFileSync(aPath));
  const b = readPNG(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height || a.bpp !== b.bpp) {
    return {
      status: 'size-mismatch',
      diffPercent: 100,
      details: `${a.width}x${a.height}/${a.bpp} vs ${b.width}x${b.height}/${b.bpp}`,
    };
  }

  let diffPixels = 0;
  const totalPixels = a.width * a.height;
  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * a.bpp;
    let differs = false;
    for (let k = 0; k < a.bpp; k += 1) {
      if (a.pixels[offset + k] !== b.pixels[offset + k]) {
        differs = true;
        break;
      }
    }
    if (differs) diffPixels += 1;
  }
  return {
    status: 'ok',
    diffPercent: diffPixels / totalPixels * 100,
    details: `${diffPixels}/${totalPixels}`,
  };
}

function screenshotFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.png') && name !== 'shell-nav-final.png')
    .sort();
}

const [baselineDir, currentDir] = resolveDirs();
const maxDiff = Number(argValue('--max-diff', process.env.COCKPIT_SCREENSHOT_MAX_DIFF || '5'));
const reportPath = path.resolve(argValue(
  '--report',
  path.join(screenshotsRoot, `cockpit-screenshot-diff-${path.basename(baselineDir)}-${path.basename(currentDir)}.md`),
));

const baselineFiles = screenshotFiles(baselineDir);
const currentSet = new Set(screenshotFiles(currentDir));
const rows = [];
const failures = [];

for (const name of baselineFiles) {
  const aPath = path.join(baselineDir, name);
  const bPath = path.join(currentDir, name);
  if (!currentSet.has(name)) {
    rows.push({ name, status: 'missing-current', diffPercent: null, details: '-' });
    failures.push(`${name}: missing current screenshot`);
    continue;
  }
  const result = compareImages(aPath, bPath);
  rows.push({ name, ...result });
  if (result.status !== 'ok') failures.push(`${name}: ${result.status}`);
  else if (result.diffPercent > maxDiff) failures.push(`${name}: ${result.diffPercent.toFixed(4)}% > ${maxDiff}%`);
}

const lines = [];
lines.push(`# Cockpit Screenshot Diff - ${path.basename(baselineDir)} vs ${path.basename(currentDir)}`);
lines.push('');
lines.push(`Baseline: \`${path.relative(root, baselineDir)}\``);
lines.push(`Current: \`${path.relative(root, currentDir)}\``);
lines.push(`Max diff threshold: \`${maxDiff}%\``);
lines.push('');
lines.push('| Screenshot | Status | Diff | Details |');
lines.push('|---|---|---:|---|');
for (const row of rows) {
  const diff = row.diffPercent == null ? '-' : `${row.diffPercent.toFixed(4)}%`;
  lines.push(`| ${row.name} | ${row.status} | ${diff} | ${row.details} |`);
}
lines.push('');
lines.push('## Result');
lines.push('');
lines.push(failures.length ? `Failures: ${failures.join(', ')}` : 'Screenshot diff checks passed.');

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
console.log(`wrote ${path.relative(root, reportPath)}`);

if (failures.length) {
  console.error(`screenshot diff failures: ${failures.join(', ')}`);
  process.exitCode = 1;
}
