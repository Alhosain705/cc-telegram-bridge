'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./src/config');
const { Logger } = require('./src/logger');
const { JsonStore, StateCorruptionError } = require('./src/store');
const { TelegramClient } = require('./src/telegram');
const { ClaudeRunner, resolveClaudeCommand } = require('./src/runner');
const { Bridge } = require('./src/bridge');
const { ApprovalBroker } = require('./src/approval-broker');
const {
  RESTART_EXIT_CODE,
  STATE_CORRUPTION_EXIT_CODE,
  writeRestartMarker
} = require('./src/lifecycle');

async function main() {
  const rootDir = __dirname;
  const logger = new Logger({ filePath: path.join(rootDir, 'logs', 'bridge.log') });
  const config = loadConfig(rootDir);
  const command = resolveClaudeCommand(config.claudeBin);
  const store = new JsonStore(path.join(config.dataDir, 'state.json'), logger);
  const telegram = new TelegramClient(config.telegramToken, logger);
  const approvalBroker = new ApprovalBroker({ telegram, logger });
  const runner = new ClaudeRunner({
    command,
    cwd: config.claudeWorkdir,
    timeoutMs: config.claudeTimeoutMs,
    allowApiBilling: config.allowApiBilling,
    logger
  });
  const readyPath = path.join(config.dataDir, 'bridge.ready');
  const restartPath = path.join(config.dataDir, 'bridge.restart');
  const bridge = new Bridge({
    config,
    store,
    telegram,
    runner,
    approvalBroker,
    logger,
    onRestart: () => {
      writeRestartMarker(restartPath);
      process.exit(RESTART_EXIT_CODE);
    },
    onReady: () => {
      const temporary = `${readyPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({
        pid: process.pid,
        readyAt: new Date().toISOString()
      })}\n`, { mode: 0o600 });
      fs.renameSync(temporary, readyPath);
    }
  });
  await bridge.start();
}

main().catch((error) => {
  const logger = new Logger({ filePath: path.join(__dirname, 'logs', 'bridge.log') });
  logger.error('startup_failed', error);
  process.stderr.write('Bridge startup failed. Check .env and the structured error above.\n');
  process.exitCode = error instanceof StateCorruptionError || error?.code === 'state_corrupted'
    ? STATE_CORRUPTION_EXIT_CODE
    : 1;
});
