'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Bridge } = require('../src/bridge');
const { Logger } = require('../src/logger');
const { JsonStore } = require('../src/store');
const { TelegramClient } = require('../src/telegram');
const { buildChildEnv, classifyClaudeFailure } = require('../src/runner');
const { unprotectDpapi } = require('../src/config');

const quietLogger = { info() {}, warn() {}, error() {} };

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-fixes-'));
  const store = new JsonStore(path.join(directory, 'state.json'), quietLogger);
  return { directory, store };
}

function bridgeWith(overrides = {}) {
  const owned = temporaryStore();
  const config = {
    ownerIds: new Set(['10']),
    allowedUserIds: new Set(),
    allowedChatIds: new Set(),
    expectedBotUsername: '',
    apiKeyDetected: false,
    allowApiBilling: false
  };
  const telegram = {
    async getMe() { return { id: 1, username: 'test_bot' }; },
    async getUpdates() { return []; },
    async sendText() { return { message_id: 1 }; },
    async sendTyping() {},
    async answerCallback() {}
  };
  const runner = { cancel() {}, async run() { throw new Error('runner_should_not_run'); } };
  const bridge = new Bridge({
    config,
    store: owned.store,
    telegram,
    runner,
    logger: quietLogger,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides
  });
  return { ...owned, bridge, telegram };
}

test('starts from the durable Telegram offset and skips an already processed pairing update', async () => {
  const owned = bridgeWith();
  owned.store.confirmUpdate(100);
  const offsets = [];
  owned.bridge.offset = owned.store.getUpdateOffset();
  owned.bridge.telegram.getUpdates = async (offset) => {
    offsets.push(offset);
    owned.bridge.stopping = true;
    return [{ update_id: 100, message: { chat: { id: 10, type: 'private' }, from: { id: 10 }, text: '731905' } }];
  };
  await owned.bridge.poll();
  assert.deepEqual(offsets, [101]);
  assert.equal(owned.store.getUpdateOffset(), 101);
  fs.rmSync(owned.directory, { recursive: true, force: true });
});

