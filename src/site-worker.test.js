import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './site-worker.js';
import { emptyCad } from './cad-core/document.js';
import { emptyDraft } from './cad-core/rough-sketch.js';
import { createCodexAdapter } from './ai-adapter/codex.js';

class Bucket {
  items = new Map(); serial = 0;
  async get(key) { const v=this.items.get(key); return v && {etag:v.etag,json:async()=>JSON.parse(v.text)}; }
  async put(key,text,options={}) {
    const old=this.items.get(key), cond=options.onlyIf;
    if(cond?.etagMatches && old?.etag!==cond.etagMatches || cond?.etagDoesNotMatch==='*' && old)return null;
    const etag=String(++this.serial);this.items.set(key,{text,etag,customMetadata:options.customMetadata});return {etag};
  }
  async list({prefix}) {return {objects:[...this.items].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,customMetadata:v.customMetadata})),truncated:false};}
}
const env=()=>({CAD_EXCHANGE:new Bucket()});
const id='a7c7c4a8-9005-49e2-91e8-568cd4b68212';
const request=()=>({task:'sketch',prompt:'厚さ3mmの板にして',document:{schemaVersion:5,shapes:[],cad:emptyCad()},sketchDraft:emptyDraft()});
const cmd={operation:'addSketchSolid',origin:[0,0,0],dimensions:{width:40,depth:30,height:3},profiles:{top:{outer:{type:'polygon',points:[[0,0],[1,0],[1,1],[0,1]]},holes:[]}}};
const fetcher=(e,user='alice')=>(path,options={})=>worker.fetch(new Request(new URL(path,'https://cad.test'),{...options,headers:{...options.headers,...(user?{'oai-authenticated-user-id':user}:{})}}),e);
const rpc=(fetch,name,args={})=>fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:name,params:args})});

test('MCP discovery is data-free; private tools and API require Sites identity',async()=>{
  const e=env(),anon=fetcher(e,null);
  const list=await(await rpc(anon,'tools/list')).json();assert.equal(list.result.tools.length,4);
  const init=await(await rpc(anon,'initialize')).json();assert.equal(init.result.serverInfo.name,'oshida-personal-cad');
  assert.equal((await rpc(anon,'tools/call',{name:'list_cad_requests',arguments:{}})).status,401);
  assert.equal((await anon('/api/cad/requests',{method:'POST',body:'{}'})).status,401);
});
test('authenticated draft -> Codex read -> strict proposal -> browser polling; separate users cannot read it',async()=>{
  const e=env(),fetch=fetcher(e);
  assert.equal((await fetch('/api/cad/requests',{method:'POST',body:JSON.stringify({requestId:id,request:request()})})).status,201);
  assert.equal((await fetcher(e,'bob')(`/api/cad/requests/${id}`)).status,404);
  const pending=await(await rpc(fetch,'tools/call',{name:'list_cad_requests',arguments:{}})).json();
  assert.equal(JSON.parse(pending.result.content[0].text).requests[0].requestId,id);
  const read=await(await rpc(fetch,'tools/call',{name:'read_cad_request',arguments:{requestId:id}})).json();
  const data=JSON.parse(read.result.content[0].text);assert.deepEqual(data.request.sketchDraft,emptyDraft());assert.ok(data.contract.commandSchema);
  const bad=await(await rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId:id,commands:[{operation:'eval',code:'evil'}]}})).json();assert.ok(bad.result.isError);
  const proposed=await(await rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId:id,commands:[cmd],explanation:'厚さ3mmの板です'}})).json();assert.equal(JSON.parse(proposed.result.content[0].text).applied,false);
  const duplicate=await(await rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId:id,commands:[cmd],explanation:'厚さ3mmの板です'}})).json();assert.equal(duplicate.result.isError,undefined);
  const polled=await(await fetch(`/api/cad/requests/${id}`)).json();assert.deepEqual(polled.response.commands,[cmd]);
  const rereply=await(await rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId:id,commands:[cmd]}})).json();assert.ok(rereply.result.isError);
});

const modernRpc=(fetch,method,params={},headers={})=>fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{}),...headers},body:JSON.stringify({jsonrpc:'2.0',id:2,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});

test('rejection diagnostics contain fixed labels and flags, never caller data or credentials', async () => {
  const messages = [], previous = console.warn;
  console.warn = value => messages.push(value);
  try {
    const fetch = fetcher(env(), 'private-user-marker');
    const response = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', Authorization: 'Bearer private-token-marker' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'private-request-marker', method: 'initialize', params: { clientInfo: { name: 'private-client-marker' } } }) });
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(messages[0]), { event: 'cad.mcp.rejected', reason: 'metadata-missing', method: 'initialize', protocol: '2026-07-28', hasMethodHeader: false, hasNameHeader: false, hasMetadata: false, hasMetadataVersion: false, hasClientCapabilities: false });
    assert.equal(messages.join('').includes('private-'), false);
    assert.equal((await modernRpc(fetch, 'events/list', {}, { 'Mcp-Method': 'private-header-marker' })).status, 400);
    assert.equal(JSON.parse(messages[1]).reason, 'header-mismatch');
    assert.equal(messages.join('').includes('private-'), false);
  } finally { console.warn = previous; }
});
test('MCP2 discovery/events and mandatory header consistency coexist with legacy tools',async()=>{
  const e=env(),fetch=fetcher(e),anon=fetcher(e,null);
  const discovery=await(await modernRpc(anon,'server/discover')).json();assert.equal(discovery.result.resultType,'complete');assert.deepEqual(discovery.result.capabilities.events,{});
  const catalog=await(await modernRpc(fetch,'events/list')).json();assert.equal(catalog.result.events[0].name,'cad.request.created');
  assert.equal((await modernRpc(anon,'events/list')).status,401);
  const status=await(await modernRpc(fetch,'tools/call',{name:'get_cad_connection_status',arguments:{}})).json();assert.equal(status.result.structuredContent.connected,false);assert.equal(status.result.resultType,'complete');
  assert.equal((await modernRpc(fetch,'tools/call',{name:'get_cad_connection_status'},{'Mcp-Name':'read_cad_request'})).status,400);
  assert.equal((await modernRpc(fetch,'events/list',{}, {'Mcp-Method':'tools/list'})).status,400);
  assert.equal((await modernRpc(fetch,'does/not/exist')).status,404);
  assert.equal((await modernRpc(fetch,'events/list',{}, {Origin:'https://evil.test'})).status,403);
});

