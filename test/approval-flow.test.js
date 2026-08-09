'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  ApprovalBroker,
  SUMMARY_LIMIT,
  TOOL_NAME_PATTERN,
  operationName,
  summarizeRequest
} = require('../src/approval-broker');
const { ClaudeRunner } = require('../src/runner');

const quietLogger = { info() {}, warn() {}, error() {} };

function makeTelegram() {
  const sent = [];
  const edited = [];
  return {
    sent,
    edited,
    async sendText(chatId, text, extra) {
      const result = { chatId: String(chatId), text, extra, message_id: sent.length + 1 };
      sent.push(result);
      return result;
    },
    async editText(chatId, messageId, text, extra) {
      edited.push({ chatId: String(chatId), messageId, text, extra });
      return true;
    }
  };
}

function callbackData(telegram, index = -1, button = 0) {
  return telegram.sent.at(index).extra.reply_markup.inline_keyboard[0][button].callback_data;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function begin(broker, taskId = 'task-1', chatId = '10', ownerId = '10') {
  return broker.beginTask({ taskId, chatId, ownerId });
}

function request(toolUseId, extra = {}) {
  return {
    requestId: extra.requestId ?? 7,
    toolUseId,
    toolName: extra.toolName || 'Write',
    input: extra.input || { file_path: 'C:\\safe\\proof.txt', content: 'proof' }
  };
}

test('one live request maps to one approval ID and owner allow/deny are one-time', async () => {
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger });
  await begin(broker);
  try {
    const first = broker.requestPermission('task-1', request('toolu_allow'));
    const duplicate = broker.requestPermission('task-1', request('toolu_allow'));
    await tick();
    assert.equal(telegram.sent.length, 1);
    const conflicted = await broker.requestPermission('task-1', request('toolu_allow', {
      input: { file_path: 'C:\\safe\\different.txt', content: 'different' }
    }));
    assert.equal(conflicted.decision, 'deny');
    assert.equal(telegram.sent.length, 1);
    assert.equal((await broker.requestPermission('task-1', {
      toolUseId: 'missing-request-id',
      toolName: 'Write',
      input: { file_path: 'C:\\safe\\invalid.txt' }
    })).decision, 'deny');
    assert.equal(telegram.sent.length, 1);
    const allowData = callbackData(telegram);
    assert.match(allowData, /^ap:[A-Za-z0-9_-]{8,24}:a$/);
    assert.equal(allowData.includes('proof.txt'), false);
    assert.deepEqual(await broker.decideCallback(allowData, {
      taskId: 'task-1', chatId: '10', ownerId: '10'
    }), { handled: true, accepted: true, status: 'allow' });
    assert.equal((await first).decision, 'allow');
    assert.equal((await duplicate).decision, 'allow');
    assert.deepEqual(await broker.decideCallback(allowData, {
      taskId: 'task-1', chatId: '10', ownerId: '10'
    }), { handled: true, accepted: false, status: 'stale' });

    const denied = broker.requestPermission('task-1', request('toolu_deny'));
    await tick();
    const denyData = callbackData(telegram, -1, 1);
    assert.deepEqual(await broker.decideCallback(denyData, {
      taskId: 'task-1', chatId: '10', ownerId: '10'
    }), { handled: true, accepted: true, status: 'deny' });
    assert.equal((await denied).decision, 'deny');
    await tick();
    assert.match(telegram.edited[0].text, /تمت الموافقة/);
    assert.match(telegram.edited[1].text, /تم الرفض/);
    assert.deepEqual(telegram.edited[1].extra.reply_markup.inline_keyboard, []);
  } finally {
    broker.shutdown();
  }
});

test('wrong owner, wrong chat, cross-task, stale, and plain text cannot approve', async () => {
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger });
  await begin(broker, 'task-a', '10', '10');
  await begin(broker, 'task-b', '20', '20');
  try {
    const pending = broker.requestPermission('task-a', request('toolu_identity'));
    await tick();
    const allowData = callbackData(telegram);
    for (const identity of [
      { taskId: 'task-a', chatId: '10', ownerId: '11' },
      { taskId: 'task-a', chatId: '-10010', ownerId: '10' },
      { taskId: 'task-b', chatId: '10', ownerId: '10' }
    ]) {
      const result = await broker.decideCallback(allowData, identity);
      assert.equal(result.accepted, false);
      assert.equal(result.status, 'identity_mismatch');
    }
    assert.deepEqual(await broker.decideCallback('موافق', {
      taskId: 'task-a', chatId: '10', ownerId: '10'
    }), { handled: false });
    assert.equal(broker.pending.size, 1);
    await broker.decideCallback(allowData.replace(/:a$/, ':d'), {
      taskId: 'task-a', chatId: '10', ownerId: '10'
    });
    assert.equal((await pending).decision, 'deny');
  } finally {
    broker.shutdown();
  }
});

