'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./redact');

class Logger {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.throttleMs = options.throttleMs || 60_000;
    this.filePath = options.filePath || '';
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.lastWrites = new Map();
    this.suppressed = new Map();
  }

  emit(line) {
    if (!this.filePath) {
      process.stderr.write(line);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const lineBytes = Buffer.byteLength(line);
      const currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      if (currentBytes > 0 && currentBytes + lineBytes > this.maxBytes) {
        const rotatedPath = `${this.filePath}.1`;
        fs.rmSync(rotatedPath, { force: true });
        fs.renameSync(this.filePath, rotatedPath);
      }
      fs.appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        event: 'log_file_write_failed',
        error: redact(error.message)
      })}\n`);
      process.stderr.write(line);
    }
  }

  write(level, event, detail) {
    const key = `${level}:${event}`;
    const now = this.now();
    const previous = this.lastWrites.get(key);
    if (level !== 'info' && previous !== undefined && now - previous < this.throttleMs) {
      this.suppressed.set(key, (this.suppressed.get(key) || 0) + 1);
      return false;
    }
    this.lastWrites.set(key, now);
    const payload = {
      time: new Date().toISOString(),
      level,
      event: String(event || 'unknown')
    };
    const suppressed = this.suppressed.get(key) || 0;
    if (suppressed) {
      payload.suppressed = suppressed;
      this.suppressed.delete(key);
    }
    if (detail instanceof Error) {
      payload.error = redact(detail.message);
      payload.code = detail.code ? String(detail.code) : undefined;
    } else if (detail !== undefined) {
      payload.detail = redact(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    this.emit(`${JSON.stringify(payload)}\n`);
    return true;
  }

  info(event, detail) {
    this.write('info', event, detail);
  }

  warn(event, detail) {
    this.write('warn', event, detail);
  }

  error(event, detail) {
    this.write('error', event, detail);
  }
}

module.exports = { Logger };
