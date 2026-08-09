'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXAMPLE_TOKEN,
  parseEnvFile,
  requireValidConfig
} = require('../src/config');

function validValues() {
  return {
    TELEGRAM_BOT_TOKEN: '987654321:AARealShapedButSyntheticToken_abcdefghijk',
    TELEGRAM_OWNER_IDS: '987654321',
    CLAUDE_TIMEOUT_MINUTES: '45',
    CLAUDE_ALLOW_API_BILLING: '0'
  };
}

test('parses UTF-8 BOM, CRLF, comments, and quoted values', () => {
  const parsed = parseEnvFile('\uFEFF# comment\r\nTELEGRAM_OWNER_IDS="987654321"\r\n');
  assert.equal(parsed.TELEGRAM_OWNER_IDS, '987654321');
});

test('rejects unknown configuration keys instead of swallowing them', () => {
  assert.throws(() => parseEnvFile('TELEGRAM_OWNER_IDS=987654321\nMISSPELLED_KEY=x\n'), /unknown_config_keys/);
});

test('rejects a plaintext bot token key from persisted configuration', () => {
  assert.throws(() => parseEnvFile(
    'TELEGRAM_BOT_TOKEN=987654321:AARealShapedButSyntheticToken_abcdefghijk\n'
  ), /unknown_config_keys/);
});

test('rejects the safe-looking example token', () => {
  const values = validValues();
  values.TELEGRAM_BOT_TOKEN = EXAMPLE_TOKEN;
  assert.throws(() => requireValidConfig(values, {}), /invalid_telegram_token/);
});

test('rejects non-numeric owner identifiers', () => {
  const values = validValues();
  values.TELEGRAM_OWNER_IDS = 'not-a-number';
  assert.throws(() => requireValidConfig(values, {}), /invalid_numeric_ids/);
});

test('accepts exactly one numeric owner for the owner-only first release', () => {
  const result = requireValidConfig(validValues(), {});
  assert.deepEqual([...result.ownerIds], ['987654321']);
  const multiple = validValues();
  multiple.TELEGRAM_OWNER_IDS = '987654321,111222333';
  assert.throws(() => requireValidConfig(multiple, {}), /version_one_requires_exactly_one_owner/);
  assert.throws(() => parseEnvFile(
    'TELEGRAM_OWNER_IDS=987654321\nTELEGRAM_ALLOWED_USER_IDS=111222333\n'
  ), /unknown_config_keys:TELEGRAM_ALLOWED_USER_IDS/);
});
