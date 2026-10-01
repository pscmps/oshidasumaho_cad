import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GROUPS, referenceKey, resolveReference } from '../cad-core/selectors.js';

export const GROUP_COLORS = { red: '#df424b', green: '#168653', blue: '#3276dc' };
export const GROUP_LABELS = { red: '赤', green: '緑', blue: '青' };
export const ENTITY_LABELS = { face: '面', edge: 'ふち', body: '部品' };
// Every view renders the same evaluated CAD entities, including modifiers.
const PLANES = [
  { label: '正面', direction: [0, -1, 0], up: [0, 0, 1], axes: [0, 2] },
  { label: '立体' },
  { label: '上から', direction: [0, 0, 1], up: [0, 1, 0], axes: [0, 1] },
  { label: '右から', direction: [1, 0, 0], up: [0, 0, 1], axes: [1, 2] },
];

export default function NativeViewer({ mesh, ghost, groups, mode, paint, onSelect, status, view = '3d' }) {
  const container = useRef(), sceneRef = useRef(), callbacks = useRef();
  const [error, setError] = useState('');
  const [showEdges, setShowEdges] = useState(false);
  callbacks.current = { onSelect, mode, paint };
  useEffect(() => {
    const host = container.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('このブラウザでは立体表示を利用できません。メニューから元の3面編集を開けます。'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor('#f1f5fa', 1);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000);
    camera.up.set(0, 0, 1); camera.position.set(80, -100, 80);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x708090, 2.8));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(50, -80, 100); scene.add(light);
    const objects = new THREE.Group(), ghosts = new THREE.Group();
    scene.add(objects, ghosts);
    const planes = PLANES.map(p => p.direction ? new THREE.OrthographicCamera() : camera);
    const s = { scene, camera, planes, controls, renderer, objects, ghosts, faces: [], edges: [], size: 50, fitted: false, view: '3d', width: 1, height: 1 };
    sceneRef.current = s;
    const resize = () => {
      s.width = Math.max(1, host.clientWidth); s.height = Math.max(1, host.clientHeight);
      // Intrinsic canvas pixels must never become the grid's minimum width.
      renderer.setSize(s.width, s.height, false);
      camera.aspect = s.width / s.height; camera.updateProjectionMatrix(); fitPlanes(s);
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
    const pointers = new Set(), painted = new Set();
    let start, multiTouch = false;
    const pick = event => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const viewport = viewports(s).find(v => x >= v.x && x <= v.x + v.width && y >= v.y && y <= v.y + v.height);
      if (!viewport) return;
      pointer.set(2 * (x - viewport.x) / viewport.width - 1, 1 - 2 * (y - viewport.y) / viewport.height);
      scene.updateMatrixWorld(true); viewport.camera.updateMatrixWorld(true);
      ray.setFromCamera(pointer, viewport.camera);
      const faceHit = ray.intersectObjects(s.faces)[0];
      let hit = faceHit;
      if (callbacks.current.mode === 'edge') {
        const c = viewport.camera;
        const span = c.isOrthographicCamera ? c.top - c.bottom : 2 * c.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(c.fov / 2));
        ray.params.Line.threshold = span * 10 / viewport.height;
        hit = ray.intersectObjects(s.edges.filter(o => o.visible)).find(e => !faceHit || e.distance <= faceHit.distance + s.size * 0.015);
      }
      if (!hit) return;
      const ref = callbacks.current.mode === 'body' ? hit.object.userData.bodyReference : hit.object.userData.reference;
      const key = referenceKey(ref);
      if (callbacks.current.paint && painted.has(key)) return;
      painted.add(key); callbacks.current.onSelect(ref, callbacks.current.paint);
    };
    const down = e => {
      pointers.add(e.pointerId);
      if (pointers.size > 1) { multiTouch = true; return; }
      painted.clear(); start = { x: e.clientX, y: e.clientY };
    };
    const move = e => {
      if (callbacks.current.paint && pointers.size === 1 && !multiTouch && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) pick(e);
    };
    const up = e => {
      if (start && !multiTouch && (callbacks.current.paint || Math.hypot(e.clientX - start.x, e.clientY - start.y) < (e.pointerType === 'touch' ? 12 : 6))) pick(e);
      pointers.delete(e.pointerId);
      if (!pointers.size) { start = null; multiTouch = false; }
    };
    const cancel = () => { pointers.clear(); start = null; multiTouch = false; };
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
    let animation;
    const render = () => {
      animation = requestAnimationFrame(render); controls.update(); renderer.setScissorTest(true);
      for (const v of viewports(s)) {
        renderer.setViewport(v.x, s.height - v.y - v.height, v.width, v.height);
        renderer.setScissor(v.x, s.height - v.y - v.height, v.width, v.height); renderer.render(scene, v.camera);
      }
    }; render();
    return () => {
      cancelAnimationFrame(animation); observer.disconnect(); controls.dispose();
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
      disposeGroup(objects); disposeGroup(ghosts); renderer.dispose(); host.removeChild(canvas); sceneRef.current = null;
    };
  }, []);
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    s.view = view; s.controls.enabled = view === '3d';
    s.controls.mouseButtons.LEFT = paint ? null : THREE.MOUSE.ROTATE;
    s.controls.touches.ONE = paint ? null : THREE.TOUCH.ROTATE;
    if (view === 'projections') fitPlanes(s);
  }, [paint, view]);
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const oldBodies = s.bodyKey;
    disposeGroup(s.objects); s.faces = []; s.edges = [];
    s.bodyKey = mesh?.bodies.map(b => b.lineage[0]).join('|');
    if (!mesh) return;
    mesh.bodies.forEach(body => {
      body.faces.forEach(face => {
        const object = faceObject(face, false);
        object.userData = { reference: face.reference, lineage: body.lineage, bodyReference: body.bodyReference };
        s.objects.add(object); s.faces.push(object);
      });
      body.edges.forEach(edge => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(edge.lines, 3));
        const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#476078', depthTest: true }));
        line.userData = { reference: edge.reference, lineage: body.lineage, bodyReference: body.bodyReference, appearance: edge.appearance };
        s.objects.add(line); s.edges.push(line);
      });
    });
    if (mesh.bodies.length) {
      const bounds = new THREE.Box3().setFromObject(s.objects);
      s.size = Math.max(1, ...bounds.getSize(new THREE.Vector3()).toArray());
      if (!s.fitted || oldBodies !== s.bodyKey) { fitModel(s); s.fitted = true; }
      fitPlanes(s);
    } else s.fitted = false;
  }, [mesh]);
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const candidates = [...s.faces, ...s.edges].map(object => ({ ...object.userData.reference, lineage: object.userData.lineage, object }));
    mesh?.bodies.forEach(body => candidates.push({ ...body.bodyReference, lineage: body.lineage, body }));
    const colors = new Map();
    GROUPS.forEach(group => groups[group].forEach(ref => {
      try {
        const resolved = resolveReference(ref, candidates);
        if (ref.entityType === 'body') [...s.faces, ...s.edges].filter(o => o.userData.bodyReference.featureId === resolved.featureId).forEach(o => colors.set(o, GROUP_COLORS[group]));
        else colors.set(resolved.object, GROUP_COLORS[group]);
      } catch { /* Stale marks are never guessed. */ }
    }));
    s.faces.forEach(o => {
      const marked = colors.has(o);
      o.material.color.set(colors.get(o) || '#b8cfe5');
      // Older documents may contain coincident bodies. Keep the chosen entity
      // visible instead of letting another body's surface cover its mark.
      o.renderOrder = marked ? 1 : 0; o.material.polygonOffsetFactor = marked ? -1 : 1;
    });
    s.edges.forEach(o => {
      o.material.color.set(colors.get(o) || '#476078'); o.renderOrder = 2;
      o.visible = o.userData.appearance !== 'seam' && (colors.has(o) || o.userData.appearance !== 'tangent' && (showEdges || mode === 'edge' || view === 'projections'));
    });
  }, [groups, mesh, showEdges, mode, view]);
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    disposeGroup(s.ghosts);
    ghost?.bodies.forEach(body => body.faces.forEach(face => s.ghosts.add(faceObject(face, true))));
    if (s.ghosts.children.length) {
      s.size = Math.max(1, ...displayBounds(s).getSize(new THREE.Vector3()).toArray());
      if (!s.faces.length || ghost?.bodies.map(b => b.lineage[0]).join('|') !== mesh?.bodies.map(b => b.lineage[0]).join('|')) fitModel(s);
      fitPlanes(s);
    }
  }, [ghost]);
  return <div className={`native-viewer ${view === 'projections' ? 'native-projections' : ''}`}>
    <div ref={container} className="native-canvas" aria-label={view === 'projections' ? '立体と連動する3面図・タップで選択' : 'タップで面・ふち・部品を選ぶ立体'} />
    {view === 'projections' ? <div className="projection-labels" aria-hidden="true">{PLANES.map(p => <span key={p.label}>{p.label}</span>)}</div> : null}
    {view === '3d' ? <button type="button" className="native-edge-toggle" aria-pressed={showEdges} onClick={() => setShowEdges(!showEdges)}>輪郭線 {showEdges ? 'ON' : 'OFF'}</button> : null}
    <div className="native-viewer-note" role="status">{error || (ghost && !mesh?.bodies.length ? '提案をプレビュー中 · 適用すると選択できます' : status) || (view === 'projections' ? '3面図もタップで選択できます' : paint ? '1本指でなぞる · 2本指で移動 / 拡大' : 'タップで選択 · 1本指で回転 · 2本指で移動 / 拡大')}</div>
    <button className="native-fit" type="button" aria-label="部品を中央に戻す" onClick={() => { const s = sceneRef.current; if (s && (s.faces.length || s.ghosts.children.length)) { fitModel(s); fitPlanes(s); } }}>中央へ</button>
  </div>;
}
function viewports(s) {
  if (s.view !== 'projections') return [{ x: 0, y: 0, width: s.width, height: s.height, camera: s.camera }];
  return s.planes.map((camera, i) => ({ x: (i % 2) * s.width / 2, y: Math.floor(i / 2) * s.height / 2, width: s.width / 2, height: s.height / 2, camera }));
}
function fitModel(s) {
  if (!s.faces.length && !s.ghosts.children.length) return;
  const sphere = displayBounds(s).getBoundingSphere(new THREE.Sphere());
  const halfFov = THREE.MathUtils.degToRad(s.camera.fov / 2);
  const angle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * s.camera.aspect));
  const distance = Math.max(1, sphere.radius) / Math.sin(angle) * 1.18;
  // Reset pending damping and pan too, so recentering cannot drift back.
  const damping = s.controls.enableDamping;
  s.controls.enableDamping = false; s.controls.update(); s.controls.reset();
  s.controls.target.copy(sphere.center);
  s.camera.position.copy(sphere.center).add(new THREE.Vector3(1, -1.4, 1).normalize().multiplyScalar(distance));
  s.camera.near = Math.max(0.01, s.size / 1000); s.camera.far = Math.max(10000, distance * 100);
  s.camera.updateProjectionMatrix(); s.controls.update(); s.controls.saveState(); s.controls.enableDamping = damping;
}
function fitPlanes(s) {
  if (!s.faces.length && !s.ghosts.children.length) return;
  const bounds = displayBounds(s), center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).toArray(), aspect = s.width / s.height;
  PLANES.forEach((p, i) => {
    if (!p.direction) return;
    const camera = s.planes[i], halfHeight = Math.max(1, size[p.axes[1]], size[p.axes[0]] / aspect) * 0.7;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.near = 0.01; camera.far = s.size * 10 + 100;
    camera.up.fromArray(p.up); camera.position.copy(center).add(new THREE.Vector3(...p.direction).multiplyScalar(s.size * 3));
    camera.lookAt(center); camera.updateProjectionMatrix();
  });
}
function displayBounds(s) {
  const box = new THREE.Box3();
  if (s.faces.length) box.setFromObject(s.objects);
  if (s.ghosts.children.length) box.union(new THREE.Box3().setFromObject(s.ghosts));
  return box;
}
function faceObject(face, ghost) {
  const positions = face.triangles.flatMap(i => face.vertices.slice(i * 3, i * 3 + 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (face.normals?.length === face.vertices.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(face.triangles.flatMap(i => face.normals.slice(i * 3, i * 3 + 3)), 3));
  else geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: ghost ? '#f6a623' : '#b8cfe5', roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
    transparent: ghost, opacity: ghost ? 0.35 : 1, depthWrite: !ghost, polygonOffset: true, polygonOffsetFactor: ghost ? -2 : 1, polygonOffsetUnits: 1,
  }));
}
function disposeGroup(group) {
  group.children.slice().forEach(o => { o.geometry.dispose(); o.material.dispose(); group.remove(o); });
}