test('authenticated Sites dispatch restores absent mirrors only; direct, unauthenticated and mismatched traffic remain rejected', async () => {
  const e = env(), fetch = fetcher(e), anon = fetcher(e, null);
  const dispatch = { 'x-dispatched-app': 'site---6abe87fa3e3481919fe3e891c4e6f082' };
  const request = (send, method, params = {}, headers = {}) => send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const discovery = await request(fetch, 'server/discover', {}, dispatch);
  assert.equal(discovery.status, 200);
  assert.deepEqual((await discovery.json()).result.capabilities.events, {});
  const status = await request(fetch, 'tools/call', { name: 'get_cad_connection_status', arguments: {} }, dispatch);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).result.structuredContent.connected, false);
  assert.equal((await request(fetch, 'events/list', {}, dispatch)).status, 200);
  assert.equal((await request(fetch, 'server/discover')).status, 400);
  assert.equal((await request(anon, 'server/discover', {}, dispatch)).status, 400);
  assert.equal((await request(fetch, 'server/discover', {}, { 'x-dispatched-app': 'another-site' })).status, 400);
  assert.equal((await request(fetch, 'server/discover', {}, { ...dispatch, 'Mcp-Method': 'tools/list' })).status, 400);
  assert.equal((await request(fetch, 'tools/call', { name: 'get_cad_connection_status' }, { ...dispatch, 'Mcp-Name': 'read_cad_request' })).status, 400);
  assert.equal((await request(fetch, 'server/discover', {}, { ...dispatch, 'MCP-Protocol-Version': '2025-03-26' })).status, 400);
  assert.equal((await modernRpc(anon, 'tools/call', { name: 'get_cad_connection_status', arguments: {} }, dispatch)).status, 401);
});
test('idempotent create cannot overwrite a request; cross-origin, bad draft, conflict and cancellation are bounded',async()=>{
  const e=env(),fetch=fetcher(e),post=body=>fetch('/api/cad/requests',{method:'POST',body:JSON.stringify(body)});
  assert.equal((await post({requestId:id,request:request()})).status,201);
  assert.equal((await post({requestId:id,request:request()})).status,409);
  assert.equal((await fetch('/api/cad/requests',{method:'POST',headers:{Origin:'https://evil.test'},body:'{}'})).status,403);
  const r=request();r.sketchDraft.dimensions.width=0;assert.equal((await post({requestId:crypto.randomUUID(),request:r})).status,400);
  assert.equal((await fetch(`/api/cad/requests/${id}/cancel`,{method:'POST'})).status,200);
  const answer=await(await rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId:id,commands:[cmd]}})).json();assert.ok(answer.result.isError);
});
test('Codex adapter queues a request and waits without model mutation, then accepts an MCP response',async()=>{
  const e=env(),fetch=fetcher(e),before=request();let queued;
  const adapter=createCodexAdapter({fetcher:fetch,interval:1,onQueued:requestId=>{
    queued=requestId;void rpc(fetch,'tools/call',{name:'propose_cad_commands',arguments:{requestId,commands:[cmd],explanation:'確認してください'}});
  }});
  const answer=await adapter.propose(before);assert.ok(queued);assert.deepEqual(answer.commands,[cmd]);assert.equal(before.document.cad.features.length,0);
  const controller=new AbortController(),adapter2=createCodexAdapter({fetcher:fetch,interval:1,onQueued:()=>controller.abort()});
  await assert.rejects(adapter2.propose(before,{signal:controller.signal}),e=>e.name==='AbortError');
});

test('production transport verifies and delivers with Workers redirect semantics; redirects never activate', async t => {
  const sent = [];
  let redirect = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!['follow', 'manual'].includes(init.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(init.redirect, 'manual');
    const body = JSON.parse(init.body);
    sent.push(body);
    if (redirect) return new Response(null, { status: 307, headers: { Location: 'http://127.0.0.1/private' } });
    return body.type === 'verification' ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 204 });
  });
  const e = env(), fetch = fetcher(e), params = { name: 'cad.request.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example.com/callback', secret: 'whsec_' + Buffer.alloc(32, 11).toString('base64') } };
  const subscribed = await (await modernRpc(fetch, 'events/subscribe', params)).json();
  assert.equal(subscribed.error, undefined);
  assert.ok(subscribed.result.id);
  const pending = [];
  const created = await worker.fetch(new Request('https://cad.test/api/cad/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'alice' }, body: JSON.stringify({ requestId: id, request: request() }) }), e, { waitUntil: promise => pending.push(promise) });
  assert.equal(created.status, 201);
  await Promise.all(pending);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].name, 'cad.request.created');
  assert.equal(sent[1].data.requestId, id);
  redirect = true;
  const isolated = fetcher(env());
  const rejected = await (await modernRpc(isolated, 'events/subscribe', params)).json();
  assert.equal(rejected.error.code, -32015);
  const state = await (await isolated('/api/cad/connection')).json();
  assert.equal(state.connected, false);
  assert.equal(sent.length, 3, 'redirect produces one attempt and is never followed');
});
