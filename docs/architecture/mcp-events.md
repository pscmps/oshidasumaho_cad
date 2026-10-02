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
- Hosting compatibility: production Sites dispatch was observed sending authenticated `server/discover` with complete MCP2 metadata but without `Mcp-Method`. Only the exact existing Site dispatch marker together with Sites' trusted authenticated user ID permits restoring absent method/name mirrors from the parsed body. Supplied mirrors, protocol mismatches, missing metadata, other dispatches and unauthenticated traffic remain subject to strict validation. This adapts the current Sites ingress; direct MCP2 traffic still requires the official mirrored headers. It does not substitute a service identity or grant access to caller data.
- Rejection diagnostics log fixed method/reason/protocol labels and boolean presence flags only. They contain no caller identity, request ID, body values, tool arguments, callback URLs or credentials. Worker logs must be queried with `errors_only: false` to include these warning records.
- Legacy `initialize` and tools remain available using protocol `2025-03-26`.
- Event filter: `{}` for both tasks, or `{ "task": "sketch" }` / `{ "task": "edit" }`. Unknown fields and values are rejected.
- Data schema: `{ "requestId": "UUID", "task": "sketch | edit", "url": "Site URL" }`.
- Subscriptions have deterministic principal/URL/name/canonical-arguments IDs, a default 24-hour lifetime and a maximum 7-day lifetime. Null TTL is granted a finite lifetime. `cursor` is null, without replay.
- A fresh, signed callback challenge must succeed before activation. Successful verification is cached for five minutes for the same principal, callback, and signing key.
- Signing uses Standard Webhooks HMAC-SHA256 over `eventId.timestamp.exactBody`. Each delivery includes the subscription ID. Rotation signs with both keys for one minute.

## Security and storage

Sites ingress supplies the authenticated principal. Data, subscriptions, and outbox objects are isolated by that principal in the existing `CAD_EXCHANGE` R2 binding. A service token never substitutes for a signed-in user. Cross-origin browser writes and MCP requests are rejected.

Subscription state is a bounded owner-scoped CAS registry (maximum ten active subscriptions), avoiding count/write races and unbounded tombstone scans. Callback URLs and keys are server-only JSON fields, excluded from public responses, R2 listing metadata, browser assets, and logs. Unsubscribe removes the stored keys; re-subscription gets a new generation so old queued events cannot restart. Expiry is checked before each attempt.

HTTPS callbacks require port 443, no credentials or fragments, no IP literals or local hostnames, and no redirect following. The transport uses `redirect: manual` and explicitly rejects every 3xx, opaque redirect, or already-redirected response without reading or using Location. Cloudflare workerd rejects `redirect: error` before network I/O; that unsupported setting caused the production callback-verification TypeError on 2026-10-02. Manual mode preserves the no-redirect boundary while supporting the deployed runtime. Calls use only Cloudflare's ordinary global fetch, with `global_fetch_strictly_public` required in the Worker build. No service/VPC/origin binding, Host header override, custom DNS override, or raw socket is used. The transport relies on the runtime's public-address connection boundary; a DNS preflight followed by a second unpinned lookup is deliberately not used. Hosted Site callback destinations are also rejected.

## Retry bounds and limits

The event ID/body, attempts, lease, and delivery result are persisted. R2 conditional writes claim a delivery and cap attempts across restarts. Up to three attempts use exponential backoff, with five-second HTTP timeouts, inside the request's `waitUntil` budget. HTTP 408, 425, 429 and 5xx/network failures retry; 410 and 413 do not. A failed delivery does not delete its subscription.

There is no independent scheduler/queue service. If execution is interrupted, an unfinished delivery resumes only when this user's authenticated request polling reaches the Site again. Closing the CAD page can therefore delay recovery; this is bounded best-effort delivery, not an autonomous guaranteed queue. Fresh ingress authentication gates every batch. Pending requests that have been canceled or answered are not delivered. No historical event replay is advertised.

Identical `propose_cad_commands` calls are idempotent. Existing commands cannot be replaced. A clarification-only response may advance once to commands with an explicit user `clarificationAnswer` and the current `expectedResponseRevision`; the previous question and supplement are retained under CAS. Receiving a proposal does not emit another event, avoiding a feedback loop.

## Validation and connection gate

`npm test` includes MCP2/legacy discovery, auth isolation, header validation, callback proof and HMAC verification, rotation, filter matching, duplicate delivery claims, retries/410/413/425, restart recovery, subscription turnover, quota concurrency, and no-auto-apply request/proposal tests. `npm run build:site` builds the client and Cloudflare Worker.

The production connection is ready only after the existing plugin is rescanned, the harmless read succeeds, a real subscription callback verifies, and one explicit CAD request returns a visible proposal. A successful source publication alone is not that end-to-end verification.

## References

- https://developers.openai.com/plugins/build/mcp-events
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://blog.cloudflare.com/workers-environment-live-object-bindings/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public

## Written intent and clarification continuation

Explicit user-written dimensions and conditions take priority. Dimension fields and sketch geometry fill only unspecified details; a mismatch with default fields alone is not a reason to stop. Explicit corrections supersede the text they correct. Remaining contradictions within explicit text or an indeterminate essential target still require clarification. For reversible previews, the agent may use reasonable sketch-supported placement/extent assumptions, disclose them in the explanation, and wait for Apply.

A clarification-only response may advance to commands only after an explicit user supplement. Read `responseRevision` (legacy stored responses are revision 1), then call `propose_cad_commands` with `clarificationAnswer` containing the user supplement and `expectedResponseRevision`. The server requires a matching revision, preserves the previous question and supplement in `responseHistory`, increments the revision, and rejects any different replacement of an existing commands response. Identical retries do not increment or duplicate history. This does not emit another event. A policy change alone is not a user answer.

The browser keeps polling through clarification and displays the question while waiting. Submitted request IDs remain in the same Site URL as `cadRequest`. Reloading that URL resumes an authenticated read of the original snapshot and latest response without sending a new request. For a request created by an older client, open `?ai=1&cadRequest=<requestId>` on the same Site. Commands become a preview only; the original document/sketch stale checks remain authoritative. If the user changes the sketch/model instead, explicitly submit a new request with the updated text and snapshot.

Example: written outer diameter 30, inner diameter 20, height 30, and transverse hole diameter 3 resolve to 30 x 30 x 30 mm despite default fields 80 x 50 x 20. A top annulus combined with a rectangular front profile containing a radius 0.05 normalized circle at [0.5, 0.5] represents a Y-directed hole at height 15 through both walls. The centered, both-wall extent is an assumption to disclose, not a stated user requirement. This command cannot represent a blind or single-wall side hole. Kernel regression checks its bounds and removed volume; the original document remains unchanged until Apply.
