// CAD entities and display boundaries have separate responsibilities.
export function classifyEdges(oc, candidates) {
  const edges = candidates.filter(c => c.entityType === 'edge');
  const adjacency = new Map(edges.map(c => [c.entity.hashCode, []]));
  for (const face of candidates.filter(c => c.entityType === 'face')) {
    const boundaries = face.entity.edges;
    try { for (const edge of boundaries) {
      const list = adjacency.get(edge.hashCode); if (list && !list.includes(face)) list.push(face);
    } } finally { boundaries.forEach(e => e.delete()); }
  }
  return new Map(edges.map(c => {
    const faces = adjacency.get(c.entity.hashCode);
    const seam = faces.some(f => oc.BRep_Tool.IsClosed_2(c.entity.wrapped, f.entity.wrapped));
    let tangent = false;
    if (!seam && faces.length === 2) {
      const [a, b] = faces.map(f => f.entity);
      if (oc.BRep_Tool.HasContinuity_1(c.entity.wrapped, a.wrapped, b.wrapped))
        tangent = oc.BRep_Tool.Continuity_1(c.entity.wrapped, a.wrapped, b.wrapped).value > 0;
      if (!tangent && a.geomType === 'PLANE' && b.geomType === 'PLANE') {
        const na = a.normalAt(), nb = b.normalAt();
        try { tangent = na.getAngle(nb) < 0.1; } finally { na.delete(); nb.delete(); }
      }
      if (!tangent && (a.geomType !== 'PLANE' || b.geomType !== 'PLANE')) {
        // Some boolean operations omit the G1 continuity flag. Compare normals
        // on the actual shared edge, rather than at unrelated face centers.
        tangent = [0.2, 0.5, 0.8].every(t => {
          const point = c.entity.pointAt(t); let na, nb;
          try { na = a.normalAt(point); nb = b.normalAt(point); return na.getAngle(nb) < 0.1; }
          finally { point.delete(); na?.delete(); nb?.delete(); }
        });
      }
    }
    return [c.entity.hashCode, seam ? 'seam' : tangent ? 'tangent' : faces.length < 2 ? 'boundary' : 'crease'];
  }));
}
