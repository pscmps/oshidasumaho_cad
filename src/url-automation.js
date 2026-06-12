import { parseModelJson } from './model-json.js';

const SUPPORTED_EXPORT_FORMATS = new Set(['stl', 'step']);

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
  const requestedFormat = params.get('format')?.trim().toLowerCase() || '';
  const download = params.get('download') === '1';

  if (jsonText === null) {
    if (requestedFormat || download) {
      throw new UrlAutomationError(
        'URL自動出力にはjsonパラメータが必要です。',
        'JSON_PARAMETER_REQUIRED',
      );
    }
    return null;
  }
  if (!jsonText.trim()) {
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
    document: parseModelJson(jsonText),
    format,
    download,
  };
}
