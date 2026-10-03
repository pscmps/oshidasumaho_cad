import { createMeshCache } from './mesh-cache.js';

let worker, serial = 0;
const jobs = new Map();
function request(data) {
  if (!worker) {
    worker = new Worker(new URL('./cad-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (job) data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
    };
    worker.onerror = () => {
      jobs.forEach(job => job.reject(new Error('CAD workerを起動できませんでした。ページを再読込してください。')));
      jobs.clear(); worker.terminate(); worker = undefined;
    };
  }
  return new Promise((resolve, reject) => { const id = ++serial; jobs.set(id, { resolve, reject }); worker.postMessage({ id, ...data }); });
}
export const evaluateInWorker = createMeshCache(document => request({ document, action: 'mesh' }));
export const exportInWorker = (document, format, name, resolution) => request({ document, action: 'export', format, name, resolution });
export const buildReplicadStepBlob = document => exportInWorker(document, 'step', document.partName);
