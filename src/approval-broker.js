'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { isAbsolutePrivatePath, redact } = require('./redact');

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const SUMMARY_LIMIT = 500;
const CALLBACK_PATTERN = /^ap:([A-Za-z0-9_-]{8,24}):(a|d)$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shortRandomId(randomBytes = crypto.randomBytes) {
  return randomBytes(9).toString('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requestFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify({
    requestId: request.requestId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    input: request.input
  })).digest('base64url');
}

function operationName(toolName) {
  const names = {
    Write: 'إنشاء أو تعديل ملف',
    Edit: 'تعديل ملف',
    MultiEdit: 'تعديل عدة ملفات',
    Bash: 'تشغيل أمر على الجهاز',
    WebFetch: 'الوصول إلى رابط ويب',
    WebSearch: 'البحث في الويب',
    NotebookEdit: 'تعديل دفتر برمجي'
  };
  const rawName = String(toolName || '');
  const cleanName = rawName
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 64);
  return names[rawName] || `استخدام أداة ${cleanName || 'غير معروفة'}`;
}

function cleanInline(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function redactApprovalValue(key, value) {
  const rendered = String(value ?? '');
  if (['file_path', 'path', 'notebook_path'].includes(key) && isAbsolutePrivatePath(rendered)) {
    const basename = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(rendered)
      ? path.win32.basename(rendered)
      : path.posix.basename(rendered);
    const safeBasename = cleanInline(redact(basename));
    return safeBasename ? `<REDACTED_PATH>/${safeBasename}` : '<REDACTED_PATH>';
  }
  return redact(rendered);
}

function requestSummaryDetails(toolName, input, limit = SUMMARY_LIMIT) {
  const safeInput = isPlainObject(input) ? input : {};
  const preferredKeys = [
    'file_path', 'path', 'command', 'url', 'query', 'pattern', 'description',
    'notebook_path', 'old_string', 'new_string'
  ];
  const parts = [];
  for (const key of preferredKeys) {
    if (!Object.hasOwn(safeInput, key)) continue;
    const value = typeof safeInput[key] === 'string'
      ? safeInput[key]
      : JSON.stringify(safeInput[key]);
    if (value) parts.push(`${key}: ${cleanInline(redactApprovalValue(key, value))}`);
    if (parts.length >= 3) break;
  }
  if (!parts.length) {
    for (const [key, value] of Object.entries(safeInput).slice(0, 3)) {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      const safeKey = cleanInline(key).slice(0, 64) || 'field';
      if (rendered) parts.push(`${safeKey}: ${cleanInline(redactApprovalValue(safeKey, rendered))}`);
    }
  }
  const summary = cleanInline(parts.join(' | ') || `طلب من الأداة ${operationName(toolName)}`);
  if (summary.length <= limit) {
    return { text: summary, truncated: false, originalLength: summary.length, fingerprint: null };
  }
  const fingerprint = crypto.createHash('sha256').update(summary).digest('hex').slice(0, 12);
  return {
    text: `⚠️ تفاصيل الطلب طويلة (${summary.length} محرفًا؛ البصمة ${fingerprint}) ولا يمكن عرضها كاملة بأمان. سيُرفض الطلب؛ قسّم العملية وأعد المحاولة.`,
    truncated: true,
    originalLength: summary.length,
    fingerprint
  };
}

function summarizeRequest(toolName, input, limit = SUMMARY_LIMIT) {
  return requestSummaryDetails(toolName, input, limit).text;
}

function approvalKeyboard(approvalId) {
  return {
    inline_keyboard: [[
      { text: '✅ موافق', callback_data: `ap:${approvalId}:a` },
      { text: '❌ ارفض', callback_data: `ap:${approvalId}:d` }
    ]]
  };
}

function finalApprovalText(record, finalState) {
  return [
    '🛡️ طلب موافقة من كلود',
    `العملية: ${record.operation}`,
    `التفاصيل: ${record.summary}`,
    '',
    finalState
  ].join('\n');
}

class ApprovalBroker {
  constructor({
    telegram,
    logger,
    timeoutMs = APPROVAL_TIMEOUT_MS,
    randomBytes = crypto.randomBytes,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    this.telegram = telegram;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.randomBytes = randomBytes;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.tasks = new Map();
    this.pending = new Map();
  }

  async beginTask({ taskId, chatId, ownerId }) {
    const key = String(taskId || '');
    if (!key || this.tasks.has(key)) throw new Error('approval_task_invalid_or_duplicate');
    const context = {
      taskId: key,
      chatId: String(chatId),
      ownerId: String(ownerId),
      secret: shortRandomId(this.randomBytes) + shortRandomId(this.randomBytes),
      requestKeys: new Map(),
      resolvedRequestKeys: new Set(),
      sockets: new Set(),
      closed: false,
      server: null,
      pipeName: process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-telegram-approval-${process.pid}-${shortRandomId(this.randomBytes)}`
        : `\0cc-telegram-approval-${process.pid}-${shortRandomId(this.randomBytes)}`
    };
    const server = net.createServer((socket) => this.handleSocket(context, socket));
    context.server = server;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(context.pipeName);
    });
    server.unref?.();
    this.tasks.set(key, context);
    return {
      mcpConfig: JSON.stringify({
        mcpServers: {
          cc_bridge_approval: {
            command: process.execPath,
            args: [__filename]
          }
        }
      }),
      env: {
        CC_BRIDGE_APPROVAL_PIPE: context.pipeName,
        CC_BRIDGE_APPROVAL_SECRET: context.secret,
        CC_BRIDGE_APPROVAL_TIMEOUT_MS: String(this.timeoutMs)
      }
    };
  }

  handleSocket(context, socket) {
    if (context.closed) {
      socket.destroy();
      return;
    }
    context.sockets.add(socket);
    let buffer = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) socket.destroy();
        return;
      }
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        this.logger.warn('approval_ipc_invalid_json');
        socket.end(`${JSON.stringify({ decision: 'deny', message: 'Invalid approval request.' })}\n`);
        return;
      }
      if (!safeEqual(request.secret, context.secret)) {
        this.logger.warn('approval_ipc_auth_rejected');
        socket.end(`${JSON.stringify({ decision: 'deny', message: 'Approval broker rejected the request.' })}\n`);
        return;
      }
      this.requestPermission(context.taskId, request).then((decision) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
      }).catch((error) => {
        this.logger.warn('approval_request_failed', error);
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify({ decision: 'deny', message: 'Approval broker failed closed.' })}\n`);
        }
      });
    });
    socket.on('error', (error) => this.logger.warn('approval_ipc_socket_failed', error));
    socket.on('close', () => context.sockets.delete(socket));
  }

  requestPermission(taskId, request) {
    const context = this.tasks.get(String(taskId));
    if (!context || context.closed) {
      return Promise.resolve({ decision: 'deny', message: 'Approval task is no longer active.' });
    }
    const toolUseId = String(request.toolUseId || '');
    const toolName = String(request.toolName || '');
    if (!['number', 'string'].includes(typeof request.requestId) ||
        !toolUseId || !TOOL_NAME_PATTERN.test(toolName) || !isPlainObject(request.input)) {
      return Promise.resolve({ decision: 'deny', message: 'Malformed permission request.' });
    }
    const summaryDetails = requestSummaryDetails(toolName, request.input);
    if (summaryDetails.truncated) {
      return Promise.resolve({
        decision: 'deny',
        message: `Permission request details are ${summaryDetails.originalLength} characters and cannot be displayed safely. Split the request and retry. Fingerprint: ${summaryDetails.fingerprint}.`
      });
    }
    const requestKey = `${context.taskId}:${toolUseId}`;
    const fingerprint = requestFingerprint({ ...request, toolUseId, toolName });
    const existingId = context.requestKeys.get(requestKey);
    if (existingId) {
      const existing = this.pending.get(existingId);
      return existing?.fingerprint === fingerprint
        ? existing.promise
        : Promise.resolve({ decision: 'deny', message: 'Permission request identity conflict.' });
    }
    if (context.resolvedRequestKeys.has(requestKey)) {
      return Promise.resolve({ decision: 'deny', message: 'Permission request was already resolved.' });
    }

    let approvalId;
    do approvalId = shortRandomId(this.randomBytes);
    while (this.pending.has(approvalId));
    let resolveDecision;
    const promise = new Promise((resolve) => { resolveDecision = resolve; });
    const record = {
      approvalId,
      taskId: context.taskId,
      chatId: context.chatId,
      ownerId: context.ownerId,
      requestId: request.requestId,
      toolUseId,
      toolName,
      input: request.input,
      fingerprint,
      operation: operationName(toolName),
      summary: summaryDetails.text,
      messageId: null,
      resolveDecision,
      promise,
      timer: null,
      settled: false,
      finalState: null,
      finalEdited: false
    };
    context.requestKeys.set(requestKey, approvalId);
    this.pending.set(approvalId, record);
    record.timer = this.setTimeoutImpl(() => {
      this.settle(record, 'deny', 'انتهت المهلة، وتم الرفض تلقائيًا.', 'Permission request timed out.');
    }, this.timeoutMs);
    record.timer.unref?.();

    const text = [
      '🛡️ كلود يطلب موافقتك',
      `العملية: ${record.operation}`,
      `التفاصيل: ${record.summary}`,
      '',
      'تنتهي الموافقة خلال 10 دقائق.'
    ].join('\n');
    Promise.resolve(this.telegram.sendText(record.chatId, text, {
      reply_markup: approvalKeyboard(record.approvalId)
    })).then((result) => {
      record.messageId = result?.message_id ?? null;
      if (record.settled) this.editFinalMessage(record);
    }).catch((error) => {
      this.logger.warn('approval_message_failed', error);
      this.settle(record, 'deny', null, 'Approval message could not be delivered.');
    });
    return promise;
  }

  async decideCallback(callbackData, { taskId, chatId, ownerId }) {
    const match = String(callbackData || '').match(CALLBACK_PATTERN);
    if (!match) return { handled: false };
    const record = this.pending.get(match[1]);
    if (!record) return { handled: true, accepted: false, status: 'stale' };
    if (record.taskId !== String(taskId || '') ||
        record.chatId !== String(chatId) || record.ownerId !== String(ownerId)) {
      return { handled: true, accepted: false, status: 'identity_mismatch' };
    }
    const decision = match[2] === 'a' ? 'allow' : 'deny';
    const accepted = this.settle(
      record,
      decision,
      decision === 'allow' ? '✅ تمت الموافقة.' : '❌ تم الرفض.',
      decision === 'allow' ? 'Approved by the paired owner.' : 'Denied by the paired owner.'
    );
    return { handled: true, accepted, status: decision };
  }

  settle(record, decision, finalState, message) {
    if (!record || record.settled || !this.pending.has(record.approvalId)) return false;
    record.settled = true;
    record.finalState = finalState;
    this.pending.delete(record.approvalId);
    this.clearTimeoutImpl(record.timer);
    const context = this.tasks.get(record.taskId);
    const requestKey = `${record.taskId}:${record.toolUseId}`;
    context?.requestKeys.delete(requestKey);
    context?.resolvedRequestKeys.add(requestKey);
    record.resolveDecision({ decision, message });
    this.editFinalMessage(record);
    return true;
  }

  editFinalMessage(record) {
    if (!record.finalState || record.finalEdited || record.messageId === null ||
        !this.telegram.editText) return;
    record.finalEdited = true;
    Promise.resolve(this.telegram.editText(
      record.chatId,
      record.messageId,
      finalApprovalText(record, record.finalState),
      { reply_markup: { inline_keyboard: [] } }
    )).catch((error) => {
      record.finalEdited = false;
      this.logger.warn('approval_message_edit_failed', error);
    });
  }

  cancelTask(taskId, finalState = '⏹ أُلغيت المهمة، وتم رفض الطلب تلقائيًا.') {
    const key = String(taskId || '');
    const context = this.tasks.get(key);
    if (!context) return 0;
    context.closed = true;
    let count = 0;
    for (const record of [...this.pending.values()]) {
      if (record.taskId === key && this.settle(record, 'deny', finalState, 'Task stopped before approval.')) {
        count += 1;
      }
    }
    context.server?.close();
    context.server?.unref?.();
    this.tasks.delete(key);
    return count;
  }

  shutdown() {
    let count = 0;
    for (const taskId of [...this.tasks.keys()]) {
      count += this.cancelTask(taskId, '🛑 توقف الجسر، وتم رفض الطلب تلقائيًا.');
    }
    return count;
  }
}

