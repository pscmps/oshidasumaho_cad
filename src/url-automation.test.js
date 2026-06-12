import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeModelJson } from './model-json.js';
import {
  UrlAutomationError,
  parseUrlAutomationRequest,
} from './url-automation.js';

const document = {
  schemaVersion: 1,
  partName: 'url-test',
  activeFace: 'top',
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 40, h: 30, mode: 'add', face: 'top' },
    { id: 2, type: 'rect', x: 10, y: 20, w: 40, h: 25, mode: 'add', face: 'front' },
    { id: 3, type: 'rect', x: 10, y: 20, w: 30, h: 25, mode: 'add', face: 'right' },
  ],
};

function encodeBase64UrlUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

test('URL query imports encoded JSON and STL download settings', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json=${json}&format=stl&download=1`);
  assert.equal(request.document.partName, 'url-test');
  assert.equal(request.format, 'stl');
  assert.equal(request.download, true);
  assert.equal(request.automationMode, false);
  assert.equal(request.source, 'json');
});

test('base64url UTF-8 JSON is imported', () => {
  const json64 = encodeBase64UrlUtf8(serializeModelJson({ ...document, partName: '日本語部品' }));
  const request = parseUrlAutomationRequest(`?json64=${json64}&format=stl`);
  assert.equal(request.document.partName, '日本語部品');
  assert.equal(request.source, 'json64');
});

test('mode=automation enables automation UI mode', () => {
  const json64 = encodeBase64UrlUtf8(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json64=${json64}&format=stl&download=1&mode=automation`);
  assert.equal(request.automationMode, true);
});

test('ui=none enables automation UI mode', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json=${json}&ui=none`);
  assert.equal(request.automationMode, true);
});

test('download defaults to STL when format is omitted', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json=${json}&download=1`);
  assert.equal(request.format, 'stl');
});

test('JSON can be loaded without automatic download', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json=${json}`);
  assert.equal(request.format, null);
  assert.equal(request.download, false);
});

test('STEP format is accepted', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const request = parseUrlAutomationRequest(`?json=${json}&format=step&download=1`);
  assert.equal(request.format, 'step');
  assert.equal(request.download, true);
});

test('encoded AI code block with smart quotes is normalized', () => {
  const aiOutput = '```json\n{“schemaVersion”:1,“partName”:“ai-part”,“shapes”:[]}\n```';
  const request = parseUrlAutomationRequest(`?json=${encodeURIComponent(aiOutput)}`);
  assert.equal(request.document.partName, 'ai-part');
});

test('unsupported formats are rejected', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  assert.throws(
    () => parseUrlAutomationRequest(`?json=${json}&format=obj&download=1`),
    (error) => error instanceof UrlAutomationError && error.code === 'UNSUPPORTED_EXPORT_FORMAT',
  );
});

test('download request without JSON is rejected', () => {
  assert.throws(
    () => parseUrlAutomationRequest('?format=stl&download=1'),
    (error) => error instanceof UrlAutomationError && error.code === 'JSON_PARAMETER_REQUIRED',
  );
});

test('automation mode without JSON is rejected', () => {
  assert.throws(
    () => parseUrlAutomationRequest('?mode=automation'),
    (error) => error instanceof UrlAutomationError && error.code === 'JSON_PARAMETER_REQUIRED',
  );
});

test('json and json64 cannot be specified together', () => {
  const json = encodeURIComponent(serializeModelJson(document));
  const json64 = encodeBase64UrlUtf8(serializeModelJson(document));
  assert.throws(
    () => parseUrlAutomationRequest(`?json=${json}&json64=${json64}`),
    (error) => error instanceof UrlAutomationError && error.code === 'MULTIPLE_JSON_PARAMETERS',
  );
});

test('invalid json64 is rejected', () => {
  assert.throws(
    () => parseUrlAutomationRequest('?json64=not%20base64url'),
    (error) => error instanceof UrlAutomationError && error.code === 'INVALID_JSON64',
  );
});
