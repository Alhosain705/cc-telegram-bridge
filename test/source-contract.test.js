'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceFiles = fs.readdirSync(path.join(root, 'src'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(root, 'src', name));

test('contains no empty catch blocks', () => {
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(content), false, file);
  }
});

test('contains none of the private-system features removed by design', () => {
  const content = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const forbidden = [
    'MAESTRO_',
    'AGENT_STATE_REPO',
    '/twin',
    '/backup',
    '/screenshot',
    'ultracode',
    'selfPublisher'
  ];
  for (const token of forbidden) assert.equal(content.includes(token), false, token);
});

test('does not enable dangerous permission skipping by default', () => {
  const runner = fs.readFileSync(path.join(root, 'src', 'runner.js'), 'utf8');
  assert.match(runner, /\.\.\.\(unsafe \? \['--dangerously-skip-permissions'\] : \[\]\)/);
});

test('keeps Telegram sends in plain text without parse_mode', () => {
  const telegram = fs.readFileSync(path.join(root, 'src', 'telegram.js'), 'utf8');
  assert.equal(telegram.includes('parse_mode'), false);
});
