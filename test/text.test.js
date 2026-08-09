'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBidi, splitTelegramText } = require('../src/text');

test('removes untrusted direction controls and wraps Arabic text safely', () => {
  const normalized = normalizeBidi('مرحبا\u202eabc');
  assert.equal(normalized.includes('\u202e'), false);
  assert.equal(normalized.startsWith('\u202b'), true);
  assert.equal(normalized.endsWith('\u202c'), true);
});

test('keeps a pure command line left-to-right and copyable', () => {
  assert.equal(normalizeBidi('npm run test'), 'npm run test');
  assert.equal(
    normalizeBidi('claude --model claude-sonnet-5 --effort high'),
    'claude --model claude-sonnet-5 --effort high'
  );
});

test('keeps real help, status, model, URL, path, ID, and flag tokens contiguous', () => {
  const input = [
    'الأوامر: /help أو /مساعدة ثم /status و/model',
    'الرابط: https://example.com/docs?q=bridge',
    'المسار: C:\\Program Files\\Claude\\claude.exe',
    'النموذج: claude-sonnet-5 ومستوى التفكير عبر --effort'
  ].join('\n');
  const normalized = normalizeBidi(input);
  const stripped = normalized.replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  assert.equal(stripped, input);
  for (const token of [
    '/help', '/مساعدة', '/status', '/model',
    'https://example.com/docs?q=bridge',
    'C:\\Program Files\\Claude\\claude.exe',
    'claude-sonnet-5', '--effort'
  ]) {
    assert.equal(stripped.includes(token), true, token);
    assert.equal(normalized.includes(`\u2066${token}\u2069`), true, token);
  }
  assert.equal(normalized.includes('/\u2066help\u2069'), false);
});

test('splits long text without breaking surrogate pairs', () => {
  const input = '😀'.repeat(3000);
  const chunks = splitTelegramText(input, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test('prefers readable newline boundaries', () => {
  const input = `${'أ'.repeat(50)}\n${'ب'.repeat(50)}`;
  const chunks = splitTelegramText(input, 70);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(''), input);
});
