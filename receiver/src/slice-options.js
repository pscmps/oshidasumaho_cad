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

  const requestedInfillDensity = String(headers['x-infill-density'] || '20').trim();
  const infillDensityNumber = Number(requestedInfillDensity);
  if (!Number.isFinite(infillDensityNumber) || infillDensityNumber < 0 || infillDensityNumber > 100) {
    throw new Error('X-Infill-Density must be a number from 0 through 100');
  }

  return {
    layerHeight: normalizedLayerHeight,
    enableSupport: supportValue === '1' || supportValue === 'true',
    infillDensity: String(infillDensityNumber),
  };
}
