'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { redact } = require('./redact');
const { DEFAULT_MODEL, isSupportedEffort, isSupportedModel } = require('./models');
const childEnvAllowlist = require('../launcher/claude-env-allowlist.json');

const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_SKIPPED_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const VERSION_DIRECTORY_PATTERN = /^\d+\.\d+\.\d+$/;
const CHILD_ENV_ALLOWLIST = new Set(childEnvAllowlist.map((key) => key.toUpperCase()));
const UNSUPPORTED_CLAUDE_ROUTING_KEYS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_CERT_STORE'
]);

function existingFile(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch (error) {
    return null;
  }
}

function cliNearShim(shimPath) {
  const directory = path.dirname(shimPath);
  const packageRoot = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
  return [
    path.join(packageRoot, 'bin', 'claude.exe'),
    path.join(packageRoot, 'cli.js'),
    path.join(packageRoot, 'cli-wrapper.cjs')
  ].map(existingFile).find(Boolean) || null;
}

function nativeInstallCandidates(env = process.env) {
  const fixedCandidates = [];
  const versionedCandidates = [];
  if (env.USERPROFILE) {
    fixedCandidates.push(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  }
  const roots = [
    env.APPDATA && path.join(env.APPDATA, 'Claude', 'claude-code'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Claude', 'claude-code')
  ].filter(Boolean);
  for (const root of roots) {
    fixedCandidates.push(path.join(root, 'claude.exe'));
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && VERSION_DIRECTORY_PATTERN.test(entry.name));
      for (const entry of entries) {
        versionedCandidates.push({
          file: path.join(root, entry.name, 'claude.exe'),
          version: entry.name
        });
      }
    } catch (error) {
      continue;
    }
  }
  versionedCandidates.sort((left, right) =>
    right.version.localeCompare(left.version, undefined, { numeric: true }));
  return [...fixedCandidates, ...versionedCandidates.map((candidate) => candidate.file)];
}

function npmCliCandidates(env = process.env, spawnSyncImpl = spawnSync) {
  const candidates = [];
  if (env.APPDATA) {
    const packageRoot = path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    candidates.push(
      path.join(packageRoot, 'bin', 'claude.exe'),
      path.join(packageRoot, 'cli.js'),
      path.join(packageRoot, 'cli-wrapper.cjs')
    );
  }
  const npmRoot = spawnSyncImpl('npm.cmd', ['root', '-g'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env
  });
  if (!npmRoot.error && npmRoot.status === 0) {
    const packageRoot = path.join(String(npmRoot.stdout).trim(), '@anthropic-ai', 'claude-code');
    candidates.push(
      path.join(packageRoot, 'bin', 'claude.exe'),
      path.join(packageRoot, 'cli.js'),
      path.join(packageRoot, 'cli-wrapper.cjs')
    );
  }
  return candidates;
}

function commandSpecForFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return { command: process.execPath, prefixArgs: [file], source: file };
  }
  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    const cli = cliNearShim(file);
    if (!cli) return null;
    return commandSpecForFile(cli);
  }
  return { command: file, prefixArgs: [], source: file };
}

function verifyCommand(spec, spawnSyncImpl = spawnSync, env = process.env) {
  const result = spawnSyncImpl(spec.command, [...spec.prefixArgs, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: buildChildEnv(env, false)
  });
  return !result.error && result.status === 0;
}

function resolveClaudeCommand(configuredPath = '', options = {}) {
  const env = options.env || process.env;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  candidates.push(...nativeInstallCandidates(env), ...npmCliCandidates(env, spawnSyncImpl));
  const whereResult = spawnSyncImpl('where.exe', ['claude.exe', 'claude.cmd', 'claude'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env
  });
  if (!whereResult.error) candidates.push(...String(whereResult.stdout).split(/\r?\n/).filter(Boolean));

  for (const candidate of candidates) {
    const file = existingFile(candidate);
    if (!file) continue;
    const spec = commandSpecForFile(file);
    if (spec && (options.skipVerify || verifyCommand(spec, spawnSyncImpl, env))) return spec;
  }
  throw new Error('claude_not_found_or_not_runnable');
}

