'use strict';

const { prepareTelegramText } = require('./text');
const { redact } = require('./redact');

class TelegramClient {
  constructor(token, logger, options = {}) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.logger = logger;
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async call(method, payload = {}, timeoutMs = 70000, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('telegram_timeout')), timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429 && attempt < 4) {
        const retrySeconds = Math.max(1, Math.min(3600, Number(body?.parameters?.retry_after || 1)));
        await this.sleep(retrySeconds * 1000);
        return this.call(method, payload, timeoutMs, attempt + 1);
      }
      if (!response.ok || !body.ok) {
        const error = new Error(`telegram_${method}_failed:${response.status}:${redact(body.description || 'unknown')}`);
        error.status = response.status;
        error.telegramCode = Number(body?.error_code || response.status);
        error.permanent = [400, 401, 403, 404].includes(error.telegramCode);
        throw error;
      }
      return body.result;
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'telegram_timeout' ||
          error instanceof TypeError) {
        error.transient = true;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() {
    return this.call('getMe', {}, 15000);
  }

  getUpdates(offset) {
    return this.call('getUpdates', {
      offset,
      timeout: 50,
      allowed_updates: ['message', 'callback_query']
    }, 60000);
  }

  async sendText(chatId, text, extra = {}) {
    let lastResult = null;
    const chunks = prepareTelegramText(redact(text));
    for (let index = 0; index < chunks.length; index += 1) {
      lastResult = await this.sendPreparedText(
        chatId,
        chunks[index],
        index === chunks.length - 1 ? extra : {}
      );
    }
    return lastResult;
  }

  sendPreparedText(chatId, preparedText, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: String(preparedText),
      ...extra
    });
  }

  sendTyping(chatId) {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, 15000);
  }

  async editText(chatId, messageId, text, extra = {}) {
    const chunks = prepareTelegramText(redact(text));
    if (chunks.length !== 1) throw new Error('telegram_edit_text_too_long');
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: chunks[0],
      ...extra
    }, 15000);
  }

  answerCallback(callbackQueryId, text) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: redact(text || '')
    }, 15000);
  }
}

module.exports = { TelegramClient };
