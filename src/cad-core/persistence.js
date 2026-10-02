import { validateAndMigrateModelDocument } from '../model-json.js';

// Shared by autosave and explicit CAD application. Never replace a newer tab's work.
export const DOCUMENT_STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const changed = () => new Error('別のタブで保存内容が更新されています。保存済みの作業を開き直してから操作してください。');
const unavailable = () => new Error('端末に保存できません。現在の作業を保ったまま、ブラウザの保存領域を確認してください。');
function localStorageOrThrow(storage) { try { return storage ?? globalThis.localStorage; } catch { throw unavailable(); } }
export function readStoredDocumentRaw(storage) {
  try { return localStorageOrThrow(storage).getItem(DOCUMENT_STORAGE_KEY); } catch { throw unavailable(); }
}
export function withDocumentWriteLock(action, locks = globalThis.navigator?.locks) {
  return locks?.request ? locks.request('oshida-cad-document-write', { mode: 'exclusive' }, action) : Promise.resolve().then(action);
}
export function saveDocumentIfUnchanged(document, previousRaw, storage) {
  storage = localStorageOrThrow(storage);
  const raw = JSON.stringify(document), current = readStoredDocumentRaw(storage);
  if (current !== previousRaw && current !== raw) throw changed();
  if (current !== null) {
    try { validateAndMigrateModelDocument(JSON.parse(current)); }
    catch { throw new Error('既存の保存データを読み取れないため、自動保存を停止しました。保存データは上書きしていません。'); }
  }
  try { storage.setItem(DOCUMENT_STORAGE_KEY, raw); } catch { throw unavailable(); }
  return raw;
}
export function persistDocumentChange(current, candidate, storage) {
  storage = localStorageOrThrow(storage);
  const stored = readStoredDocumentRaw(storage);
  if (stored !== null && stored !== JSON.stringify(current)) throw changed();
  return saveDocumentIfUnchanged(candidate, stored, storage);
}