function buildChildEnv(source, allowApiBilling) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (CHILD_ENV_ALLOWLIST.has(key.toUpperCase()) && value !== undefined) {
      env[key] = value;
    }
  }
  const unsupportedRoutingDetected = UNSUPPORTED_CLAUDE_ROUTING_KEYS
    .some((key) => Boolean(source[key]));
  if (allowApiBilling && source.ANTHROPIC_API_KEY && !unsupportedRoutingDetected) {
    env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  }
  else delete env.ANTHROPIC_API_KEY;
  return env;
}

function classifyClaudeFailure(stderr) {
  const value = String(stderr || '').toLowerCase();
  if (/(not logged in|login required|authentication|unauthorized|oauth)/i.test(value)) return 'auth_failed';
  if (/(quota|usage limit|rate limit|capacity|credit balance)/i.test(value)) return 'quota_exceeded';
  if (/(network|timed? out|econn|dns|fetch failed|socket)/i.test(value)) return 'network_failed';
  if (/(?:effort|thinking level)[^\r\n]*(?:not available|unavailable|not supported|unsupported|invalid)|(?:not available|unavailable|not supported|unsupported|invalid)[^\r\n]*(?:effort|thinking level)/i.test(value)) {
    return 'effort_unavailable';
  }
  if (/(invalid|malformed|unexpected|parse).{0,40}json|json.{0,40}(invalid|malformed|unexpected|parse)/i.test(value)) {
    return 'claude_failed';
  }
  if (/model[^\r\n]*(?:not available|unavailable|not supported|unsupported)[^\r\n]*(?:subscription|plan|account|organization|workspace|entitlement)|(?:subscription|plan|account|organization|workspace)[^\r\n]*(?:does not include|doesn't include|not entitled|no access|cannot access)[^\r\n]*model|(?:do not|don't|does not|doesn't)\s+have access[^\r\n]*model/i.test(value)) {
    return 'model_unavailable';
  }
  return 'claude_failed';
}

function appendBounded(current, chunk, maximum = MAX_CAPTURE_BYTES) {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(String(chunk))]);
  if (combined.length <= maximum) return combined.toString('utf8');
  return `[TRUNCATED]${combined.subarray(combined.length - maximum).toString('utf8')}`;
}

function extractEventText(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'result' && typeof event.result === 'string') return event.result;
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text').map((part) => part.text || '').join('');
}

class ClaudeRunner {
  constructor({
    command,
    cwd,
    timeoutMs,
    allowApiBilling,
    logger,
    spawnImpl = spawn,
    diagnosticSpawnImpl = spawn,
    diagnosticTimeoutMs = 5_000
  }) {
    this.command = command;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.allowApiBilling = allowApiBilling;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.diagnosticSpawnImpl = diagnosticSpawnImpl;
    this.diagnosticTimeoutMs = diagnosticTimeoutMs;
    this.active = null;
  }

  isBusy() {
    return Boolean(this.active);
  }

  cancel(taskId) {
    if (!this.active || this.active.taskId !== taskId) return false;
    this.active.reason = 'cancelled';
    this.killTree(this.active.child);
    return true;
  }

