'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Bridge } = require('../src/bridge');
const { resolveClaudeCommand } = require('../src/runner');
const { JsonStore } = require('../src/store');

const root = path.resolve(__dirname, '..');
const quietLogger = { info() {}, warn() {}, error() {} };

function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error('wait_timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

function runPowerShell(command, environment = {}, timeout = 30_000) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', `$WarningPreference='SilentlyContinue'; ${command}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    env: { ...process.env, ...environment }
  });
}

function validState() {
  return {
    pairedUsers: ['10'],
    permissions: { 10: 'safe' },
    sessions: {},
    sessionGenerations: {},
    updateOffset: 0,
    processedUpdates: [],
    pairing: null,
    pairingAttempts: {},
    outbox: [],
    outboxDeadLetters: []
  };
}

function makeBridge({ telegram, runner, sleep, random } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review3-bridge-'));
  const store = new JsonStore(path.join(directory, 'state.json'), quietLogger);
  store.state.pairedUsers = ['10'];
  store.state.permissions = { 10: 'safe' };
  store.save();
  const bridge = new Bridge({
    config: {
      ownerIds: new Set(['10']),
      expectedBotUsername: '',
      apiKeyDetected: false,
      allowApiBilling: false
    },
    store,
    telegram,
    runner: runner || { cancel() {}, async run() { throw new Error('runner_not_expected'); } },
    logger: quietLogger,
    sleep: sleep || (async () => {}),
    random: random || (() => 0.5)
  });
  return { bridge, directory, store };
}

