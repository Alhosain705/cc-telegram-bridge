'use strict';

const crypto = require('node:crypto');
const { AccessPolicy, updateIdentity } = require('./access');
const { redact } = require('./redact');
const { prepareTelegramText } = require('./text');
const { normalizeUpdateId, OUTBOX_MAX_ATOMIC_ITEMS } = require('./store');
const {
  EFFORT_DEFINITIONS,
  effortDisplayName,
  effortForValue,
  modelForValue,
  resolveModel
} = require('./models');
const { RESTART_ACTION } = require('./lifecycle');

const PERMISSION_KEYBOARD = {
  inline_keyboard: [[
    { text: '🛡️ وافق على كل خطوة', callback_data: 'permission:safe' },
    { text: '⚡ اشتغل بحرية', callback_data: 'permission:free' }
  ]]
};

const MODEL_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🪶 هايكو 4.5', callback_data: 'model:haiku' },
      { text: '⭐ سونيت 5', callback_data: 'model:sonnet' }
    ],
    [
      { text: '💪 أوبس 5', callback_data: 'model:opus' },
      { text: '✨ فيبل 5', callback_data: 'model:fable' }
    ]
  ]
};

const EFFORT_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🌱 منخفض', callback_data: 'effort:low' },
      { text: '⚖️ متوسط', callback_data: 'effort:medium' }
    ],
    [
      { text: '🧠 عالٍ', callback_data: 'effort:high' },
      { text: '🔥 عالٍ جدًا', callback_data: 'effort:xhigh' }
    ],
    [{ text: '🏔️ أقصى', callback_data: 'effort:max' }]
  ]
};

const HELP_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📊 الحالة', callback_data: 'cmd:status' },
      { text: '🆕 جلسة جديدة', callback_data: 'cmd:new' }
    ],
    [
      { text: '🔐 الصلاحيات', callback_data: 'cmd:permissions' },
      { text: '🤖 النموذج', callback_data: 'cmd:model' }
    ],
    [
      { text: '🔄 إعادة التشغيل', callback_data: 'cmd:restart' },
      { text: '🩺 التشخيص', callback_data: 'cmd:diagnose' }
    ]
  ]
};

const COMMAND_CALLBACKS = new Set(['help', 'status', 'new', 'permissions', 'model', 'restart', 'diagnose']);

function parseModelCommand(text) {
  const slash = String(text || '').match(/^\/(?:model|نموذج)(?:@\w+)?(?:\s+(.+))?$/i);
  if (slash) return { matched: true, value: String(slash[1] || '').trim() };
  const natural = String(text || '').match(
    /^(?:حوّل|حول|غيّر|غير|بدّل|بدل)\s+(?:(?:النموذج|نموذج(?:ي|ك)?|الموديل|موديل(?:ي|ك)?)\s+)?(?:إلى|الى|لـ?)?\s*(هايكو|سونيت|أوبس|اوبس|أُوبس|فيبل|haiku|sonnet|opus|fable)\s*$/i
  );
  return natural
    ? { matched: true, value: natural[1] }
    : { matched: false, value: '' };
}

function modelName(modelValue) {
  const model = modelForValue(modelValue);
  return model ? `${model.display} (${model.key})` : 'غير معروف';
}

function permissionName(mode) {
  return mode === 'free' ? 'يشتغل بحرية' : mode === 'safe' ? 'يطلب الموافقة' : 'ما اخترت بعد';
}

function parseSharedCommand(text) {
  const value = String(text || '');
  const definitions = [
    ['help', /^\/(?:help|مساعدة)(?:@\w+)?$/i],
    ['status', /^\/(?:status|حالة)(?:@\w+)?$/i],
    ['new', /^\/(?:new|جديد)(?:@\w+)?$/i],
    ['permissions', /^\/(?:permissions|صلاحيات)(?:@\w+)?$/i],
    ['model', /^\/(?:model|نموذج)(?:@\w+)?(?:\s+(.+))?$/i],
    ['restart', /^\/(?:restart|إعادة_تشغيل|اعادة_تشغيل)(?:@\w+)?$/i],
    ['diagnose', /^\/(?:diagnose|تشخيص)(?:@\w+)?$/i]
  ];
  for (const [name, pattern] of definitions) {
    const match = value.match(pattern);
    if (match) return { name, value: String(match[1] || '').trim() };
  }
  return null;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return 'أقل من دقيقة';
  if (seconds < 120) return 'دقيقة';
  if (seconds < 180) return 'دقيقتان';
  const minutes = Math.floor(seconds / 60);
  return minutes >= 3 && minutes <= 10 ? `${minutes} دقائق` : `${minutes} دقيقة`;
}

function restartAnnouncementEnvelopeId(requestedAt) {
  return `restart:announcement:${requestedAt}`;
}

function retryKeyboard(taskId) {
  return {
    inline_keyboard: [[{ text: '🔄 أعد المحاولة', callback_data: `retry:${taskId}` }]]
  };
}

function stopKeyboard(taskId) {
  return {
    inline_keyboard: [[{ text: '⏹ أوقف المهمة', callback_data: `stop:${taskId}` }]]
  };
}

