import { ensureReplicadReady } from './runtime.js';
import { evaluateDocument, meshDocument, exportEvaluated } from './evaluator.js';

// Serialize WASM jobs; UI and LLM requests live outside this worker.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, document, action, format, name, resolution } }) => {
  queue = queue.then(async () => {
    let evaluated;
    try {
      const replicad = await ensureReplicadReady();
      evaluated = evaluateDocument(replicad, document);
      const result = action === 'export' ? exportEvaluated(replicad, evaluated, format, name, resolution) : meshDocument(evaluated);
      self.postMessage({ id, result });
    } catch (error) {
      self.postMessage({ id, error: typeof error === 'number' ? `CADカーネルが形状を生成できません (${error})。寸法や対象を変更してください。` : error.message || String(error) });
    } finally { evaluated?.dispose(); }
  });
};
