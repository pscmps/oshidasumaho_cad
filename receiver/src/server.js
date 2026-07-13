import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { handleUploadedStl } from './print-pipeline.js';
import { saveStl } from './stl-store.js';
import { parseSliceOptions } from './slice-options.js';

const ALLOWED_CONTENT_TYPES = new Set(['model/stl', 'application/octet-stream']);
const CAD_PATH = '/oshidasumaho_cad/';
const STATIC_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);
let uploadInProgress = false;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function contentTypeBase(req) {
  return String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function isAuthorized(req, token) {
  if (!token) return true;
  return req.headers['x-receiver-token'] === token;
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`Upload exceeds limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

async function handleUpload(req, res, config) {
  if (!isAuthorized(req, config.token)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  const type = contentTypeBase(req);
  if (!ALLOWED_CONTENT_TYPES.has(type)) {
    sendJson(res, 415, {
      ok: false,
      error: 'Unsupported Content-Type',
      allowed: Array.from(ALLOWED_CONTENT_TYPES),
    });
    return;
  }

  if (uploadInProgress) {
    sendJson(res, 409, { ok: false, error: 'Another upload/print job is already being processed' });
    return;
  }

  uploadInProgress = true;
  try {
    const sliceOptions = parseSliceOptions(req.headers);
    const body = await readBody(req, config.maxUploadBytes);
    const upload = await saveStl({
      uploadDir: config.uploadDir,
      body,
      originalName: req.headers['x-filename'],
    });
    const pipeline = await handleUploadedStl(upload, config, sliceOptions);

    console.log('[upload] saved', {
      id: upload.id,
      filename: upload.filename,
      bytes: upload.bytes,
      remoteAddress: req.socket.remoteAddress,
      sliceOptions,
    });

    sendJson(res, 201, {
      ok: true,
      upload: {
        id: upload.id,
        filename: upload.filename,
        bytes: upload.bytes,
      },
      pipeline,
      sliceOptions,
    });
  } catch (error) {
    console.error('[upload] failed', error);
    sendJson(res, 400, { ok: false, error: error.message });
  } finally {
    uploadInProgress = false;
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Content-Length': '0' });
  res.end();
}

async function serveCadAsset(req, res, config, pathname) {
  const relativePath = pathname === CAD_PATH
    ? 'index.html'
    : decodeURIComponent(pathname.slice(CAD_PATH.length));
  const webRoot = resolve(config.webRoot);
  const filePath = resolve(webRoot, relativePath);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) return false;

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': STATIC_CONTENT_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': relativePath === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath).pipe(res);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function createServer(config) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://receiver.local').pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        localPrintUi: true,
        printerName: config.bambuPrinterName || null,
        autoPrint: config.autoPrint,
        tokenRequired: Boolean(config.token),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/upload') {
      await handleUpload(req, res, config);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/') {
      redirect(res, CAD_PATH);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/oshidasumaho_cad') {
      redirect(res, CAD_PATH);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith(CAD_PATH)) {
      if (await serveCadAsset(req, res, config, pathname)) return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  });
}

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log('[receiver] listening', {
    host: config.host,
    port: config.port,
    uploadDir: config.uploadDir,
    outputDir: config.outputDir,
    webRoot: config.webRoot,
    bambuStudioPath: config.bambuStudioPath,
    tokenRequired: Boolean(config.token),
  });
  console.log('[receiver] Tailscale/private-network use only. Do not expose this server to the internet.');
});
