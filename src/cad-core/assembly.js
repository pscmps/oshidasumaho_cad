import { validateReference } from './selectors.js';

// Separate assembly references from part topology. The existing XYZ/90-degree
// placement editor remains the executor until constraint solving is added.
export const ASSEMBLY_SCHEMA_VERSION = 1;
export const CONSTRAINT_TYPES = ['coaxial', 'coincident', 'distance', 'fixed', 'freeRotation'];
export function normalizeAssemblyStructure(assembly) {
  if (assembly.schemaVersion !== undefined && assembly.schemaVersion !== ASSEMBLY_SCHEMA_VERSION) throw new Error('未対応のassembly versionです。');
  const constraints = assembly.constraints || [];
  if (!Array.isArray(constraints)) throw new Error('assembly constraintsが不正です。');
  const instances = new Set(assembly.instances.map(i => i.id)), ids = new Set();
  constraints.forEach(c => {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || !CONSTRAINT_TYPES.includes(c.type)) throw new Error('assembly constraintが不正です。');
    ids.add(c.id);
    if (!Array.isArray(c.targets) || !c.targets.length) throw new Error('拘束対象が必要です。');
    c.targets.forEach(t => {
      if (!instances.has(t.instanceId)) throw new Error('拘束する部品がありません。');
      if (t.entity) validateReference(t.entity);
    });
    if (c.type === 'distance' && !Number.isFinite(c.distance)) throw new Error('拘束距離が不正です。');
  });
  return { ...assembly, schemaVersion: ASSEMBLY_SCHEMA_VERSION, constraints: structuredClone(constraints) };
}
