'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

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
      setTimeout(check, 25);
    };
    check();
  });
}

function prepareInstallation(prefix, { accelerateCrashDelay = false } = {}) {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(installation, 'launcher'), { recursive: true });
  fs.mkdirSync(path.join(installation, 'runtime', 'node'), { recursive: true });
  fs.mkdirSync(path.join(installation, 'data'), { recursive: true });
  const hostPath = path.join(installation, 'launcher', 'bridge-host.ps1');
  fs.copyFileSync(path.join(root, 'launcher', 'bridge-host.ps1'), hostPath);
  fs.copyFileSync(process.execPath, path.join(installation, 'runtime', 'node', 'node.exe'));
  if (accelerateCrashDelay) {
    const original = fs.readFileSync(hostPath, 'utf8');
    const accelerated = original
      .replace('[datetime]::UtcNow.AddSeconds(', '[datetime]::UtcNow.AddMilliseconds(')
      .replace('Start-Sleep -Milliseconds 200', 'Start-Sleep -Milliseconds 1');
    assert.notEqual(accelerated, original);
    fs.writeFileSync(hostPath, accelerated);
  }
  return installation;
}

function startHost(installation) {
  return spawn('powershell.exe', [
    '-Version', '5.1',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(installation, 'launcher', 'bridge-host.ps1')
  ], { windowsHide: true, stdio: 'ignore' });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  });
}

function cleanup(installations, children) {
  children.forEach(killTree);
  for (const installation of installations) {
    fs.rmSync(installation, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
}

function readCount(installation) {
  const countPath = path.join(installation, 'data', 'starts.txt');
  return fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
}

function readHostError(installation) {
  const errorPath = path.join(installation, 'logs', 'host-error.log');
  return fs.existsSync(errorPath) ? fs.readFileSync(errorPath, 'utf8') : '';
}

function startReadSharedDeleteLock(markerPath, readyPath) {
  return spawn('powershell.exe', [
    '-Version', '5.1',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', [
      '$stream=[IO.File]::Open($env:MARKER_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)',
      '[IO.File]::WriteAllText($env:READY_PATH, "ready")',
      'try { Start-Sleep -Seconds 30 } finally { $stream.Dispose() }'
    ].join('; ')
  ], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, MARKER_PATH: markerPath, READY_PATH: readyPath }
  });
}

test('host source uses markers only for child intent', () => {
  const host = fs.readFileSync(path.join(root, 'launcher', 'bridge-host.ps1'), 'utf8');
  assert.doesNotMatch(host, /\$process\.ExitCode/);
  assert.doesNotMatch(host, /\$exitCode\s*-eq/i);
  assert.doesNotMatch(host, /catch\s*\[System\.IO\.IOException\][\s\S]{0,120}exit\s+0/i);
  assert.match(host, /\$restartMarkerPid\s+-eq\s+\[long\]\$process\.Id/);
  assert.match(host, /restart_marker_consume_failed/);
  assert.match(host, /stale_restart_marker_remove_failed/);
});

test('PowerShell 5.1 honors only a matching restart PID and repeated restarts bypass crash accounting', {
  skip: process.platform !== 'win32',
  timeout: 20_000
}, async () => {
  const installation = prepareInstallation('cc-t29-restart-', { accelerateCrashDelay: true });
  const children = [];
  try {
    const lifecyclePath = JSON.stringify(path.join(root, 'src', 'lifecycle.js'));
    fs.writeFileSync(path.join(installation, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const { writeRestartMarker } = require(${lifecyclePath});`,
      "const data = path.join(__dirname, 'data');",
      "const countPath = path.join(data, 'starts.txt');",
      "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countPath, String(count));",
      "if (count <= 6) { writeRestartMarker(path.join(data, 'bridge.restart')); process.exit(count % 2 ? 0 : 23); }",
      "fs.writeFileSync(path.join(data, 'bridge.ready'), String(process.pid));",
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const host = startHost(installation);
    children.push(host);
    await waitFor(
      () => host.exitCode !== null ||
        (readCount(installation) === 7 &&
         fs.existsSync(path.join(installation, 'data', 'bridge.ready'))),
      12_000,
      'matching_restart_did_not_reach_seventh_child'
    );
    assert.equal(host.exitCode, null, readHostError(installation));
    assert.equal(readCount(installation), 7);
    assert.equal(fs.existsSync(path.join(installation, 'data', 'bridge.restart')), false);
    fs.writeFileSync(path.join(installation, 'data', 'bridge.stop'), 'stop');
    await waitFor(() => host.exitCode !== null, 5_000, 'matching_restart_stop_timeout');
    assert.equal(host.exitCode, 0);
  } finally {
    cleanup([installation], children);
  }
});

test('PowerShell 5.1 rejects a stale restart PID and counts the exit as a crash', {
  skip: process.platform !== 'win32',
  timeout: 20_000
}, async () => {
  const installation = prepareInstallation('cc-t29-stale-', { accelerateCrashDelay: true });
  const children = [];
  try {
    fs.writeFileSync(path.join(installation, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const data = path.join(__dirname, 'data');",
      "const countPath = path.join(data, 'starts.txt');",
      "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countPath, String(count));",
      "fs.writeFileSync(path.join(data, 'bridge.restart'), JSON.stringify({ pid: process.pid + 1 }));",
      'process.exit(0);'
    ].join('\n'));
    const host = startHost(installation);
    children.push(host);
    await waitFor(
      () => host.exitCode !== null || readCount(installation) >= 7,
      12_000,
      'stale_restart_crash_accounting_timeout'
    );
    assert.equal(host.exitCode, 1, readHostError(installation));
    assert.equal(readCount(installation), 6);
    assert.match(readHostError(installation), /bridge_crash_loop_stopped/);
    assert.equal(fs.existsSync(path.join(installation, 'data', 'bridge.restart')), false);
  } finally {
    cleanup([installation], children);
  }
});

test('PowerShell 5.1 fails loudly when a matching restart marker cannot be removed', {
  skip: process.platform !== 'win32',
  timeout: 15_000
}, async () => {
  const installation = prepareInstallation('cc-t29-locked-');
  const children = [];
  try {
    const lifecyclePath = JSON.stringify(path.join(root, 'src', 'lifecycle.js'));
    fs.writeFileSync(path.join(installation, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const { writeRestartMarker } = require(${lifecyclePath});`,
      "const data = path.join(__dirname, 'data');",
      "fs.writeFileSync(path.join(data, 'starts.txt'), '1');",
      "writeRestartMarker(path.join(data, 'bridge.restart'));",
      "fs.writeFileSync(path.join(data, 'lock-requested'), 'ready');",
      "const timer = setInterval(() => {",
      "  if (fs.existsSync(path.join(data, 'lock-held'))) { clearInterval(timer); process.exit(0); }",
      '}, 10);'
    ].join('\n'));
    const host = startHost(installation);
    children.push(host);
    await waitFor(
      () => fs.existsSync(path.join(installation, 'data', 'lock-requested')),
      5_000,
      'restart_lock_request_timeout'
    );
    const markerPath = path.join(installation, 'data', 'bridge.restart');
    const lockReadyPath = path.join(installation, 'data', 'lock-held');
    const lock = startReadSharedDeleteLock(markerPath, lockReadyPath);
    children.push(lock);
    await waitFor(() => fs.existsSync(lockReadyPath), 5_000, 'restart_lock_ready_timeout');
    await waitFor(() => host.exitCode !== null, 8_000, 'locked_restart_host_exit_timeout');
    assert.equal(host.exitCode, 1);
    assert.equal(readCount(installation), 1);
    assert.equal(fs.existsSync(markerPath), true);
    assert.match(readHostError(installation), /restart_marker_consume_failed/);
  } finally {
    cleanup([installation], children);
  }
});

