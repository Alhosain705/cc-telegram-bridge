'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccessPolicy } = require('../src/access');

function policy(paired = ['10']) {
  const pairedSet = new Set(paired);
  return new AccessPolicy({
    ownerIds: new Set(['10']),
    store: {
      hasPairedUser: (id) => pairedSet.has(String(id)),
      pairUser: (id) => pairedSet.add(String(id))
    }
  });
}

test('allows a paired owner in a private chat', () => {
  const update = { message: { chat: { id: 10, type: 'private' }, from: { id: 10 } } };
  assert.equal(policy().authorize(update), true);
});

test('version one rejects groups and non-owner private senders', () => {
  const group = { message: { chat: { id: -100, type: 'group' }, from: { id: 10 } } };
  const otherPrivate = { message: { chat: { id: 20, type: 'private' }, from: { id: 20 } } };
  assert.equal(policy().authorize(group), false);
  assert.equal(policy().authorize(otherPrivate), false);
});

test('applies the same owner-only private rule to callback buttons', () => {
  const allowed = {
    callback_query: {
      from: { id: 10 },
      message: { chat: { id: 10, type: 'private' } }
    }
  };
  const bypassAttempt = {
    callback_query: {
      from: { id: 999 },
      message: { chat: { id: 999, type: 'private' } }
    }
  };
  assert.equal(policy().authorize(allowed), true);
  assert.equal(policy().authorize(bypassAttempt), false);
});

test('never authorizes the owner before pairing', () => {
  const update = { message: { chat: { id: 10, type: 'private' }, from: { id: 10 } } };
  assert.equal(policy([]).authorize(update), false);
  assert.equal(policy([]).authorize(update, false), true);
});
