'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'launcher', 'Launcher.Core.psm1');

function runPowerShell(command, extraEnv = {}) {
  const quietCommand = `$WarningPreference='SilentlyContinue'; ${command}`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    quietCommand
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MODULE_PATH: modulePath, ...extraEnv },
    timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('normalizes copied Telegram token damage before shape validation', () => {
  const dirty = '\u201chttps://api.telegram.org/bot\u200f\u0661\u0662\u0663\u0664\u0665\u0666:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi/getMe\u201d';
  const output = runPowerShell(
    "Import-Module $env:MODULE_PATH -Force; $raw=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOT_TOKEN_B64)); $v=Normalize-BotToken $raw; Write-Output $v; Write-Output (Test-BotTokenShape $v)",
    { BOT_TOKEN_B64: Buffer.from(dirty, 'utf8').toString('base64') }
  ).split(/\r?\n/);
  assert.equal(output[0], '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi');
  assert.equal(output[1], 'True');
});

test('generates six-digit non-template pairing codes', () => {
  const output = runPowerShell(
    "Import-Module $env:MODULE_PATH -Force; 1..50 | ForEach-Object { New-PairingCode }"
  ).split(/\r?\n/);
  assert.equal(output.length, 50);
  assert.ok(output.every((value) => /^[1-9]\d{5}$/.test(value)));
  assert.ok(new Set(output).size > 45);
});

