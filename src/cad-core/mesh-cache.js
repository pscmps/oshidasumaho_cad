import { cadOf, validateCad } from './document.js';

// Keep only two small, detached meshes. Never keep WASM objects or skip validation.
export function createMeshCache(evaluate, { capacity = 2, maxBytes = 12 * 1024 * 1024 } = {}) {
  const entries = new Map();
  return async document => {
    const cad = cadOf(document); validateCad(cad);
    // Preserve every legacy projection input; only known non-geometry CAD fields
    // are excluded. Selection/draft/receipts are still validated on every call.
    const { draft, selectionGroups, appliedRequestIds, ...geometry } = cad;
    const key = JSON.stringify({ ...document, cad: geometry });
    let entry = entries.get(key);
    if (!entry) {
      entry = Promise.resolve().then(() => evaluate(document)).then(result => {
        if (2 * (key.length + JSON.stringify(result).length) > maxBytes && entries.get(key) === entry) entries.delete(key);
        return result;
      }, error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      entries.set(key, entry);
      while (entries.size > capacity) entries.delete(entries.keys().next().value);
    } else { entries.delete(key); entries.set(key, entry); }
    return structuredClone(await entry);
  };
}
