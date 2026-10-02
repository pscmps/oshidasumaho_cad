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
  if (target.hostname === 'chatgpt.site' || target.hostname.endsWith('.chatgpt.site')) {
    console.warn(JSON.stringify({ event: 'cad.callback.transport', stage: 'destination-check', outcome: 'rejected', reason: 'hosted-site-destination' }));
    throw new EventError(-32602, 'Invalid callback destination');
  }
  console.info(JSON.stringify({ event: 'cad.callback.transport', stage: 'public-fetch', outcome: 'started' }));
  const classify = error => {
    // Compare locally but emit only fixed labels, never the exception text/URL.
    const message = String(error?.message ?? '');
    if (/timed? ?out|timeout/i.test(message)) return 'timeout';
    if (/dns|resolve|name.*not.*found/i.test(message)) return 'dns';
    if (/certificate|tls|ssl/i.test(message)) return 'tls';
    if (/redirect/i.test(message)) return 'redirect';
    if (/private|public.*address|strictly.public|same.zone|origin.*binding/i.test(message)) return 'address-boundary';
    if (/disallowed|not allowed|outside.*request|cannot.*i\/o|io.*context|not.*permitted/i.test(message)) return 'runtime-policy';
    return 'other';
  };
  try {
    return Promise.resolve(fetch(target.href, { method: 'POST', redirect: 'error', signal: options.signal, headers: options.headers, body: options.body })).catch(error => {
      console.warn(JSON.stringify({ event: 'cad.callback.transport', stage: 'public-fetch', outcome: 'rejected', reason: classify(error) })); throw error;
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'cad.callback.transport', stage: 'public-fetch', outcome: 'rejected', reason: classify(error) })); throw error;
  }
}