test('PowerShell 5.1 fails loudly when a stale startup marker cannot be removed', {
  skip: process.platform !== 'win32',
  timeout: 15_000
}, async () => {
  const installation = prepareInstallation('cc-t29-startup-lock-');
  const children = [];
  try {
    const markerPath = path.join(installation, 'data', 'bridge.restart');
    const lockReadyPath = path.join(installation, 'data', 'lock-held');
    fs.writeFileSync(markerPath, '{"pid":1234}\n');
    fs.writeFileSync(path.join(installation, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'data', 'started.txt'), 'unexpected');"
    ].join('\n'));
    const lock = startReadSharedDeleteLock(markerPath, lockReadyPath);
    children.push(lock);
    await waitFor(() => fs.existsSync(lockReadyPath), 5_000, 'startup_lock_ready_timeout');
    const host = startHost(installation);
    children.push(host);
    await waitFor(() => host.exitCode !== null, 8_000, 'startup_lock_host_exit_timeout');
    assert.equal(host.exitCode, 1);
    assert.equal(fs.existsSync(path.join(installation, 'data', 'started.txt')), false);
    assert.equal(fs.existsSync(markerPath), true);
    assert.match(readHostError(installation), /stale_restart_marker_remove_failed/);
  } finally {
    cleanup([installation], children);
  }
});

test('PowerShell 5.1 treats stop, corruption, and unmarked zero exit by markers only', {
  skip: process.platform !== 'win32',
  timeout: 25_000
}, async () => {
  const stopped = prepareInstallation('cc-t29-stop-');
  const corrupt = prepareInstallation('cc-t29-corrupt-', { accelerateCrashDelay: true });
  const crashed = prepareInstallation('cc-t29-unmarked-', { accelerateCrashDelay: true });
  const children = [];
  try {
    fs.writeFileSync(path.join(stopped, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'data', 'started.txt'), 'unexpected');"
    ].join('\n'));
    fs.writeFileSync(path.join(stopped, 'data', 'bridge.stop'), 'stop');
    const stoppedHost = startHost(stopped);
    children.push(stoppedHost);
    await waitFor(() => stoppedHost.exitCode !== null, 5_000, 'stop_marker_timeout');
    assert.equal(stoppedHost.exitCode, 0);
    assert.equal(fs.existsSync(path.join(stopped, 'data', 'started.txt')), false);

    fs.writeFileSync(path.join(corrupt, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const data = path.join(__dirname, 'data');",
      "fs.writeFileSync(path.join(data, 'starts.txt'), '1');",
      "fs.writeFileSync(path.join(data, 'state.json.corrupt-marker'), '{}');",
      'process.exit(0);'
    ].join('\n'));
    const corruptHost = startHost(corrupt);
    children.push(corruptHost);
    await waitFor(() => corruptHost.exitCode !== null, 5_000, 'corruption_marker_timeout');
    assert.equal(corruptHost.exitCode, 78);
    assert.equal(readCount(corrupt), 1);

    fs.writeFileSync(path.join(crashed, 'index.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const countPath = path.join(__dirname, 'data', 'starts.txt');",
      "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countPath, String(count));",
      'process.exit(0);'
    ].join('\n'));
    const crashedHost = startHost(crashed);
    children.push(crashedHost);
    await waitFor(() => crashedHost.exitCode !== null, 12_000, 'unmarked_zero_crash_timeout');
    assert.equal(crashedHost.exitCode, 1);
    assert.equal(readCount(crashed), 6);
    assert.match(readHostError(crashed), /bridge_crash_loop_stopped/);
  } finally {
    cleanup([stopped, corrupt, crashed], children);
  }
});
