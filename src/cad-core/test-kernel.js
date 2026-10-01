// Test-only Node loader for the same WASM build used in the browser worker.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as replicad from 'replicad';
import init from 'replicad-opencascadejs/src/replicad_single.js';

export async function testKernel() {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('replicad-opencascadejs/src/replicad_single.wasm');
  globalThis.require = require;
  globalThis.__dirname = dirname(wasmPath);
  const oc = await init({ wasmBinary: await readFile(wasmPath) });
  replicad.setOC(oc);
  return replicad;
}
