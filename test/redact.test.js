'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { redact } = require('../src/redact');

test('redacts Windows paths without consuming a following line', () => {
  const input = 'failure at D:\\AgentFele Local\\private\\state.json\n/var/private/next.log';
  const output = redact(input);
  assert.equal(output, 'failure at <REDACTED_PATH>\n<REDACTED_PATH>');
  assert.equal(output.includes('AgentFele'), false);
  assert.equal(output.includes('/var/private'), false);
});

test('redacts drive, UNC, and generic POSIX paths while preserving command tails and URLs', () => {
  const input = [
    'cd D:\\private folder && echo windows',
    'type \\\\server\\share\\owner\\secret.txt; echo unc',
    'cat /var/lib/private/state.json | echo posix',
    'type C:/private/file.txt & echo cmd-tail',
    'source:/opt/private/config.json',
    'curl https://example.test/public/path'
  ].join('\n');
  assert.equal(redact(input), [
    'cd <REDACTED_PATH> && echo windows',
    'type <REDACTED_PATH>; echo unc',
    'cat <REDACTED_PATH> | echo posix',
    'type <REDACTED_PATH> & echo cmd-tail',
    'source:<REDACTED_PATH>',
    'curl https://example.test/public/path'
  ].join('\n'));
});

test('redacts absolute paths beside common prose and Markdown punctuation', () => {
  const privatePath = 'D:\\AgentFele Local\\private\\.env';
  for (const [prefix, suffix] of [
    ['`', '`'], ['**', '**'], ['#', ';'], ['~', ';'], ['%', ';'], ['+', ';'],
    ['.', ';'], [')', ';'], ['*', '*']
  ]) {
    const output = redact(`before ${prefix}${privatePath}${suffix} after`);
    assert.equal(output.includes(privatePath), false, `${prefix} leaked the path`);
    assert.match(output, /<REDACTED_PATH>/);
    assert.match(output, /after$/);
  }
  for (const [prefix, suffix] of [['_', '_'], ['__', '__']]) {
    const output = redact(`before ${prefix}${privatePath}${suffix} after`);
    assert.equal(output, `before ${prefix}<REDACTED_PATH>${suffix} after`);
  }
});

test('preserves bridge commands and URLs while still redacting nearby POSIX paths', () => {
  const commands = '/start /help /status /new /permissions /model /restart /diagnose';
  const url = 'https://example.test/public/path';
  assert.equal(redact(`${commands}\n${url}\n/var/private/state.json`),
    `${commands}\n${url}\n<REDACTED_PATH>`);
});

test('redacts legal bracketed and ampersand Windows path characters without leaking the tail', () => {
  for (const path of [
    'C:\\Program Files (x86)\\App\\private-notes.txt',
    'C:\\Users\\AgentFele\\Documents\\Report (final).docx',
    'D:\\private\\R&D\\secret.txt',
    'C:\\Users\\AgentFele\\Research & Development\\secret.txt',
    'C:\\Users\\AgentFele\\Tom & Jerry\\private.txt',
    'D:\\private\\Q & A\\answers.txt',
    'D:\\private\\[archive]\\secret.txt',
    'D:\\private\\{tmp}\\secret.txt',
    'C:\\Users\\AgentFele\\Documents\\draft_ v2\\secret.txt',
    'D:\\private\\report_ (final).docx',
    'C:\\private\\weird)name\\secret.txt',
    'D:\\private\\notes_.txt',
    'D:\\private\\backup&git',
    'D:\\private\\backup &git',
    'D:\\private\\Report, Final.docx',
    '/var/private/Backup (2)/state.json'
  ]) {
    assert.equal(redact(path), '<REDACTED_PATH>', `${path} leaked a path tail`);
  }
  assert.equal(redact('type D:\\private\\R&D\\secret.txt & echo tail'),
    'type <REDACTED_PATH> & echo tail');
  assert.equal(redact('open D:\\private\\backup&git'),
    'open <REDACTED_PATH>');
  assert.equal(redact('type D:\\private\\a.txt & type C:\\other\\b.txt'),
    'type <REDACTED_PATH> & type <REDACTED_PATH>');
  assert.equal(redact('see (D:\\private\\secret.txt). ok'),
    'see (<REDACTED_PATH>). ok');
  assert.equal(redact('see [D:\\private\\secret.txt]: ok'),
    'see [<REDACTED_PATH>]: ok');
  assert.equal(redact('see {D:\\private\\secret.txt}, ok'),
    'see {<REDACTED_PATH>}, ok');
  assert.equal(redact('markdown [label](D:\\private\\a.txt), tail'),
    'markdown [label](<REDACTED_PATH>), tail');
  assert.equal(redact('see D:\\private\\secret.txt). ok'),
    'see <REDACTED_PATH>). ok');
});