  diagnose() {
    return new Promise((resolve) => {
      let child;
      let timer;
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ status });
      };
      try {
        child = this.diagnosticSpawnImpl(this.command.command, [
          ...this.command.prefixArgs,
          'auth',
          'status'
        ], {
          cwd: this.cwd,
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
          env: buildChildEnv(process.env, this.allowApiBilling)
        });
      } catch (error) {
        finish(error.code === 'ENOENT' ? 'not_found' : 'check_failed');
        return;
      }
      child.once('error', (error) => {
        finish(error.code === 'ENOENT' ? 'not_found' : 'check_failed');
      });
      child.once('close', (code) => {
        finish(code === 0 ? 'authenticated' : 'not_authenticated');
      });
      timer = setTimeout(() => {
        finish('timeout');
        try {
          child.kill();
        } catch (error) {
          this.logger.warn('claude_diagnostic_kill_failed', error);
        }
      }, this.diagnosticTimeoutMs);
    });
  }

  killTree(child) {
    if (!child || !child.pid) return;
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.on('error', (error) => {
      this.logger.warn('taskkill_failed', error);
      try {
        child.kill();
      } catch (killError) {
        this.logger.warn('child_kill_failed', killError);
      }
    });
  }

  async run({
    prompt,
    sessionId,
    unsafe,
    taskId,
    onActivity,
    model = DEFAULT_MODEL,
    approvalContext = null,
    effort = null
  }) {
    if (this.active) throw new Error('runner_busy');
    if (!isSupportedModel(model)) throw new Error('invalid_model');
    if (effort !== null && !isSupportedEffort(effort)) throw new Error('invalid_effort');
    if (!unsafe && (!approvalContext || typeof approvalContext.mcpConfig !== 'string' ||
        !approvalContext.mcpConfig || !approvalContext.env ||
        typeof approvalContext.env.CC_BRIDGE_APPROVAL_PIPE !== 'string' ||
        !approvalContext.env.CC_BRIDGE_APPROVAL_PIPE ||
        typeof approvalContext.env.CC_BRIDGE_APPROVAL_SECRET !== 'string' ||
        !approvalContext.env.CC_BRIDGE_APPROVAL_SECRET)) {
      throw new Error('approval_context_required');
    }
    const chosenSession = sessionId || crypto.randomUUID();
    const args = [
      ...this.command.prefixArgs,
      '--model', model,
      ...(effort ? ['--effort', effort] : []),
      '--output-format', 'stream-json',
      '--verbose',
      ...(sessionId ? ['--resume', sessionId] : ['--session-id', chosenSession]),
      ...(!unsafe ? [
        '--mcp-config', approvalContext.mcpConfig,
        '--strict-mcp-config',
        '--permission-mode', 'manual',
        '--permission-prompt-tool', 'mcp__cc_bridge_approval__decide'
      ] : []),
      ...(unsafe ? ['--dangerously-skip-permissions'] : []),
      '-p'
    ];
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(this.command.command, args, {
          cwd: this.cwd,
          env: {
            ...buildChildEnv(process.env, this.allowApiBilling),
            ...(!unsafe ? approvalContext.env : {})
          },
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        resolve({ ok: false, reason: 'spawn_failed', text: 'تعذّر تشغيل كلود كود. تأكد من تثبيته ثم أعد المحاولة.' });
        return;
      }

      this.active = { child, taskId, reason: null };
      let stdoutBuffer = Buffer.alloc(0);
      let stderr = '';
      let assistantText = '';
      let finalResultText = '';
      let observedSession = chosenSession;
      let skipBytes = 0;
      let skippingLargeLine = false;
      let finalized = false;
      let exitTimer = null;

      const finalize = (code, signal, error) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(absoluteTimer);
        if (exitTimer) clearTimeout(exitTimer);
        const activeReason = this.active?.reason;
        const outputText = finalResultText || assistantText;
        this.active = null;
        if (error) {
          this.logger.error('claude_spawn_error', error);
          resolve({ ok: false, reason: 'spawn_failed', text: 'تعذّر تشغيل كلود كود. تأكد من التثبيت والمسار ثم أعد المحاولة.' });
          return;
        }
        if (activeReason === 'cancelled') {
          resolve({ ok: false, reason: 'cancelled', text: outputText, sessionId: observedSession });
          return;
        }
        if (activeReason === 'timeout') {
          resolve({ ok: false, reason: 'timeout', text: outputText, sessionId: observedSession });
          return;
        }
        if (activeReason === 'oversized_output') {
          resolve({ ok: false, reason: 'oversized_output', text: outputText, sessionId: observedSession });
          return;
        }
        if (code !== 0) {
          const reason = classifyClaudeFailure(`${stderr}\n${outputText}`);
          this.logger.warn('claude_process_failed', `${reason}:${redact(stderr).slice(0, 500)}`);
          resolve({
            ok: false,
            reason,
            text: reason === 'model_unavailable' ? '' : outputText,
            sessionId: observedSession
          });
          return;
        }
        resolve({
          ok: true,
          text: outputText || 'خلصت المهمة، لكن ما رجع جواب نصّي.',
          sessionId: observedSession,
          skippedLargeEvents: skipBytes > 0
        });
      };

      const consumeLine = (lineBuffer) => {
        if (!lineBuffer.length) return;
        if (lineBuffer.length > MAX_EVENT_LINE_BYTES) {
          skipBytes += lineBuffer.length;
          onActivity('تجاوزت جزءاً ضخماً من المخرجات وكملت المهمة.');
          return;
        }
        try {
          const event = JSON.parse(lineBuffer.toString('utf8'));
          if (event.session_id) observedSession = String(event.session_id);
          const text = extractEventText(event);
          if (text && event.type === 'result') finalResultText = appendBounded(finalResultText, text);
          else if (text) assistantText = appendBounded(assistantText, text);
          if (event.type === 'assistant') onActivity('أكتب الجواب الآن.');
        } catch (error) {
          this.logger.warn('claude_event_parse_failed', error);
        }
      };

      child.stdout.on('data', (chunk) => {
        let remaining = Buffer.from(chunk);
        while (remaining.length) {
          if (skippingLargeLine) {
            const newline = remaining.indexOf(0x0a);
            if (newline === -1) {
              skipBytes += remaining.length;
              remaining = Buffer.alloc(0);
            } else {
              skipBytes += newline + 1;
              remaining = remaining.subarray(newline + 1);
              skippingLargeLine = false;
              onActivity('تجاوزت جزءاً ضخماً من المخرجات وكملت المهمة.');
            }
          } else {
            stdoutBuffer = Buffer.concat([stdoutBuffer, remaining]);
            remaining = Buffer.alloc(0);
            let newline = stdoutBuffer.indexOf(0x0a);
            while (newline !== -1) {
              consumeLine(stdoutBuffer.subarray(0, newline));
              stdoutBuffer = stdoutBuffer.subarray(newline + 1);
              newline = stdoutBuffer.indexOf(0x0a);
            }
            if (stdoutBuffer.length > MAX_EVENT_LINE_BYTES) {
              skipBytes += stdoutBuffer.length;
              stdoutBuffer = Buffer.alloc(0);
              skippingLargeLine = true;
            }
          }
          if (skipBytes > MAX_SKIPPED_EVENT_BYTES && this.active) {
            this.active.reason = 'oversized_output';
            this.killTree(child);
            break;
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendBounded(stderr, chunk, 64 * 1024);
      });
      child.on('error', (error) => finalize(null, null, error));
      child.on('exit', (code, signal) => {
        exitTimer = setTimeout(() => finalize(code, signal), 250);
      });
      child.on('close', (code, signal) => finalize(code, signal));

      const absoluteTimer = setTimeout(() => {
        if (!this.active) return;
        this.active.reason = 'timeout';
        this.killTree(child);
        setTimeout(() => finalize(null, 'SIGKILL'), 3000);
      }, this.timeoutMs);
      absoluteTimer.unref?.();

      try {
        child.stdin.end(String(prompt));
      } catch (error) {
        this.logger.warn('claude_stdin_failed', error);
        finalize(null, null, error);
      }
    });
  }
}

module.exports = {
  ClaudeRunner,
  MAX_EVENT_LINE_BYTES,
  MAX_SKIPPED_EVENT_BYTES,
  UNSUPPORTED_CLAUDE_ROUTING_KEYS,
  appendBounded,
  buildChildEnv,
  classifyClaudeFailure,
  commandSpecForFile,
  extractEventText,
  resolveClaudeCommand,
  verifyCommand
};