test('a poison Telegram update is acknowledged once and cannot pin the durable offset', async () => {
  const owned = bridgeWith();
  const offsets = [];
  let handlerAttempts = 0;
  let errorNotices = 0;
  owned.bridge.telegram.getUpdates = async (offset) => {
    offsets.push(offset);
    if (offset > 700) {
      owned.bridge.stopping = true;
      return [];
    }
    return [{
      update_id: 700,
      message: { chat: { id: 10, type: 'private' }, from: { id: 10 }, text: 'poison' }
    }];
  };
  owned.bridge.handleUpdate = async () => {
    handlerAttempts += 1;
    throw new Error('synthetic handler failure');
  };
  owned.bridge.safeSend = async () => {
    errorNotices += 1;
    throw new Error('synthetic notice failure');
  };
  try {
    await owned.bridge.poll();
    assert.deepEqual(offsets, [0, 701]);
    assert.equal(handlerAttempts, 1);
    assert.equal(errorNotices, 1);
    assert.equal(owned.store.getUpdateOffset(), 701);
    assert.equal(owned.store.hasProcessedUpdate(700), true);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('a malformed Telegram update ID fails closed without touching durable state', async () => {
  const owned = bridgeWith();
  let handled = false;
  owned.bridge.telegram.getUpdates = async () => [{
    update_id: 'not-a-number',
    message: { chat: { id: 10, type: 'private' }, from: { id: 10 }, text: 'poison' }
  }];
  owned.bridge.handleUpdate = async () => { handled = true; };
  try {
    await assert.rejects(owned.bridge.poll(), /invalid_update_id/);
    assert.equal(handled, false);
    assert.equal(owned.store.getUpdateOffset(), 0);
    assert.deepEqual(owned.store.state.processedUpdates, []);
    assert.doesNotThrow(() => new JsonStore(path.join(owned.directory, 'state.json'), quietLogger));
    assert.throws(() => owned.store.confirmUpdate(Number.NaN), /invalid_update_id/);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('a durable update confirmation failure is explicit and terminal', async () => {
  const errors = [];
  const owned = bridgeWith({
    logger: { info() {}, warn() {}, error(event) { errors.push(event); } }
  });
  owned.bridge.telegram.getUpdates = async () => [{ update_id: 44 }];
  owned.bridge.handleUpdate = async () => null;
  owned.store.confirmUpdate = () => { throw new Error('synthetic disk failure'); };
  try {
    await assert.rejects(owned.bridge.poll(), /synthetic disk failure/);
    assert.deepEqual(errors, ['update_confirmation_failed']);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('an expired callback answer is cosmetic and cannot fail update handling', async () => {
  const warnings = [];
  const owned = bridgeWith({
    logger: { info() {}, error() {}, warn(event) { warnings.push(event); } }
  });
  owned.store.state.pairedUsers = ['10'];
  owned.store.save();
  owned.bridge.telegram.answerCallback = async () => {
    throw Object.assign(new Error('query is too old'), { status: 400, permanent: true });
  };
  try {
    await assert.doesNotReject(owned.bridge.handleCallback(
      { id: 'expired-callback', data: 'unknown' },
      { chatId: 10, chatType: 'private', userId: 10 }
    ));
    assert.deepEqual(warnings, ['telegram_answer_callback_failed']);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('offline startup retries and recovers, while permanent token errors stop', async () => {
  const delays = [];
  let calls = 0;
  const transient = bridgeWith({
    telegram: {
      async getMe() {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed');
        return { id: 1, username: 'test_bot' };
      }
    },
    sleep: async (delay) => delays.push(delay)
  });
  const bot = await transient.bridge.waitForTelegram();
  assert.equal(bot.username, 'test_bot');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);

  const permanentError = Object.assign(new Error('bad token'), { status: 401, permanent: true });
  const permanent = bridgeWith({ telegram: { async getMe() { throw permanentError; } } });
  await assert.rejects(permanent.bridge.waitForTelegram(), /bad token/);
  fs.rmSync(transient.directory, { recursive: true, force: true });
  fs.rmSync(permanent.directory, { recursive: true, force: true });
});

test('pairing expiry, use flag, and attempt counter survive a store restart', () => {
  const owned = temporaryStore();
  owned.store.setPairing({
    code: '731905',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    used: false
  });
  assert.equal(owned.store.recordPairingAttempt('20', 1000, 10_000), 1);
  owned.store.markPairingUsed('20');
  const reloaded = new JsonStore(path.join(owned.directory, 'state.json'), quietLogger);
  assert.equal(reloaded.getPairing().used, true);
  assert.equal(reloaded.getPairing().usedBy, '20');
  assert.equal(reloaded.recordPairingAttempt('20', 2000, 10_000), 2);
  fs.rmSync(owned.directory, { recursive: true, force: true });
});

test('Node runtime decrypts a CurrentUser DPAPI value created by the launcher', {
  skip: process.platform !== 'win32'
}, () => {
  const modulePath = path.join(__dirname, '..', 'launcher', 'Launcher.Core.psm1');
  const protectedResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command',
    "$WarningPreference='SilentlyContinue'; Import-Module $env:MODULE_PATH -Force; Protect-CurrentUserSecret $env:PLAIN_VALUE"
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      MODULE_PATH: modulePath,
      PLAIN_VALUE: '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'
    }
  });
  assert.equal(protectedResult.status, 0, protectedResult.stderr);
  assert.equal(
    unprotectDpapi(protectedResult.stdout.trim()),
    '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'
  );
});

test('child environment is an allowlist and rejects cloud, file, and unknown secrets', () => {
  const env = buildChildEnv({
    PATH: 'path',
    HOME: 'home',
    USERPROFILE: 'profile',
    AWS_ACCESS_KEY_ID: 'aws',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AZURE_CLIENT_SECRET_VALUE: 'azure',
    GOOGLE_APPLICATION_CREDENTIALS: 'gcp',
    NONSTANDARD_PRIVATE_VALUE: 'unknown',
    SSH_KEY_FILE: 'file-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude'
  }, false);
  assert.deepEqual(env, {
    PATH: 'path',
    HOME: 'home',
    USERPROFILE: 'profile',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude'
  });
});

test('failed Telegram delivery remains in a durable outbox and later delivers once', async () => {
  let sends = 0;
  const owned = bridgeWith({
    telegram: {
      async sendText() {
        sends += 1;
        if (sends === 1) throw new TypeError('offline');
        return { message_id: 7 };
      }
    }
  });
  owned.bridge.stopping = true;
  const result = await owned.bridge.safeSend('10', 'answer', {}, 'task:one:answer');
  assert.equal(result, null);
  assert.equal(owned.store.state.outbox[0].status, 'pending');
  const reloaded = new JsonStore(path.join(owned.directory, 'state.json'), quietLogger);
  assert.equal(reloaded.state.outbox[0].text, 'answer');
  reloaded.state.outbox[0].nextAttemptAt = 0;
  reloaded.save();
  owned.bridge.store = reloaded;
  owned.bridge.stopping = false;
  await owned.bridge.flushOutbox();
  assert.equal(reloaded.state.outbox[0].status, 'delivered');
  assert.equal(sends, 2);
  fs.rmSync(owned.directory, { recursive: true, force: true });
});

test('session generation prevents an old task from restoring a session after /new', () => {
  const owned = temporaryStore();
  const generation = owned.store.getSessionGeneration('10');
  owned.store.deleteSession('10');
  assert.equal(owned.store.setSessionIfGeneration('10', 'stale-session', generation), false);
  assert.equal(owned.store.getSession('10'), null);
  fs.rmSync(owned.directory, { recursive: true, force: true });
});

test('Telegram respects the full retry_after value', async () => {
  const waits = [];
  let calls = 0;
  const client = new TelegramClient('synthetic', quietLogger, {
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          ok: false,
          async json() { return { ok: false, parameters: { retry_after: 300 } }; }
        };
      }
      return { status: 200, ok: true, async json() { return { ok: true, result: [] }; } };
    }
  });
  await client.call('getUpdates', {});
  assert.deepEqual(waits, [300_000]);
});

test('Claude stderr is classified without exposing raw stderr to the user', () => {
  assert.equal(classifyClaudeFailure('Authentication required. Please login.'), 'auth_failed');
  assert.equal(classifyClaudeFailure('Usage limit reached'), 'quota_exceeded');
  assert.equal(classifyClaudeFailure('Requested model is not available for this plan'), 'model_unavailable');
  assert.equal(classifyClaudeFailure('ECONNRESET network error'), 'network_failed');
  assert.equal(classifyClaudeFailure('unexpected internal detail'), 'claude_failed');
});

test('logger throttles repeated failures and reports the suppressed count on recovery window', () => {
  let now = 0;
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (value) => { writes.push(String(value)); return true; };
  try {
    const logger = new Logger({ now: () => now, throttleMs: 1000 });
    logger.warn('offline', 'one');
    logger.warn('offline', 'two');
    now = 1001;
    logger.warn('offline', 'three');
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]).suppressed, 1);
});

test('a second host instance cannot delete the first instance PID file', {
  skip: process.platform !== 'win32',
  timeout: 20_000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-host-race-'));
  const launcherDirectory = path.join(root, 'launcher');
  const runtimeDirectory = path.join(root, 'runtime', 'node');
  fs.mkdirSync(launcherDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'launcher', 'bridge-host.ps1'),
    path.join(launcherDirectory, 'bridge-host.ps1'));
  fs.copyFileSync(process.execPath, path.join(runtimeDirectory, 'node.exe'));
  fs.writeFileSync(path.join(root, 'index.js'), 'setInterval(() => {}, 1000);\n');

  const hostArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(launcherDirectory, 'bridge-host.ps1')
  ];
  const first = spawn('powershell.exe', hostArguments, {
    windowsHide: true,
    stdio: 'ignore'
  });
  const pidPath = path.join(root, 'data', 'bridge.pid');
  try {
    const deadline = Date.now() + 7000;
    while (!fs.existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fs.existsSync(pidPath), true);
    const ownerPid = fs.readFileSync(pidPath, 'utf8').trim();
    const second = spawnSync('powershell.exe', hostArguments, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(second.status, 1, second.stderr);
    assert.match(
      fs.readFileSync(path.join(root, 'logs', 'host-error.log'), 'utf8'),
      /used by another process|cannot access the file/i
    );
    assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), ownerPid);
    assert.notEqual(spawnSync('tasklist.exe', ['/FI', `PID eq ${ownerPid}`], {
      encoding: 'utf8',
      windowsHide: true
    }).stdout.indexOf(ownerPid), -1);
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(first.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
