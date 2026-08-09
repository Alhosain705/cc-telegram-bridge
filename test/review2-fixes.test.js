'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Bridge } = require('../src/bridge');
const { buildChildEnv, ClaudeRunner, resolveClaudeCommand } = require('../src/runner');
const { Logger } = require('../src/logger');
const {
  JsonStore,
  OUTBOX_MAX_ITEMS,
  OUTBOX_PENDING_TTL_MS,
  StateCorruptionError
} = require('../src/store');

const root = path.resolve(__dirname, '..');
const quietLogger = { info() {}, warn() {}, error() {} };
const syntheticApprovalContext = Object.freeze({
  mcpConfig: '{"mcpServers":{}}',
  env: { CC_BRIDGE_APPROVAL_PIPE: 'synthetic-pipe', CC_BRIDGE_APPROVAL_SECRET: 'synthetic-secret' }
});

function waitFor(predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('wait_timeout'));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function runPowerShell(command, environment = {}, timeout = 30_000) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', `$WarningPreference='SilentlyContinue'; ${command}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function processAlive(processId) {
  if (!processId) return false;
  const output = spawnSync('tasklist.exe', ['/FI', `PID eq ${processId}`, '/NH'], {
    encoding: 'utf8',
    windowsHide: true
  }).stdout;
  return new RegExp(`\\b${processId}\\b`).test(output);
}

function makeStore(prefix = 'cc-review2-store-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    filePath: path.join(directory, 'state.json'),
    store: new JsonStore(path.join(directory, 'state.json'), quietLogger)
  };
}

function makeBridge(telegram) {
  const owned = makeStore('cc-review2-bridge-');
  const bridge = new Bridge({
    config: {
      ownerIds: new Set(['10']),
      expectedBotUsername: '',
      apiKeyDetected: false,
      allowApiBilling: false
    },
    store: owned.store,
    telegram,
    runner: { cancel() {}, async run() { throw new Error('runner_not_expected'); } },
    logger: quietLogger,
    sleep: async () => {},
    random: () => 0.5
  });
  return { ...owned, bridge };
}