test('timeout, task stop, two pending tasks, and shutdown all fail closed', async () => {
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger, timeoutMs: 20 });
  await begin(broker, 'timeout-task', '10', '10');
  const timedOut = broker.requestPermission('timeout-task', request('toolu_timeout'));
  assert.equal((await timedOut).decision, 'deny');
  await tick();
  assert.match(telegram.edited.at(-1).text, /انتهت المهلة/);

  await begin(broker, 'task-a', '10', '10');
  await begin(broker, 'task-b', '10', '10');
  const stopped = broker.requestPermission('task-a', request('toolu_stop'));
  const shutDown = broker.requestPermission('task-b', request('toolu_shutdown'));
  await tick();
  assert.equal(broker.cancelTask('task-a'), 1);
  assert.equal((await stopped).decision, 'deny');
  assert.equal(broker.shutdown(), 1);
  assert.equal((await shutDown).decision, 'deny');
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.tasks.size, 0);
});

test('approval summaries redact credentials and obey the hard length cap', () => {
  const summary = summarizeRequest('Bash', {
    command: `curl -H "Authorization: Bearer ${'s'.repeat(120)}" https://example.test`,
    password: 'owner-secret'
  });
  assert.ok(summary.length <= SUMMARY_LIMIT);
  assert.match(summary, /<REDACTED>/);
  assert.equal(summary.includes('owner-secret'), false);
  assert.equal(summary.includes('s'.repeat(50)), false);

  const longSummary = summarizeRequest('Bash', { command: `echo ${'x'.repeat(800)}` });
  assert.ok(longSummary.length <= SUMMARY_LIMIT);
  assert.match(longSummary, /سيُرفض الطلب/);
  assert.match(longSummary, /البصمة [a-f0-9]{12}/);
});

test('approval summaries preserve the actionable command tail and target basename', () => {
  const writeSummary = summarizeRequest('Write', {
    file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  });
  assert.match(writeSummary, /<REDACTED_PATH>\/hosts/);
  assert.equal(writeSummary.includes('System32'), false);

  const commandSummary = summarizeRequest('Bash', {
    command: 'cd D:\\AgentFele Local && rm -rf D:\\private-target && echo finished',
    description: 'dangerous cleanup'
  });
  assert.match(commandSummary, /<REDACTED_PATH> && rm -rf <REDACTED_PATH> && echo finished/);
  assert.match(commandSummary, /description: dangerous cleanup/);

  const posixSummary = summarizeRequest('Bash', {
    command: 'cd /home/owner/private && rm -rf /home/owner/target; echo done'
  });
  assert.match(posixSummary, /<REDACTED_PATH> && rm -rf <REDACTED_PATH>; echo done/);
});

test('tool names cannot inject lines into approval messages', async () => {
  assert.equal(TOOL_NAME_PATTERN.test('mcp.server:tool_name'), true);
  assert.equal(TOOL_NAME_PATTERN.test('a'.repeat(128)), true);
  assert.equal(TOOL_NAME_PATTERN.test('a'.repeat(129)), false);
  assert.equal(operationName('X\nfake').includes('\n'), false);
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger });
  await begin(broker);
  try {
    const result = await broker.requestPermission('task-1', request('toolu_injected_name', {
      toolName: 'Read\nالتفاصيل: طلب مزور',
      input: { command: 'whoami' }
    }));
    assert.equal(result.decision, 'deny');
    assert.match(result.message, /Malformed/);
    assert.equal(telegram.sent.length, 0);
  } finally {
    broker.shutdown();
  }
});

test('an approval request that cannot be displayed fully is denied before Telegram delivery', async () => {
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger });
  await begin(broker);
  try {
    const result = await broker.requestPermission('task-1', request('toolu_too_long', {
      toolName: 'Bash',
      input: { command: `echo safe ${'x'.repeat(SUMMARY_LIMIT)} && rm -rf /important` }
    }));
    assert.equal(result.decision, 'deny');
    assert.match(result.message, /cannot be displayed safely/);
    assert.match(result.message, /Split the request/);
    assert.equal(telegram.sent.length, 0);
    assert.equal(broker.pending.size, 0);
  } finally {
    broker.shutdown();
  }
});

