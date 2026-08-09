'use strict';

function updateIdentity(update) {
  const message = update && update.message;
  const callback = update && update.callback_query;
  const callbackMessage = callback && callback.message;
  return {
    chatId: message?.chat?.id ?? callbackMessage?.chat?.id ?? null,
    chatType: message?.chat?.type ?? callbackMessage?.chat?.type ?? null,
    userId: message?.from?.id ?? callback?.from?.id ?? null
  };
}

class AccessPolicy {
  constructor({ ownerIds, store }) {
    this.ownerIds = new Set([...ownerIds].map(String));
    this.store = store;
  }

  isBaseAllowed(identity) {
    if (!identity || identity.userId === null || identity.chatId === null) return false;
    return identity.chatType === 'private' && this.ownerIds.has(String(identity.userId));
  }

  isPaired(identity) {
    return this.store.hasPairedUser(String(identity.userId));
  }

  authorize(update, requirePairing = true) {
    const identity = updateIdentity(update);
    return this.isBaseAllowed(identity) && (!requirePairing || this.isPaired(identity));
  }

  pair(identity) {
    if (!this.isBaseAllowed(identity)) return false;
    this.store.pairUser(String(identity.userId));
    return true;
  }

  isOwner(userId) {
    return this.ownerIds.has(String(userId));
  }
}

module.exports = { AccessPolicy, updateIdentity };
