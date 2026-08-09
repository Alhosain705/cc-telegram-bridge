'use strict';

const TELEGRAM_SAFE_LIMIT = 3900;
const ARABIC_PATTERN = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;
const LTR_PATTERN = /[A-Za-z0-9]/;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RLE = '\u202b';
const PDF = '\u202c';
const LRI = '\u2066';
const PDI = '\u2069';
const COPYABLE_TOKEN_PATTERN = /(https?:\/\/[^\s\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]+|[A-Za-z]:\\[\x20-\x7e]*|\/[\p{L}\p{N}_]+(?:@[A-Za-z0-9_]+)?|--[A-Za-z0-9][A-Za-z0-9-]*|claude-[A-Za-z0-9-]+|[A-Za-z0-9][A-Za-z0-9._:@+%#?&=\\/-]*)/gu;

function normalizeBidi(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(BIDI_CONTROL_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => {
      if (!ARABIC_PATTERN.test(line)) return line;
      const isolated = line.replace(COPYABLE_TOKEN_PATTERN, (token) => `${LRI}${token}${PDI}`);
      return `${RLE}${isolated}${PDF}`;
    })
    .join('\n');
}

function graphemes(value) {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter('ar', { granularity: 'grapheme' }).segment(value)]
      .map((entry) => entry.segment);
  }
  return Array.from(value);
}

function splitTelegramText(value, limit = TELEGRAM_SAFE_LIMIT) {
  const units = graphemes(String(value ?? ''));
  const chunks = [];
  let current = '';
  let lastNewlineLength = -1;

  for (const unit of units) {
    if (current.length + unit.length > limit) {
      if (lastNewlineLength > Math.floor(limit * 0.45)) {
        chunks.push(current.slice(0, lastNewlineLength));
        current = `${current.slice(lastNewlineLength).replace(/^\n/, '')}${unit}`;
      } else {
        chunks.push(current);
        current = unit;
      }
      lastNewlineLength = current.lastIndexOf('\n');
    } else {
      current += unit;
      if (unit === '\n') lastNewlineLength = current.length;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ['(ما وصلني جواب نصّي.)'];
}

function prepareTelegramText(value) {
  return splitTelegramText(normalizeBidi(value));
}

module.exports = {
  normalizeBidi,
  prepareTelegramText,
  splitTelegramText,
  TELEGRAM_SAFE_LIMIT,
  ARABIC_PATTERN,
  LTR_PATTERN
};