class Bridge {
  constructor({
    config,
    store,
    telegram,
    runner,
    approvalBroker,
    logger,
    sleep,
    random,
    now,
    setIntervalImpl,
    clearIntervalImpl,
    onReady,
    onRestart
  }) {
    this.config = config;
    this.store = store;
    this.telegram = telegram;
    this.runner = runner;
    this.approvalBroker = approvalBroker || null;
    this.logger = logger;
    this.access = new AccessPolicy({ ...config, store });
    this.offset = this.store.getUpdateOffset();
    this.queue = [];
    this.processing = false;
    this.activeTask = null;
    this.retryTasks = new Map();
    this.unauthorizedNotified = new Set();
    this.stopping = false;
    this.sleep = sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = random || Math.random;
    this.now = now || Date.now;
    this.setIntervalImpl = setIntervalImpl || setInterval;
    this.clearIntervalImpl = clearIntervalImpl || clearInterval;
    this.networkWasDown = false;
    this.outboxRunning = false;
    this.ready = false;
    this.pendingRestartConfirmation = null;
    this.onReady = onReady || (() => {});
    this.onRestart = onRestart || (() => {});
  }

  async start() {
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(major) || major < 20 ||
        (major === 20 && Number(process.versions.node.split('.')[1]) < 12)) {
      throw new Error('node_20_12_or_newer_required');
    }
    const bot = await this.waitForTelegram();
    if (this.config.expectedBotUsername &&
        bot.username?.toLowerCase() !== this.config.expectedBotUsername.toLowerCase()) {
      throw new Error('configured_bot_username_does_not_match_token');
    }
    this.logger.info('bridge_started', { botId: bot.id, username: bot.username || '' });
    const billingMessage = this.config.apiKeyDetected
      ? (this.config.allowApiBilling && !this.config.unsupportedClaudeRoutingDetected
          ? '⚠️ لقيت مفتاح ANTHROPIC_API_KEY وسمحت له بالوصول. استخدامك قد يُحسب من رصيد API بالدولار بدل اشتراكك.'
          : this.config.unsupportedClaudeRoutingDetected
            ? '⚠️ لقيت إعداد بوابة أو بروكسي غير مدعوم، لذلك حجبت مفاتيح Anthropic حتى ما يروح اعتماد لوجهة غلط.'
            : '⚠️ لقيت مفتاح ANTHROPIC_API_KEY، لكني حجبته عن كلود كود عشان ما تتغير الفوترة بصمت. احذفه من البيئة إذا ما تحتاجه.')
      : '';
    const restartRequest = this.store.getRestartRequest();
    let restartRecipientFound = false;
    if (restartRequest) {
      this.store.discardPendingOutboxEnvelope(
        restartAnnouncementEnvelopeId(restartRequest.requestedAt)
      );
    }
    for (const ownerId of this.config.ownerIds) {
      if (restartRequest && String(ownerId) === restartRequest.chatId) {
        restartRecipientFound = true;
        continue;
      }
      try {
        await this.telegram.sendText(ownerId, `✅ الربط شغّال الآن.${billingMessage ? `\n\n${billingMessage}` : ''}`);
      } catch (error) {
        this.logger.warn('owner_start_notification_failed', error);
      }
    }
    if (restartRequest && !restartRecipientFound) {
      this.logger.warn('restart_request_owner_changed');
      this.store.clearRestartRequest(restartRequest.requestedAt);
    }
    if (restartRequest && restartRecipientFound) {
      this.pendingRestartConfirmation = { restartRequest, billingMessage };
    }
    this.installShutdownHandlers();
    this.flushOutbox().catch((error) => this.logger.error('outbox_flush_failed', error));
    try {
      await this.poll();
    } finally {
      this.approvalBroker?.shutdown();
      if (this.activeTask) this.runner.cancel(this.activeTask.id);
    }
  }

  async waitForTelegram() {
    let attempt = 0;
    while (!this.stopping) {
      try {
        const bot = await this.telegram.getMe();
        if (attempt > 0) this.logger.info('telegram_connection_restored');
        return bot;
      } catch (error) {
        if (error.permanent || [400, 401, 403, 404].includes(error.status)) throw error;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 6)));
        attempt += 1;
        this.logger.warn('telegram_startup_offline', error);
        await this.sleep(Math.round(delay * (0.8 + this.random() * 0.4)));
      }
    }
    throw new Error('bridge_stopping');
  }

  installShutdownHandlers() {
    const stop = (signal) => {
      if (this.stopping) return;
      this.stopping = true;
      this.logger.info('shutdown_requested', signal);
      this.approvalBroker?.shutdown();
      if (this.activeTask) this.runner.cancel(this.activeTask.id);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  async poll() {
    let failures = 0;
    while (!this.stopping) {
      let updates;
      try {
        updates = await this.telegram.getUpdates(this.offset);
        if (this.networkWasDown) {
          this.logger.info('telegram_connection_restored');
          this.networkWasDown = false;
        }
        failures = 0;
      } catch (error) {
        if (error.permanent || [400, 401, 403, 404].includes(error.status)) throw error;
        this.networkWasDown = true;
        this.logger.warn('poll_failed', error);
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(failures, 6)));
        failures += 1;
        await this.sleep(Math.round(delay * (0.8 + this.random() * 0.4)));
        continue;
      }
      if (!this.ready) {
        await this.markPollingReady();
      }
      for (const update of updates) {
        let updateId;
        try {
          updateId = normalizeUpdateId(update?.update_id);
        } catch (error) {
          this.logger.error('invalid_update_id', error);
          throw error;
        }
        if (this.store.hasProcessedUpdate(updateId)) {
          this.offset = Math.max(this.offset, updateId + 1);
          continue;
        }
        let action = null;
        try {
          action = await this.handleUpdate(update);
        } catch (error) {
          this.logger.error('update_handler_failed', error);
          const identity = updateIdentity(update);
          if (identity.chatId !== null && this.access.isBaseAllowed(identity)) {
            try {
              await this.safeSend(identity.chatId, '⚠️ صار خطأ غير متوقع. جرّب مرة ثانية، وإذا تكرر راجع سجل التشغيل.', {
                reply_markup: retryKeyboard(String(updateId))
              });
            } catch (noticeError) {
              this.logger.warn('update_error_notice_failed', noticeError);
            }
          }
        }
        try {
          this.store.confirmUpdate(updateId);
          this.offset = this.store.getUpdateOffset();
        } catch (confirmationError) {
          this.logger.error('update_confirmation_failed', confirmationError);
          throw confirmationError;
        }
        if (action === RESTART_ACTION) {
          this.stopping = true;
          this.logger.info('restart_requested');
          await Promise.resolve(this.onRestart());
          return;
        }
      }
    }
  }

  async markPollingReady() {
    await Promise.resolve(this.onReady());
    this.ready = true;
    const pending = this.pendingRestartConfirmation;
    if (!pending) return;
    const { restartRequest, billingMessage } = pending;
    await this.safeSend(
      restartRequest.chatId,
      `✅ رجع الجسر بعد إعادة التشغيل، والاتصال بتيليجرام شغّال.${billingMessage ? `\n\n${billingMessage}` : ''}`,
      {},
      `restart:recovered:${restartRequest.requestedAt}`
    );
    this.store.clearRestartRequest(restartRequest.requestedAt);
    this.pendingRestartConfirmation = null;
  }

  async handleUpdate(update) {
    const identity = updateIdentity(update);
    if (!this.access.isBaseAllowed(identity)) {
      await this.notifyUnauthorizedOnce(identity);
      return;
    }
    if (update.callback_query) {
      return this.handleCallback(update.callback_query, identity);
    }
    if (!update.message) return;
    return this.handleMessage(update.message, identity);
  }

  async notifyUnauthorizedOnce(identity) {
    if (!identity || identity.chatId === null || identity.userId === null) return;
    const key = `${identity.chatId}:${identity.userId}`;
    if (this.unauthorizedNotified.has(key)) return;
    this.unauthorizedNotified.add(key);
    await this.safeSend(identity.chatId, '🔒 هذا البوت خاص، وحسابك غير موجود ضمن الأشخاص المسموح لهم.');
  }

  async handleMessage(message, identity) {
    const text = String(message.text || '').trim();
    if (!this.access.isPaired(identity)) {
      const match = text.match(/^\/(?:ربط|pair)(?:@\w+)?\s+(\d{6})$/i);
      if (!match) {
        await this.safeSend(identity.chatId, '🔐 باقي خطوة ربط واحدة. أرسل: /ربط ثم الرمز المكوّن من 6 أرقام الموجود في ملف الإعداد.');
        return;
      }
      const pairing = this.store.getPairing();
      if (this.store.recordPairingAttempt(identity.userId) > 5) {
        await this.safeSend(identity.chatId, '⏳ كثرت المحاولات. انتظر 10 دقائق ثم جرّب من جديد.');
        return;
      }
      if (!pairing || pairing.used || Date.now() >= Date.parse(pairing.expiresAt || 0)) {
        await this.safeSend(identity.chatId, '⏳ انتهى كود الربط أو استُخدم. افتح نافذة الإعداد وولّد كوداً جديداً.');
        return;
      }
      const receivedCode = Buffer.from(match[1]);
      const expectedCode = Buffer.from(String(pairing.code || ''));
      if (receivedCode.length !== expectedCode.length ||
          !crypto.timingSafeEqual(receivedCode, expectedCode)) {
        await this.safeSend(identity.chatId, '❌ رمز الربط غير صحيح. تأكد من الرقم الظاهر في نافذة الإعداد ثم أعد المحاولة.');
        return;
      }
      this.access.pair(identity);
      this.store.markPairingUsed(identity.userId);
      await this.safeSend(identity.chatId, '✅ تم الربط بأمان. الحين اختر طريقة العمل:', {
        reply_markup: PERMISSION_KEYBOARD
      });
      return;
    }

    const sharedCommand = parseSharedCommand(text);
    if (sharedCommand) {
      return this.dispatchCommand(sharedCommand.name, identity, { value: sharedCommand.value });
    }
    const modelCommand = parseModelCommand(text);
    if (modelCommand.matched) {
      return this.dispatchCommand('model', identity, { value: modelCommand.value });
    }
    if (!text) {
      await this.safeSend(identity.chatId, '📄 حالياً أتعامل مع الرسائل النصية فقط. أرسل طلبك كنص.');
      return;
    }
    if (!this.store.getPermission(identity.userId)) {
      await this.safeSend(identity.chatId,
        'قبل أول مهمة اختر طريقة العمل:\n\n🛡️ أوافق على كل خطوة: أكثر أماناً، وإذا احتاج كلود عملاً حساسًا يرسل لك زري موافقة ورفض. الكتابة العادية ما تعتمد الطلب، وانتهاء المهلة يعني الرفض.\n\n⚡ أشتغل بحرية: ينفّذ بدون سؤال، وهذا مناسب فقط لجهاز مخصص.',
        { reply_markup: PERMISSION_KEYBOARD });
      return;
    }
    await this.enqueue({
      id: crypto.randomUUID().slice(0, 12),
      chatId: identity.chatId,
      userId: identity.userId,
      prompt: text
    });
  }

  async dispatchCommand(name, identity, options = {}) {
    if (name === 'help') {
      await this.safeSend(identity.chatId,
        'الأوامر:\n/help أو /مساعدة — المساعدة\n/status أو /حالة — حالة الربط\n/new أو /جديد — جلسة جديدة\n/permissions أو /صلاحيات — تغيير طريقة الصلاحيات\n/model أو /نموذج — اختيار النموذج\n/restart أو /إعادة_تشغيل — إعادة تشغيل الجسر\n/diagnose أو /تشخيص — فحص الجسر وكلود كود\n\nتقدر تضغط الأزرار تحت مباشرة، أو ترسل أي طلب نصّي عشان أشغّله على كلود كود.',
        { reply_markup: HELP_KEYBOARD });
      return;
    }
    if (name === 'status') {
      const activeStartedAt = Number(this.activeTask?.startedAt);
      const active = this.activeTask
        ? `قيد التنفيذ منذ ${formatDuration(
          Number.isFinite(activeStartedAt) ? this.now() - activeStartedAt : 0
        )}`
        : 'لا توجد';
      await this.safeSend(identity.chatId, [
        '✅ الربط شغّال.',
        `⚙️ المهمة النشطة: ${active}.`,
        `📥 طلبات تنتظر خلف المهمة النشطة: ${this.queue.length}.`,
        `🧠 سياق المحادثة: ${this.store.getSession(identity.chatId)
          ? 'محفوظ وسيُستخدم في رسالتك التالية'
          : 'جلسة جديدة بلا سياق سابق'}.`,
        `🤖 النموذج: ${modelName(this.store.getModel(identity.userId))}.`,
        `💭 مستوى التفكير: ${effortDisplayName(this.store.getEffort(identity.userId))}.`,
        `🔐 الصلاحيات: ${permissionName(this.store.getPermission(identity.userId))}.`,
        '🌐 الاتصال: متصل بتيليجرام.'
      ].join('\n'));
      return;
    }
    if (name === 'new') {
      this.store.deleteSession(identity.chatId);
      await this.safeSend(identity.chatId, '🆕 بدأت جلسة جديدة. الطلب الجاي ما يعتمد على الكلام السابق.');
      return;
    }
    if (name === 'permissions') {
      await this.safeSend(identity.chatId,
        '🛡️ «وافق على كل خطوة»: إذا طلب كلود عملاً حساسًا، يرسل لك زرين واضحين للموافقة أو الرفض. الكتابة العادية مثل «موافق» ما تعتمد الطلب، وإذا رفضت أو انتهت مهلة 10 دقائق فلن يُنفّذ العمل.\n\n⚡ «اشتغل بحرية»: تعطيه صلاحية كاملة على جهازك بدون سؤال. استخدمها فقط على جهاز مخصص وما فيه بيانات شخصية.',
        { reply_markup: PERMISSION_KEYBOARD });
      return;
    }
    if (name === 'model') {
      return this.selectModel(identity, options.value);
    }
    if (name === 'diagnose') {
      const health = await this.runner.diagnose();
      const claudeLines = {
        authenticated: '✅ كلود كود موجود ومسجّل الدخول.',
        not_authenticated: '⚠️ كلود كود موجود لكنه يحتاج تسجيل دخول. الحل: افتح START.cmd وكمل تسجيل الدخول.',
        not_found: '❌ كلود كود غير موجود. الحل: افتح START.cmd واتبع خطوة التثبيت.',
        timeout: '⚠️ فحص كلود كود تأخر وما اكتمل. الحل: تأكد أن كلود مو عالق، ثم افتح START.cmd وأعد التشخيص.',
        check_failed: '⚠️ ما قدرت أفحص كلود كود بسبب مشكلة تشغيل أو صلاحيات. الحل: افتح START.cmd وشغّل التشخيص من النافذة.'
      };
      const activeStartedAt = Number(this.activeTask?.startedAt);
      const active = this.activeTask
        ? `قيد التنفيذ منذ ${formatDuration(
          Number.isFinite(activeStartedAt) ? this.now() - activeStartedAt : 0
        )}`
        : 'لا توجد';
      await this.safeSend(identity.chatId, [
        '🩺 نتيجة التشخيص:',
        '✅ الجسر شغّال ومتصل بتيليجرام.',
        `⚙️ المهمة النشطة: ${active}.`,
        `📥 طلبات تنتظر خلف المهمة النشطة: ${this.queue.length}.`,
        `🧠 سياق المحادثة: ${this.store.getSession(identity.chatId)
          ? 'محفوظ وسيُستخدم في رسالتك التالية'
          : 'جلسة جديدة بلا سياق سابق'}.`,
        claudeLines[health.status] || claudeLines.check_failed,
        `🔐 الصلاحيات: ${permissionName(this.store.getPermission(identity.userId))}.`,
        `🤖 النموذج: ${modelName(this.store.getModel(identity.userId))}.`,
        `💭 مستوى التفكير: ${effortDisplayName(this.store.getEffort(identity.userId))}.`
      ].join('\n'));
      return;
    }
    if (name === 'restart') {
      if (this.processing || this.activeTask || this.queue.length || this.runner.isBusy?.()) {
        await this.safeSend(identity.chatId, '⏳ فيه مهمة شغّالة الآن. انتظر تنتهي، ثم أرسل أمر إعادة التشغيل من جديد.');
        return;
      }
      const restartRequest = this.store.setRestartRequest(identity.chatId);
      try {
        await this.safeSend(
          identity.chatId,
          '🔄 بأعيد تشغيل الجسر الآن. برسل لك تأكيد أول ما يرجع.',
          {},
          restartAnnouncementEnvelopeId(restartRequest.requestedAt)
        );
      } catch (error) {
        this.store.clearRestartRequest(restartRequest.requestedAt);
        throw error;
      }
      return RESTART_ACTION;
    }
    throw new Error('unknown_shared_command');
  }

  async selectModel(identity, value) {
    if (!value) {
      await this.safeSend(
        identity.chatId,
        `🤖 النموذج الحالي: ${modelName(this.store.getModel(identity.userId))}.\nاختر النموذج اللي تبيه:`,
        { reply_markup: MODEL_KEYBOARD }
      );
      return;
    }
    const model = resolveModel(value);
    if (!model) {
      await this.safeSend(identity.chatId, '⚠️ النموذج غير معروف. اختر هايكو أو سونيت أو أوبس أو فيبل.');
      return;
    }
    this.store.setModel(identity.userId, model.id);
    const availability = model.key === 'fable'
      ? '\nℹ️ قد لا يكون فيبل متاحاً إلا في باقة Max؛ إذا رفضه اشتراكك بقول لك بوضوح.'
      : '';
    await this.safeSend(
      identity.chatId,
      `✅ تم تغيير النموذج إلى ${model.display} (${model.key}).${availability}\n\nاختر مستوى التفكير، أو تجاهل الأزرار ليبقى المستوى السابق أو افتراضي كلود:`,
      { reply_markup: EFFORT_KEYBOARD }
    );
  }

  async answerCallback(callbackId, text) {
    try {
      await this.telegram.answerCallback(callbackId, text);
    } catch (error) {
      this.logger.warn('telegram_answer_callback_failed', error);
    }
  }

  async handleCallback(callback, identity) {
    if (!this.access.isPaired(identity)) {
      await this.answerCallback(callback.id, 'اربط حسابك أول.');
      return;
    }
    const data = String(callback.data || '');
    if (data.startsWith('ap:')) {
      if (!this.approvalBroker) {
        await this.answerCallback(callback.id, 'انتهى طلب الموافقة.');
        return;
      }
      const decision = await this.approvalBroker.decideCallback(data, {
        taskId: this.activeTask?.id,
        chatId: identity.chatId,
        ownerId: identity.userId
      });
      const messages = {
        allow: 'تمت الموافقة.',
        deny: 'تم الرفض.',
        stale: 'انتهى طلب الموافقة أو تم استخدام الزر.',
        identity_mismatch: 'هذا الطلب ما يخص هذه المحادثة أو المهمة.'
      };
      await this.answerCallback(
        callback.id,
        decision.handled && decision.accepted
          ? messages[decision.status]
          : messages[decision.status] || 'زر الموافقة غير صالح.'
      );
      return;
    }
    if (data.startsWith('cmd:')) {
      const command = data.slice('cmd:'.length);
      if (!COMMAND_CALLBACKS.has(command)) {
        await this.answerCallback(callback.id, 'زر الأمر غير معروف.');
        return;
      }
      await this.answerCallback(callback.id, 'تم تنفيذ الأمر.');
      return this.dispatchCommand(command, identity);
    }
    if (data === 'permission:safe' || data === 'permission:free') {
      const mode = data.endsWith(':free') ? 'free' : 'safe';
      this.store.setPermission(identity.userId, mode);
      await this.answerCallback(callback.id, 'تم حفظ اختيارك.');
      await this.safeSend(identity.chatId,
        mode === 'safe'
          ? '✅ اخترت الوضع الآمن: كلود يرسل زري موافقة ورفض قبل الأعمال الحساسة، والمهلة تنتهي بالرفض تلقائيًا.'
          : '⚠️ اخترت العمل بحرية. كلود يقدر ينفّذ على جهازك بدون سؤال؛ لا تستخدمه على جهاز فيه بياناتك الشخصية.');
      return;
    }
    if (data.startsWith('model:')) {
      const model = resolveModel(data.slice('model:'.length));
      if (!model) {
        await this.answerCallback(callback.id, 'النموذج غير معروف.');
        return;
      }
      await this.answerCallback(callback.id, 'تم حفظ النموذج.');
      await this.selectModel(identity, model.id);
      return;
    }
    if (data.startsWith('effort:')) {
      const effort = effortForValue(data.slice('effort:'.length));
      if (!effort || !Object.hasOwn(EFFORT_DEFINITIONS, effort.key)) {
        await this.answerCallback(callback.id, 'مستوى التفكير غير معروف.');
        return;
      }
      this.store.setEffort(identity.userId, effort.key);
      await this.answerCallback(callback.id, 'تم حفظ مستوى التفكير.');
      await this.safeSend(identity.chatId, `✅ مستوى التفكير الآن: ${effort.label}.`);
      return;
    }
    if (data.startsWith('stop:')) {
      const taskId = data.slice(5);
      let stopped = false;
      if (this.activeTask?.id === taskId &&
          String(this.activeTask.userId) === String(identity.userId)) {
        this.approvalBroker?.cancelTask(taskId);
        stopped = this.runner.cancel(taskId);
      }
      const queuedIndex = this.queue.findIndex((task) => task.id === taskId && String(task.userId) === String(identity.userId));
      if (queuedIndex >= 0) {
        const [queuedTask] = this.queue.splice(queuedIndex, 1);
        if (queuedTask.progressMessageId && this.telegram.editText) {
          const queuedAt = Number(queuedTask.queuedAt);
          await this.telegram.editText(
            queuedTask.chatId,
            queuedTask.progressMessageId,
            `⏹ ألغيت الطلب قبل بدء التنفيذ.\n⏱ المدة: ${formatDuration(
              Number.isFinite(queuedAt) ? this.now() - queuedAt : 0
            )}.`,
            { reply_markup: { inline_keyboard: [] } }
          ).catch((error) => this.logger.warn('queued_progress_edit_failed', error));
        }
        stopped = true;
      }
      await this.answerCallback(callback.id, stopped ? 'تم طلب الإيقاف.' : 'المهمة منتهية أو ما تخص حسابك.');
      return;
    }
    if (data.startsWith('retry:')) {
      const failedTaskId = data.slice(6);
      const failedTask = this.retryTasks.get(failedTaskId);
      if (!failedTask ||
          String(failedTask.chatId) !== String(identity.chatId) ||
          String(failedTask.userId) !== String(identity.userId)) {
        await this.answerCallback(callback.id, 'ما لقيت طلباً سابقاً لإعادته.');
        return;
      }
      await this.answerCallback(callback.id, 'أعدت الطلب.');
      await this.enqueue({
        id: crypto.randomUUID().slice(0, 12),
        chatId: identity.chatId,
        userId: identity.userId,
        prompt: failedTask.prompt
      });
      return;
    }
    await this.answerCallback(callback.id, 'الزر غير معروف.');
  }

  async enqueue(task) {
    if (this.queue.length >= 50) {
      await this.safeSend(task.chatId, '🚦 قائمة الانتظار ممتلئة. انتظر شوي ثم أرسل الطلب من جديد.');
      return;
    }
    task.queuedAt = this.now();
    this.queue.push(task);
    const progressMessage = await this.safeSend(task.chatId,
      this.processing
        ? `📥 استلمت طلبك وحطيته في الانتظار. قبلك ${this.queue.length - 1} طلب.`
        : '⚙️ استلمت رسالتك… أبدأ عليها الآن.',
      { reply_markup: stopKeyboard(task.id) });
    task.progressMessageId = progressMessage?.message_id ?? null;
    this.drainQueue().catch((error) => this.logger.error('queue_drain_failed', error));
  }

  async drainQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift();
        this.activeTask = task;
        await this.executeTask(task);
        this.activeTask = null;
      }
    } finally {
      this.activeTask = null;
      this.processing = false;
    }
  }

  async executeTask(task) {
    const sessionGeneration = this.store.getSessionGeneration(task.chatId);
    const unsafe = this.store.getPermission(task.userId) === 'free';
    const startedAt = this.now();
    task.startedAt = startedAt;
    let approvalContext = null;
    let activity = 'كلود ينفّذ طلبك الآن.';
    let lastProgressText = '';
    let typingTimer = this.setIntervalImpl(() => {
      this.telegram.sendTyping(task.chatId).catch((error) => this.logger.warn('typing_failed', error));
    }, 4000);
    typingTimer?.unref?.();
    let progressTimer = null;
    let timersStopped = false;
    const stopActivityTimers = () => {
      if (timersStopped) return;
      timersStopped = true;
      if (typingTimer !== null) this.clearIntervalImpl(typingTimer);
      if (progressTimer !== null) this.clearIntervalImpl(progressTimer);
      typingTimer = null;
      progressTimer = null;
    };
    const editProgress = async (text, final = false) => {
      if (!task.progressMessageId || !this.telegram.editText || text === lastProgressText) return;
      lastProgressText = text;
      try {
        await this.telegram.editText(task.chatId, task.progressMessageId, text, {
          reply_markup: final ? { inline_keyboard: [] } : stopKeyboard(task.id)
        });
      } catch (error) {
        this.logger.warn('progress_message_edit_failed', error);
      }
    };
    const updateProgress = (nextActivity) => {
      if (nextActivity && nextActivity !== activity) activity = nextActivity;
      const text = `⚙️ ${activity}\n⏱ المدة: ${formatDuration(this.now() - startedAt)}.`;
      return editProgress(text, false);
    };
    const finishProgress = (status, delivered) => {
      const duration = formatDuration(this.now() - startedAt);
      const text = delivered
        ? `${status}\n⏱ المدة: ${duration}.`
        : `📤 انتهى التنفيذ خلال ${duration}، والنتيجة تنتظر اكتمال التسليم.`;
      return editProgress(text, true);
    };
    try {
      await this.telegram.sendTyping(task.chatId)
        .catch((error) => this.logger.warn('typing_failed', error));
      await updateProgress();
      progressTimer = this.setIntervalImpl(() => {
        updateProgress().catch((error) => this.logger.warn('progress_update_failed', error));
      }, 4000);
      progressTimer?.unref?.();
      if (!unsafe && this.approvalBroker) {
        approvalContext = await this.approvalBroker.beginTask({
          taskId: task.id,
          chatId: task.chatId,
          ownerId: task.userId
        });
      }
      const result = await this.runner.run({
        prompt: task.prompt,
        sessionId: this.store.getSession(task.chatId),
        unsafe,
        model: this.store.getModel(task.userId),
        effort: this.store.getEffort(task.userId),
        taskId: task.id,
        approvalContext,
        onActivity: (message) => {
          this.logger.info('claude_activity', message);
          updateProgress(message).catch((error) => this.logger.warn('progress_update_failed', error));
        }
      });
      stopActivityTimers();
      if (result.sessionId) {
        this.store.setSessionIfGeneration(task.chatId, result.sessionId, sessionGeneration);
      }
      if (result.ok) {
        const duration = formatDuration(this.now() - startedAt);
        const delivered = await this.safeSendSequence(task.chatId, [
          { text: result.text },
          {
            text: result.skippedLargeEvents
              ? `✅ خلصت. تجاوزت جزءاً ضخماً من بيانات التشغيل بدون ما أوقف المهمة.\n⏱ المدة: ${duration}.`
              : `✅ خلصت المهمة.\n⏱ المدة: ${duration}.`
          }
        ], `task:${task.id}:result`);
        await finishProgress('✅ انتهت المهمة.', delivered !== null);
        return;
      }
      const reasonMessages = {
        cancelled: '⏹ وقفت المهمة بناءً على طلبك.',
        timeout: '⏳ وقفت المهمة لأنها تجاوزت الوقت المحدد. تقدر تقسّمها لطلبات أصغر ثم تعيد.',
        oversized_output: '📦 وقفت المهمة لأن بيانات التشغيل تجاوزت السقف الآمن. جرّب طلباً أصغر.',
        spawn_failed: '🚫 ما قدرت أشغّل كلود كود. تأكد من تثبيته أو اضبط CLAUDE_BIN في ملف .env.',
        claude_failed: '⚠️ كلود كود توقف بخطأ. راجع التشخيص ثم أعد المحاولة.',
        auth_failed: '🔐 انتهى تسجيل دخول كلود. افتح نافذة الإعداد وسجّل الدخول من جديد.',
        quota_exceeded: '📊 وصلت حد حصة كلود الحالية. انتظر تجدد الحصة ثم أعد المحاولة.',
        model_unavailable: '🚫 هذا النموذج غير متاح في باقة اشتراكك الحالية — جرّب نموذجاً آخر من /model.',
        effort_unavailable: '🚫 مستوى التفكير المختار غير متوافق مع هذا النموذج أو اشتراكك. اختر مستوى آخر بعد /model ثم أعد المحاولة.',
        network_failed: '🌐 كلود ما قدر يتصل بالشبكة. تأكد من الإنترنت ثم أعد المحاولة.'
      };
      const explanation = reasonMessages[result.reason] || '⚠️ توقفت المهمة بسبب غير متوقع. أعد المحاولة، وإذا تكرر راجع سجل التشغيل.';
      const duration = formatDuration(this.now() - startedAt);
      this.retryTasks.set(task.id, task);
      const delivered = await this.safeSend(task.chatId,
        result.text
          ? `${explanation}\n⏱ المدة: ${duration}.\n\nآخر جواب وصل:\n${result.text}`
          : `${explanation}\n⏱ المدة: ${duration}.`,
        { reply_markup: retryKeyboard(task.id) });
      const finalStatus = result.reason === 'cancelled'
        ? '⏹ توقفت المهمة.'
        : result.reason === 'timeout'
          ? '⏳ انتهت مهلة المهمة.'
          : '⚠️ توقفت المهمة.';
      await finishProgress(finalStatus, delivered !== null);
    } catch (error) {
      stopActivityTimers();
      this.logger.error('task_execution_failed', error);
      this.retryTasks.set(task.id, task);
      const duration = formatDuration(this.now() - startedAt);
      const delivered = await this.safeSend(task.chatId,
        `⚠️ صار خطأ أثناء تنفيذ المهمة. جرّب مرة ثانية، وإذا تكرر تأكد من تسجيل دخول كلود كود.\n⏱ المدة: ${duration}.`,
        { reply_markup: retryKeyboard(task.id) });
      await finishProgress('⚠️ توقفت المهمة.', delivered !== null);
    } finally {
      stopActivityTimers();
      this.approvalBroker?.cancelTask(task.id);
    }
  }

  async safeSend(chatId, text, extra, idempotencyKey = crypto.randomUUID()) {
    return this.safeSendSequence(chatId, [{ text, extra }], idempotencyKey);
  }

  async safeSendSequence(chatId, messages, idempotencyKey = crypto.randomUUID()) {
    const envelopeId = String(idempotencyKey);
    let prepared = [];
    messages.forEach((message, messageIndex) => {
      const chunks = prepareTelegramText(redact(message.text));
      chunks.forEach((chunk, chunkIndex) => {
        const chunkKey = messages.length === 1
          ? `${envelopeId}:chunk:${chunkIndex + 1}:${chunks.length}`
          : `${envelopeId}:message:${messageIndex + 1}:chunk:${chunkIndex + 1}:${chunks.length}`;
        prepared.push({
          text: chunk,
          extra: chunkIndex === chunks.length - 1 ? message.extra : {},
          idempotencyKey: chunkKey
        });
      });
    });
    if (prepared.length > OUTBOX_MAX_ATOMIC_ITEMS) {
      prepared = [{
        text: '📦 الجواب أطول من سعة التسليم الآمنة، لذلك ما أرسلت جزءاً ناقصاً منه. اطلب تقسيم الجواب إلى أقسام أصغر.',
        extra: {},
        idempotencyKey: `${envelopeId}:oversized`
      }];
    }
    const records = this.store.enqueueOutboxBatch(prepared.map((item, index) => ({
      id: crypto.randomUUID(),
      idempotencyKey: item.idempotencyKey,
      chatId,
      text: item.text,
      extra: item.extra || {},
      envelopeId,
      sequence: index + 1,
      total: prepared.length
    })));
    let lastResult = true;
    for (const record of records) {
      if (record.status === 'delivered') continue;
      try {
        lastResult = this.telegram.sendPreparedText
          ? await this.telegram.sendPreparedText(record.chatId, record.text, record.extra)
          : await this.telegram.sendText(record.chatId, record.text, record.extra);
        this.store.markOutboxDelivered(record.id, lastResult?.message_id);
      } catch (error) {
        this.logger.error('telegram_send_failed', error);
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(record.attempts || 0, 6)));
        this.store.markOutboxAttempt(record.id, error.message, Date.now() + delay);
        this.flushOutbox().catch((flushError) => this.logger.error('outbox_flush_failed', flushError));
        return null;
      }
    }
    return lastResult;
  }

  async flushOutbox() {
    if (this.outboxRunning || this.stopping) return;
    this.outboxRunning = true;
    try {
      while (!this.stopping) {
        const pending = this.store.pendingOutbox();
        if (!pending.length) {
          const futureAttempts = this.store.nextOutboxAttemptAt();
          if (!futureAttempts.length) return;
          await this.sleep(Math.max(100, Math.min(60_000, Math.min(...futureAttempts) - Date.now())));
          continue;
        }
        for (const item of pending) {
          try {
            const result = this.telegram.sendPreparedText
              ? await this.telegram.sendPreparedText(item.chatId, item.text, item.extra)
              : await this.telegram.sendText(item.chatId, item.text, item.extra);
            this.store.markOutboxDelivered(item.id, result?.message_id);
          } catch (error) {
            const delay = Math.min(60_000, 1_000 * (2 ** Math.min(item.attempts || 0, 6)));
            const jittered = Math.round(delay * (0.8 + this.random() * 0.4));
            this.store.markOutboxAttempt(item.id, error.message, Date.now() + jittered);
            this.logger.warn('outbox_delivery_deferred', error);
          }
        }
        const nextAttempts = this.store.nextOutboxAttemptAt();
        if (!nextAttempts.length) return;
        await this.sleep(Math.max(100, Math.min(60_000, Math.min(...nextAttempts) - Date.now())));
      }
    } finally {
      this.outboxRunning = false;
    }
  }
}

module.exports = {
  Bridge,
  EFFORT_KEYBOARD,
  HELP_KEYBOARD,
  MODEL_KEYBOARD,
  PERMISSION_KEYBOARD,
  formatDuration,
  modelName,
  parseModelCommand,
  parseSharedCommand,
  restartAnnouncementEnvelopeId,
  retryKeyboard,
  stopKeyboard
};
