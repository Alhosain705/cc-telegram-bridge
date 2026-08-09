'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { UNSUPPORTED_CLAUDE_ROUTING_KEYS } = require('./runner');

const EXAMPLE_TOKEN = '123456789:AAExampleTokenThatMustBeReplaced_123456789';
const EXAMPLE_OWNER = '123456789';
const ALLOWED_KEYS = new Set([
  'TELEGRAM_BOT_TOKEN_DPAPI',
  'TELEGRAM_OWNER_IDS',
  'TELEGRAM_BOT_USERNAME',
  'CLAUDE_WORKDIR',
  'CLAUDE_BIN',
  'CLAUDE_TIMEOUT_MINUTES',
  'CLAUDE_ALLOW_API_BILLING'
]);

function unprotectDpapi(ciphertext, spawnSyncImpl = spawnSync) {
  if (!ciphertext) return '';
  if (process.platform !== 'win32') throw new Error('dpapi_requires_windows');
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Security',
    '$bytes=[Convert]::FromBase64String($env:CC_DPAPI_CIPHERTEXT)',
    '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))'
  ].join(';');
  const result = spawnSyncImpl('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, CC_DPAPI_CIPHERTEXT: ciphertext }
  });
  if (result.error || result.status !== 0) throw new Error('telegram_token_decryption_failed');
  return String(result.stdout || '');
}

function parseEnvFile(raw) {
  const values = {};
  const unknown = [];
  for (const sourceLine of String(raw).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`invalid_config_line:${sourceLine}`);
    if (!ALLOWED_KEYS.has(match[1])) {
      unknown.push(match[1]);
      continue;
    }
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (unknown.length) throw new Error(`unknown_config_keys:${unknown.join(',')}`);
  return values;
}

function parseIds(value, key, allowNegative) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (items.some((item) => !pattern.test(item) || /^-?0+$/.test(item))) {
    throw new Error(`invalid_numeric_ids:${key}`);
  }
  return new Set(items);
}

function requireValidConfig(values, env) {
  const telegramToken = values.__DECRYPTED_TELEGRAM_TOKEN || values.TELEGRAM_BOT_TOKEN || '';
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(telegramToken) ||
      telegramToken === EXAMPLE_TOKEN) {
    throw new Error('invalid_telegram_token');
  }
  const ownerIds = parseIds(values.TELEGRAM_OWNER_IDS, 'TELEGRAM_OWNER_IDS', false);
  if (!ownerIds.size || (ownerIds.size === 1 && ownerIds.has(EXAMPLE_OWNER))) {
    throw new Error('invalid_owner_ids');
  }
  if (ownerIds.size !== 1) {
    throw new Error('version_one_requires_exactly_one_owner');
  }
  const minutes = Number(values.CLAUDE_TIMEOUT_MINUTES || 45);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    throw new Error('invalid_timeout_minutes');
  }
  const allowApiBilling = values.CLAUDE_ALLOW_API_BILLING === '1';
  return {
    ownerIds,
    timeoutMs: minutes * 60 * 1000,
    allowApiBilling,
    apiKeyDetected: Boolean(env.ANTHROPIC_API_KEY),
    unsupportedClaudeRoutingDetected: UNSUPPORTED_CLAUDE_ROUTING_KEYS
      .some((key) => Boolean(env[key])),
    telegramToken
  };
}

function loadConfig(rootDir, options = {}) {
  const envPath = options.envPath || path.join(rootDir, '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    throw new Error(`config_file_missing:${envPath}`, { cause: error });
  }
  const values = parseEnvFile(raw);
  if (values.TELEGRAM_BOT_TOKEN_DPAPI) {
    values.__DECRYPTED_TELEGRAM_TOKEN = unprotectDpapi(
      values.TELEGRAM_BOT_TOKEN_DPAPI,
      options.spawnSyncImpl
    );
  }
  const checked = requireValidConfig(values, options.processEnv || process.env);
  const workdir = path.resolve(rootDir, values.CLAUDE_WORKDIR || '.');
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new Error('claude_workdir_not_found');
  }
  return {
    telegramToken: checked.telegramToken,
    ownerIds: checked.ownerIds,
    allowedUserIds: checked.allowedUserIds,
    allowedChatIds: checked.allowedChatIds,
    expectedBotUsername: String(values.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
    claudeWorkdir: workdir,
    claudeBin: values.CLAUDE_BIN || '',
    claudeTimeoutMs: checked.timeoutMs,
    allowApiBilling: checked.allowApiBilling,
    apiKeyDetected: checked.apiKeyDetected,
    unsupportedClaudeRoutingDetected: checked.unsupportedClaudeRoutingDetected,
    dataDir: path.join(rootDir, 'data')
  };
}

module.exports = {
  ALLOWED_KEYS,
  EXAMPLE_OWNER,
  EXAMPLE_TOKEN,
  loadConfig,
  parseEnvFile,
  parseIds,
  requireValidConfig,
  unprotectDpapi
};