function denyPayload(message) {
  return { behavior: 'deny', message: String(message || 'Permission denied.') };
}

function requestParentDecision(request) {
  return new Promise((resolve) => {
    const pipeName = process.env.CC_BRIDGE_APPROVAL_PIPE;
    const secret = process.env.CC_BRIDGE_APPROVAL_SECRET;
    const timeoutMs = Math.max(1, Number(process.env.CC_BRIDGE_APPROVAL_TIMEOUT_MS || APPROVAL_TIMEOUT_MS));
    if (!pipeName || !secret) {
      resolve({ decision: 'deny', message: 'Approval broker is unavailable.' });
      return;
    }
    let settled = false;
    let buffer = '';
    const socket = net.createConnection(pipeName);
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => {
      finish({ decision: 'deny', message: 'Approval broker timed out.' });
    }, timeoutMs + 5_000);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ ...request, secret })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish(response?.decision === 'allow'
          ? { decision: 'allow', message: response.message }
          : { decision: 'deny', message: response?.message || 'Permission denied.' });
      } catch (error) {
        finish({ decision: 'deny', message: 'Approval broker returned invalid data.' });
      }
    });
    socket.once('error', () => finish({ decision: 'deny', message: 'Approval broker connection failed.' }));
    socket.once('close', () => finish({ decision: 'deny', message: 'Approval broker connection closed.' }));
  });
}

