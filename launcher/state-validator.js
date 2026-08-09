'use strict';

const fs = require('node:fs');
const { normalizeState } = require('../src/store');

const candidatePath = process.argv[2];
if (!candidatePath) {
  process.stderr.write('state_validator_path_required\n');
  process.exit(2);
}

try {
  normalizeState(JSON.parse(fs.readFileSync(candidatePath, 'utf8')));
  process.stdout.write('valid\n');
} catch (error) {
  process.stderr.write(`${error.code || 'invalid_state'}\n`);
  process.exit(1);
}
