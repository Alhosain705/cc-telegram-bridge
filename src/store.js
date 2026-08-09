'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_MODEL, isSupportedEffort, isSupportedModel } = require('./models');

const OUTBOX_MAX_ITEMS = 500;
const OUTBOX_MAX_ATOMIC_ITEMS = 600;
const OUTBOX_MAX_RECORDS = OUTBOX_MAX_ITEMS + OUTBOX_MAX_ATOMIC_ITEMS;
const OUTBOX_DEAD_LETTER_MAX_ITEMS = 50;
const OUTBOX_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1000;
const STATE_READ_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800]);

const EMPTY_STATE = Object.freeze({
  pairedUsers: [],
  permissions: {},
  models: {},
  efforts: {},
  sessions: {},
  sessionGenerations: {},
  updateOffset: 0,
  processedUpdates: [],
  pairing: null,
  pairingAttempts: {},
  restartRequest: null,
  outbox: [],
  outboxDeadLetters: []
});

class StateCorruptionError extends Error {
  constructor(filePath, quarantinePath, cause) {
    super('ملف حالة الجسر تالف، لذلك توقف الجسر لحماية الربط والذاكرة. افتح START.cmd واضغط «استعادة الحالة» لاسترجاع آخر نسخة سليمة.');
    this.name = 'StateCorruptionError';
    this.code = 'state_corrupted';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
    this.cause = cause;
  }
}

class StateAccessError extends Error {
  constructor(filePath, cause, code = 'state_read_temporarily_unavailable') {
    super('تعذّر الوصول إلى ملف حالة الجسر الآن، لكن ما اعتبرناه تالفاً. أغلق مؤقتاً برنامج النسخ الاحتياطي أو الفهرسة أو الحماية الذي قد يمسك الملف، انتظر دقيقة، ثم افتح START.cmd من جديد واضغط «تشخيص» إذا تكرر الخطأ.');
    this.name = 'StateAccessError';
    this.code = code;
    this.filePath = filePath;
    this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(field) {
  const error = new Error(`invalid_state_schema:${field}`);
  error.code = 'invalid_state_schema';
  return error;
}

function optionalObject(parsed, field) {
  if (parsed[field] === undefined) return {};
  if (!isPlainObject(parsed[field])) throw schemaError(field);
  return parsed[field];
}

function optionalArray(parsed, field) {
  if (parsed[field] === undefined) return [];
  if (!Array.isArray(parsed[field])) throw schemaError(field);
  return parsed[field];
}

function normalizeUpdateId(updateId) {
  if (typeof updateId === 'string' && !/^\d+$/.test(updateId)) {
    throw new TypeError('invalid_update_id');
  }
  if (!['number', 'string'].includes(typeof updateId)) {
    throw new TypeError('invalid_update_id');
  }
  const numericId = Number(updateId);
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    throw new TypeError('invalid_update_id');
  }
  return numericId;
}

function validateOutboxRecord(item, index) {
  if (!isPlainObject(item)) throw schemaError(`outbox[${index}]`);
  for (const field of ['id', 'idempotencyKey', 'chatId', 'text']) {
    if (typeof item[field] !== 'string' || !item[field]) {
      throw schemaError(`outbox[${index}].${field}`);
    }
  }
  if (!['pending', 'delivered'].includes(item.status)) {
    throw schemaError(`outbox[${index}].status`);
  }
  if (!Number.isSafeInteger(Number(item.attempts || 0)) || Number(item.attempts || 0) < 0) {
    throw schemaError(`outbox[${index}].attempts`);
  }
  if (!Number.isFinite(Date.parse(item.createdAt || ''))) {
    throw schemaError(`outbox[${index}].createdAt`);
  }
  const envelopeId = item.envelopeId === undefined ? item.id : item.envelopeId;
  const sequence = item.sequence === undefined ? 1 : Number(item.sequence);
  const total = item.total === undefined ? 1 : Number(item.total);
  if (typeof envelopeId !== 'string' || !envelopeId) {
    throw schemaError(`outbox[${index}].envelopeId`);
  }
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(total) ||
      sequence < 1 || total < 1 || sequence > total) {
    throw schemaError(`outbox[${index}].sequence`);
  }
  return {
    ...item,
    id: item.id,
    idempotencyKey: item.idempotencyKey,
    chatId: item.chatId,
    text: item.text,
    extra: isPlainObject(item.extra) ? item.extra : {},
    status: item.status,
    attempts: Number(item.attempts || 0),
    nextAttemptAt: Number(item.nextAttemptAt || 0),
    createdAt: item.createdAt,
    envelopeId,
    sequence,
    total
  };
}

