import { callbackUrl, EventError } from './cad-events.js';

// Hosted-only transport. Cloudflare's ordinary global fetch connects through its
// public-address network; the build requires global_fetch_strictly_public so
// callbacks cannot bypass the public front door to an origin in the same zone.
// Do NOT replace this with a service/VPC binding, DNS-preflight + fetch, a Host
// override, resolveOverride, or a redirect-following client.
// https://blog.cloudflare.com/workers-environment-live-object-bindings/
// https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
export function webhookFetch(url, options) {
  const target = new URL(callbackUrl(url));
  // No callback into another hosted Site, including this application's ingress.
  if (target.hostname === 'chatgpt.site' || target.hostname.endsWith('.chatgpt.site')) throw new EventError(-32602, 'Invalid callback destination');
  return fetch(target.href, { method: 'POST', redirect: 'error', signal: options.signal, headers: options.headers, body: options.body });
}
