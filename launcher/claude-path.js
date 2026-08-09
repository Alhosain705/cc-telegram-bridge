'use strict';

const { resolveClaudeCommand } = require('../src/runner');

try {
  const spec = resolveClaudeCommand(process.argv[2] || '');
  process.stdout.write(JSON.stringify(spec));
} catch (error) {
  process.stderr.write('claude_not_found\n');
  process.exitCode = 2;
}
