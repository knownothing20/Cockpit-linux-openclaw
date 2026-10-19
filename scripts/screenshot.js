#!/usr/bin/env node
// Screenshot tool using chromium --screenshot (方案 C fallback)
// No selector waiting, uses --virtual-time-budget for JS execution
// Usage: node screenshot.js <url> <outPath> [virtualTimeBudget]
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [url, outPath, vtb = '8000'] = process.argv.slice(2);
if (!url || !outPath) { console.error('Usage: node screenshot.js <url> <outPath> [virtualTimeBudget]'); process.exit(1); }

const dir = path.dirname(outPath);
if (dir) fs.mkdirSync(dir, { recursive: true });

try {
  execSync(`chromium --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer --window-size=1440,900 --hide-scrollbars --virtual-time-budget=${vtb} --screenshot=${outPath} "${url}" 2>/dev/null`, { timeout: 30000 });
  if (fs.existsSync(outPath)) console.log(`OK: ${outPath}`);
  else { console.error(`FAIL: ${outPath} not created`); process.exit(1); }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