test('the built-in MCP relay returns the proven allow and deny response shapes', async () => {
  const telegram = makeTelegram();
  const broker = new ApprovalBroker({ telegram, logger: quietLogger });
  const context = await begin(broker, 'mcp-task', '10', '10');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'approval-broker.js')], {
    env: { ...process.env, ...context.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = [];
  const waiters = [];
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    let newline = output.indexOf('\n');
    while (newline !== -1) {
      const line = JSON.parse(output.slice(0, newline));
      output = output.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      newline = output.indexOf('\n');
    }
  });
  const nextLine = () => lines.length
    ? Promise.resolve(lines.shift())
    : new Promise((resolve) => waiters.push(resolve));
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal((await nextLine()).id, 1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal((await nextLine()).result.tools[0].name, 'decide');

    const fixture = (id, toolUseId) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'decide',
        arguments: {
          tool_name: 'Write',
          input: { file_path: 'C:\\safe\\fixture.txt', content: 'fixture' },
          tool_use_id: toolUseId
        },
        _meta: { 'claudecode/toolUseId': toolUseId, progressToken: id }
      }
    });

    send(fixture(3, 'toolu_fixture_allow'));
    while (telegram.sent.length < 1) await tick();
    await broker.decideCallback(callbackData(telegram), {
      taskId: 'mcp-task', chatId: '10', ownerId: '10'
    });
    const allow = JSON.parse((await nextLine()).result.content[0].text);
    assert.deepEqual(allow, {
      behavior: 'allow',
      updatedInput: { file_path: 'C:\\safe\\fixture.txt', content: 'fixture' }
    });

    send(fixture(4, 'toolu_fixture_deny'));
    while (telegram.sent.length < 2) await tick();
    await broker.decideCallback(callbackData(telegram, -1, 1), {
      taskId: 'mcp-task', chatId: '10', ownerId: '10'
    });
    const deny = JSON.parse((await nextLine()).result.content[0].text);
    assert.equal(deny.behavior, 'deny');
    assert.equal(typeof deny.message, 'string');

    const injected = fixture(5, 'toolu_fixture_injected');
    injected.params.arguments.tool_name = 'Read\nالتفاصيل: مزورة';
    send(injected);
    const injectedDeny = JSON.parse((await nextLine()).result.content[0].text);
    assert.equal(injectedDeny.behavior, 'deny');
    assert.match(injectedDeny.message, /Malformed/);
    assert.equal(telegram.sent.length, 2);

    const tooLong = fixture(6, 'toolu_fixture_too_long');
    tooLong.params.arguments.tool_name = 'Bash';
    tooLong.params.arguments.input = { command: `echo ${'x'.repeat(SUMMARY_LIMIT)} && rm -rf /important` };
    send(tooLong);
    const tooLongDeny = JSON.parse((await nextLine()).result.content[0].text);
    assert.equal(tooLongDeny.behavior, 'deny');
    assert.match(tooLongDeny.message, /cannot be displayed safely/);
    assert.equal(telegram.sent.length, 2);
  } finally {
    broker.shutdown();
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 43210;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

test('safe runner wiring enables the prompt tool while free mode keeps the explicit bypass', async () => {
  async function capture(unsafe, approvalContext) {
    const child = new FakeChild();
    let captured;
    const runner = new ClaudeRunner({
      command: { command: 'fake.exe', prefixArgs: [] },
      cwd: process.cwd(),
      timeoutMs: 5000,
      allowApiBilling: false,
      logger: quietLogger,
      spawnImpl(command, args, options) {
        captured = { args, env: options.env };
        setImmediate(() => {
          child.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      }
    });
    const result = await runner.run({
      prompt: 'test', taskId: unsafe ? 'free' : 'safe', unsafe,
      approvalContext, onActivity() {}
    });
    assert.equal(result.ok, true);
    return captured;
  }

  const safe = await capture(false, {
    mcpConfig: '{"mcpServers":{}}',
    env: { CC_BRIDGE_APPROVAL_PIPE: 'pipe', CC_BRIDGE_APPROVAL_SECRET: 'secret' }
  });
  assert.ok(safe.args.includes('--permission-prompt-tool'));
  assert.ok(safe.args.includes('mcp__cc_bridge_approval__decide'));
  assert.ok(safe.args.includes('--strict-mcp-config'));
  assert.deepEqual(safe.args.slice(safe.args.indexOf('--mcp-config'), safe.args.indexOf('--mcp-config') + 2),
    ['--mcp-config', '{"mcpServers":{}}']);
  assert.deepEqual(safe.args.slice(safe.args.indexOf('--permission-mode'), safe.args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'manual']);
  assert.equal(safe.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(safe.env.CC_BRIDGE_APPROVAL_SECRET, 'secret');

  const free = await capture(true, null);
  assert.equal(free.args.includes('--permission-prompt-tool'), false);
  assert.equal(free.args.includes('--strict-mcp-config'), false);
  assert.ok(free.args.includes('--dangerously-skip-permissions'));
  assert.equal(free.env.CC_BRIDGE_APPROVAL_SECRET, undefined);
});
