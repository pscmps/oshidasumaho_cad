import { validateAndMigrateModelDocument } from './model-json.js';
import { validateDraft } from './cad-core/rough-sketch.js';
import { AI_COMMAND_CONTRACT, CAD_COMMAND_SCHEMA, validateCommands } from './cad-command/schema.js';
import { createProposal } from './cad-command/proposals.js';

const ID = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 1000000;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function exact(v, fields) { if (!object(v) || Object.keys(v).some(k => !fields.includes(k))) throw new Error('未対応の入力です'); }
function idOf(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('requestIdが不正です'); return id; }
function userOf(request) {
  // Only Sites' trusted ingress provides this identity. Never substitute a service identity.
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 200) throw Object.assign(new Error('ログインが必要です'), { status: 401 });
  return encodeURIComponent(id);
}
async function readBody(request) {
  if (+request.headers.get('Content-Length') > MAX_BYTES) throw new Error('依頼が大きすぎます');
  const data = await request.text(); if (new TextEncoder().encode(data).length > MAX_BYTES) throw new Error('依頼が大きすぎます');
  return JSON.parse(data);
}
function storage(env, user) {
  const bucket = env.CAD_EXCHANGE;
  if (!bucket) throw Object.assign(new Error('Codexの接続を準備中です。スケッチは端末に保存されています'), { status: 503 });
  const prefix = `cad/${user}/`;
  return {
    prefix, bucket,
    async get(id) { const item = await bucket.get(`${prefix}${idOf(id)}.json`); if (!item) throw Object.assign(new Error('依頼が見つかりません'), { status: 404 }); return { data: await item.json(), etag: item.etag }; },
    async put(id, data, etag) {
      const saved = await bucket.put(`${prefix}${idOf(id)}.json`, JSON.stringify(data), { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
        customMetadata: { createdAt: data.createdAt, task: data.request.task, prompt: data.request.prompt.slice(0,400), state: data.cancelled ? 'cancelled' : data.response ? 'answered' : 'pending' } });
      if (!saved) throw Object.assign(new Error('依頼が更新されています。読み直してください'), { status: 409 });
    },
  };
}
const requestIdSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
const TOOLS = [
  { name: 'list_cad_requests', description: 'List the authenticated user’s pending CAD sketch/edit requests, newest first. No model is changed.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'read_cad_request', description: 'Read one CAD request: structured sketch strokes, anchored comments, dimensions, feature graph, actual CAD entity selection groups and permitted-command contract. Interpret intent from this data; ask if ambiguous.', inputSchema: { type: 'object', properties: { requestId: requestIdSchema }, required: ['requestId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'propose_cad_commands', description: 'Return a proposal for an existing request. Use only permitted CAD commands. The browser will generate a ghost and ask the user to apply. Never execute code or replace the whole document. For sketches use addSketchSolid normalized closed profiles; read the contract first. Either commands or clarification, never both.', inputSchema: { type: 'object', properties: { requestId: requestIdSchema, commands: { type: 'array', items: CAD_COMMAND_SCHEMA, minItems: 1, maxItems: 20 }, explanation: { type: 'string', maxLength: 4000 }, clarification: { type: 'string', maxLength: 4000 } }, required: ['requestId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
];

async function callTool(name, args, store) {
  if (name === 'list_cad_requests') {
    exact(args, []);
    const all = []; let cursor;
    do {
      const list = await store.bucket.list({ prefix: store.prefix, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      for (const item of list.objects) if (item.customMetadata?.state === 'pending' && Date.now() - Date.parse(item.customMetadata.createdAt) < 86400000)
        all.push({ requestId: item.key.slice(store.prefix.length,-5), ...item.customMetadata });
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    return { requests: all.sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({state,...d})=>d) };
  }
  if (name === 'read_cad_request') {
    exact(args, ['requestId']); const { data } = await store.get(args.requestId);
    return { ...data, contract: AI_COMMAND_CONTRACT };
  }
  if (name === 'propose_cad_commands') {
    exact(args, ['requestId', 'commands', 'explanation', 'clarification']);
    const { data, etag } = await store.get(args.requestId);
    if (data.cancelled || data.response) throw new Error('この依頼は取り消し済み、または回答済みです');
    if ([args.explanation, args.clarification].some(s => s !== undefined && (typeof s !== 'string' || s.length > 4000))) throw new Error('説明は4000字以内です');
    let response;
    if (args.clarification && !args.commands) response = { clarification: args.clarification };
    else {
      if (args.clarification) throw new Error('命令と確認質問を同時に返すことはできません');
      const commands = validateCommands(args.commands);
      createProposal(data.request.document, commands); // Validate graph and captured targets; no kernel or JS runs server-side.
      response = { commands, explanation: args.explanation || '' };
    }
    await store.put(args.requestId, { ...data, response }, etag);
    return { status: 'proposed', requestId: args.requestId, applied: false };
  }
  throw new Error('未対応のツールです');
}

async function mcp(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: request.method === 'GET' ? 405 : 400 });
  const rpc = await readBody(request); let result;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'oshida-personal-cad', version: '2.0.0' } };
  else if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 });
  else if (rpc.method === 'ping') result = {};
  else if (rpc.method === 'tools/list') result = { tools: TOOLS };
  else if (rpc.method === 'tools/call') {
    const user = userOf(request); // unauthenticated calls fail with HTTP 401, including guessed IDs.
    try { const value = await callTool(rpc.params?.name, rpc.params?.arguments || {}, storage(env, user)); result = { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
    catch (e) { result = { content: [{ type: 'text', text: e.message }], isError: true }; }
  } else return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
  return json({ jsonrpc: '2.0', id: rpc.id ?? null, result });
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/mcp') return await mcp(request, env);
    if (!url.pathname.startsWith('/api/cad/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    const user = userOf(request), store = storage(env, user);
    if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'このサイトから操作してください' }, 403);
    if (url.pathname === '/api/cad/requests' && request.method === 'POST') {
      const body = await readBody(request); exact(body, ['requestId', 'request']); idOf(body.requestId);
      const r = body.request; exact(r, ['task', 'prompt', 'document', 'sketchDraft', 'activeGroup', 'features', 'selectionGroups', 'contract']);
      if (!['sketch', 'edit'].includes(r.task) || typeof r.prompt !== 'string' || r.prompt.length > 8000) throw new Error('依頼が不正です');
      const document = validateAndMigrateModelDocument(r.document);
      if (r.task === 'sketch') validateDraft(r.sketchDraft);
      const safe = { task: r.task, prompt: r.prompt, document, ...(r.task === 'sketch' ? { sketchDraft: r.sketchDraft } : {}), ...(r.activeGroup ? { activeGroup: r.activeGroup } : {}) };
      await store.put(body.requestId, { requestId: body.requestId, request: safe, createdAt: new Date().toISOString(), cancelled: false });
      return json({ requestId: body.requestId }, 201);
    }
    const match = url.pathname.match(/^\/api\/cad\/requests\/([a-f0-9-]{36})(\/cancel)?$/);
    if (!match) return json({ error: 'Not found' }, 404);
    const { data, etag } = await store.get(match[1]);
    if (match[2] && request.method === 'POST') { await store.put(match[1], { ...data, cancelled: true }, etag); return json({ cancelled: true }); }
    if (!match[2] && request.method === 'GET') return json({ response: data.response || null, cancelled: data.cancelled });
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) { return json({ error: e.message || '接続を利用できません' }, e.status || 400); }
} };
