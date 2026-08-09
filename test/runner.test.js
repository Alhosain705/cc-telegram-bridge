'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  ClaudeRunner,
  MAX_EVENT_LINE_BYTES,
  buildChildEnv,
  commandSpecForFile,
  extractEventText
} = require('../src/runner');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 43210;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    this.emit('exit', 1, 'SIGTERM');
  }
}

const logger = {
  info() {},
  warn() {},
  error() {}
};

const syntheticApprovalContext = Object.freeze({
  mcpConfig: '{"mcpServers":{}}',
  env: { CC_BRIDGE_APPROVAL_PIPE: 'synthetic-pipe', CC_BRIDGE_APPROVAL_SECRET: 'synthetic-secret' }
});

test('scrubs broad credential names including _FILE variants from the child', () => {
  const env = buildChildEnv({
    PATH: 'ok',
    TELEGRAM_BOT_TOKEN: 'secret',
    RANDOM_PASSWORD: 'secret',
    SERVICE_API_KEY: 'secret',
    SERVICE_TOKEN_FILE: 'secret-path',
    CLAUDE_CODE_OAUTH_TOKEN: 'needed',
    ANTHROPIC_API_KEY: 'billable'
  }, false);
  assert.equal(env.PATH, 'ok');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.RANDOM_PASSWORD, undefined);
  assert.equal(env.SERVICE_API_KEY, undefined);
  assert.equal(env.SERVICE_TOKEN_FILE, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'needed');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('allows API billing only after an explicit configuration choice', () => {
  const env = buildChildEnv({ ANTHROPIC_API_KEY: 'billable' }, true);
  assert.equal(env.ANTHROPIC_API_KEY, 'billable');
});

test('maps JavaScript CLI files to Node without a shell', () => {
  const spec = commandSpecForFile('C:\\tools\\claude\\cli.js');
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.prefixArgs, ['C:\\tools\\claude\\cli.js']);
});

test('resolves a modern npm cmd shim to the packaged native executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-runner-'));
  const shim = path.join(root, 'claude.cmd');
  const executable = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(shim, '@echo off\n');
  fs.writeFileSync(executable, '');
  const spec = commandSpecForFile(shim);
  assert.equal(spec.command, executable);
  assert.deepEqual(spec.prefixArgs, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('extracts final and assistant text from stream events', () => {
  assert.equal(extractEventText({ type: 'result', result: 'done' }), 'done');
  assert.equal(extractEventText({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }] }
  }), 'hello');
});

test('releases the execution lock on exit even if close never arrives', async () => {
  const child = new FakeChild();
  const runner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowApiBilling: false,
    logger,
    spawnImpl: () => child
  });
  const running = runner.run({
    prompt: 'hello',
    taskId: 'task-1',
    unsafe: false,
    approvalContext: syntheticApprovalContext,
    onActivity() {}
  });
  child.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'finished' }] }
  })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'result', result: 'finished', session_id: 'session-1' })}\n`);
  child.emit('exit', 0, null);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'finished');
  assert.equal(runner.isBusy(), false);
});

test('skips an oversized event and completes on the following valid result', async () => {
  const child = new FakeChild();
  const runner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowApiBilling: false,
    logger,
    spawnImpl: () => child
  });
  const running = runner.run({
    prompt: 'hello',
    taskId: 'task-2',
    unsafe: false,
    approvalContext: syntheticApprovalContext,
    onActivity() {}
  });
  child.stdout.write(`${'x'.repeat(MAX_EVENT_LINE_BYTES + 1)}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'result', result: 'still finished' })}\n`);
  child.emit('exit', 0, null);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'still finished');
  assert.equal(result.skippedLargeEvents, true);
});

test('safe execution fails closed when the approval broker context is missing', async () => {
  let spawned = false;
  const runner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowApiBilling: false,
    logger,
    spawnImpl: () => { spawned = true; return new FakeChild(); }
  });
  await assert.rejects(runner.run({
    prompt: 'hello', taskId: 'safe-without-broker', unsafe: false, onActivity() {}
  }), /approval_context_required/);
  assert.equal(spawned, false);
});
