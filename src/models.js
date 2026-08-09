'use strict';

const MODEL_DEFINITIONS = Object.freeze({
  haiku: Object.freeze({
    id: 'claude-haiku-4-5-20251001',
    label: 'هايكو',
    version: '4.5',
    display: 'هايكو 4.5',
    aliases: Object.freeze(['haiku', 'هايكو'])
  }),
  sonnet: Object.freeze({
    id: 'claude-sonnet-5',
    label: 'سونيت',
    version: '5',
    display: 'سونيت 5',
    aliases: Object.freeze(['sonnet', 'سونيت'])
  }),
  opus: Object.freeze({
    id: 'claude-opus-5',
    label: 'أوبس',
    version: '5',
    display: 'أوبس 5',
    aliases: Object.freeze(['opus', 'أوبس', 'اوبس', 'أُوبس'])
  }),
  fable: Object.freeze({
    id: 'claude-fable-5',
    label: 'فيبل',
    version: '5',
    display: 'فيبل 5',
    aliases: Object.freeze(['fable', 'فيبل'])
  })
});

const DEFAULT_MODEL_KEY = 'sonnet';
const DEFAULT_MODEL = MODEL_DEFINITIONS[DEFAULT_MODEL_KEY].id;
const MODEL_VALUES = new Set(Object.values(MODEL_DEFINITIONS).map((model) => model.id));
const EFFORT_DEFINITIONS = Object.freeze({
  low: Object.freeze({ label: 'منخفض' }),
  medium: Object.freeze({ label: 'متوسط' }),
  high: Object.freeze({ label: 'عالٍ' }),
  xhigh: Object.freeze({ label: 'عالٍ جدًا' }),
  max: Object.freeze({ label: 'أقصى' })
});
const EFFORT_VALUES = new Set(Object.keys(EFFORT_DEFINITIONS));

function resolveModel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const [key, model] of Object.entries(MODEL_DEFINITIONS)) {
    if (key === normalized || model.id === normalized ||
        model.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return { key, ...model };
    }
  }
  return null;
}

function modelForValue(value) {
  return Object.entries(MODEL_DEFINITIONS)
    .map(([key, model]) => ({ key, ...model }))
    .find((model) => model.id === value) || null;
}

function isSupportedModel(value) {
  return MODEL_VALUES.has(String(value || ''));
}

function isSupportedEffort(value) {
  return EFFORT_VALUES.has(String(value || ''));
}

function effortForValue(value) {
  const key = String(value || '');
  return isSupportedEffort(key) ? { key, ...EFFORT_DEFINITIONS[key] } : null;
}

function effortDisplayName(value) {
  return effortForValue(value)?.label || 'افتراضي من كلود';
}

function modelDisplayName(value) {
  return modelForValue(value)?.display || 'غير معروف';
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MODEL_KEY,
  EFFORT_DEFINITIONS,
  MODEL_DEFINITIONS,
  effortDisplayName,
  effortForValue,
  isSupportedEffort,
  isSupportedModel,
  modelDisplayName,
  modelForValue,
  resolveModel
};
