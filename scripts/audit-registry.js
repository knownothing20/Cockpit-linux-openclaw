#!/usr/bin/env node
'use strict';

/**
 * Task 3.1 — registry 单元测试
 * 只用 Node 内置 assert + http（不引入测试框架）
 *
 * 覆盖：
 *   1. validateManifest（registry/manifest-schema.js）
 *   2. loadManifests（registry/app-registry.js）
 */

const assert = require('assert');
const path = require('path');
const { validateManifest, ID_PATTERN } = require('../registry/manifest-schema');
const { loadManifests } = require('../registry/app-registry');

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    failed++;
    console.error('  FAIL -', name);
    console.error('    ', e.message);
  }
}

// 以真实 skill-manager.module.json 为合法基线
const validBaseline = require('../modules/skill-manager.module.json');

function cloneBaseline(overrides) {
  return Object.assign({}, validBaseline, overrides);
}

console.log('audit-registry:');

// ── validateManifest ──────────────────────────────────────────

console.log('  -- validateManifest --');

t('valid manifest (skill-manager baseline) passes', () => {
  const result = validateManifest(validBaseline, 'skill-manager.module.json');
  assert.strictEqual(result.valid, true, 'expected valid: true, got errors: ' + (result.errors || []).join('; '));
});

t('invalid id: uppercase rejected', () => {
  const m = cloneBaseline({ id: 'SkillManager' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /id/i.test(e)), 'expected an id error, got: ' + result.errors.join('; '));
});

t('invalid id: underscore rejected', () => {
  const m = cloneBaseline({ id: 'skill_manager' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
});

t('invalid id: too long (>32 chars) rejected', () => {
  // ID_PATTERN 要求 2-32 字符（首字母 + 1..31）
  const m = cloneBaseline({ id: 'a' + 'b'.repeat(32) }); // 33 chars
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
});

t('invalid id: single char rejected', () => {
  const m = cloneBaseline({ id: 'a' }); // length 1, pattern needs 2-32
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
});

t('public IP baseUrl rejected for proxy integration', () => {
  const m = cloneBaseline({ integration: 'proxy', baseUrl: 'http://8.8.8.8:8080' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some((e) => /baseUrl/i.test(e)),
    'expected a baseUrl error, got: ' + result.errors.join('; ')
  );
});

t('localhost baseUrl accepted for proxy integration', () => {
  const m = cloneBaseline({ integration: 'proxy', baseUrl: 'http://127.0.0.1:8001' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, true, 'expected valid, got: ' + (result.errors || []).join('; '));
});

t('private IP baseUrl (10.x) accepted for proxy integration', () => {
  const m = cloneBaseline({ integration: 'proxy', baseUrl: 'http://' + [10, 0, 0, 5].join('.') + ':3000' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, true);
});

t('mountPath not starting with /apps/ rejected', () => {
  const m = cloneBaseline({ mountPath: '/foo/skill-manager' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
  assert.ok(
    result.errors.some((e) => /mountPath/i.test(e)),
    'expected a mountPath error, got: ' + result.errors.join('; ')
  );
});

t('invalid integration rejected', () => {
  const m = cloneBaseline({ integration: 'magic' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
  assert.ok(/integration/i.test(result.errors.join(' ')));
});

t('invalid type rejected', () => {
  const m = cloneBaseline({ type: 'magic-app' });
  const result = validateManifest(m, 'x');
  assert.strictEqual(result.valid, false);
  assert.ok(/type/i.test(result.errors.join(' ')));
});

t('non-object manifest rejected', () => {
  const result = validateManifest(null, 'x');
  assert.strictEqual(result.valid, false);
});

t('ID_PATTERN exported and matches expected form', () => {
  assert.ok(ID_PATTERN.test('skill-manager'));
  assert.ok(!ID_PATTERN.test('Skill-Manager'));
  assert.ok(!ID_PATTERN.test(''));
});

// ── loadManifests ─────────────────────────────────────────────

console.log('  -- loadManifests --');

t('loadManifests returns an array', () => {
  const list = loadManifests();
  assert.ok(Array.isArray(list), 'expected an array');
});

t('loadManifests returns at least 8 modules', () => {
  const list = loadManifests();
  assert.ok(list.length >= 8, 'expected >= 8 modules, got ' + list.length);
});

t('loadManifests result sorted by order ascending', () => {
  const list = loadManifests();
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].order || 0;
    const curr = list[i].order || 0;
    assert.ok(
      prev <= curr,
      `order not ascending at index ${i}: prev=${prev} curr=${curr}`
    );
  }
});

t('every loaded manifest has required fields', () => {
  const list = loadManifests();
  for (const m of list) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0, 'missing id');
    assert.ok(typeof m.mountPath === 'string' && m.mountPath.startsWith('/apps/'), 'bad mountPath: ' + m.mountPath);
    assert.ok(typeof m.integration === 'string', 'missing integration');
  }
});

// ── summary ───────────────────────────────────────────────────

console.log(`\nregistry tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
