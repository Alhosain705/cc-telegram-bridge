'use strict';

const SECRET_RULES = [
  { pattern: /(?:bot)?\d{6,32}:[A-Za-z0-9_-]{20,}/gi },
  { pattern: /(?:sk-ant-|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}/gi },
  {
    pattern: /Authorization\s*:\s*(?:Bearer|token)\s+(?:[^?&\s]|[?&](?!Bearer\s))+/gi
  },
  { pattern: /Bearer\s+(?:[^?&\s]|[?&](?!Bearer\s))+/gi },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  {
    pattern: /(["']?(?:token|secret|password|passwd|api[_-]?key|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
    preservePrefix: true
  }
];

const TELEGRAM_COMMANDS = new Set([
  'start', 'help', 'status', 'new', 'permissions', 'model', 'restart', 'diagnose',
  'مساعدة', 'حالة', 'جديد', 'صلاحيات', 'نموذج', 'إعادة_تشغيل', 'اعادة_تشغيل', 'تشخيص'
]);
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'<>]*/g;
const ENCODED_LOCAL_PATH_START = /(?:[A-Za-z](?:%3A(?:%2F|%5C)|%253A(?:%252F|%255C))|(?:%5C){2}|(?:%255C){2})/i;
const PRIVATE_KEY_BEGIN = '-----BEGIN ';
const PRIVATE_KEY_END = '-----END ';
const LOCAL_POSIX_URL_PATH = /^\/(?:boot|dev|etc|mnt|opt|private|proc|root|sys|tmp|usr|var|volumes)(?:[\\/]|$)/i;
const AMBIGUOUS_LOCAL_POSIX_URL_PATH = /^\/(?:home|media|run|srv|users)[\\/]+[^\\/?#&]+[\\/]+[^\\/?#&]+/i;
const FILE_QUERY_KEYS = new Set([
  'cwd', 'dir', 'directory', 'file', 'filepath', 'filename', 'root', 'workspace'
]);
const SHELL_COMMANDS = new Set([
  'cat', 'cd', 'cmd', 'copy', 'del', 'echo', 'erase', 'git', 'get-content', 'move',
  'node', 'npm', 'npx', 'powershell', 'pwsh', 'remove-item', 'rm', 'robocopy', 'type'
]);

function isAsciiLetter(character) {
  const code = character?.charCodeAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTelegramCommand(value, index) {
  let end = index + 1;
  while (end < value.length && /[\p{L}\p{N}_]/u.test(value[end]) && end - index <= 32) end += 1;
  const command = value.slice(index + 1, end).toLowerCase();
  if (!TELEGRAM_COMMANDS.has(command)) return false;
  if (value[end] === '@') {
    end += 1;
    const usernameStart = end;
    while (end < value.length && /[A-Za-z0-9_]/.test(value[end]) && end - usernameStart <= 32) {
      end += 1;
    }
    if (end === usernameStart) return false;
  }
  return end === value.length || /[\s.,!?;:)\]}>]/u.test(value[end]);
}

function isPrivatePathStart(value, index) {
  const current = value[index];
  const next = value[index + 1];
  const afterNext = value[index + 2];
  if (isAsciiLetter(current) && next === ':' && ['\\', '/'].includes(afterNext)) {
    return index === 0 || !/[\p{L}\p{N}]/u.test(value[index - 1]);
  }
  if (current === '\\' && next === '\\' && afterNext && !/[\s\\/]/.test(afterNext)) {
    return true;
  }
  if (current !== '/' || !next || /[\s/|;&]/.test(next) || isTelegramCommand(value, index)) {
    return false;
  }
  return index === 0 || !/[\p{L}\p{N}\\/]/u.test(value[index - 1]);
}

function isShellAmpersand(value, index) {
  const previous = value[index - 1] || '';
  const next = value[index + 1] || '';
  if (previous === '&' || next === '&') return true;
  let cursor = index + 1;
  while (cursor < value.length && /[ \t]/.test(value[cursor])) cursor += 1;
  if (isPrivatePathStart(value, cursor)) return true;
  if (!/[ \t]/.test(previous) || !/[ \t]/.test(next)) return false;
  let end = cursor;
  while (end < value.length && /[A-Za-z0-9_.-]/.test(value[end]) && end - cursor < 32) end += 1;
  if (end === cursor || (end < value.length && !/[\s;&|]/.test(value[end]))) return false;
  return SHELL_COMMANDS.has(value.slice(cursor, end).toLowerCase());
}

function markdownUnderscoreWrapperLength(value, pathStart) {
  let start = pathStart;
  while (start > 0 && value[start - 1] === '_' && pathStart - start < 2) start -= 1;
  const count = pathStart - start;
  if (count === 0) return 0;
  const before = value[start - 1] || '';
  return !before || /[\s([<{`*]/u.test(before) ? count : 0;
}

function isMarkdownUnderscoreCloser(value, index, wrapperLength) {
  if (wrapperLength === 0) return false;
  for (let offset = 0; offset < wrapperLength; offset += 1) {
    if (value[index + offset] !== '_') return false;
  }
  const end = index + wrapperLength;
  return end === value.length || /[\s.,!?;:)\]}>]/u.test(value[end]);
}

function pathWrapperCloser(value, pathStart) {
  return { '(': ')', '[': ']', '{': '}' }[value[pathStart - 1]] || '';
}

function closerEndsPath(value, index, wrapperCloser) {
  const current = value[index];
  const next = value[index + 1] || '';
  return wrapperCloser === current || !next || /[\s.,:;!?]/u.test(next);
}

function redactPrivatePathSegment(value) {
  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const current = value[index];
    const couldStartPath = current === '/' || current === '\\' ||
      (isAsciiLetter(current) && value[index + 1] === ':');
    if (!couldStartPath) {
      index += 1;
      continue;
    }
    if (!isPrivatePathStart(value, index)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    const underscoreWrapper = markdownUnderscoreWrapperLength(value, index);
    const wrapperCloser = pathWrapperCloser(value, index);
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    while (end < value.length) {
      const character = value[end];
      if (character === '\r' || character === '\n' || character === '"' ||
          character === "'" || character === '`' || character === '*' ||
          character === '<' || character === '>' || character === ';' ||
          character === '|' ||
          (character === '&' && isShellAmpersand(value, end)) ||
          (character === '_' && isMarkdownUnderscoreCloser(value, end, underscoreWrapper))) {
        break;
      }
      if (character === '(') parentheses += 1;
      if (character === '[') brackets += 1;
      if (character === '{') braces += 1;
      if (character === ')') {
        if (parentheses === 0) {
          if (closerEndsPath(value, end, wrapperCloser)) break;
        } else {
          parentheses -= 1;
        }
      }
      if (character === ']') {
        if (brackets === 0) {
          if (closerEndsPath(value, end, wrapperCloser)) break;
        } else {
          brackets -= 1;
        }
      }
      if (character === '}') {
        if (braces === 0) {
          if (closerEndsPath(value, end, wrapperCloser)) break;
        } else {
          braces -= 1;
        }
      }
      end += 1;
    }
    let pathEnd = end;
    while (pathEnd > index && /[ \t]/.test(value[pathEnd - 1])) pathEnd -= 1;
    output += `${value.slice(cursor, index)}<REDACTED_PATH>${value.slice(pathEnd, end)}`;
    cursor = end;
    index = end;
  }
  return output + value.slice(cursor);
}

function firstUrlDelimiter(value, start, delimiters) {
  let result = -1;
  for (const delimiter of delimiters) {
    const found = value.indexOf(delimiter, start);
    if (found !== -1 && (result === -1 || found < result)) result = found;
  }
  return result;
}

function isLocalUrlValue(value, parameterName = '') {
  const decode = (candidate) => candidate.replace(/%([0-9A-Fa-f]{2})/g,
    (_match, octet) => String.fromCharCode(Number.parseInt(octet, 16)));
  const decoded = decode(value);
  const decodedTwice = decode(decoded);
  return [value, decoded, decodedTwice].some((candidate) =>
    /^[A-Za-z]:[\\/]/.test(candidate) || /^\/[A-Za-z]:[\\/]/.test(candidate) ||
    /^\\\\[^\\]/.test(candidate) || LOCAL_POSIX_URL_PATH.test(candidate) ||
    AMBIGUOUS_LOCAL_POSIX_URL_PATH.test(candidate) ||
    /^(?:file|vscode|vscode-insiders):\/\//i.test(candidate) ||
    (FILE_QUERY_KEYS.has(parameterName.toLowerCase()) && /^\//.test(candidate)));
}

function redactUrlParameters(value) {
  return value.split('&').map((parameter) => {
    const equals = parameter.indexOf('=');
    if (equals === -1) return parameter;
    const parameterName = parameter.slice(0, equals);
    const parameterValue = parameter.slice(equals + 1);
    return isLocalUrlValue(parameterValue, parameterName)
      ? `${parameter.slice(0, equals + 1)}<REDACTED_PATH>`
      : parameter;
  }).join('&');
}

function redactUrlSuffix(value) {
  const fragmentIndex = value.indexOf('#');
  const query = fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : value.slice(fragmentIndex + 1);
  const redactedQuery = query.startsWith('?')
    ? `?${redactUrlParameters(query.slice(1))}`
    : query;
  if (fragmentIndex === -1) return redactedQuery;
  const redactedFragment = isLocalUrlValue(fragment)
    ? '<REDACTED_PATH>'
    : redactUrlParameters(fragment);
  return `${redactedQuery}#${redactedFragment}`;
}

function redactEmbeddedLocalPath(value) {
  const encodedPath = ENCODED_LOCAL_PATH_START.exec(value);
  if (encodedPath && (encodedPath.index === 0 || value[encodedPath.index - 1] === '/')) {
    return `${value.slice(0, encodedPath.index)}<REDACTED_PATH>`;
  }
  for (let index = 0; index + 2 < value.length; index += 1) {
    if (isAsciiLetter(value[index]) && value[index + 1] === ':' &&
        ['\\', '/'].includes(value[index + 2]) &&
        (index === 0 || value[index - 1] === '/')) {
      return `${value.slice(0, index)}${redactPrivatePathSegment(value.slice(index))}`;
    }
    if (value[index] === '\\' && value[index + 1] === '\\' &&
        (index === 0 || value[index - 1] === '/')) {
      return `${value.slice(0, index)}${redactPrivatePathSegment(value.slice(index))}`;
    }
  }
  return value;
}

function redactUrl(value) {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return value;
  const contentStart = schemeEnd + 3;
  const scheme = value.slice(0, schemeEnd).toLowerCase();
  const remainder = value.slice(contentStart);

  if (scheme === 'file') {
    const redacted = redactPrivatePathSegment(remainder);
    if (redacted !== remainder) return `${value.slice(0, contentStart)}${redacted}`;
    const pathStart = remainder.indexOf('/');
    if (pathStart === -1) return value;
    return `${value.slice(0, contentStart)}${remainder.slice(0, pathStart)}` +
      redactPrivatePathSegment(remainder.slice(pathStart));
  }

  const authorityEnd = firstUrlDelimiter(value, contentStart, ['/', '?', '#']);
  if (authorityEnd === -1) return value;
  const queryStart = firstUrlDelimiter(value, authorityEnd, ['?', '#']);
  const pathEnd = queryStart === -1 ? value.length : queryStart;
  const path = value.slice(authorityEnd, pathEnd);
  const editorLocalPath = scheme === 'vscode' || scheme === 'vscode-insiders';
  const redactedPath = editorLocalPath
    ? redactPrivatePathSegment(path)
    : redactEmbeddedLocalPath(path);
  const suffix = queryStart === -1 ? '' : redactUrlSuffix(value.slice(queryStart));
  return `${value.slice(0, authorityEnd)}${redactedPath}${suffix}`;
}

function redactPrivatePaths(value) {
  let output = '';
  let cursor = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    output += redactPrivatePathSegment(value.slice(cursor, match.index));
    output += redactUrl(match[0]);
    cursor = match.index + match[0].length;
  }
  return output + redactPrivatePathSegment(value.slice(cursor));
}

function isAbsolutePrivatePath(value) {
  return isPrivatePathStart(String(value ?? ''), 0);
}

function privateKeyMarker(value, markerStart, markerPrefix) {
  const labelStart = markerStart + markerPrefix.length;
  const suffixStart = value.indexOf('-----', labelStart);
  if (suffixStart === -1) return null;
  const label = value.slice(labelStart, suffixStart);
  if (!label.endsWith('PRIVATE KEY') || !label || /[\r\n\x00-\x1F\x7F]/u.test(label)) return null;
  return { end: suffixStart + 5, label };
}

function redactPrivateKeys(value) {
  let output = '';
  let cursor = 0;
  let search = 0;
  while (search < value.length) {
    const begin = value.indexOf(PRIVATE_KEY_BEGIN, search);
    if (begin === -1) break;
    const beginMarker = privateKeyMarker(value, begin, PRIVATE_KEY_BEGIN);
    if (!beginMarker) {
      output += `${value.slice(cursor, begin)}<REDACTED>`;
      cursor = value.length;
      search = value.length;
      break;
    }
    const endMarker = `${PRIVATE_KEY_END}${beginMarker.label}-----`;
    const end = value.indexOf(endMarker, beginMarker.end);
    if (end === -1) {
      output += `${value.slice(cursor, begin)}<REDACTED>`;
      cursor = value.length;
      search = value.length;
      break;
    }
    const keyEnd = end + endMarker.length;
    output += `${value.slice(cursor, begin)}<REDACTED>`;
    cursor = keyEnd;
    search = keyEnd;
  }
  return output + value.slice(cursor);
}

function redact(value) {
  let output = redactPrivateKeys(String(value ?? ''));
  for (const rule of SECRET_RULES) {
    output = output.replace(rule.pattern, (match, prefix) =>
      rule.preservePrefix ? `${prefix}<REDACTED>` : '<REDACTED>');
  }
  return redactPrivatePaths(output);
}

module.exports = { isAbsolutePrivatePath, redact, redactPrivatePaths };