function sendMcp(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function runPermissionPromptServer() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      return;
    }
    if (request.method === 'initialize') {
      sendMcp({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'cc-telegram-approval', version: '1.0.0' }
        }
      });
      return;
    }
    if (request.method === 'tools/list') {
      sendMcp({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{
            name: 'decide',
            description: 'Ask the paired Telegram owner to allow or deny one Claude tool request.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
                permission_suggestions: { type: 'array' },
                blocked_path: { type: 'string' }
              },
              required: ['tool_name', 'input'],
              additionalProperties: true
            }
          }]
        }
      });
      return;
    }
    if (request.method === 'tools/call') {
      const argumentsValue = request.params?.arguments;
      const toolUseId = argumentsValue?.tool_use_id || request.params?._meta?.['claudecode/toolUseId'];
      let payload = denyPayload('Malformed permission request.');
      if (request.params?.name === 'decide' && typeof toolUseId === 'string' &&
          typeof argumentsValue?.tool_name === 'string' &&
          TOOL_NAME_PATTERN.test(argumentsValue.tool_name) && isPlainObject(argumentsValue.input)) {
        const response = await requestParentDecision({
          requestId: request.id,
          toolUseId,
          toolName: argumentsValue.tool_name,
          input: argumentsValue.input
        });
        payload = response.decision === 'allow'
          ? { behavior: 'allow', updatedInput: argumentsValue.input }
          : denyPayload(response.message);
      }
      sendMcp({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      });
      return;
    }
    if (Object.hasOwn(request, 'id')) {
      sendMcp({ jsonrpc: '2.0', id: request.id, result: {} });
    }
  });
}

if (require.main === module) runPermissionPromptServer();

module.exports = {
  APPROVAL_TIMEOUT_MS,
  ApprovalBroker,
  CALLBACK_PATTERN,
  SUMMARY_LIMIT,
  TOOL_NAME_PATTERN,
  approvalKeyboard,
  operationName,
  runPermissionPromptServer,
  summarizeRequest
};
