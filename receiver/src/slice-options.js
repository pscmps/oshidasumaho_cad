export const ALLOWED_LAYER_HEIGHTS = ['0.08', '0.12', '0.16', '0.20', '0.24', '0.28'];

export function parseSliceOptions(headers) {
  const requestedLayerHeight = String(headers['x-layer-height'] || '0.20').trim();
  const normalizedLayerHeight = Number(requestedLayerHeight).toFixed(2);
  if (!ALLOWED_LAYER_HEIGHTS.includes(normalizedLayerHeight)) {
    throw new Error(`X-Layer-Height must be one of: ${ALLOWED_LAYER_HEIGHTS.join(', ')}`);
  }

  const supportValue = String(headers['x-enable-support'] || '0').trim().toLowerCase();
  if (!['0', '1', 'false', 'true'].includes(supportValue)) {
    throw new Error('X-Enable-Support must be 0, 1, false, or true');
  }

  return {
    layerHeight: normalizedLayerHeight,
    enableSupport: supportValue === '1' || supportValue === 'true',
  };
}
