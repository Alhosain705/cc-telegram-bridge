'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const {
  Bridge,
  parseModelCommand,
  restartAnnouncementEnvelopeId
} = require('../src/bridge');
const {
  RESTART_ACTION,
  RESTART_EXIT_CODE,
  STATE_CORRUPTION_EXIT_CODE,
  writeRestartMarker
} = require('../src/lifecycle');
const { DEFAULT_MODEL, MODEL_DEFINITIONS } = require('../src/models');
const { ClaudeRunner, classifyClaudeFailure } = require('../src/runner');
const { JsonStore } = require('../src/store');

const root = path.resolve(__dirname, '..');
const quietLogger = { info() {}, warn() {}, error() {} };
const syntheticApprovalContext = Object.freeze({
  mcpConfig: '{"mcpServers":{}}',
  env: { CC_BRIDGE_APPROVAL_PIPE: 'synthetic-pipe', CC_BRIDGE_APPROVAL_SECRET: 'synthetic-secret' }
});

function waitFor(predicate, timeoutMs = 10_000, label = 'condition_timeout') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(label));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function makeBridge({ runner, onRestart, telegram } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t25-commands-'));
  const store = new JsonStore(path.join(directory, 'state.json'), quietLogger);
  store.state.pairedUsers = ['10'];
  store.state.permissions = { 10: 'safe' };
  store.save();
  const sent = [];
  const callbacks = [];
  const telegramClient = telegram || {
    async getMe() { return { id: 1, username: 'test_bot' }; },
    async getUpdates() { return []; },
    async sendPreparedText(chatId, text, extra) {
      sent.push({ chatId: String(chatId), text, extra });
      return { message_id: sent.length };
    },
    async sendText(chatId, text, extra) {
      sent.push({ chatId: String(chatId), text, extra });
      return { message_id: sent.length };
    },
    async sendTyping() {},
    async answerCallback(id, text) { callbacks.push({ id, text }); }
  };
  const claudeRunner = runner || {
    isBusy() { return false; },
    cancel() { return false; },
    async diagnose() { return { status: 'authenticated' }; },
    async run() { throw new Error('runner_should_not_run'); }
  };
  const bridge = new Bridge({
    config: {
      ownerIds: new Set(['10']),
      expectedBotUsername: '',
      apiKeyDetected: false,
      allowApiBilling: false
    },
    store,
    telegram: telegramClient,
    runner: claudeRunner,
    logger: quietLogger,
    sleep: async () => {},
    random: () => 0.5,
    onRestart
  });
  return { bridge, callbacks, directory, runner: claudeRunner, sent, store, telegram: telegramClient };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 43125;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

test('/model stores the canonical per-user choice and passes it to Claude Code', async () => {
  let runInput;
  const owned = makeBridge({
    runner: {
      isBusy() { return false; },
      cancel() { return false; },
      async diagnose() { return { status: 'authenticated' }; },
      async run(input) {
        runInput = input;
        return { ok: true, text: 'done', sessionId: 'session-model' };
      }
    }
  });
  try {
    assert.equal(owned.store.getModel('10'), DEFAULT_MODEL);
    await owned.bridge.handleMessage(
      { text: '/model', chat: { id: 10 }, from: { id: 10 } },
      { chatId: 10, userId: 10 }
    );
    assert.match(owned.sent.at(-1).text, /سونيت/);
    assert.equal(owned.sent.at(-1).extra.reply_markup.inline_keyboard.flat().length, 4);

    const parsed = parseModelCommand('غيّر النموذج إلى أوبس');
    assert.deepEqual(parsed, { matched: true, value: 'أوبس' });
    await owned.bridge.handleMessage(
      { text: 'غيّر النموذج إلى أوبس', chat: { id: 10 }, from: { id: 10 } },
      { chatId: 10, userId: 10 }
    );
    assert.equal(owned.store.getModel('10'), MODEL_DEFINITIONS.opus.id);
    const reloaded = new JsonStore(path.join(owned.directory, 'state.json'), quietLogger);
    assert.equal(reloaded.getModel('10'), MODEL_DEFINITIONS.opus.id);

    await owned.bridge.executeTask({
      id: 'model-task',
      chatId: 10,
      userId: 10,
      prompt: 'test'
    });
    assert.equal(runInput.model, MODEL_DEFINITIONS.opus.id);

    await owned.bridge.handleCallback(
      { id: 'callback-model', data: 'model:fable' },
      { chatId: 10, userId: 10 }
    );
    assert.equal(owned.store.getModel('10'), MODEL_DEFINITIONS.fable.id);
    assert.match(owned.sent.at(-1).text, /قد لا يكون فيبل متاحاً إلا في باقة/);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('ClaudeRunner uses the selected model and classifies only explicit availability rejection', async () => {
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
    prompt: 'hello',
    taskId: 'selected-model',
    unsafe: false,
    approvalContext: syntheticApprovalContext,
    model: MODEL_DEFINITIONS.haiku.id,
    onActivity() {}
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    capturedArgs.slice(capturedArgs.indexOf('--model'), capturedArgs.indexOf('--model') + 2),
    ['--model', MODEL_DEFINITIONS.haiku.id]
  );
  assert.equal(
    classifyClaudeFailure("Model 'claude-fable-5' is not available for this subscription"),
    'model_unavailable'
  );
  assert.equal(
    classifyClaudeFailure('Network access to model endpoint timed out'),
    'network_failed'
  );
  assert.equal(
    classifyClaudeFailure('Invalid model response JSON from upstream'),
    'claude_failed'
  );
  assert.equal(
    classifyClaudeFailure("Model 'claude-unknown' was not found"),
    'claude_failed'
  );
  assert.equal(classifyClaudeFailure('Unexpected model worker failure'), 'claude_failed');

  const rejectedChild = new FakeChild();
  const rejectedRunner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowApiBilling: false,
    logger: quietLogger,
    spawnImpl() {
      setImmediate(() => {
        rejectedChild.stdout.write(`${JSON.stringify({
          type: 'result',
          result: "Model 'claude-fable-5' is not available for this subscription"
        })}\n`);
        rejectedChild.emit('close', 1, null);
      });
      return rejectedChild;
    }
  });
  const rejected = await rejectedRunner.run({
    prompt: 'hello',
    taskId: 'rejected-model',
    unsafe: false,
    approvalContext: syntheticApprovalContext,
    model: MODEL_DEFINITIONS.fable.id,
    onActivity() {}
  });
  assert.equal(rejected.reason, 'model_unavailable');
  assert.equal(rejected.text, '');
});

test('/diagnose is asynchronous, bounded, and reports distinct safe failures', {
  timeout: 2_000
}, async () => {
  let authArguments;
  let authOptions;
  let eventLoopProgressed = false;
  const diagnosticRunner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: ['cli.js'] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    diagnosticTimeoutMs: 250,
    allowApiBilling: false,
    logger: quietLogger,
    diagnosticSpawnImpl(command, args, options) {
      assert.equal(command, 'fake.exe');
      authArguments = args;
      authOptions = options;
      const child = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        eventLoopProgressed = true;
      }, 5);
      setTimeout(() => child.emit('close', 0), 30);
      return child;
    }
  });
  assert.deepEqual(await diagnosticRunner.diagnose(), { status: 'authenticated' });
  assert.equal(eventLoopProgressed, true);
  assert.deepEqual(authArguments, ['cli.js', 'auth', 'status']);
  assert.equal(authOptions.shell, false);
  assert.equal(authOptions.stdio, 'ignore');

  let timedOutChildKilled = false;
  const timeoutRunner = new ClaudeRunner({
    command: { command: 'fake.exe', prefixArgs: [] },
    cwd: process.cwd(),
    timeoutMs: 5000,
    diagnosticTimeoutMs: 25,
    allowApiBilling: false,
    logger: quietLogger,
    diagnosticSpawnImpl() {
      const child = new EventEmitter();
      child.kill = () => {
        timedOutChildKilled = true;
      };
      return child;
    }
  });
  assert.deepEqual(await timeoutRunner.diagnose(), { status: 'timeout' });
  assert.equal(timedOutChildKilled, true);

  async function diagnoseSpawnError(code) {
    const runner = new ClaudeRunner({
      command: { command: 'fake.exe', prefixArgs: [] },
      cwd: process.cwd(),
      timeoutMs: 5000,
      diagnosticTimeoutMs: 100,
      allowApiBilling: false,
      logger: quietLogger,
      diagnosticSpawnImpl() {
        const child = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => child.emit('error', Object.assign(new Error(code), { code })));
        return child;
      }
    });
    return runner.diagnose();
  }
  assert.deepEqual(await diagnoseSpawnError('ENOENT'), { status: 'not_found' });
  assert.deepEqual(await diagnoseSpawnError('EACCES'), { status: 'check_failed' });

  const statuses = [
    ['not_authenticated', /تسجيل دخول/],
    ['not_found', /غير موجود/],
    ['timeout', /تأخر/],
    ['check_failed', /صلاحيات/]
  ];
  for (const [status, expected] of statuses) {
    const owned = makeBridge({
      runner: {
        isBusy() { return false; },
        cancel() { return false; },
        async diagnose() { return { status }; }
      }
    });
    try {
      owned.store.setModel('10', MODEL_DEFINITIONS.sonnet.id);
      await owned.bridge.handleMessage(
        { text: '/تشخيص', chat: { id: 10 }, from: { id: 10 } },
        { chatId: 10, userId: 10 }
      );
      const report = owned.sent.at(-1).text;
      assert.match(report, /الجسر شغّال ومتصل بتيليجرام/);
      assert.match(report, expected);
      assert.match(report, /الصلاحيات: يطلب الموافقة/);
      assert.match(report, /النموذج: سونيت/);
      assert.doesNotMatch(report, /(?:[A-Z]:\\|bot\d+:|CLAUDE_BIN)/i);
    } finally {
      fs.rmSync(owned.directory, { recursive: true, force: true });
    }
  }
});