function normalizeState(parsed) {
  if (!isPlainObject(parsed)) throw schemaError('root');
  const pairedUsers = optionalArray(parsed, 'pairedUsers');
  if (pairedUsers.some((item) => !/^\d+$/.test(String(item)))) {
    throw schemaError('pairedUsers');
  }
  const permissions = optionalObject(parsed, 'permissions');
  if (Object.values(permissions).some((mode) => !['safe', 'free'].includes(mode))) {
    throw schemaError('permissions');
  }
  const models = optionalObject(parsed, 'models');
  if (Object.values(models).some((model) => !isSupportedModel(model))) {
    throw schemaError('models');
  }
  const efforts = optionalObject(parsed, 'efforts');
  if (Object.values(efforts).some((effort) => !isSupportedEffort(effort))) {
    throw schemaError('efforts');
  }
  const sessions = optionalObject(parsed, 'sessions');
  if (Object.values(sessions).some((session) => typeof session !== 'string')) {
    throw schemaError('sessions');
  }
  const sessionGenerations = optionalObject(parsed, 'sessionGenerations');
  if (Object.values(sessionGenerations).some((generation) =>
    !Number.isSafeInteger(Number(generation)) || Number(generation) < 0)) {
    throw schemaError('sessionGenerations');
  }
  const updateOffset = parsed.updateOffset === undefined ? 0 : Number(parsed.updateOffset);
  if (!Number.isSafeInteger(updateOffset) || updateOffset < 0) {
    throw schemaError('updateOffset');
  }
  const processedUpdates = optionalArray(parsed, 'processedUpdates');
  let normalizedProcessedUpdates;
  try {
    normalizedProcessedUpdates = processedUpdates.map(normalizeUpdateId).map(String);
  } catch (error) {
    throw schemaError('processedUpdates');
  }
  const pairingAttempts = optionalObject(parsed, 'pairingAttempts');
  if (Object.values(pairingAttempts).some((attempts) =>
    !Array.isArray(attempts) || attempts.some((timestamp) => !Number.isFinite(Number(timestamp))))) {
    throw schemaError('pairingAttempts');
  }
  if (parsed.pairing !== undefined && parsed.pairing !== null && !isPlainObject(parsed.pairing)) {
    throw schemaError('pairing');
  }
  const restartRequest = parsed.restartRequest === undefined ? null : parsed.restartRequest;
  if (restartRequest !== null &&
      (!isPlainObject(restartRequest) ||
       !/^\d+$/.test(String(restartRequest.chatId || '')) ||
       !Number.isFinite(Date.parse(restartRequest.requestedAt || '')))) {
    throw schemaError('restartRequest');
  }
  const outbox = optionalArray(parsed, 'outbox').map(validateOutboxRecord);
  const outboxDeadLetters = optionalArray(parsed, 'outboxDeadLetters');
  if (outboxDeadLetters.some((item) => !isPlainObject(item))) {
    throw schemaError('outboxDeadLetters');
  }
  return {
    pairedUsers: pairedUsers.map(String),
    permissions: { ...permissions },
    models: { ...models },
    efforts: { ...efforts },
    sessions: { ...sessions },
    sessionGenerations: { ...sessionGenerations },
    updateOffset,
    processedUpdates: normalizedProcessedUpdates.slice(-1000),
    pairing: parsed.pairing ? { ...parsed.pairing } : null,
    pairingAttempts: { ...pairingAttempts },
    restartRequest: restartRequest ? {
      chatId: String(restartRequest.chatId),
      requestedAt: restartRequest.requestedAt
    } : null,
    outbox,
    outboxDeadLetters: outboxDeadLetters.slice(-OUTBOX_DEAD_LETTER_MAX_ITEMS)
  };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readStateText(filePath) {
  let lastError;
  for (let attempt = 0; attempt <= STATE_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return { exists: true, text: fs.readFileSync(filePath, 'utf8') };
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, text: '' };
      lastError = error;
      if (attempt < STATE_READ_RETRY_DELAYS_MS.length) {
        sleepSync(STATE_READ_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

class JsonStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = structuredClone(EMPTY_STATE);
    this.load();
  }

  load() {
    const markerPath = `${this.filePath}.corrupt-marker`;
    const readErrorPath = `${this.filePath}.read-error.json`;
    if (fs.existsSync(markerPath)) {
      const corruption = new StateCorruptionError(this.filePath, null,
        new Error('state_corruption_marker_present'));
      this.logger.error('state_corrupted', corruption);
      throw corruption;
    }
    let source;
    try {
      source = readStateText(this.filePath);
    } catch (error) {
      const accessError = new StateAccessError(this.filePath, error);
      this.writeStateIssue(readErrorPath, accessError);
      this.logger.warn('state_read_temporarily_unavailable', accessError);
      throw accessError;
    }
    if (!source.exists) {
      this.state = structuredClone(EMPTY_STATE);
      fs.rmSync(readErrorPath, { force: true });
      return;
    }
    try {
      this.state = normalizeState(JSON.parse(source.text));
      fs.rmSync(readErrorPath, { force: true });
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      const quarantinePath = `${this.filePath}.corrupt-${stamp}`;
      try {
        fs.renameSync(this.filePath, quarantinePath);
      } catch (quarantineError) {
        const accessError = new StateAccessError(
          this.filePath,
          quarantineError,
          'state_quarantine_failed'
        );
        this.writeStateIssue(readErrorPath, accessError);
        this.logger.error('state_quarantine_failed', accessError);
        throw accessError;
      }
      try {
        fs.writeFileSync(markerPath, `${JSON.stringify({
          detectedAt: new Date().toISOString(),
          quarantinePath
        })}\n`, { mode: 0o600 });
      } catch (markerError) {
        this.logger.error('state_corruption_marker_failed', markerError);
      }
      const corruption = new StateCorruptionError(this.filePath, quarantinePath, error);
      this.logger.error('state_corrupted', corruption);
      throw corruption;
    }
  }

  writeStateIssue(issuePath, error) {
    try {
      fs.mkdirSync(path.dirname(issuePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(issuePath, `${JSON.stringify({
        code: error.code,
        detectedAt: new Date().toISOString()
      })}\n`, { mode: 0o600 });
    } catch (statusError) {
      this.logger.warn('state_issue_status_write_failed', statusError);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    const backupPath = `${this.filePath}.bak`;
    if (fs.existsSync(this.filePath)) {
      let current;
      try {
        current = readStateText(this.filePath);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw new StateAccessError(this.filePath, error);
      }
      try {
        normalizeState(JSON.parse(current.text));
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw new StateCorruptionError(this.filePath, null, error);
      }
      fs.copyFileSync(this.filePath, backupPath);
    }
    fs.renameSync(temporary, this.filePath);
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(this.filePath, backupPath);
    }
    try {
      fs.chmodSync(this.filePath, 0o600);
      fs.chmodSync(backupPath, 0o600);
    } catch (error) {
      this.logger.warn('state_chmod_not_supported', error);
    }
  }

  hasPairedUser(userId) {
    return this.state.pairedUsers.includes(String(userId));
  }

  pairUser(userId) {
    const normalized = String(userId);
    if (!this.state.pairedUsers.includes(normalized)) {
      this.state.pairedUsers.push(normalized);
      this.save();
    }
  }

  getPermission(userId) {
    return this.state.permissions[String(userId)] || null;
  }

  setPermission(userId, mode) {
    if (!['safe', 'free'].includes(mode)) throw new Error('invalid_permission_mode');
    this.state.permissions[String(userId)] = mode;
    this.save();
  }

  getModel(userId) {
    return this.state.models[String(userId)] || DEFAULT_MODEL;
  }

  setModel(userId, model) {
    if (!isSupportedModel(model)) throw new Error('invalid_model');
    this.state.models[String(userId)] = model;
    this.save();
  }

  getEffort(userId) {
    return this.state.efforts[String(userId)] || null;
  }

  setEffort(userId, effort) {
    if (!isSupportedEffort(effort)) throw new Error('invalid_effort');
    this.state.efforts[String(userId)] = effort;
    this.save();
  }

  getSession(chatId) {
    return this.state.sessions[String(chatId)] || null;
  }

  setSession(chatId, sessionId) {
    this.state.sessions[String(chatId)] = String(sessionId);
    this.save();
  }

  deleteSession(chatId) {
    delete this.state.sessions[String(chatId)];
    this.bumpSessionGeneration(chatId, false);
    this.save();
  }

  getSessionGeneration(chatId) {
    return Number(this.state.sessionGenerations[String(chatId)] || 0);
  }

  bumpSessionGeneration(chatId, save = true) {
    const key = String(chatId);
    this.state.sessionGenerations[key] = this.getSessionGeneration(key) + 1;
    if (save) this.save();
    return this.state.sessionGenerations[key];
  }

  setSessionIfGeneration(chatId, sessionId, generation) {
    if (this.getSessionGeneration(chatId) !== Number(generation)) return false;
    this.setSession(chatId, sessionId);
    return true;
  }

  getUpdateOffset() {
    return this.state.updateOffset;
  }

  confirmUpdate(updateId) {
    const numericId = normalizeUpdateId(updateId);
    const id = String(numericId);
    this.state.updateOffset = Math.max(this.state.updateOffset, numericId + 1);
    if (!this.state.processedUpdates.includes(id)) this.state.processedUpdates.push(id);
    this.state.processedUpdates = this.state.processedUpdates.slice(-1000);
    this.save();
  }

  hasProcessedUpdate(updateId) {
    return this.state.processedUpdates.includes(String(normalizeUpdateId(updateId)));
  }

  getPairing() {
    return this.state.pairing;
  }

  setPairing(pairing) {
    this.state.pairing = pairing ? { ...pairing } : null;
    this.save();
  }

  recordPairingAttempt(userId, now = Date.now(), windowMs = 10 * 60 * 1000) {
    const key = String(userId);
    const recent = (this.state.pairingAttempts[key] || [])
      .map(Number)
      .filter((timestamp) => now - timestamp < windowMs);
    recent.push(now);
    this.state.pairingAttempts[key] = recent;
    this.save();
    return recent.length;
  }

  markPairingUsed(userId) {
    if (!this.state.pairing) return false;
    this.state.pairing.used = true;
    this.state.pairing.usedAt = new Date().toISOString();
    this.state.pairing.usedBy = String(userId);
    this.save();
    return true;
  }

  getRestartRequest() {
    return this.state.restartRequest ? { ...this.state.restartRequest } : null;
  }

  setRestartRequest(chatId, now = Date.now()) {
    if (!/^\d+$/.test(String(chatId || ''))) throw new Error('invalid_restart_chat');
    this.state.restartRequest = {
      chatId: String(chatId),
      requestedAt: new Date(now).toISOString()
    };
    this.save();
    return { ...this.state.restartRequest };
  }

  clearRestartRequest(requestedAt) {
    if (!this.state.restartRequest) return false;
    if (requestedAt && this.state.restartRequest.requestedAt !== requestedAt) return false;
    this.state.restartRequest = null;
    this.save();
    return true;
  }

  discardPendingOutboxEnvelope(envelopeId, now = Date.now()) {
    const normalized = String(envelopeId || '');
    const discarded = this.state.outbox.filter((item) =>
      item.envelopeId === normalized && item.status !== 'delivered');
    if (!discarded.length) return 0;
    const discardedIds = new Set(discarded.map((item) => item.id));
    this.state.outbox = this.state.outbox.filter((item) => !discardedIds.has(item.id));
    for (const item of discarded) {
      this.archiveOutbox(item, 'superseded_by_restart_recovery', now);
    }
    this.save();
    return discarded.length;
  }

  archiveOutbox(item, reason, now) {
    this.state.outboxDeadLetters.push({
      id: item.id,
      idempotencyKey: item.idempotencyKey,
      chatId: item.chatId,
      envelopeId: item.envelopeId || item.id,
      sequence: Number(item.sequence || 1),
      total: Number(item.total || 1),
      reason,
      createdAt: item.createdAt,
      archivedAt: new Date(now).toISOString()
    });
    this.state.outboxDeadLetters = this.state.outboxDeadLetters
      .slice(-OUTBOX_DEAD_LETTER_MAX_ITEMS);
  }

  maintainOutbox(now = Date.now()) {
    let changed = false;
    const retained = [];
    for (const item of this.state.outbox) {
      const createdAt = Date.parse(item.createdAt);
      if (item.status === 'delivered') {
        const deliveredAt = Date.parse(item.deliveredAt || item.createdAt);
        if (Number.isFinite(deliveredAt) && now - deliveredAt >= OUTBOX_DELIVERED_RETENTION_MS) {
          changed = true;
          continue;
        }
      } else if (Number.isFinite(createdAt) && now - createdAt >= OUTBOX_PENDING_TTL_MS) {
        this.archiveOutbox(item, 'pending_ttl_exceeded', now);
        this.logger.warn('outbox_pending_expired', { id: item.id, chatId: item.chatId });
        changed = true;
        continue;
      }
      retained.push(item);
    }
    this.state.outbox = retained;
    return changed;
  }

  enqueueOutbox(message, now = Date.now()) {
    return this.enqueueOutboxBatch([{
      ...message,
      envelopeId: message.envelopeId || message.id,
      sequence: message.sequence || 1,
      total: message.total || 1
    }], now)[0];
  }

  enqueueOutboxBatch(messages, now = Date.now()) {
    if (!Array.isArray(messages) || messages.length < 1) {
      throw new Error('outbox_batch_empty');
    }
    if (messages.length > OUTBOX_MAX_ATOMIC_ITEMS) {
      throw new Error('outbox_batch_too_large');
    }
    const keys = messages.map((message) => String(message.idempotencyKey));
    if (new Set(keys).size !== keys.length) {
      throw new Error('outbox_batch_duplicate_key');
    }
    const incomingEnvelopeIds = new Set(messages.map((message) => String(message.envelopeId)));
    if (incomingEnvelopeIds.size !== 1) {
      throw new Error('outbox_batch_mixed_envelopes');
    }
    const existing = keys.map((key) =>
      this.state.outbox.find((item) => item.idempotencyKey === key));
    if (existing.every(Boolean)) {
      return existing.sort((left, right) => left.sequence - right.sequence);
    }
    if (existing.some(Boolean)) {
      throw new Error('outbox_batch_partial_conflict');
    }

    const previousState = structuredClone(this.state);
    try {
      this.maintainOutbox(now);
      while (true) {
        const envelopes = new Map();
        for (const item of this.state.outbox) {
          const envelopeId = item.envelopeId || item.id;
          if (!envelopes.has(envelopeId)) envelopes.set(envelopeId, []);
          envelopes.get(envelopeId).push(item);
        }
        const exceedsEnvelopeLimit = envelopes.size + 1 > OUTBOX_MAX_ITEMS;
        const exceedsRecordLimit =
          this.state.outbox.length + messages.length > OUTBOX_MAX_RECORDS;
        if (!exceedsEnvelopeLimit && !exceedsRecordLimit) break;
        const candidates = [...envelopes.entries()].map(([envelopeId, items]) => ({
          envelopeId,
          items,
          delivered: items.every((item) => item.status === 'delivered'),
          protected: items.length > 1 && items.some((item) => item.status !== 'delivered'),
          createdAt: Math.min(...items.map((item) => Date.parse(item.createdAt) || 0))
        })).filter((candidate) => !candidate.protected)
          .sort((left, right) => {
            if (left.delivered !== right.delivered) return left.delivered ? -1 : 1;
            return left.createdAt - right.createdAt;
          });
        const oldest = candidates[0];
        if (!oldest) {
          const capacityError = new Error('outbox_capacity_unavailable');
          capacityError.code = 'outbox_capacity_unavailable';
          throw capacityError;
        }
        const evictedIds = new Set(oldest.items.map((item) => item.id));
        this.state.outbox = this.state.outbox.filter((item) => !evictedIds.has(item.id));
        for (const item of oldest.items) {
          this.archiveOutbox(item, 'outbox_capacity_exceeded', now);
        }
        this.logger.warn('outbox_oldest_envelope_evicted', {
          envelopeId: oldest.envelopeId,
          itemCount: oldest.items.length,
          delivered: oldest.delivered
        });
      }

      const createdAt = new Date(now).toISOString();
      const records = messages.map((message, index) => ({
        id: String(message.id),
        idempotencyKey: keys[index],
        chatId: String(message.chatId),
        text: String(message.text),
        extra: isPlainObject(message.extra) ? message.extra : {},
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt,
        envelopeId: String(message.envelopeId),
        sequence: Number(message.sequence),
        total: Number(message.total)
      }));
      records.forEach((record, index) => validateOutboxRecord(record, index));
      this.state.outbox.push(...records);
      this.save();
      return records;
    } catch (error) {
      this.state = previousState;
      throw error;
    }
  }

  pendingOutbox(now = Date.now()) {
    if (this.maintainOutbox(now)) this.save();
    return this.firstPendingPerEnvelope()
      .filter((item) => Number(item.nextAttemptAt || 0) <= now);
  }

  firstPendingPerEnvelope() {
    const envelopes = new Map();
    for (const item of this.state.outbox) {
      const envelopeId = item.envelopeId || item.id;
      if (!envelopes.has(envelopeId)) envelopes.set(envelopeId, []);
      envelopes.get(envelopeId).push(item);
    }
    const pending = [];
    for (const items of envelopes.values()) {
      const first = items
        .sort((left, right) => Number(left.sequence || 1) - Number(right.sequence || 1))
        .find((item) => item.status !== 'delivered');
      if (first) pending.push(first);
    }
    return pending;
  }

  nextOutboxAttemptAt() {
    return this.firstPendingPerEnvelope()
      .map((item) => Number(item.nextAttemptAt || Date.now()));
  }

  markOutboxAttempt(id, error, nextAttemptAt) {
    const item = this.state.outbox.find((entry) => entry.id === id);
    if (!item) return;
    item.attempts = Number(item.attempts || 0) + 1;
    item.lastError = String(error || 'unknown').slice(0, 300);
    item.nextAttemptAt = Number(nextAttemptAt || 0);
    this.save();
  }

  markOutboxDelivered(id, telegramMessageId) {
    const item = this.state.outbox.find((entry) => entry.id === id);
    if (!item) return;
    item.status = 'delivered';
    item.deliveredAt = new Date().toISOString();
    if (telegramMessageId !== undefined && telegramMessageId !== null) {
      item.telegramMessageId = String(telegramMessageId);
    }
    this.maintainOutbox();
    this.save();
  }
}

module.exports = {
  JsonStore,
  OUTBOX_DEAD_LETTER_MAX_ITEMS,
  OUTBOX_MAX_ATOMIC_ITEMS,
  OUTBOX_MAX_ITEMS,
  OUTBOX_MAX_RECORDS,
  OUTBOX_PENDING_TTL_MS,
  StateAccessError,
  StateCorruptionError,
  normalizeUpdateId,
  normalizeState
};