test('writes UTF-8 without BOM and round-trips the real env keys', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-env-'));
  const envPath = path.join(temporary, '.env');
  const command = [
    'Import-Module $env:MODULE_PATH -Force',
    "$v=@{TELEGRAM_BOT_TOKEN_DPAPI='encrypted-value';TELEGRAM_OWNER_IDS='987654321';CLAUDE_WORKDIR='workspace';CLAUDE_TIMEOUT_MINUTES='45';CLAUDE_ALLOW_API_BILLING='0'}",
    'Write-EnvFile -Path $env:ENV_PATH -Values $v',
    '$r=Read-EnvFile $env:ENV_PATH',
    'Write-Output ($r.TELEGRAM_OWNER_IDS + "|" + $r.TELEGRAM_BOT_TOKEN_DPAPI + "|" + $r.CLAUDE_WORKDIR)'
  ].join('; ');
  const output = runPowerShell(command, { ENV_PATH: envPath });
  assert.equal(output, '987654321|encrypted-value|workspace');
  const bytes = fs.readFileSync(envPath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(bytes.toString('utf8'), /\r\n/);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('pre-pairs the captured owner and stores the selected safe mode', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-state-'));
  const statePath = path.join(temporary, 'data', 'state.json');
  runPowerShell(
    "Import-Module $env:MODULE_PATH -Force; Initialize-BridgeState -Path $env:STATE_PATH -OwnerId '987654321' -Permission safe -UpdateOffset 78 -PairingCode '731905'",
    { STATE_PATH: statePath }
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.pairedUsers, ['987654321']);
  assert.equal(state.permissions['987654321'], 'safe');
  assert.deepEqual(state.sessions, {});
  assert.equal(state.updateOffset, 78);
  assert.equal(state.pairing.used, true);
  assert.equal(state.pairing.code, '731905');
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('keeps console entry files ASCII-only and routes through wscript', () => {
  const start = fs.readFileSync(path.join(root, 'START.cmd'));
  const hidden = fs.readFileSync(path.join(root, 'launcher', 'start-hidden.vbs'));
  const bridge = fs.readFileSync(path.join(root, 'launcher', 'start-bridge.vbs'));
  for (const content of [start, hidden, bridge]) {
    assert.ok([...content].every((byte) => byte < 128));
  }
  assert.match(start.toString('ascii'), /wscript\.exe/i);
});

test('stores the Arabic WinForms script as UTF-8 with BOM', () => {
  const content = fs.readFileSync(path.join(root, 'launcher', 'launcher.ps1'));
  assert.deepEqual([...content.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(content.toString('utf8'), /RightToLeftLayout = \$true/);
});

test('release builder pins official Node LTS and verifies SHA-256', () => {
  const builder = fs.readFileSync(path.join(root, 'tools', 'build-release.ps1'), 'utf8');
  assert.match(builder, /\$NodeVersion = '24\.18\.0'/);
  assert.match(builder, /https:\/\/nodejs\.org\/dist\/v\$NodeVersion/);
  assert.match(builder, /SHASUMS256\.txt/);
  assert.match(builder, /node_archive_checksum_mismatch/);
});

test('lifecycle module can open and release the real bridge lock', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lifecycle-lock-'));
  const lockPath = path.join(temporary, 'bridge-host.lock');
  fs.writeFileSync(lockPath, '');
  const lifecyclePath = path.join(root, 'launcher', 'Bridge.Lifecycle.psm1');
  const output = runPowerShell(
    'Import-Module $env:LIFECYCLE_PATH -Force; Write-Output (Test-BridgeLockReleased $env:LOCK_PATH)',
    { LIFECYCLE_PATH: lifecyclePath, LOCK_PATH: lockPath }
  );
  assert.equal(output, 'True');
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('protects the bot token with CurrentUser DPAPI', () => {
  const output = runPowerShell(
    "Import-Module $env:MODULE_PATH -Force; $cipher=Protect-CurrentUserSecret '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi'; Write-Output ($cipher -notmatch '987654321'); Write-Output (Unprotect-CurrentUserSecret $cipher)"
  ).split(/\r?\n/);
  assert.equal(output[0], 'True');
  assert.equal(output[1], '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi');
});

test('launcher confirms Telegram offset and implements rollback stages', () => {
  const launcher = fs.readFileSync(path.join(root, 'launcher', 'launcher.ps1'), 'utf8');
  assert.match(launcher, /pairing_confirmation_failed/);
  assert.match(launcher, /-UpdateOffset \$script:PairOffset/);
  assert.match(launcher, /Restore-BridgeInstallTransaction -InstallDir \$installDir/);
  assert.match(launcher, /Complete-BridgeInstallTransaction -InstallDir \$installDir/);
  assert.match(launcher, /TELEGRAM_BOT_TOKEN_DPAPI/);
  assert.match(launcher, /cc-telegram-bridge-pairing\.json/);
  assert.match(launcher, /Write-PairingState/);
  assert.match(launcher, /pairingState\.attempts/);
  assert.doesNotMatch(launcher, /TELEGRAM_BOT_TOKEN\s*=/);
});

test('release builder emits a checksum manifest beside version 0.1.3', () => {
  const builder = fs.readFileSync(path.join(root, 'tools', 'build-release.ps1'), 'utf8');
  const zipModule = fs.readFileSync(path.join(root, 'tools', 'DeterministicZip.psm1'), 'utf8');
  assert.match(builder, /0\.1\.3-win-\$Architecture\.zip/);
  assert.match(builder, /\$manifestPath/);
  assert.match(builder, /MANIFEST=/);
  assert.match(builder, /New-DeterministicZip/);
  assert.match(builder, /DeterministicZip\.psm1/);
  assert.match(zipModule, /LastWriteTime = \$fixedTimestamp/);
  assert.doesNotMatch(builder, /Compress-Archive/);
});

test('deterministic ZIP helper is byte-stable across source timestamp changes', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deterministic-zip-'));
  const source = path.join(temporary, 'source');
  const nested = path.join(source, 'nested');
  const firstZip = path.join(temporary, 'first.zip');
  const secondZip = path.join(temporary, 'second.zip');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'z.txt'), 'z-content');
  fs.writeFileSync(path.join(source, 'a.txt'), 'a-content');
  try {
    const output = JSON.parse(runPowerShell([
      'Import-Module $env:ZIP_MODULE -Force',
      'New-DeterministicZip -SourceDirectory $env:SOURCE_DIR -DestinationPath $env:FIRST_ZIP',
      "Get-ChildItem -LiteralPath $env:SOURCE_DIR -Recurse -File | ForEach-Object { $_.LastWriteTimeUtc = [datetime]'2035-05-06T07:08:09Z' }",
      'New-DeterministicZip -SourceDirectory $env:SOURCE_DIR -DestinationPath $env:SECOND_ZIP',
      'Add-Type -AssemblyName System.IO.Compression',
      '$stream=[System.IO.File]::OpenRead($env:FIRST_ZIP)',
      '$archive=[System.IO.Compression.ZipArchive]::new($stream,[System.IO.Compression.ZipArchiveMode]::Read,$false)',
      '$names=@($archive.Entries | ForEach-Object { $_.FullName })',
      "$times=@($archive.Entries | ForEach-Object { $_.LastWriteTime.DateTime.ToString('yyyy-MM-ddTHH:mm:ss') } | Sort-Object -Unique)",
      '$archive.Dispose()',
      '[pscustomobject]@{hash1=(Get-FileHash -LiteralPath $env:FIRST_ZIP -Algorithm SHA256).Hash;hash2=(Get-FileHash -LiteralPath $env:SECOND_ZIP -Algorithm SHA256).Hash;names=$names;times=$times} | ConvertTo-Json -Compress'
    ].join('; '), {
      ZIP_MODULE: path.join(root, 'tools', 'DeterministicZip.psm1'),
      SOURCE_DIR: source,
      FIRST_ZIP: firstZip,
      SECOND_ZIP: secondZip
    }));
    assert.equal(output.hash1, output.hash2);
    assert.deepEqual(output.names, ['a.txt', 'nested/z.txt']);
    assert.deepEqual(output.times, ['1980-01-01T00:00:00']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
