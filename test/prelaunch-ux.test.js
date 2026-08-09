'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  Bridge,
  EFFORT_KEYBOARD,
  HELP_KEYBOARD,
  formatDuration
} = require('../src/bridge');
const {
  DEFAULT_MODEL,
  EFFORT_DEFINITIONS,
  MODEL_DEFINITIONS,
  effortDisplayName,
  modelDisplayName
} = require('../src/models');
const { ClaudeRunner, classifyClaudeFailure } = require('../src/runner');
const { JsonStore, normalizeState } = require('../src/store');
const { TelegramClient } = require('../src/telegram');

const quietLogger = { info() {}, warn() {}, error() {} };
const syntheticApprovalContext = Object.freeze({
  mcpConfig: '{"mcpServers":{}}',
  env: { CC_BRIDGE_APPROVAL_PIPE: 'synthetic-pipe', CC_BRIDGE_APPROVAL_SECRET: 'synthetic-secret' }
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function withoutBidi(value) {
  return String(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

function makeBridge(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prelaunch-ux-'));
  const store = new JsonStore(path.join(directory, 'state.json'), quietLogger);
  store.state.pairedUsers = ['10'];
  store.state.permissions = { 10: 'safe' };
  store.save();
  const sent = [];
  const edits = [];
  const callbacks = [];
  const typing = [];
  const telegram = overrides.telegram || {
    async sendPreparedText(chatId, text, extra) {
      const result = { chatId: String(chatId), text, extra, message_id: sent.length + 1 };
      sent.push(result);
      return result;
    },
    async sendText(chatId, text, extra) {
      const result = { chatId: String(chatId), text, extra, message_id: sent.length + 1 };
      sent.push(result);
      return result;
    },
    async editText(chatId, messageId, text, extra) {
      edits.push({ chatId: String(chatId), messageId, text, extra });
      return true;
    },
    async sendTyping(chatId) { typing.push(String(chatId)); },
    async answerCallback(id, text) { callbacks.push({ id, text }); }
  };
  const runner = overrides.runner || {
    isBusy() { return false; },
    cancel() { return false; },
    async diagnose() { return { status: 'authenticated' }; },
    async run() { return { ok: true, text: 'done', sessionId: 'session' }; }
  };
  const bridge = new Bridge({
    config: {
      ownerIds: new Set(['10']),
      expectedBotUsername: '',
      apiKeyDetected: false,
      allowApiBilling: false
    },
    store,
    telegram,
    runner,
    approvalBroker: overrides.approvalBroker,
    logger: quietLogger,
    sleep: async () => {},
    random: () => 0.5,
    now: overrides.now,
    setIntervalImpl: overrides.setIntervalImpl,
    clearIntervalImpl: overrides.clearIntervalImpl
  });
  return { bridge, callbacks, directory, edits, runner, sent, store, telegram, typing };
}

async function slash(owned, text) {
  return owned.bridge.handleMessage(
    { text, chat: { id: 10, type: 'private' }, from: { id: 10 } },
    { chatId: 10, chatType: 'private', userId: 10 }
  );
}

async function callback(owned, data) {
  return owned.bridge.handleCallback(
    { id: `callback-${data}`, data },
    { chatId: 10, chatType: 'private', userId: 10 }
  );
}

test('every clickable help command uses the same command action as its slash counterpart', async () => {
  const commandCases = {
    status: '/status',
    new: '/new',
    permissions: '/permissions',
    model: '/model',
    restart: '/restart',
    diagnose: '/diagnose'
  };
  const helpCallbacks = HELP_KEYBOARD.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(helpCallbacks.sort(), Object.keys(commandCases).map((name) => `cmd:${name}`).sort());

  for (const [command, slashText] of Object.entries(commandCases)) {
    const fromSlash = makeBridge({ now: () => 120_000 });
    const fromButton = makeBridge({ now: () => 120_000 });
    try {
      if (command === 'new') {
        fromSlash.store.setSession('10', 'old-session');
        fromButton.store.setSession('10', 'old-session');
      }
      const slashAction = await slash(fromSlash, slashText);
      const buttonAction = await callback(fromButton, `cmd:${command}`);
      assert.equal(buttonAction, slashAction, command);
      assert.equal(fromButton.sent.at(-1).text, fromSlash.sent.at(-1).text, command);
      assert.deepEqual(fromButton.sent.at(-1).extra, fromSlash.sent.at(-1).extra, command);
      assert.equal(fromButton.store.getSession('10'), fromSlash.store.getSession('10'), command);
      assert.match(fromButton.callbacks.at(-1).text, /تم تنفيذ الأمر/);
    } finally {
      fs.rmSync(fromSlash.directory, { recursive: true, force: true });
      fs.rmSync(fromButton.directory, { recursive: true, force: true });
    }
  }
});

test('wrong-user and group help callbacks cannot execute owner commands', async () => {
  const owned = makeBridge();
  owned.store.setSession('10', 'keep-session');
  try {
    await owned.bridge.handleUpdate({
      callback_query: {
        id: 'group-callback',
        data: 'cmd:new',
        message: { chat: { id: -10010, type: 'group' } },
        from: { id: 10 }
      }
    });
    await owned.bridge.handleUpdate({
      callback_query: {
        id: 'wrong-user-callback',
        data: 'cmd:new',
        message: { chat: { id: 10, type: 'private' } },
        from: { id: 11 }
      }
    });
    assert.equal(owned.store.getSession('10'), 'keep-session');
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('old state migrates without effort and every canonical effort persists strictly', () => {
  const old = normalizeState({
    pairedUsers: ['10'],
    permissions: { 10: 'safe' },
    models: { 10: DEFAULT_MODEL }
  });
  assert.deepEqual(old.efforts, {});

  const owned = makeBridge();
  try {
    assert.equal(owned.store.getEffort('10'), null);
    for (const effort of Object.keys(EFFORT_DEFINITIONS)) {
      owned.store.setEffort('10', effort);
      const reloaded = new JsonStore(path.join(owned.directory, 'state.json'), quietLogger);
      assert.equal(reloaded.getEffort('10'), effort);
    }
    const previous = owned.store.getEffort('10');
    assert.throws(() => owned.store.setEffort('10', 'extreme'), /invalid_effort/);
    assert.equal(owned.store.getEffort('10'), previous);
    assert.throws(() => normalizeState({ efforts: { 10: 'extreme' } }), /invalid_state_schema:efforts/);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('model selection shows versions then effort selection without forcing a default', async () => {
  const owned = makeBridge();
  try {
    assert.equal(modelDisplayName(MODEL_DEFINITIONS.haiku.id), 'هايكو 4.5');
    assert.equal(modelDisplayName(MODEL_DEFINITIONS.sonnet.id), 'سونيت 5');
    assert.equal(modelDisplayName(MODEL_DEFINITIONS.opus.id), 'أوبس 5');
    assert.equal(modelDisplayName(MODEL_DEFINITIONS.fable.id), 'فيبل 5');
    assert.equal(effortDisplayName(null), 'افتراضي من كلود');

    await callback(owned, 'model:opus');
    assert.equal(owned.store.getModel('10'), MODEL_DEFINITIONS.opus.id);
    assert.equal(owned.store.getEffort('10'), null);
    assert.deepEqual(owned.sent.at(-1).extra.reply_markup, EFFORT_KEYBOARD);
    assert.match(withoutBidi(owned.sent.at(-1).text), /أوبس 5/);

    await callback(owned, 'effort:xhigh');
    assert.equal(owned.store.getEffort('10'), 'xhigh');
    assert.match(owned.sent.at(-1).text, /عالٍ جدًا/);
    await callback(owned, 'effort:unknown');
    assert.equal(owned.store.getEffort('10'), 'xhigh');
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('free mode never opens an approval task while safe mode does', async () => {
  const opened = [];
  const closed = [];
  const runInputs = [];
  const approvalBroker = {
    async beginTask(binding) {
      opened.push(binding);
      return { mcpConfig: '{}', env: { CC_BRIDGE_APPROVAL_SECRET: 'synthetic' } };
    },
    cancelTask(taskId) { closed.push(taskId); }
  };
  const owned = makeBridge({
    approvalBroker,
    runner: {
      isBusy() { return false; },
      cancel() { return false; },
      async diagnose() { return { status: 'authenticated' }; },
      async run(input) {
        runInputs.push(input);
        return { ok: true, text: 'done', sessionId: `session-${input.taskId}` };
      }
    }
  });
  try {
    owned.store.setPermission('10', 'free');
    await owned.bridge.executeTask({ id: 'free-task', chatId: '10', userId: '10', prompt: 'free' });
    assert.equal(opened.length, 0);
    assert.equal(runInputs[0].unsafe, true);
    assert.equal(runInputs[0].approvalContext, null);

    owned.store.setPermission('10', 'safe');
    await owned.bridge.executeTask({ id: 'safe-task', chatId: '10', userId: '10', prompt: 'safe' });
    assert.deepEqual(opened, [{ taskId: 'safe-task', chatId: '10', ownerId: '10' }]);
    assert.equal(runInputs[1].unsafe, false);
    assert.equal(runInputs[1].approvalContext.env.CC_BRIDGE_APPROVAL_SECRET, 'synthetic');
    assert.deepEqual(closed, ['free-task', 'safe-task']);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
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

async function runnerArgs(effort) {
  const child = new FakeChild();
  let capturedArgs;
  const runner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowApiBilling: false,
    logger: quietLogger,
    spawnImpl(command, args) {
      capturedArgs = args;
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\n`);
        child.emit('close', 0, null);
      });
      return child;
    }
  });
  const result = await runner.run({
    prompt: 'test', taskId: `effort-${effort}`, unsafe: false, effort,
    approvalContext: syntheticApprovalContext, onActivity() {}
  });
  assert.equal(result.ok, true);
  return capturedArgs;
}

test('runner omits an unset effort and passes every selected canonical effort', async () => {
  assert.equal((await runnerArgs(null)).includes('--effort'), false);
  for (const effort of Object.keys(EFFORT_DEFINITIONS)) {
    const args = await runnerArgs(effort);
    const index = args.indexOf('--effort');
    assert.deepEqual(args.slice(index, index + 2), ['--effort', effort]);
  }
  await assert.rejects(runnerArgs('extreme'), /invalid_effort/);
  assert.equal(
    classifyClaudeFailure('The effort level xhigh is not supported for this model'),
    'effort_unavailable'
  );
});

test('status and diagnose distinguish active work, queued-behind, context, model, and effort', async () => {
  const owned = makeBridge({ now: () => 180_000 });
  try {
    owned.store.setSession('10', 'saved-session');
    owned.store.setModel('10', MODEL_DEFINITIONS.sonnet.id);
    owned.store.setEffort('10', 'high');
    owned.bridge.activeTask = { id: 'active', userId: '10', startedAt: 60_000 };
    owned.bridge.queue.push({ id: 'queued-1' }, { id: 'queued-2' });

    await slash(owned, '/status');
    const status = withoutBidi(owned.sent.at(-1).text);
    assert.match(status, /المهمة النشطة: قيد التنفيذ منذ دقيقتان/);
    assert.match(status, /طلبات تنتظر خلف المهمة النشطة: 2/);
    assert.match(status, /سياق المحادثة: محفوظ وسيُستخدم في رسالتك التالية/);
    assert.match(status, /النموذج: سونيت 5/);
    assert.match(status, /مستوى التفكير: عالٍ/);

    await slash(owned, '/diagnose');
    const diagnose = withoutBidi(owned.sent.at(-1).text);
    for (const expected of [
      /المهمة النشطة: قيد التنفيذ منذ دقيقتان/,
      /طلبات تنتظر خلف المهمة النشطة: 2/,
      /سياق المحادثة: محفوظ وسيُستخدم في رسالتك التالية/,
      /النموذج: سونيت 5/,
      /مستوى التفكير: عالٍ/
    ]) assert.match(diagnose, expected);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const handles = [];
  return {
    now: () => now,
    handles,
    activeCount: () => timers.size,
    setInterval(callback, milliseconds) {
      const handle = {
        id: nextId++,
        unrefCalled: false,
        unref() { this.unrefCalled = true; }
      };
      handles.push(handle);
      timers.set(handle.id, { callback, milliseconds, nextAt: now + milliseconds });
      return handle;
    },
    clearInterval(handle) {
      timers.delete(handle?.id);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.nextAt <= target)
          .sort((left, right) => left[1].nextAt - right[1].nextAt)[0];
        if (!due) break;
        now = due[1].nextAt;
        const current = timers.get(due[0]);
        if (!current) continue;
        current.nextAt += current.milliseconds;
        current.callback();
        await tick();
      }
      now = target;
      await tick();
    }
  };
}

test('duration formatting follows every required minute boundary', () => {
  const boundaries = [
    [0, 'أقل من دقيقة'],
    [59_000, 'أقل من دقيقة'],
    [60_000, 'دقيقة'],
    [119_000, 'دقيقة'],
    [120_000, 'دقيقتان'],
    [179_000, 'دقيقتان'],
    [180_000, '3 دقائق']
  ];
  for (const [milliseconds, expected] of boundaries) {
    assert.equal(formatDuration(milliseconds), expected);
  }
});

test('Telegram activity and progress use the exact Bot API methods and bounded payloads', async () => {
  const calls = [];
  const client = new TelegramClient('synthetic-token', quietLogger);
  client.call = async (method, payload, timeoutMs) => {
    calls.push({ method, payload, timeoutMs });
    return { message_id: payload.message_id || 1 };
  };
  await client.sendTyping('10');
  await client.editText('10', 55, '⚙️ المهمة شغّالة.\n⏱ المدة: دقيقة.', {
    reply_markup: { inline_keyboard: [] }
  });
  assert.deepEqual(calls[0], {
    method: 'sendChatAction',
    payload: { chat_id: '10', action: 'typing' },
    timeoutMs: 15000
  });
  assert.equal(calls[1].method, 'editMessageText');
  assert.equal(calls[1].payload.chat_id, '10');
  assert.equal(calls[1].payload.message_id, 55);
  assert.deepEqual(calls[1].payload.reply_markup.inline_keyboard, []);
  assert.ok(calls[1].payload.text.length < 3900);
  assert.equal(calls[1].timeoutMs, 15000);
});

test('typing renews every four seconds while progress edits only on minute or activity changes', async () => {
  const clock = makeClock();
  let resolveRun;
  let onActivity;
  const owned = makeBridge({
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
    runner: {
      isBusy() { return true; },
      cancel() { return true; },
      async diagnose() { return { status: 'authenticated' }; },
      run(input) {
        onActivity = input.onActivity;
        return new Promise((resolve) => { resolveRun = resolve; });
      }
    }
  });
  try {
    const running = owned.bridge.executeTask({
      id: 'progress-task', chatId: '10', userId: '10', prompt: 'test', progressMessageId: 99
    });
    while (!resolveRun) await tick();
    assert.equal(owned.typing.length, 1);
    assert.equal(owned.edits.length, 1);
    assert.match(owned.edits[0].text, /أقل من دقيقة/);
    assert.deepEqual(owned.edits[0].extra.reply_markup.inline_keyboard[0][0].callback_data, 'stop:progress-task');
    assert.equal(clock.handles.length, 2);
    assert.equal(clock.handles.every((handle) => handle.unrefCalled), true);

    await clock.advance(4_000);
    assert.equal(owned.typing.length, 2);
    assert.equal(owned.edits.length, 1);
    await clock.advance(52_000);
    assert.equal(owned.typing.length, 15);
    assert.equal(owned.edits.length, 1);
    await clock.advance(4_000);
    assert.equal(owned.typing.length, 16);
    assert.equal(owned.edits.length, 2);
    assert.match(owned.edits.at(-1).text, /المدة: دقيقة/);

    onActivity('أكتب الجواب الآن.');
    await tick();
    assert.equal(owned.edits.length, 3);
    onActivity('أكتب الجواب الآن.');
    await tick();
    assert.equal(owned.edits.length, 3);

    resolveRun({ ok: true, text: 'result', sessionId: 'progress-session' });
    await running;
    assert.equal(clock.activeCount(), 0);
    assert.match(owned.sent.at(-1).text, /المدة: دقيقة/);
    assert.match(owned.edits.at(-1).text, /انتهت المهمة/);
    assert.deepEqual(owned.edits.at(-1).extra.reply_markup.inline_keyboard, []);
    const typingAtFinish = owned.typing.length;
    await clock.advance(20_000);
    assert.equal(owned.typing.length, typingAtFinish);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('activity timers and stop buttons are cleaned on every terminal path', async () => {
  const outcomes = [
    { name: 'cancelled', result: { ok: false, reason: 'cancelled', text: '' } },
    { name: 'timeout', result: { ok: false, reason: 'timeout', text: '' } },
    { name: 'oversized', result: { ok: false, reason: 'oversized_output', text: '' } },
    { name: 'failure', result: { ok: false, reason: 'claude_failed', text: '' } },
    { name: 'throw', error: new Error('synthetic') }
  ];
  for (const outcome of outcomes) {
    const clock = makeClock();
    const owned = makeBridge({
      now: clock.now,
      setIntervalImpl: clock.setInterval,
      clearIntervalImpl: clock.clearInterval,
      runner: {
        isBusy() { return true; },
        cancel() { return true; },
        async diagnose() { return { status: 'authenticated' }; },
        async run() {
          if (outcome.error) throw outcome.error;
          return outcome.result;
        }
      }
    });
    try {
      await owned.bridge.executeTask({
        id: `terminal-${outcome.name}`,
        chatId: '10',
        userId: '10',
        prompt: 'test',
        progressMessageId: 88
      });
      assert.equal(clock.activeCount(), 0, outcome.name);
      assert.deepEqual(owned.edits.at(-1).extra.reply_markup.inline_keyboard, [], outcome.name);
      assert.match(owned.sent.at(-1).text, /المدة: أقل من دقيقة/, outcome.name);
    } finally {
      fs.rmSync(owned.directory, { recursive: true, force: true });
    }
  }
});

test('cancelling a queued request removes its stop button and reports minute duration', async () => {
  const owned = makeBridge({ now: () => 60_000 });
  try {
    owned.bridge.queue.push({
      id: 'queued-stop',
      chatId: '10',
      userId: '10',
      queuedAt: 0,
      progressMessageId: 77
    });
    await callback(owned, 'stop:queued-stop');
    assert.equal(owned.bridge.queue.length, 0);
    assert.match(withoutBidi(owned.edits.at(-1).text), /المدة: دقيقة/);
    assert.deepEqual(owned.edits.at(-1).extra.reply_markup.inline_keyboard, []);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});