test('intentional stop, uninstall, and update use real processes and preserve the final stopped state', {
  skip: process.platform !== 'win32',
  timeout: 60_000
}, async () => {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review2-lifecycle-'));
  const stage = `${installation}.stage-review2`;
  const backup = `${installation}.rollback`;
  const shortcut = `${installation}.lnk`;
  const launcherDirectory = path.join(installation, 'launcher');
  const runtimeDirectory = path.join(installation, 'runtime', 'node');
  const dataDirectory = path.join(installation, 'data');
  const lifecyclePath = path.join(root, 'launcher', 'Bridge.Lifecycle.psm1');
  fs.mkdirSync(launcherDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, 'launcher', 'bridge-host.ps1'),
    path.join(launcherDirectory, 'bridge-host.ps1'));
  fs.copyFileSync(process.execPath, path.join(runtimeDirectory, 'node.exe'));
  fs.writeFileSync(path.join(installation, 'index.js'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const data = path.join(__dirname, "data");',
    'const state = path.join(data, "state.json");',
    'const stop = path.join(data, "bridge.stop");',
    'let counter = 0;',
    'function write(final) {',
    '  counter += 1;',
    '  const temporary = `${state}.${process.pid}.tmp`;',
    '  fs.writeFileSync(temporary, JSON.stringify({ counter, final }) + "\\n");',
    '  fs.renameSync(temporary, state);',
    '}',
    'write(false);',
    'setInterval(() => {',
    '  if (fs.existsSync(stop)) { write(true); process.exit(0); }',
    '  write(false);',
    '}, 20);'
  ].join('\n'));

  const hostArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(launcherDirectory, 'bridge-host.ps1')
  ];
  const hosts = [];
  const startHost = async () => {
    fs.rmSync(path.join(dataDirectory, 'bridge.stop'), { force: true });
    const host = spawn('powershell.exe', hostArguments, { windowsHide: true, stdio: 'ignore' });
    hosts.push(host);
    await waitFor(() =>
      fs.existsSync(path.join(dataDirectory, 'bridge-host.pid')) &&
      fs.existsSync(path.join(dataDirectory, 'bridge.pid')) &&
      fs.existsSync(path.join(dataDirectory, 'state.json')));
    return {
      hostPid: Number(fs.readFileSync(path.join(dataDirectory, 'bridge-host.pid'), 'utf8')),
      childPid: Number(fs.readFileSync(path.join(dataDirectory, 'bridge.pid'), 'utf8'))
    };
  };
  const lifecycleCommand = (command) => runPowerShell(
    `Import-Module $env:LIFECYCLE_PATH -Force; ${command}`,
    {
      LIFECYCLE_PATH: lifecyclePath,
      INSTALL_PATH: installation,
      STAGE_PATH: stage,
      BACKUP_PATH: backup,
      SHORTCUT_PATH: shortcut
    }
  );

  try {
    const stopped = await startHost();
    lifecycleCommand('Stop-BridgeInstance -InstallDir $env:INSTALL_PATH | Out-Null');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(processAlive(stopped.hostPid), false);
    assert.equal(processAlive(stopped.childPid), false);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'bridge-host.pid')), false);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'bridge.pid')), false);
    assert.equal(lifecycleCommand(
      'Write-Output (Test-BridgeLockReleased (Join-Path $env:INSTALL_PATH "data\\bridge-host.lock"))'
    ), 'True');
    fs.writeFileSync(path.join(dataDirectory, 'bridge-host.pid'), String(process.pid));
    fs.writeFileSync(path.join(dataDirectory, 'bridge.pid'), String(process.pid));
    lifecycleCommand('Stop-BridgeInstance -InstallDir $env:INSTALL_PATH | Out-Null');
    assert.equal(processAlive(process.pid), true);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'bridge-host.pid')), false);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'bridge.pid')), false);

    const uninstalled = await startHost();
    fs.writeFileSync(shortcut, 'startup');
    lifecycleCommand(
      'Uninstall-BridgeInstance -InstallDir $env:INSTALL_PATH -StartupShortcutPath $env:SHORTCUT_PATH'
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(processAlive(uninstalled.hostPid), false);
    assert.equal(processAlive(uninstalled.childPid), false);
    assert.equal(fs.existsSync(shortcut), false);

    await startHost();
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(dataDirectory, 'state.json'), 'utf8')).counter >= 3);
    fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'version.txt'), 'new-version');
    lifecycleCommand(
      'Invoke-BridgeInstallSwap -InstallDir $env:INSTALL_PATH -StageDir $env:STAGE_PATH | Out-Null'
    );
    const preserved = JSON.parse(fs.readFileSync(path.join(installation, 'data', 'state.json'), 'utf8'));
    assert.equal(preserved.final, true);
    assert.equal(fs.readFileSync(path.join(installation, 'version.txt'), 'utf8'), 'new-version');
    assert.equal(fs.existsSync(path.join(installation, 'data', 'bridge.stop')), false);
    assert.equal(fs.existsSync(backup), true);
  } finally {
    for (const host of hosts) {
      if (processAlive(host.pid)) {
        spawnSync('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      }
    }
    for (const target of [installation, stage, backup, `${installation}.install-journal.json`]) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    fs.rmSync(shortcut, { force: true });
  }
});