test('R-01 state corruption is terminal across the real host and only the shared validator clears it', {
  skip: process.platform !== 'win32',
  timeout: 45_000
}, async () => {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review3-corruption-'));
  const launcherDirectory = path.join(installation, 'launcher');
  const runtimeDirectory = path.join(installation, 'runtime', 'node');
  const sourceDirectory = path.join(installation, 'src');
  const dataDirectory = path.join(installation, 'data');
  const statePath = path.join(dataDirectory, 'state.json');
  const startedPath = path.join(dataDirectory, 'validated-start.txt');
  const lifecyclePath = path.join(root, 'launcher', 'Bridge.Lifecycle.psm1');
  const corePath = path.join(root, 'launcher', 'Launcher.Core.psm1');
  fs.mkdirSync(launcherDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, 'launcher', 'bridge-host.ps1'),
    path.join(launcherDirectory, 'bridge-host.ps1'));
  fs.copyFileSync(path.join(root, 'launcher', 'state-validator.js'),
    path.join(launcherDirectory, 'state-validator.js'));
  fs.copyFileSync(path.join(root, 'src', 'store.js'), path.join(sourceDirectory, 'store.js'));
  fs.copyFileSync(path.join(root, 'src', 'models.js'), path.join(sourceDirectory, 'models.js'));
  fs.copyFileSync(process.execPath, path.join(runtimeDirectory, 'node.exe'));
  fs.writeFileSync(path.join(installation, 'index.js'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const { JsonStore } = require(${JSON.stringify(path.join(root, 'src', 'store.js'))});`,
    'try {',
    "  new JsonStore(path.join(__dirname, 'data', 'state.json'), { info(){}, warn(){}, error(){} });",
    "  fs.writeFileSync(path.join(__dirname, 'data', 'validated-start.txt'), String(process.pid));",
    '  setInterval(() => {}, 1000);',
    '} catch (error) {',
    "  process.exitCode = error.code === 'state_corrupted' ? 78 : 1;",
    '}'
  ].join('\n'));
  fs.writeFileSync(statePath, '{"pairedUsers":["10"],"outbox":');
  fs.writeFileSync(`${statePath}.bak`, `${JSON.stringify(validState())}\n`);

  const hostArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(launcherDirectory, 'bridge-host.ps1')
  ];
  const firstHost = spawn('powershell.exe', hostArguments, { windowsHide: true, stdio: 'ignore' });
  let secondHost;
  try {
    await waitFor(() => fs.existsSync(`${statePath}.corrupt-marker`));
    await waitFor(() => firstHost.exitCode !== null);
    assert.equal(firstHost.exitCode, 78);
    assert.equal(fs.existsSync(startedPath), false);
    assert.equal(fs.existsSync(statePath), false);

    const rejected = validState();
    rejected.permissions = { 10: 'administrator' };
    fs.writeFileSync(`${statePath}.bak`, `${JSON.stringify(rejected)}\n`);
    const rejectedRestore = runPowerShell(
      'Import-Module $env:CORE_PATH -Force; Restore-BridgeStateBackup -Path $env:STATE_PATH | Out-Null',
      { CORE_PATH: corePath, STATE_PATH: statePath }
    );
    assert.notEqual(rejectedRestore.status, 0);
    assert.equal(fs.existsSync(`${statePath}.corrupt-marker`), true);

    fs.writeFileSync(`${statePath}.bak`, `${JSON.stringify(validState())}\n`);
    const restored = runPowerShell(
      'Import-Module $env:CORE_PATH -Force; Restore-BridgeStateBackup -Path $env:STATE_PATH | Out-Null',
      { CORE_PATH: corePath, STATE_PATH: statePath }
    );
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.equal(fs.existsSync(`${statePath}.corrupt-marker`), false);

    secondHost = spawn('powershell.exe', hostArguments, { windowsHide: true, stdio: 'ignore' });
    await waitFor(() => fs.existsSync(startedPath));
    const stop = runPowerShell(
      'Import-Module $env:LIFECYCLE_PATH -Force; Stop-BridgeInstance -InstallDir $env:INSTALL_PATH | Out-Null',
      { LIFECYCLE_PATH: lifecyclePath, INSTALL_PATH: installation }
    );
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    await waitFor(() => secondHost.exitCode !== null);
  } finally {
    for (const child of [firstHost, secondHost]) {
      if (child && child.exitCode === null) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      }
    }
    fs.rmSync(installation, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('T21-02 transient state locks retry without quarantine and marker clearing is verified', {
  skip: process.platform !== 'win32',
  timeout: 45_000
}, async () => {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review4-state-lock-'))
  );
  const localAppData = path.join(parent, 'localappdata');
  const installation = path.join(localAppData, 'cc-telegram-bridge');
  const launcherDirectory = path.join(installation, 'launcher');
  const runtimeDirectory = path.join(installation, 'runtime', 'node');
  const sourceDirectory = path.join(installation, 'src');
  const dataDirectory = path.join(installation, 'data');
  const statePath = path.join(dataDirectory, 'state.json');
  const startedPath = path.join(dataDirectory, 'validated-start.txt');
  const readAttemptPath = path.join(dataDirectory, 'state-read-attempt.txt');
  const lockReadyPath = path.join(dataDirectory, 'state-lock-ready.txt');
  const markerReadyPath = path.join(dataDirectory, 'marker-lock-ready.txt');
  const restoreLockReadyPath = path.join(dataDirectory, 'restore-lock-ready.txt');
  const lifecyclePath = path.join(root, 'launcher', 'Bridge.Lifecycle.psm1');
  const corePath = path.join(root, 'launcher', 'Launcher.Core.psm1');
  const launcherPath = path.join(root, 'launcher', 'launcher.ps1');
  fs.mkdirSync(launcherDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, 'launcher', 'bridge-host.ps1'),
    path.join(launcherDirectory, 'bridge-host.ps1'));
  fs.copyFileSync(path.join(root, 'launcher', 'start-bridge.vbs'),
    path.join(launcherDirectory, 'start-bridge.vbs'));
  fs.copyFileSync(path.join(root, 'launcher', 'state-validator.js'),
    path.join(launcherDirectory, 'state-validator.js'));
  fs.copyFileSync(path.join(root, 'src', 'store.js'), path.join(sourceDirectory, 'store.js'));
  fs.copyFileSync(path.join(root, 'src', 'models.js'), path.join(sourceDirectory, 'models.js'));
  fs.copyFileSync(process.execPath, path.join(runtimeDirectory, 'node.exe'));
  fs.writeFileSync(path.join(installation, 'index.js'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const { JsonStore } = require(${JSON.stringify(path.join(root, 'src', 'store.js'))});`,
    "fs.writeFileSync(path.join(__dirname, 'data', 'state-read-attempt.txt'), String(process.pid));",
    "new JsonStore(path.join(__dirname, 'data', 'state.json'), { info(){}, warn(){}, error(){} });",
    "fs.writeFileSync(path.join(__dirname, 'data', 'validated-start.txt'), String(process.pid));",
    "fs.writeFileSync(path.join(__dirname, 'data', 'bridge.ready'), JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString() }));",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  fs.writeFileSync(statePath, `${JSON.stringify(validState())}\n`);
  fs.writeFileSync(`${statePath}.bak`, `${JSON.stringify(validState())}\n`);

  const stateLock = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command',
    [
      '$stream=[IO.File]::Open($env:STATE_PATH,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)',
      '[IO.File]::WriteAllText($env:READY_PATH, "ready")',
      'try { while (-not (Test-Path -LiteralPath $env:ATTEMPT_PATH)) { Start-Sleep -Milliseconds 25 }; Start-Sleep -Milliseconds 500 } finally { $stream.Dispose() }'
    ].join('; ')
  ], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      STATE_PATH: statePath,
      READY_PATH: lockReadyPath,
      ATTEMPT_PATH: readAttemptPath
    }
  });
  const hostArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(launcherDirectory, 'bridge-host.ps1')
  ];
  let firstHost;
  let markerLock;
  let restoreStateLock;
  try {
    await waitFor(() => fs.existsSync(lockReadyPath));
    firstHost = spawn('powershell.exe', hostArguments, { windowsHide: true, stdio: 'ignore' });
    await waitFor(() => fs.existsSync(startedPath), 8_000);
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(`${statePath}.corrupt-marker`), false);
    assert.equal(fs.existsSync(`${statePath}.read-error.json`), false);
    assert.equal(
      fs.readdirSync(dataDirectory).some((name) => name.startsWith('state.json.corrupt-')),
      false
    );

    const stopped = runPowerShell(
      'Import-Module $env:LIFECYCLE_PATH -Force; Stop-BridgeInstance -InstallDir $env:INSTALL_PATH | Out-Null',
      { LIFECYCLE_PATH: lifecyclePath, INSTALL_PATH: installation }
    );
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    await waitFor(() => firstHost.exitCode !== null);
    fs.rmSync(startedPath, { force: true });

    const markerPath = `${statePath}.corrupt-marker`;
    fs.writeFileSync(markerPath, '{"version":1}\n');
    markerLock = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      [
        '$stream=[IO.File]::Open($env:MARKER_PATH,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)',
        '[IO.File]::WriteAllText($env:READY_PATH, "ready")',
        'try { Start-Sleep -Seconds 20 } finally { $stream.Dispose() }'
      ].join('; ')
    ], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, MARKER_PATH: markerPath, READY_PATH: markerReadyPath }
    });
    await waitFor(() => fs.existsSync(markerReadyPath));
    const rejectedRestore = runPowerShell(
      'Import-Module $env:CORE_PATH -Force; Restore-BridgeStateBackup -Path $env:STATE_PATH | Out-Null',
      { CORE_PATH: corePath, STATE_PATH: statePath }
    );
    assert.notEqual(rejectedRestore.status, 0);
    assert.equal(fs.existsSync(markerPath), true);

    spawnSync('taskkill.exe', ['/PID', String(markerLock.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    await waitFor(() => markerLock.exitCode !== null);

    restoreStateLock = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      [
        '$stream=[IO.File]::Open($env:STATE_PATH,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)',
        '[IO.File]::WriteAllText($env:READY_PATH, "ready")',
        'try { Start-Sleep -Seconds 20 } finally { $stream.Dispose() }'
      ].join('; ')
    ], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, STATE_PATH: statePath, READY_PATH: restoreLockReadyPath }
    });
    await waitFor(() => fs.existsSync(restoreLockReadyPath));
    const rolledBackRestore = runPowerShell(
      'Import-Module $env:CORE_PATH -Force; Restore-BridgeStateBackup -Path $env:STATE_PATH | Out-Null',
      { CORE_PATH: corePath, STATE_PATH: statePath }
    );
    assert.notEqual(rolledBackRestore.status, 0);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(
      fs.readdirSync(dataDirectory).some((name) => name.startsWith('state.json.corrupt-marker.cleared-')),
      false
    );
    spawnSync('taskkill.exe', ['/PID', String(restoreStateLock.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    await waitFor(() => restoreStateLock.exitCode !== null);

    const restored = runPowerShell(
      '& $env:LAUNCHER_PATH -StateRestoreSmokeTest',
      {
        LAUNCHER_PATH: launcherPath,
        LOCALAPPDATA: localAppData,
        APPDATA: path.join(parent, 'appdata')
      },
      40_000
    );
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.match(restored.stdout, /STATE_RESTORE_SMOKE_OK=/);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(
      fs.readdirSync(dataDirectory).some((name) => name.startsWith('state.json.corrupt-marker.cleared-')),
      true
    );

    await waitFor(() => fs.existsSync(startedPath), 8_000);
    const stoppedAgain = runPowerShell(
      'Import-Module $env:LIFECYCLE_PATH -Force; Stop-BridgeInstance -InstallDir $env:INSTALL_PATH | Out-Null',
      { LIFECYCLE_PATH: lifecyclePath, INSTALL_PATH: installation }
    );
    assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr || stoppedAgain.stdout);
  } finally {
    for (const child of [stateLock, firstHost, markerLock, restoreStateLock]) {
      if (child && child.exitCode === null) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      }
    }
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('R-02 a failed first chunk blocks later chunks and the completion message', async () => {
  const attempts = [];
  const delivered = [];
  let failFirst = true;
  const telegram = {
    async sendTyping() {},
    async sendPreparedText(chatId, text) {
      attempts.push(text);
      if (failFirst) {
        failFirst = false;
        throw new TypeError('synthetic first-chunk disconnect');
      }
      delivered.push(text);
      return { message_id: delivered.length };
    }
  };
  const answer = `${'A'.repeat(3900)}${'B'.repeat(3900)}`;
  const owned = makeBridge({
    telegram,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    runner: {
      cancel() {},
      async run() {
        return { ok: true, text: answer, sessionId: 'session-r02' };
      }
    }
  });
  try {
    await owned.bridge.executeTask({ id: 'r02', chatId: '10', userId: '10', prompt: 'synthetic' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(attempts.length, 1);
    assert.match(attempts[0], /^A/);
    assert.equal(owned.store.state.outbox.length, 3);
    assert.deepEqual(owned.store.state.outbox.map((item) => item.sequence), [1, 2, 3]);
    assert.match(owned.store.state.outbox[2].text, /✅ خلصت المهمة\./);

    await waitFor(() => delivered.length === 3, 4_000);
    assert.equal(delivered[0].startsWith('A'), true);
    assert.equal(delivered[1].startsWith('B'), true);
    assert.match(delivered[2], /✅ خلصت المهمة\./);
    assert.equal(owned.store.state.outbox.every((item) => item.status === 'delivered'), true);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});

test('R-03 disk journal recovery survives an activation failure and the launcher mutex is exclusive', {
  skip: process.platform !== 'win32',
  timeout: 30_000
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review3-transaction-'));
  const localAppData = path.join(parent, 'localappdata');
  const appData = path.join(parent, 'appdata');
  const installation = path.join(localAppData, 'cc-telegram-bridge');
  const nestedStage = `${installation}.stage-failure`;
  const backup = `${installation}.rollback`;
  const journal = `${installation}.install-journal.json`;
  const lifecyclePath = path.join(root, 'launcher', 'Bridge.Lifecycle.psm1');
  const launcherPath = path.join(root, 'launcher', 'launcher.ps1');
  const screenshotPath = path.join(parent, 'launcher-recovery.png');
  fs.mkdirSync(installation, { recursive: true });
  fs.mkdirSync(nestedStage, { recursive: true });
  fs.writeFileSync(path.join(installation, 'old.txt'), 'old-install');
  fs.writeFileSync(path.join(nestedStage, 'new.txt'), 'new-install');
  const failedSwap = runPowerShell(
    'Import-Module $env:LIFECYCLE_PATH -Force; Invoke-BridgeInstallSwap -InstallDir $env:INSTALL_PATH -StageDir $env:STAGE_PATH -FailAfterOldMove | Out-Null',
    { LIFECYCLE_PATH: lifecyclePath, INSTALL_PATH: installation, STAGE_PATH: nestedStage }
  );
  assert.notEqual(failedSwap.status, 0);
  assert.equal(fs.readFileSync(path.join(installation, 'old.txt'), 'utf8'), 'old-install');
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(journal), false);

  const stageAfterCrash = `${installation}.stage-crash`;
  fs.mkdirSync(stageAfterCrash, { recursive: true });
  fs.writeFileSync(path.join(stageAfterCrash, 'new.txt'), 'new-after-crash');
  fs.writeFileSync(journal, `${JSON.stringify({
    version: 1,
    phase: 'before_new_activation',
    installDir: installation,
    stageDir: stageAfterCrash,
    backupDir: backup,
    hadExistingInstall: true
  })}\n`);
  fs.renameSync(installation, backup);
  const recovered = runPowerShell(
    '& $env:LAUNCHER_PATH -UiSmokeTestPath $env:SCREENSHOT_PATH',
    {
      LAUNCHER_PATH: launcherPath,
      SCREENSHOT_PATH: screenshotPath,
      LOCALAPPDATA: localAppData,
      APPDATA: appData
    }
  );
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(fs.existsSync(screenshotPath), true);
  assert.equal(fs.readFileSync(path.join(installation, 'old.txt'), 'utf8'), 'old-install');
  assert.equal(fs.existsSync(stageAfterCrash), false);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(journal), false);

  const mutexName = `Local\\cc-review3-${process.pid}-${Date.now()}`;
  const readyPath = path.join(parent, 'mutex-ready');
  const holder = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command',
    [
      'Import-Module $env:LIFECYCLE_PATH -Force',
      '$mutex=Enter-BridgeLauncherLock -Name $env:MUTEX_NAME',
      'if (-not $mutex) { exit 2 }',
      '[IO.File]::WriteAllText($env:READY_PATH, "ready")',
      'try { Start-Sleep -Seconds 20 } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }'
    ].join('; ')
  ], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LIFECYCLE_PATH: lifecyclePath,
      MUTEX_NAME: mutexName,
      READY_PATH: readyPath
    }
  });
  try {
    await waitFor(() => fs.existsSync(readyPath));
    const contender = runPowerShell(
      'Import-Module $env:LIFECYCLE_PATH -Force; $mutex=Enter-BridgeLauncherLock -Name $env:MUTEX_NAME; if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose(); exit 3 }',
      { LIFECYCLE_PATH: lifecyclePath, MUTEX_NAME: mutexName }
    );
    assert.equal(contender.status, 0, contender.stderr || contender.stdout);
  } finally {
    if (holder.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(holder.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    }
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('R-04 resolver priority is configured, fixed, newest versioned, then npm', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review3-resolver-'));
  const profile = path.join(directory, 'profile');
  const appData = path.join(directory, 'appdata');
  const localAppData = path.join(directory, 'localappdata');
  const configured = path.join(directory, 'configured', 'claude.exe');
  const fixed = path.join(profile, '.local', 'bin', 'claude.exe');
  const oldVersioned = path.join(appData, 'Claude', 'claude-code', '2.1.219', 'claude.exe');
  const newVersioned = path.join(localAppData, 'Claude', 'claude-code', '2.1.220', 'claude.exe');
  const invalidVersioned = path.join(localAppData, 'Claude', 'claude-code', 'zzz-backup', 'claude.exe');
  const npmCli = path.join(
    appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'
  );
  for (const candidate of [configured, fixed, oldVersioned, newVersioned, invalidVersioned]) {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.copyFileSync(process.execPath, candidate);
  }
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(npmCli, "process.stdout.write('npm synthetic\\n');\n");
  const environment = {
    USERPROFILE: profile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATH: path.join(process.env.WINDIR, 'System32'),
    PATHEXT: process.env.PATHEXT
  };
  try {
    assert.equal(resolveClaudeCommand(configured, { env: environment }).source, path.resolve(configured));
    assert.equal(resolveClaudeCommand('', { env: environment }).source, path.resolve(fixed));
    fs.rmSync(fixed);
    assert.equal(resolveClaudeCommand('', { env: environment }).source, path.resolve(newVersioned));
    fs.rmSync(newVersioned);
    assert.equal(resolveClaudeCommand('', { env: environment }).source, path.resolve(oldVersioned));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R-05 a 501-chunk answer is reserved atomically before the first send', async () => {
  let attempts = 0;
  const owned = makeBridge({
    telegram: {
      async sendPreparedText() {
        attempts += 1;
        throw new TypeError('synthetic offline before first delivery');
      }
    }
  });
  owned.bridge.stopping = true;
  const answer = 'A'.repeat(501 * 3900);
  try {
    const result = await owned.bridge.safeSend('10', answer, {}, 'task:r05:result');
    assert.equal(result, null);
    assert.equal(attempts, 1);
    assert.equal(owned.store.state.outbox.length, 501);
    assert.equal(owned.store.state.outbox[0].sequence, 1);
    assert.equal(owned.store.state.outbox[0].text.startsWith('A'), true);
    assert.equal(new Set(owned.store.state.outbox.map((item) => item.envelopeId)).size, 1);
    assert.equal(owned.store.state.outboxDeadLetters.length, 0);

    const next = await owned.bridge.safeSend('10', 'next message', {}, 'task:r05:next');
    assert.equal(next, null);
    assert.equal(attempts, 2);
    assert.equal(owned.store.state.outbox.length, 502);
    assert.equal(
      owned.store.state.outbox.filter((item) => item.envelopeId === 'task:r05:result').length,
      501
    );
    assert.equal(
      owned.store.state.outbox.filter((item) => item.envelopeId === 'task:r05:next').length,
      1
    );
    assert.equal(owned.store.state.outboxDeadLetters.length, 0);
  } finally {
    fs.rmSync(owned.directory, { recursive: true, force: true });
  }
});
