'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESTART_EXIT_CODE = 75;
const STATE_CORRUPTION_EXIT_CODE = 78;
const RESTART_ACTION = 'restart_bridge_after_update_confirmation';

function writeRestartMarker(markerPath, options = {}) {
  const pid = Number(options.pid || process.pid);
  const requestedAt = options.requestedAt || new Date().toISOString();
  const temporary = `${markerPath}.${pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ pid, requestedAt })}\n`, 'utf8');
  fs.rmSync(markerPath, { force: true });
  fs.renameSync(temporary, markerPath);
}

module.exports = {
  RESTART_ACTION,
  RESTART_EXIT_CODE,
  STATE_CORRUPTION_EXIT_CODE,
  writeRestartMarker
};