test('/restart confirms the update, waits for readiness, and supersedes its stale announcement', async () => {
  let restartSawConfirmedUpdate = false;
  let updateDelivered = false;
  const telegram = {
    sent: [],
    async getMe() { return { id: 1, username: 'test_bot' }; },
    async getUpdates() {
      if (updateDelivered) return [];
      updateDelivered = true;
      return [{
        update_id: 25,
        message: {
          text: '/restart',
          chat: { id: 10, type: 'private' },
          from: { id: 10 }
        }
      }];
    },
    async sendPreparedText(chatId, text, extra) {
      this.sent.push({ chatId: String(chatId), text, extra });
      return { message_id: this.sent.length };
    },
    async sendText(chatId, text, extra) {
      this.sent.push({ chatId: String(chatId), text, extra });
      return { message_id: this.sent.length };
    },
    async sendTyping() {},
    async answerCallback() {}
  };
  const owned = makeBridge({
    telegram,
    onRestart: () => {
      restartSawConfirmedUpdate = owned.store.hasProcessedUpdate(25);
    }
  });
  try {
    await owned.bridge.poll();
    assert.equal(restartSawConfirmedUpdate, true);
    assert.equal(owned.store.getUpdateOffset(), 26);
    const restartRequest = owned.store.getRestartRequest();
    assert.ok(restartRequest);

    const announcementEnvelopeId = restartAnnouncementEnvelopeId(restartRequest.requestedAt);
    const announcement = owned.store.state.outbox.find(
      (item) => item.envelopeId === announcementEnvelopeId
    );
    assert.ok(announcement);
    announcement.status = 'pending';
    delete announcement.deliveredAt;
    delete announcement.telegramMessageId;
    announcement.nextAttemptAt = 0;
    owned.store.save();

    const events = [];
    const recovered = new Bridge({
      config: {
        ownerIds: new Set(['10']),
        expectedBotUsername: '',
        apiKeyDetected: false,
        allowApiBilling: false
      },
      store: owned.store,
      telegram: {
        async getMe() {
          return { id: 1, username: 'test_bot' };
        },
        async getUpdates() {
          events.push('poll');
          recovered.stopping = true;
          return [];
        },
        async sendPreparedText(chatId, text) {
          events.push(text.includes('رجع الجسر') ? 'recovered' : `unexpected:${text}`);
          return { message_id: 100 };
        },
        async sendText(chatId, text) {
          events.push(`unexpected:${text}`);
          return { message_id: 101 };
        }
      },
      runner: owned.runner,
      logger: quietLogger,
      sleep: async () => {},
      random: () => 0.5,
      onReady: () => events.push('ready')
    });
    await recovered.start();
    assert.equal(owned.store.getRestartRequest(), null);
    assert.deepEqual(events, ['poll', 'ready', 'recovered']);
    assert.equal(events.some((event) => event.includes('بأعيد تشغيل الجسر')), false);
    assert.equal(
      owned.store.state.outboxDeadLetters.some(
        (item) =>
          item.envelopeId === announcementEnvelopeId &&
          item.reason === 'superseded_by_restart_recovery'
      ),
      true
    );
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('/restart recovery remains pending when the ready marker cannot be written', async () => {
  const owned = makeBridge();
  try {
    const restartRequest = owned.store.setRestartRequest('10');
    const sent = [];
    const recovered = new Bridge({
      config: {
        ownerIds: new Set(['10']),
        expectedBotUsername: '',
        apiKeyDetected: false,
        allowApiBilling: false
      },
      store: owned.store,
      telegram: {
        async getMe() { return { id: 1, username: 'test_bot' }; },
        async getUpdates() {
          recovered.stopping = true;
          return [];
        },
        async sendPreparedText(chatId, text) {
          sent.push(text);
          return { message_id: 1 };
        },
        async sendText(chatId, text) {
          sent.push(text);
          return { message_id: 2 };
        }
      },
      runner: owned.runner,
      logger: quietLogger,
      sleep: async () => {},
      random: () => 0.5,
      onReady: () => {
        throw new Error('ready_marker_write_failed');
      }
    });
    await assert.rejects(recovered.start(), /ready_marker_write_failed/);
    assert.deepEqual(owned.store.getRestartRequest(), restartRequest);
    assert.equal(sent.some((text) => text.includes('رجع الجسر')), false);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('/restart independently refuses every active-work guard', async () => {
  const cases = [
    {
      name: 'processing',
      arrange(owned) { owned.bridge.processing = true; }
    },
    {
      name: 'activeTask',
      arrange(owned) { owned.bridge.activeTask = { id: 'active' }; }
    },
    {
      name: 'queue',
      arrange(owned) { owned.bridge.queue.push({ id: 'queued' }); }
    },
    {
      name: 'runner',
      runner: {
        isBusy() { return true; },
        cancel() { return false; },
        async diagnose() { return { status: 'authenticated' }; }
      },
      arrange() {}
    }
  ];
  for (const current of cases) {
    const owned = makeBridge({ runner: current.runner });
    try {
      current.arrange(owned);
      const action = await owned.bridge.handleMessage(
        { text: '/إعادة_تشغيل', chat: { id: 10 }, from: { id: 10 } },
        { chatId: 10, userId: 10 }
      );
      assert.equal(action, undefined, current.name);
      assert.equal(owned.store.getRestartRequest(), null, current.name);
      assert.match(owned.sent.at(-1).text, /فيه مهمة شغّالة الآن/, current.name);
    } finally {
      fs.rmSync(owned.directory, { recursive: true, force: true });
    }
  }
});

test('the PowerShell 5.1 host distinguishes restart, crash, stop, and corruption', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  assert.equal(RESTART_ACTION, 'restart_bridge_after_update_confirmation');
  assert.notEqual(RESTART_EXIT_CODE, STATE_CORRUPTION_EXIT_CODE);
  assert.notEqual(RESTART_EXIT_CODE, 0);
  const powershellVersion = spawnSync('powershell.exe', [
    '-Version', '5.1',
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-Command', '$PSVersionTable.PSVersion.ToString()'
  ], { windowsHide: true, encoding: 'utf8' });
  assert.equal(powershellVersion.status, 0);
  assert.match(powershellVersion.stdout.trim(), /^5\.1(?:\.|$)/);
  assert.match(
    fs.readFileSync(path.join(root, 'index.js'), 'utf8'),
    /writeRestartMarker\(restartPath\)/
  );

  const markerProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t27-marker-'));
  const markerProbePath = path.join(markerProbe, 'data', 'bridge.restart');
  writeRestartMarker(markerProbePath, {
    pid: 1234,
    requestedAt: '2026-07-31T00:00:00.000Z'
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerProbePath, 'utf8')), {
    pid: 1234,
    requestedAt: '2026-07-31T00:00:00.000Z'
  });

  const installations = {
    restart: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t27-host-restart-')),
    repeated: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t27-host-repeated-')),
    corrupt: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t27-host-corrupt-')),
    stopped: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t27-host-stopped-'))
  };
  const children = [];

  function prepareInstallation(installation) {
    fs.mkdirSync(path.join(installation, 'launcher'), { recursive: true });
    fs.mkdirSync(path.join(installation, 'runtime', 'node'), { recursive: true });
    fs.mkdirSync(path.join(installation, 'data'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'launcher', 'bridge-host.ps1'),
      path.join(installation, 'launcher', 'bridge-host.ps1')
    );
    fs.copyFileSync(process.execPath, path.join(installation, 'runtime', 'node', 'node.exe'));
  }

  function startHost(installation) {
    const child = spawn('powershell.exe', [
      '-Version', '5.1',
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(installation, 'launcher', 'bridge-host.ps1')
    ], { windowsHide: true, stdio: 'ignore' });
    children.push(child);
    return child;
  }

  function hostDetails(installation, child) {
    const readIfPresent = (relativePath) => {
      const filePath = path.join(installation, relativePath);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    };
    return JSON.stringify({
      exitCode: child.exitCode,
      data: fs.readdirSync(path.join(installation, 'data')),
      starts: readIfPresent(path.join('data', 'starts.txt')),
      hostError: readIfPresent(path.join('logs', 'host-error.log')),
      bridgeError: readIfPresent(path.join('logs', 'bridge-error.log'))
    });
  }

  try {
    Object.values(installations).forEach(prepareInstallation);
    const lifecyclePath = JSON.stringify(path.join(root, 'src', 'lifecycle.js'));

    fs.writeFileSync(path.join(installations.restart, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const { writeRestartMarker } = require(${lifecyclePath});`,
      "const data = path.join(__dirname, 'data');",
      "const countPath = path.join(data, 'starts.txt');",
      "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countPath, String(count));",
      `if (count === 1) { writeRestartMarker(path.join(data, 'bridge.restart')); process.exit(${RESTART_EXIT_CODE}); }`,
      "fs.writeFileSync(path.join(data, 'bridge.ready'), String(process.pid));",
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const restartHost = startHost(installations.restart);
    const restartCountPath = path.join(installations.restart, 'data', 'starts.txt');
    await waitFor(
      () => restartHost.exitCode !== null ||
        (fs.existsSync(restartCountPath) &&
         Number(fs.readFileSync(restartCountPath, 'utf8')) === 2 &&
         fs.existsSync(path.join(installations.restart, 'data', 'bridge.ready'))),
      10_000,
      `restart_relaunch_timeout:${hostDetails(installations.restart, restartHost)}`
    );
    assert.equal(restartHost.exitCode, null, hostDetails(installations.restart, restartHost));
    assert.equal(fs.existsSync(path.join(installations.restart, 'data', 'bridge.restart')), false);
    fs.writeFileSync(path.join(installations.restart, 'data', 'bridge.stop'), 'stop');
    await waitFor(() => restartHost.exitCode !== null, 10_000, 'intentional_stop_timeout');
    assert.equal(restartHost.exitCode, 0);
    assert.equal(Number(fs.readFileSync(restartCountPath, 'utf8')), 2);

    const repeatedHostPath = path.join(installations.repeated, 'launcher', 'bridge-host.ps1');
    const productionHost = fs.readFileSync(repeatedHostPath, 'utf8');
    const acceleratedHost = productionHost
      .replace('[datetime]::UtcNow.AddSeconds(', '[datetime]::UtcNow.AddMilliseconds(')
      .replace('Start-Sleep -Milliseconds 200', 'Start-Sleep -Milliseconds 1');
    assert.notEqual(acceleratedHost, productionHost);
    fs.writeFileSync(repeatedHostPath, acceleratedHost);
    fs.writeFileSync(path.join(installations.repeated, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const { writeRestartMarker } = require(${lifecyclePath});`,
      "const data = path.join(__dirname, 'data');",
      "const countPath = path.join(data, 'starts.txt');",
      "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countPath, String(count));",
      `if (count <= 6) { writeRestartMarker(path.join(data, 'bridge.restart')); process.exit(${RESTART_EXIT_CODE}); }`,
      "fs.writeFileSync(path.join(data, 'bridge.ready'), String(process.pid));",
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const repeatedHost = startHost(installations.repeated);
    const repeatedCountPath = path.join(installations.repeated, 'data', 'starts.txt');
    await waitFor(
      () => repeatedHost.exitCode !== null ||
        (fs.existsSync(repeatedCountPath) &&
         Number(fs.readFileSync(repeatedCountPath, 'utf8')) === 7 &&
         fs.existsSync(path.join(installations.repeated, 'data', 'bridge.ready'))),
      10_000,
      `repeated_restart_timeout:${hostDetails(installations.repeated, repeatedHost)}`
    );
    assert.equal(repeatedHost.exitCode, null, hostDetails(installations.repeated, repeatedHost));
    assert.equal(Number(fs.readFileSync(repeatedCountPath, 'utf8')), 7);
    assert.equal(fs.existsSync(path.join(installations.repeated, 'data', 'bridge.restart')), false);
    fs.writeFileSync(path.join(installations.repeated, 'data', 'bridge.stop'), 'stop');
    await waitFor(() => repeatedHost.exitCode !== null, 10_000, 'repeated_stop_timeout');
    assert.equal(repeatedHost.exitCode, 0);

    fs.writeFileSync(path.join(installations.corrupt, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'data', 'starts.txt'), '1');",
      "fs.writeFileSync(path.join(__dirname, 'data', 'state.json.corrupt-marker'), '{}');",
      `process.exit(${STATE_CORRUPTION_EXIT_CODE});`
    ].join('\n'));
    const corruptHost = startHost(installations.corrupt);
    await waitFor(() => corruptHost.exitCode !== null, 10_000, 'corruption_exit_timeout');
    assert.equal(corruptHost.exitCode, STATE_CORRUPTION_EXIT_CODE);
    assert.equal(
      fs.existsSync(path.join(installations.corrupt, 'data', 'state.json.corrupt-marker')),
      true
    );
    assert.equal(
      Number(fs.readFileSync(path.join(installations.corrupt, 'data', 'starts.txt'), 'utf8')),
      1
    );

    fs.writeFileSync(path.join(installations.stopped, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'data', 'started.txt'), 'unexpected');"
    ].join('\n'));
    fs.writeFileSync(path.join(installations.stopped, 'data', 'bridge.stop'), 'stop');
    const stoppedHost = startHost(installations.stopped);
    await waitFor(() => stoppedHost.exitCode !== null, 10_000, 'preexisting_stop_timeout');
    assert.equal(stoppedHost.exitCode, 0);
    assert.equal(fs.existsSync(path.join(installations.stopped, 'data', 'started.txt')), false);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      }
    }
    fs.rmSync(markerProbe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const installation of Object.values(installations)) {
      fs.rmSync(installation, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
