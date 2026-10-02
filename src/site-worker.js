import { validateAndMigrateModelDocument } from './model-json.js';
import { validateDraft } from './cad-core/rough-sketch.js';
import { AI_COMMAND_CONTRACT, CAD_COMMAND_SCHEMA, validateCommands } from './cad-command/schema.js';
import { createProposal } from './cad-command/proposals.js';
import { createEvents, EVENT, EventError, canonical } from './cad-events.js';
import { webhookFetch } from './webhook-fetch.js';

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
  { name: 'get_cad_connection_status', description: 'Read whether this user has an active CAD-request webhook subscription. Returns counts and expiration only, never callback URLs or secrets. Does not subscribe or change models.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'list_cad_requests', description: 'List the authenticated user’s pending CAD sketch/edit requests, newest first. No model is changed.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'read_cad_request', description: 'Read one CAD request: structured sketch strokes, anchored comments, dimensions, feature graph, actual CAD entity selection groups and permitted-command contract. Interpret intent from this data; ask if ambiguous.', inputSchema: { type: 'object', properties: { requestId: requestIdSchema }, required: ['requestId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'propose_cad_commands', description: 'Return a proposal for an existing request. Use only permitted CAD commands. The browser will generate a ghost and ask the user to apply. Never execute code or replace the whole document. For sketches use addSketchSolid normalized closed profiles; read the contract first. Either commands or clarification, never both. Repeating the identical response is safe; replacing an existing response is rejected.', inputSchema: { type: 'object', properties: { requestId: requestIdSchema, commands: { type: 'array', items: CAD_COMMAND_SCHEMA, minItems: 1, maxItems: 20 }, explanation: { type: 'string', maxLength: 4000 }, clarification: { type: 'string', maxLength: 4000 } }, required: ['requestId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
];

async function callTool(name, args, store, events) {
  if (name === 'get_cad_connection_status') { exact(args, []); return events.status(); }
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
    if (data.cancelled) throw new Error('この依頼は取り消し済みです');
    if ([args.explanation, args.clarification].some(s => s !== undefined && (typeof s !== 'string' || s.length > 4000))) throw new Error('説明は4000字以内です');
    let response;
    if (args.clarification && !args.commands) response = { clarification: args.clarification };
    else {
      if (args.clarification) throw new Error('命令と確認質問を同時に返すことはできません');
      const commands = validateCommands(args.commands);
      createProposal(data.request.document, commands); // Validate graph and captured targets; no kernel or JS runs server-side.
      response = { commands, explanation: args.explanation || '' };
    }
    if (data.response) {
      if (canonical(data.response) !== canonical(response)) throw new Error('この依頼は回答済みです');
    } else {
      try { await store.put(args.requestId, { ...data, response }, etag); }
      catch (error) { const latest = (await store.get(args.requestId)).data; if (latest.cancelled || canonical(latest.response ?? null) !== canonical(response)) throw error; }
    }
    return { status: 'proposed', requestId: args.requestId, applied: false };
  }
  throw new Error('未対応のツールです');
}

const MODERN = '2026-07-28', LEGACY = '2025-03-26';
const INFO = { name: 'oshida-personal-cad', version: '3.0.0' };
function rpcError(id, code, message, status = 200, data) { return json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, status); }
function headerName(value) {
  if (value?.startsWith('=?base64?') && value.endsWith('?=')) { try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.slice(9, -2)), c => c.charCodeAt(0))); } catch { return null; } }
  return value;
}
function eventsOf(env, user) { return createEvents(env.CAD_EXCHANGE, user, { webhookFetch }); }
function mcpDiagnostic(request, rpc, reason) {
  // Fixed labels and presence flags only: never log body values, credentials,
  // request IDs, tool arguments, callback addresses, or user identity.
  const methods = ['initialize', 'server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe', 'ping', 'notifications/initialized'];
  const meta = rpc?.params?._meta;
  console.warn(JSON.stringify({ event: 'cad.mcp.rejected', reason,
    method: methods.includes(rpc?.method) ? rpc.method : 'other',
    protocol: [MODERN, LEGACY].includes(request.headers.get('MCP-Protocol-Version')) ? request.headers.get('MCP-Protocol-Version') : 'other-or-absent',
    hasMethodHeader: request.headers.has('Mcp-Method'), hasNameHeader: request.headers.has('Mcp-Name'),
    hasMetadata: !!object(meta), hasMetadataVersion: typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string',
    hasClientCapabilities: !!object(meta?.['io.modelcontextprotocol/clientCapabilities']) }));
}
async function mcp(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: request.method === 'GET' ? 405 : 400 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return rpcError(null, -32012, 'Forbidden origin', 403);
  let rpc; try { rpc = await readBody(request); } catch { mcpDiagnostic(request, null, 'parse-error'); return rpcError(null, -32700, 'Parse error', 400); }
  if (!object(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || rpc.params !== undefined && !object(rpc.params)) return rpcError(rpc?.id, -32600, 'Invalid Request', 400);
  const version = request.headers.get('MCP-Protocol-Version'), metaVersion = rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const modern = rpc.method === 'server/discover' || rpc.method.startsWith('events/') || metaVersion !== undefined || version === MODERN;
  // Sites' authenticated dispatch currently omits MCP2 mirrored method/name
  // headers (confirmed in production discovery). Adapt only that trusted
  // ingress; this is a hosting compatibility boundary, not relaxed MCP2
  // validation for direct traffic. Never replace an explicitly supplied header.
  const sitesIngress = request.headers.get('x-dispatched-app') === 'site---6abe87fa3e3481919fe3e891c4e6f082' && !!request.headers.get('oai-authenticated-user-id');
  const methodHeader = request.headers.get('Mcp-Method') ?? (sitesIngress ? rpc.method : null);
  const nameHeader = request.headers.get('Mcp-Name');
  const toolName = nameHeader === null && sitesIngress ? rpc.params?.name : headerName(nameHeader);
  if (modern) {
    if (!object(rpc.params?._meta) || typeof metaVersion !== 'string' || !object(rpc.params._meta['io.modelcontextprotocol/clientCapabilities'])) { mcpDiagnostic(request, rpc, 'metadata-missing'); return rpcError(rpc.id, -32602, 'Required MCP request metadata missing', 400); }
    if (version !== metaVersion || methodHeader !== rpc.method || rpc.method === 'tools/call' && toolName !== rpc.params?.name) { mcpDiagnostic(request, rpc, 'header-mismatch'); return rpcError(rpc.id, -32020, 'HeaderMismatch', 400); }
    if (version !== MODERN) return rpcError(rpc.id, -32022, 'UnsupportedProtocolVersionError', 400, { supported: [MODERN], requested: version });
  } else if (version && version !== LEGACY) return rpcError(rpc.id, -32022, 'UnsupportedProtocolVersionError', 400, { supported: [MODERN, LEGACY], requested: version });
  let result;
  try {
    if (rpc.method === 'server/discover') result = { supportedVersions: [MODERN], capabilities: { tools: {}, events: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': INFO } };
    else if (rpc.method === 'initialize' && !modern) result = { protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: INFO };
    else if (rpc.method.startsWith('notifications/') && !modern) return new Response(null, { status: 202 });
    else if (rpc.method === 'ping') result = {};
    else if (rpc.method === 'tools/list') result = { tools: TOOLS };
    else if (rpc.method === 'tools/call') {
      const user = userOf(request); // Never manufacture a user from service access.
      if (!TOOLS.some(t => t.name === rpc.params?.name)) return rpcError(rpc.id, -32602, 'Unknown tool', 400);
      try { const value = await callTool(rpc.params?.name, rpc.params?.arguments ?? {}, storage(env, user), eventsOf(env, user)); result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
      catch (e) { result = { content: [{ type: 'text', text: e instanceof EventError ? e.message : e.message }], isError: true }; }
    } else if (rpc.method.startsWith('events/')) {
      const user = userOf(request), events = eventsOf(env, user);
      if (rpc.method === 'events/list') {
        if (rpc.params?.cursor != null) throw new EventError(-32602, 'Invalid cursor');
        result = { events: [EVENT] };
      } else if (rpc.method === 'events/subscribe') result = await events.subscribe(rpc.params);
      else if (rpc.method === 'events/unsubscribe') result = await events.unsubscribe(rpc.params);
      else return rpcError(rpc.id, -32601, 'Method not found', 404);
    } else return rpcError(rpc.id, -32601, 'Method not found', 404);
  } catch (e) {
    if (e.status === 401) return rpcError(rpc.id, -32012, 'Authentication required', 401);
    return rpcError(rpc.id, e.code ?? -32603, e instanceof EventError ? e.message : 'Internal error', 200, e.data);
  }
  return json({ jsonrpc: '2.0', id: rpc.id ?? null, result: { ...(modern ? { resultType: 'complete' } : {}), ...result } });
}

export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/mcp') return await mcp(request, env);
    if (!url.pathname.startsWith('/api/cad/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    const user = userOf(request), store = storage(env, user), events = eventsOf(env, user);
    const readCurrent = async id => { try { return (await store.get(id)).data; } catch (error) { if (error.status === 404) return null; throw error; } };
    const dispatch = id => { const work = events.dispatch(id, readCurrent).catch(() => {}); if (ctx?.waitUntil) ctx.waitUntil(work); return work; };
    if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'このサイトから操作してください' }, 403);
    if (url.pathname === '/api/cad/connection' && request.method === 'GET') return json(await events.status());
    if (url.pathname === '/api/cad/requests' && request.method === 'POST') {
      const body = await readBody(request); exact(body, ['requestId', 'request']); idOf(body.requestId);
      const r = body.request; exact(r, ['task', 'prompt', 'document', 'sketchDraft', 'activeGroup', 'features', 'selectionGroups', 'contract']);
      if (!['sketch', 'edit'].includes(r.task) || typeof r.prompt !== 'string' || r.prompt.length > 8000) throw new Error('依頼が不正です');
      const document = validateAndMigrateModelDocument(r.document);
      if (r.task === 'sketch') validateDraft(r.sketchDraft);
      const safe = { task: r.task, prompt: r.prompt, document, ...(r.task === 'sketch' ? { sketchDraft: r.sketchDraft } : {}), ...(r.activeGroup ? { activeGroup: r.activeGroup } : {}) };
      const saved = { requestId: body.requestId, request: safe, createdAt: new Date().toISOString(), cancelled: false };
      await store.put(body.requestId, saved);
      let subscribed = 0, notificationError = false;
      try { subscribed = await events.queue(saved, url.origin); if (ctx?.waitUntil) dispatch(body.requestId); else await dispatch(body.requestId); }
      catch { notificationError = true; }
      return json({ requestId: body.requestId, webhook: { connected: subscribed > 0, notificationError } }, 201);
    }
    const match = url.pathname.match(/^\/api\/cad\/requests\/([a-f0-9-]{36})(\/cancel)?$/);
    if (!match) return json({ error: 'Not found' }, 404);
    const { data, etag } = await store.get(match[1]);
    if (match[2] && request.method === 'POST') { await store.put(match[1], { ...data, cancelled: true }, etag); return json({ cancelled: true }); }
    if (!match[2] && request.method === 'GET') {
      if (!data.cancelled && !data.response) {
        // Repair an interrupted queue write, but never replay pre-subscription requests.
        await events.queue(data, url.origin);
        if (ctx?.waitUntil) dispatch(match[1]); else await dispatch(match[1]);
      }
      return json({ response: data.response || null, cancelled: data.cancelled, webhook: { ...await events.status(data.request.task), ...await events.deliveryStatus(match[1]) } });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) { return json({ error: e.message || '接続を利用できません' }, e.status || 400); }
} };
