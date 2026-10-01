let replicadReadyPromise = null;

export async function ensureReplicadReady() {
  if (!replicadReadyPromise) {
    replicadReadyPromise = Promise.all([
      import('replicad-opencascadejs/src/replicad_single.js'),
      import('replicad-opencascadejs/src/replicad_single.wasm?url'),
      import('replicad'),
    ]).then(async ([opencascadeModule, opencascadeWasmModule, replicad]) => {
      const opencascade = opencascadeModule.default;
      const opencascadeWasm = opencascadeWasmModule.default;
      const oc = await opencascade({
        locateFile: (path) => (path.endsWith('.wasm') ? opencascadeWasm : path),
      });
      replicad.setOC(oc);
      return replicad;
    }).catch(error => { replicadReadyPromise = null; throw error; });
  }
  return replicadReadyPromise;
}
