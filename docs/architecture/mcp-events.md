# CAD request events

This change belongs to the existing AI-native experimental branch and private Site. It does not merge into the smartphone CAD main branch, change the GitHub Pages workflow, change the Site audience, introduce another plugin, or use an external LLM API.

## User flow

1. Connect the existing Site plugin and rescan its MCP server after publication.
2. In dot, subscribe to `cad.request.created` and ask it to read each submitted request and return a CAD proposal.
3. The user explicitly submits a sketch/edit in the CAD UI. Saving a draft, changing the model, or receiving a proposal does not emit an event.
4. The event contains only request ID, task kind, Site URL, event ID and occurrence time. dot reads the full structured request through `read_cad_request` and calls `propose_cad_commands` with allowed commands or a clarification.
5. The same browser receives the response and evaluates/displays the ghost. Only the user's Apply action changes the model. Existing stale-document and stale-sketch checks remain in place.

`get_cad_connection_status` is a harmless authenticated read for connection checks. It exposes counts and expiry, never callback URLs or secrets. `list_cad_requests` remains available for manually processing an existing request. New subscriptions do not replay older requests.

## Wire contract

- Stateless `POST /mcp` implements `server/discover`, `tools/list`, `tools/call`, `events/list`, `events/subscribe`, and `events/unsubscribe` for protocol `2026-07-28`.
- Modern requests carry the protocol and client capabilities in `_meta`, plus matching `MCP-Protocol-Version`, `Mcp-Method`, and (for tools/call) `Mcp-Name` headers. Modern successes include `resultType: complete`.
- Legacy `initialize` and tools remain available using protocol `2025-03-26`.
- Event filter: `{}` for both tasks, or `{ "task": "sketch" }` / `{ "task": "edit" }`. Unknown fields and values are rejected.
- Data schema: `{ "requestId": "UUID", "task": "sketch | edit", "url": "Site URL" }`.
- Subscriptions have deterministic principal/URL/name/canonical-arguments IDs, a default 24-hour lifetime and a maximum 7-day lifetime. Null TTL is granted a finite lifetime. `cursor` is null, without replay.
- A fresh, signed callback challenge must succeed before activation. Successful verification is cached for five minutes for the same principal, callback, and signing key.
- Signing uses Standard Webhooks HMAC-SHA256 over `eventId.timestamp.exactBody`. Each delivery includes the subscription ID. Rotation signs with both keys for one minute.

## Security and storage

Sites ingress supplies the authenticated principal. Data, subscriptions, and outbox objects are isolated by that principal in the existing `CAD_EXCHANGE` R2 binding. A service token never substitutes for a signed-in user. Cross-origin browser writes and MCP requests are rejected.

Subscription state is a bounded owner-scoped CAS registry (maximum ten active subscriptions), avoiding count/write races and unbounded tombstone scans. Callback URLs and keys are server-only JSON fields, excluded from public responses, R2 listing metadata, browser assets, and logs. Unsubscribe removes the stored keys; re-subscription gets a new generation so old queued events cannot restart. Expiry is checked before each attempt.

HTTPS callbacks require port 443, no credentials or fragments, no IP literals or local hostnames, and no redirect following. Calls use only Cloudflare's ordinary global fetch, with `global_fetch_strictly_public` required in the Worker build. No service/VPC/origin binding, Host header override, custom DNS override, or raw socket is used. The transport relies on the runtime's public-address connection boundary; a DNS preflight followed by a second unpinned lookup is deliberately not used. Hosted Site callback destinations are also rejected.

## Retry bounds and limits

The event ID/body, attempts, lease, and delivery result are persisted. R2 conditional writes claim a delivery and cap attempts across restarts. Up to three attempts use exponential backoff, with five-second HTTP timeouts, inside the request's `waitUntil` budget. HTTP 408, 425, 429 and 5xx/network failures retry; 410 and 413 do not. A failed delivery does not delete its subscription.

There is no independent scheduler/queue service. If execution is interrupted, an unfinished delivery resumes only when this user's authenticated request polling reaches the Site again. Closing the CAD page can therefore delay recovery; this is bounded best-effort delivery, not an autonomous guaranteed queue. Fresh ingress authentication gates every batch. Pending requests that have been canceled or answered are not delivered. No historical event replay is advertised.

Identical `propose_cad_commands` calls are idempotent. Different second responses are rejected. Receiving a proposal does not emit another event, avoiding a feedback loop.

## Validation and connection gate

`npm test` includes MCP2/legacy discovery, auth isolation, header validation, callback proof and HMAC verification, rotation, filter matching, duplicate delivery claims, retries/410/413/425, restart recovery, subscription turnover, quota concurrency, and no-auto-apply request/proposal tests. `npm run build:site` builds the client and Cloudflare Worker.

The production connection is ready only after the existing plugin is rescanned, the harmless read succeeds, a real subscription callback verifies, and one explicit CAD request returns a visible proposal. A successful source publication alone is not that end-to-end verification.

## References

- https://developers.openai.com/plugins/build/mcp-events
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://blog.cloudflare.com/workers-environment-live-object-bindings/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
