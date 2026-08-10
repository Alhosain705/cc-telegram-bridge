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

test('gives non-technical users direct package and checksum links', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const manual = fs.readFileSync(path.join(root, 'MANUAL.html'), 'utf8');
  const packageUrl = 'https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip';
  const checksumUrl = `${packageUrl}.sha256`;

  assert.ok(readme.split(packageUrl).length >= 4, 'README must link the package in both languages and installation steps');
  assert.ok(readme.split(checksumUrl).length >= 3, 'README must link the checksum in both languages');
  assert.match(readme, /لا تستخدم \*\*Code → Download ZIP\*\*/);
  assert.match(readme, /Do not use \*\*Code → Download ZIP\*\*/);
  assert.match(manual, new RegExp(packageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(manual, new RegExp(checksumUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