test('redacts local paths embedded in URLs while preserving public URL structure', () => {
  assert.equal(redact('file:///C:/Users/AgentFele/.ssh/id_rsa'),
    'file://<REDACTED_PATH>');
  assert.equal(redact('file://server/share/private/state.json'),
    'file://server<REDACTED_PATH>');
  assert.equal(redact('vscode://file/D:/private/secret.txt'),
    'vscode://file<REDACTED_PATH>');
  assert.equal(redact('http://h/?p=/etc/shadow'),
    'http://h/?p=<REDACTED_PATH>');
  assert.equal(redact('http://h/?p=D:/private/.env'),
    'http://h/?p=<REDACTED_PATH>');
  assert.equal(redact('http://h/?target=file:///C:/private/.env&mode=view'),
    'http://h/?target=<REDACTED_PATH>&mode=view');
  assert.equal(redact('https://docs.test/guide#/var/private/state.json'),
    'https://docs.test/guide#<REDACTED_PATH>');
  assert.equal(redact('http://h/foo/D:/private/secret.txt'),
    'http://h/foo/<REDACTED_PATH>');
  assert.equal(redact('http://h/foo/bar/../../C:/private/secret.txt'),
    'http://h/foo/bar/../../<REDACTED_PATH>');
  assert.equal(redact('http://h/foo/\\\\server\\share\\private\\secret.txt'),
    'http://h/foo/<REDACTED_PATH>');
  assert.equal(redact('http://h/foo/%5C%5Cserver%5Cshare%5Cprivate%5Csecret.txt'),
    'http://h/foo/<REDACTED_PATH>');
  assert.equal(redact('http://h/?file=/home/owner/private.txt'),
    'http://h/?file=<REDACTED_PATH>');
  assert.equal(redact('http://h/?p=C%3A%2Fprivate%2F.env'),
    'http://h/?p=<REDACTED_PATH>');
  assert.equal(redact('http://h/?p=C%253A%252Fprivate%252F.env'),
    'http://h/?p=<REDACTED_PATH>');
  assert.equal(redact('http://h/?next=%252Fhome%252Fhussain%252F.ssh%252Fid_rsa'),
    'http://h/?next=<REDACTED_PATH>');
  for (const url of [
    'http://h/?next=/home/hussain/.ssh/id_rsa',
    'http://h/?path=/home/hussain/.ssh/id_rsa',
    'http://h/?u=/Users/hussain/Documents/.env',
    'http://h/?src=/media/hussain/usb/id_rsa',
    'http://h/?p=/srv/hussain/secret/id_rsa',
    'http://h/?p=/run/user/1000/keyring/id_rsa',
    'http://h/x#/home/hussain/.ssh/id_rsa',
    'http://h/x#/Users/hussain/.ssh/id_rsa'
  ]) {
    assert.equal(redact(url).includes('hussain'), false, `${url} leaked a local path`);
    assert.match(redact(url), /<REDACTED_PATH>/);
  }
  for (const root of ['home', 'media', 'run', 'srv', 'users']) {
    for (const key of ['next', 'path', 'src', 'p', 'u', 'url', 'redirect']) {
      const localPath = `/${root}/owner/.private`;
      for (const encodedPath of [
        localPath,
        encodeURIComponent(localPath),
        encodeURIComponent(encodeURIComponent(localPath))
      ]) {
        const url = `http://h/?${key}=${encodedPath}`;
        assert.match(redact(url), /<REDACTED_PATH>/, `${url} leaked a local path`);
      }
      const publicUrl = `https://example.test/?${key}=/${root}/dashboard`;
      assert.equal(redact(publicUrl), publicUrl, `${publicUrl} was distorted`);
    }
  }
  for (const url of [
    'https://example.test/public/path?q=public',
    'https://example.test/redir?next=/login',
    'https://example.test/redir?next=/home/dashboard',
    'https://example.test/profile?path=/users/42',
    'https://example.test/assets?src=/media/logo.png',
    'https://example.test/oauth?redirect_uri=/callback&state=abc',
    'https://github.test/o/r/blob/main/src/index.js?path=/src/index.js',
    'https://api.test/v1/items?filter=/active&sort=name',
    'https://docs.test/guide#/getting-started',
    'https://docs.test/guide#/users/42',
    'https://example.test/ci?job=/build/42'
  ]) {
    assert.equal(redact(url), url, `${url} was distorted`);
  }
});

function medianRedactionTime(input, repeats = 5) {
  redact(input);
  const samples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < repeats; iteration += 1) redact(input);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

