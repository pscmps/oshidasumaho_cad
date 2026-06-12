import { parseModelJson } from './model-json.js';

const SUPPORTED_EXPORT_FORMATS = new Set(['stl', 'step']);

function decodeBase64UrlUtf8(value) {
  const normalized = value.trim();
  if (!normalized) {
    throw new UrlAutomationError('json64パラメータが空です。', 'EMPTY_JSON64_PARAMETER');
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(normalized)) {
    throw new UrlAutomationError('json64パラメータがbase64url形式ではありません。', 'INVALID_JSON64');
  }

  const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UrlAutomationError('json64パラメータをUTF-8 JSONとして復号できません。', 'INVALID_JSON64');
  }
}

export class UrlAutomationError extends Error {
  constructor(message, code = 'INVALID_URL_AUTOMATION') {
    super(message);
    this.name = 'UrlAutomationError';
    this.code = code;
  }
}

export function parseUrlAutomationRequest(search) {
  const params = new URLSearchParams(search || '');
  const jsonText = params.get('json');
  const json64Text = params.get('json64');
  const requestedFormat = params.get('format')?.trim().toLowerCase() || '';
  const download = params.get('download') === '1';
  const automationMode = params.get('mode')?.trim().toLowerCase() === 'automation'
    || params.get('ui')?.trim().toLowerCase() === 'none';

  if (jsonText !== null && json64Text !== null) {
    throw new UrlAutomationError(
      'jsonとjson64は同時に指定できません。',
      'MULTIPLE_JSON_PARAMETERS',
    );
  }
  if (jsonText === null && json64Text === null) {
    if (requestedFormat || download || automationMode) {
      throw new UrlAutomationError(
        'URL自動出力にはjsonまたはjson64パラメータが必要です。',
        'JSON_PARAMETER_REQUIRED',
      );
    }
    return null;
  }
  if (jsonText !== null && !jsonText.trim()) {
    throw new UrlAutomationError('jsonパラメータが空です。', 'EMPTY_JSON_PARAMETER');
  }

  const format = requestedFormat || (download ? 'stl' : null);
  if (format && !SUPPORTED_EXPORT_FORMATS.has(format)) {
    throw new UrlAutomationError(
      `formatはstlまたはstepを指定してください: ${requestedFormat}`,
      'UNSUPPORTED_EXPORT_FORMAT',
    );
  }

  return {
    document: parseModelJson(jsonText ?? decodeBase64UrlUtf8(json64Text)),
    format,
    download,
    automationMode,
    source: jsonText === null ? 'json64' : 'json',
  };
}