test('Claude resolver uses the fixed native path in native-only and native-plus-npm environments', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review2-claude-path-'));
  const userProfile = path.join(directory, 'profile');
  const appData = path.join(directory, 'appdata');
  const localAppData = path.join(directory, 'localappdata');
  const nativePath = path.join(userProfile, '.local', 'bin', 'claude.exe');
  const npmCli = path.join(
    appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'
  );
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.copyFileSync(process.execPath, nativePath);
  const environment = {
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATH: path.join(process.env.WINDIR, 'System32'),
    PATHEXT: process.env.PATHEXT
  };
  try {
    const nativeOnly = resolveClaudeCommand('', { env: environment });
    assert.equal(nativeOnly.source, path.resolve(nativePath));
    const nativeVersion = spawnSync(nativeOnly.command, [...nativeOnly.prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      env: environment
    });
    assert.equal(nativeVersion.status, 0, nativeVersion.stderr);

    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, "process.stdout.write('2.1.211\\n');\n");
    const nativeAndOldNpm = resolveClaudeCommand('', { env: environment });
    assert.equal(nativeAndOldNpm.source, path.resolve(nativePath));
    const oldNpmVersion = spawnSync(process.execPath, [npmCli, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      env: environment
    });
    assert.equal(oldNpmVersion.stdout.trim(), '2.1.211');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime and launcher auth checks spawn real children with the same coherent personal environment', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review2-child-env-'));
  const runnerProbe = path.join(directory, 'runner-probe.js');
  const launcherProbe = path.join(directory, 'launcher-probe.js');
  const selectedKeys = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS'
  ];
  const probeExpression = `Object.fromEntries(${JSON.stringify(selectedKeys)}.map((key) => [key, process.env[key] || null]))`;
  fs.writeFileSync(runnerProbe,
    `process.stdout.write(JSON.stringify({type:'result',result:JSON.stringify(${probeExpression})})+'\\n');\n`);
  fs.writeFileSync(launcherProbe, `process.stdout.write(JSON.stringify(${probeExpression}));\n`);
  const originals = Object.fromEntries(selectedKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CLAUDE_CODE_OAUTH_TOKEN: 'personal-oauth-synthetic',
    ANTHROPIC_AUTH_TOKEN: 'gateway-token-synthetic',
    ANTHROPIC_BASE_URL: 'https://gateway.invalid',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    NODE_EXTRA_CA_CERTS: 'C:\\synthetic-ca.pem'
  });
  try {
    const runner = new ClaudeRunner({
      command: { command: process.execPath, prefixArgs: [runnerProbe], source: runnerProbe },
      cwd: directory,
      timeoutMs: 10_000,
      allowApiBilling: false,
      logger: quietLogger
    });
    const runtimeResult = await runner.run({
      prompt: 'synthetic',
      sessionId: null,
      unsafe: false,
      approvalContext: syntheticApprovalContext,
      taskId: 'env',
      onActivity() {}
    });
    assert.equal(runtimeResult.ok, true);
    assert.deepEqual(JSON.parse(runtimeResult.text), {
      CLAUDE_CODE_OAUTH_TOKEN: 'personal-oauth-synthetic',
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
      HTTPS_PROXY: null,
      NODE_EXTRA_CA_CERTS: null
    });

    const corePath = path.join(root, 'launcher', 'Launcher.Core.psm1');
    const allowlistPath = path.join(root, 'launcher', 'claude-env-allowlist.json');
    const launcherOutput = runPowerShell(
      'Import-Module $env:CORE_PATH -Force; $node=$env:NODE_EXE; $probe=$env:PROBE; Invoke-WithClaudeEnvironment -AllowlistPath $env:ALLOWLIST -Action { & $node $probe }',
      {
        CORE_PATH: corePath,
        ALLOWLIST: allowlistPath,
        NODE_EXE: process.execPath,
        PROBE: launcherProbe,
        CLAUDE_CODE_OAUTH_TOKEN: 'personal-oauth-synthetic',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token-synthetic',
        ANTHROPIC_BASE_URL: 'https://gateway.invalid',
        HTTPS_PROXY: 'http://proxy.invalid:8080',
        NODE_EXTRA_CA_CERTS: 'C:\\synthetic-ca.pem'
      }
    );
    assert.deepEqual(JSON.parse(launcherOutput), JSON.parse(runtimeResult.text));
    assert.equal(buildChildEnv({
      ANTHROPIC_API_KEY: 'synthetic-api-key',
      ANTHROPIC_BASE_URL: 'https://gateway.invalid'
    }, true).ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const key of selectedKeys) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('multi-part outbox persists each chunk and retries only the failed chunk', async () => {
  const sent = [];
  let failSecondOnce = true;
  const owned = makeBridge({
    async sendPreparedText(chatId, text) {
      sent.push(text);
      if (sent.length === 2 && failSecondOnce) {
        failSecondOnce = false;
        throw new TypeError('ambiguous synthetic disconnect');
      }
      return { message_id: sent.length };
    }
  });
  owned.bridge.stopping = true;
  try {
    const text = `${'أ'.repeat(3500)}\n${'ب'.repeat(3500)}`;
    const firstAttempt = await owned.bridge.safeSend('10', text, {}, 'task:multipart');
    assert.equal(firstAttempt, null);
    assert.equal(owned.store.state.outbox.length, 2);
    assert.equal(owned.store.state.outbox[0].status, 'delivered');
    assert.equal(owned.store.state.outbox[0].telegramMessageId, '1');
    assert.equal(owned.store.state.outbox[1].status, 'pending');

    owned.store.state.outbox[1].nextAttemptAt = 0;
    owned.store.save();
    owned.bridge.stopping = false;
    await owned.bridge.flushOutbox();
    assert.equal(sent.length, 3);
    assert.equal(sent[0], sent.filter((item) => item === sent[0])[0]);
    assert.equal(sent.filter((item) => item === sent[0]).length, 1);
    assert.equal(sent.filter((item) => item === sent[1]).length, 2);
    assert.equal(owned.store.state.outbox[1].telegramMessageId, '3');
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('corrupt state fails closed, is quarantined, and restores only through the explicit backup action', {
  skip: process.platform !== 'win32'
}, () => {
  const owned = makeStore('cc-review2-corrupt-state-');
  try {
    owned.store.pairUser('10');
    owned.store.enqueueOutbox({
      id: 'answer-1',
      idempotencyKey: 'answer-1',
      chatId: '10',
      text: 'synthetic answer',
      extra: {}
    });
    owned.store.save();
    fs.writeFileSync(owned.filePath, '{"pairedUsers":["10"],"outbox":');

    assert.throws(
      () => new JsonStore(owned.filePath, quietLogger),
      (error) => error instanceof StateCorruptionError &&
        error.code === 'state_corrupted' &&
        /ملف حالة الجسر تالف/.test(error.message)
    );
    assert.equal(fs.existsSync(owned.filePath), false);
    assert.equal(fs.existsSync(`${owned.filePath}.bak`), true);
    assert.equal(fs.readdirSync(owned.directory).some((name) => name.startsWith('state.json.corrupt-')), true);

    const corePath = path.join(root, 'launcher', 'Launcher.Core.psm1');
    runPowerShell(
      'Import-Module $env:CORE_PATH -Force; Restore-BridgeStateBackup -Path $env:STATE_PATH | Out-Null',
      { CORE_PATH: corePath, STATE_PATH: owned.filePath }
    );
    const restored = new JsonStore(owned.filePath, quietLogger);
    assert.equal(restored.hasPairedUser('10'), true);
    assert.equal(restored.state.outbox.length, 1);
    assert.equal(restored.state.outbox[0].text, 'synthetic answer');
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('outbox has a hard cap, a pending TTL, and an oldest-first dead-letter policy', () => {
  const capped = makeStore('cc-review2-outbox-cap-');
  const now = Date.now();
  try {
    for (let index = 0; index < OUTBOX_MAX_ITEMS + 20; index += 1) {
      capped.store.enqueueOutbox({
        id: `message-${index}`,
        idempotencyKey: `message-${index}`,
        chatId: '10',
        text: `answer-${index}`,
        extra: {}
      }, now + index);
    }
    assert.equal(capped.store.state.outbox.length, OUTBOX_MAX_ITEMS);
    assert.equal(capped.store.state.outbox.some((item) => item.id === 'message-0'), false);
    assert.equal(capped.store.state.outbox[0].id, 'message-20');
    assert.equal(capped.store.state.outboxDeadLetters.length, 20);
    assert.equal(capped.store.state.outboxDeadLetters[0].reason, 'outbox_capacity_exceeded');
  } finally {
    fs.rmSync(capped.directory, { recursive: true, force: true });
  }

  const expiring = makeStore('cc-review2-outbox-ttl-');
  try {
    expiring.store.enqueueOutbox({
      id: 'expired-message',
      idempotencyKey: 'expired-message',
      chatId: '10',
      text: 'old answer',
      extra: {}
    }, now - OUTBOX_PENDING_TTL_MS - 1);
    assert.deepEqual(expiring.store.pendingOutbox(now), []);
    assert.equal(expiring.store.state.outbox.length, 0);
    assert.equal(expiring.store.state.outboxDeadLetters[0].reason, 'pending_ttl_exceeded');
  } finally {
    fs.rmSync(expiring.directory, { recursive: true, force: true });
  }
});

test('logger rotates while the child process remains alive', {
  timeout: 15_000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review2-live-log-'));
  const script = path.join(directory, 'writer.js');
  const logPath = path.join(directory, 'bridge.log');
  fs.writeFileSync(script, [
    `const { Logger } = require(${JSON.stringify(path.join(root, 'src', 'logger.js'))});`,
    `const logger = new Logger({ filePath: ${JSON.stringify(logPath)}, maxBytes: 300, throttleMs: 1 });`,
    'let index = 0;',
    "const timer = setInterval(() => { logger.warn(`event-${index}`, 'x'.repeat(90)); index += 1; if (index === 80) clearInterval(timer); }, 5);",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: 'ignore' });
  try {
    await waitFor(() => fs.existsSync(`${logPath}.1`), 7000);
    assert.equal(child.exitCode, null);
    assert.equal(fs.statSync(`${logPath}.1`).size > 0, true);
    assert.equal(fs.statSync(logPath).size <= 300, true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
