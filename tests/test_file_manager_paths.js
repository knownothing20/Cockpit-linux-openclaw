'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../shell-ui/modules/file-manager/file-manager.js'), 'utf8');
const match = source.match(/function parseOpenClawPath\(absPath\) \{[\s\S]*?\n\}/);
assert.ok(match, 'read the actual path parser');
const ctx = {OPENCLAW_DIR: ''};
vm.createContext(ctx);
vm.runInContext(match[0], ctx);
for (const home of ['/home/user', '/custom-user-home']) {
  const parsed = ctx.parseOpenClawPath(home + '/.openclaw/agents/demo/SOUL.md');
  assert.equal(parsed.category, 'agents');
  assert.equal(parsed.subfolder, 'demo');
  assert.equal(parsed.file, 'SOUL.md');
}
assert.equal(ctx.parseOpenClawPath('/tmp/unrelated.txt'), null);
ctx.OPENCLAW_DIR = '/custom/openclaw';
assert.equal(ctx.parseOpenClawPath('/custom/openclaw/agents/demo/SOUL.md').file, 'SOUL.md');
assert.equal(ctx.parseOpenClawPath('/other/.openclaw/agents/demo/SOUL.md'), null);
console.log('PASS: actual parser supports default homes, configured root, and unrelated-path rejection');
