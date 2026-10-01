// Bridge exact-kernel meshes to the existing SVG preview / assembly projections.
export function meshToSurfaces(mesh) {
  return (mesh?.bodies || []).flatMap(body => body.faces.flatMap(face => {
    const surfaces = [];
    for (let i = 0; i < face.triangles.length; i += 3) {
      const ring = face.triangles.slice(i, i + 3).map(index => ({ x: face.vertices[index * 3], y: face.vertices[index * 3 + 1], z: face.vertices[index * 3 + 2] }));
      surfaces.push({ rings: [ring], className: 'iso-preview-top', edge: false });
    }
    return surfaces;
  }));
}
export const hasNativeGeometry = document => Boolean(document.cad?.features.length || document.cad?.suppressedProjection);