test('path and every credential redaction rule scale near-linearly across fourfold inputs', () => {
  const sizes = [8 * 1024, 16 * 1024, 32 * 1024];
  const cases = [
    ['path whitespace', (size) => `D:\\private${' '.repeat(size)}\nfinished`],
    ['ampersands inside a path', (size) =>
      `D:\\private\\${'A & '.repeat(Math.ceil(size / 4))}tail\\secret.txt`],
    ['underscore closer candidates', (size) => `_/${'_'.repeat(size)}x`],
    ['bot-like digits', (size) => '9'.repeat(size)],
    ['API-key prefix', (size) => `sk-${'A'.repeat(size)}`],
    ['authorization header', (size) => `Authorization: Bearer ${'A'.repeat(size)}`],
    ['bearer value', (size) => `Bearer ${'A'.repeat(size)}`],
    ['unclosed private-key markers', (size) =>
      '-----BEGIN A PRIVATE KEY-----'.repeat(Math.ceil(size / 29))],
    ['long private-key label', (size) => {
      const label = 'A'.repeat(size);
      return `-----BEGIN ${label} PRIVATE KEY-----\nbody\n` +
        `-----END ${label} PRIVATE KEY-----`;
    }],
    ['percent-decoding', (size) => `http://h/?p=${'%25'.repeat(Math.ceil(size / 3))}`],
    ['JWT-like value', (size) => `eyJ${'A'.repeat(size)}.eyJ${'B'.repeat(size)}.sig`],
    ['named secret', (size) => `token=${'A'.repeat(size)}`]
  ];
  for (const [label, makeInput] of cases) {
    const timings = sizes.map((size) => medianRedactionTime(makeInput(size), 3));
    const growth = timings[2] / Math.max(timings[0], 0.001);
    assert.ok(growth < 8,
      `${label} grew ${growth.toFixed(2)}x across 4x input ` +
      `(${timings.map((time) => time.toFixed(2)).join(' -> ')}ms)`);
  }
});

test('redacts representative credentials independently of path handling', () => {
  const token = `123456789:${'A'.repeat(30)}`;
  const output = redact(`Authorization: Bearer secret-value\nbot=${token}`);
  assert.equal(output, '<REDACTED>\nbot=<REDACTED>');
  assert.equal(redact('header Bearer abcdefghijklmnop tail'), 'header <REDACTED> tail');
  const privateKey = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'synthetic-key-body',
    '-----END RSA PRIVATE KEY-----'
  ].join('\n');
  assert.equal(redact(`before ${privateKey} after`), 'before <REDACTED> after');
  const longLabel = 'A'.repeat(70);
  const longLabelKey = [
    `-----BEGIN ${longLabel} PRIVATE KEY-----`,
    'synthetic-key-body',
    `-----END ${longLabel} PRIVATE KEY-----`
  ].join('\n');
  assert.equal(redact(`before ${longLabelKey} after`), 'before <REDACTED> after');
  const unboundedLabel = 'A'.repeat(257);
  const unboundedLabelKey = [
    `-----BEGIN ${unboundedLabel} PRIVATE KEY-----`,
    'synthetic-key-body',
    `-----END ${unboundedLabel} PRIVATE KEY-----`
  ].join('\n');
  assert.equal(redact(`before ${unboundedLabelKey} after`), 'before <REDACTED> after');
  const hyphenatedLabelKey = [
    '-----BEGIN X-Y PRIVATE KEY-----',
    'synthetic-key-body',
    '-----END X-Y PRIVATE KEY-----'
  ].join('\n');
  assert.equal(redact(`before ${hyphenatedLabelKey} after`), 'before <REDACTED> after');
  assert.equal(redact('before -----BEGIN RSA PRIVATE KEY-----\ntruncated-secret-body'),
    'before <REDACTED>');
  assert.equal(redact(`Bearer ${'X'.repeat(20)}?Bearer ${'Y'.repeat(20)}`),
    '<REDACTED>?<REDACTED>');
  assert.equal(redact('Authorization: Bearer abc:def?Bearer xyz:123 tail'),
    '<REDACTED>?<REDACTED> tail');
});

test('preserves wrapper and shell-tail invariants across representative combinations', () => {
  const privatePath = 'D:\\private\\folder\\secret.txt';
  for (const [open, close] of [
    ['(', ')'], ['[', ']'], ['{', '}'], ['_', '_'], ['__', '__'], ['`', '`'], ['**', '**']
  ]) {
    assert.equal(redact(`before ${open}${privatePath}${close}, TAIL`),
      `before ${open}<REDACTED_PATH>${close}, TAIL`);
  }
  for (const command of ['cat', 'echo', 'git', 'powershell', 'rm', 'type']) {
    assert.equal(redact(`type ${privatePath} & ${command} C:\\other\\secret.txt`),
      `type <REDACTED_PATH> & ${command} <REDACTED_PATH>`);
  }
});
