import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSliceOptions } from '../src/slice-options.js';

test('slice options use safe defaults', () => {
  assert.deepEqual(parseSliceOptions({}), {
    layerHeight: '0.20',
    enableSupport: false,
    infillDensity: '20',
  });
});

test('slice options normalize supported values', () => {
  assert.deepEqual(
    parseSliceOptions({
      'x-layer-height': '0.12',
      'x-enable-support': 'true',
      'x-infill-density': '15',
    }),
    { layerHeight: '0.12', enableSupport: true, infillDensity: '15' },
  );
});

test('slice options reject unsupported layer heights and support values', () => {
  assert.throws(() => parseSliceOptions({ 'x-layer-height': '0.10' }), /X-Layer-Height/);
  assert.throws(() => parseSliceOptions({ 'x-enable-support': 'yes' }), /X-Enable-Support/);
  assert.throws(() => parseSliceOptions({ 'x-infill-density': '-1' }), /X-Infill-Density/);
  assert.throws(() => parseSliceOptions({ 'x-infill-density': '101' }), /X-Infill-Density/);
});
