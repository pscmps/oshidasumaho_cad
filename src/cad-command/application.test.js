import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCad, validateCad } from '../cad-core/document.js';
import { createProposal, proposalDocument, resumedProposal, proposalIssue } from './proposals.js';
import { parseModelJson, serializeModelJson } from '../model-json.js';
import { DOCUMENT_STORAGE_KEY, persistDocumentChange, saveDocumentIfUnchanged, readStoredDocumentRaw, withDocumentWriteLock } from '../cad-core/persistence.js';

const id='7f88431e-e627-4b67-9e9a-27eed6387457';
const base=()=>({schemaVersion:5,shapes:[],cad:emptyCad()});
const commands=[{operation:'addExtrude',profile:{type:'circle',radius:15},distance:30,origin:[0,0,0]}];
const saved=d=>({task:'sketch',document:d,sketchDraft:d.cad.draft});
const memory=(initial=null)=>{ let raw=initial; return {getItem:k=>{assert.equal(k,DOCUMENT_STORAGE_KEY);return raw;},setItem:(k,v)=>{assert.equal(k,DOCUMENT_STORAGE_KEY);raw=v;}}; };

test('request receipt survives save/reload and rejects a second apply after unrelated changes',()=>{
  const original=base(),p=resumedProposal(saved(original),{commands},id);
  const once=proposalDocument(original,p);
  assert.equal(original.cad.appliedRequestIds,undefined,'preview never mutates source');
  assert.deepEqual(once.cad.appliedRequestIds,[id]);
  const reloaded=parseModelJson(serializeModelJson(once));
  assert.match(proposalIssue(reloaded,p),/適用済み/);
  assert.throws(()=>proposalDocument(reloaded,p),/適用済み/);
  const other=proposalDocument(reloaded,createProposal(reloaded,[{...commands[0],origin:[50,0,0]}]));
  assert.equal(other.cad.features.length,2);
  assert.throws(()=>proposalDocument(other,p),/適用済み/);
  assert.equal(proposalDocument(original,p).cad.features.length,1,'undo restoring the original CAD permits intentional reapply');
});
test('application receipts reject malformed/duplicate IDs without weakening old documents',()=>{
  assert.deepEqual(parseModelJson(serializeModelJson(base())),base());
  for(const appliedRequestIds of ['bad',['bad'],[id,id],Array(5001).fill(id)]) assert.throws(()=>validateCad({...emptyCad(),appliedRequestIds}));
  assert.throws(()=>proposalDocument(base(),{...createProposal(base(),commands),requestId:'not-a-request'}),/依頼番号/);
});
test('guarded persistence preserves newer or corrupt data from another tab',()=>{
  const original=base(),other={...original,partName:'other tab'},candidate=proposalDocument(original,createProposal(original,commands));
  const storage=memory(JSON.stringify(original));
  persistDocumentChange(original,candidate,storage);
  assert.deepEqual(JSON.parse(readStoredDocumentRaw(storage)),candidate);
  storage.setItem(DOCUMENT_STORAGE_KEY,JSON.stringify(other));
  assert.throws(()=>persistDocumentChange(original,candidate,storage),/別のタブ/);
  assert.throws(()=>saveDocumentIfUnchanged(candidate,JSON.stringify(original),storage),/別のタブ/);
  assert.equal(storage.getItem(DOCUMENT_STORAGE_KEY),JSON.stringify(other));
  storage.setItem(DOCUMENT_STORAGE_KEY,'broken JSON');
  assert.throws(()=>persistDocumentChange(original,candidate,storage),/別のタブ/);
  assert.equal(storage.getItem(DOCUMENT_STORAGE_KEY),'broken JSON');
  assert.throws(()=>saveDocumentIfUnchanged(original,'broken JSON',storage),/上書きしていません/);
  assert.equal(storage.getItem(DOCUMENT_STORAGE_KEY),'broken JSON');
  const future=JSON.stringify({...original,schemaVersion:999});storage.setItem(DOCUMENT_STORAGE_KEY,future);
  assert.throws(()=>saveDocumentIfUnchanged(original,future,storage),/上書きしていません/);
  assert.equal(storage.getItem(DOCUMENT_STORAGE_KEY),future);
});
test('autosave accepts its own explicit commit and never silently discards a storage error',()=>{
  const original=base(),next={...original,partName:'new name'},storage=memory();
  const first=saveDocumentIfUnchanged(original,null,storage);
  persistDocumentChange(original,next,storage);
  assert.equal(saveDocumentIfUnchanged(next,first,storage),JSON.stringify(next));
  const failure={getItem(){return JSON.stringify(original);},setItem(){throw Error('quota');}};
  assert.throws(()=>persistDocumentChange(original,next,failure),/端末に保存できません/);
});
test('two tab-like applications share a write lock and only one stale model can commit',async()=>{
  const original=base(),storage=memory(JSON.stringify(original)); let queue=Promise.resolve(),active=0,maxActive=0;
  const locks={request(name,options,action){assert.equal(name,'oshida-cad-document-write');assert.equal(options.mode,'exclusive');const next=queue.then(action);queue=next.catch(()=>{});return next;}};
  const p=resumedProposal(saved(original),{commands},id);
  const apply=()=>withDocumentWriteLock(async()=>{active++;maxActive=Math.max(active,maxActive);try{await Promise.resolve();persistDocumentChange(original,proposalDocument(original,p),storage);}finally{active--;}},locks);
  const results=await Promise.allSettled([apply(),apply()]);
  assert.equal(maxActive,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(JSON.parse(storage.getItem(DOCUMENT_STORAGE_KEY)).cad.features.length,1);
  assert.deepEqual(JSON.parse(storage.getItem(DOCUMENT_STORAGE_KEY)).cad.appliedRequestIds,[id]);
  assert.equal(await withDocumentWriteLock(()=>42,null),42,'unsupported browsers retain comparison guards');
});
