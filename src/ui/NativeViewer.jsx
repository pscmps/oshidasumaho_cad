import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GROUPS, referenceKey, resolveReference } from '../cad-core/selectors.js';

export const GROUP_COLORS = { red: '#e74b50', green: '#22a36a', blue: '#3986f3' };
export const GROUP_LABELS = { red: '赤 / A', green: '緑 / B', blue: '青 / 参照' };

export default function NativeViewer({ mesh, ghost, groups, mode, paint, onSelect, status }) {
  const container = useRef(), sceneRef = useRef(), callbacks = useRef();
  const [error, setError] = useState('');
  callbacks.current = { onSelect, mode, paint };
  useEffect(() => {
    const host = container.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('このブラウザではWebGLを利用できません。3面プレビューをご利用ください。'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor('#edf2f8', 1);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000);
    camera.up.set(0, 0, 1); camera.position.set(80, -100, 80);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x708090, 2.8));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(50, -80, 100); scene.add(light);
    const objects = new THREE.Group(), ghosts = new THREE.Group();
    scene.add(objects, ghosts);
    const state = { scene, camera, controls, renderer, objects, ghosts, faces: [], edges: [], size: 50, fitted: false };
    sceneRef.current = state;
    const resize = () => { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
    const pointers = new Set(), painted = new Set();
    let start, multiTouch = false;
    const pick = event => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height);
      ray.setFromCamera(pointer, camera);
      const faceHit = ray.intersectObjects(state.faces)[0];
      let hit = faceHit;
      if (callbacks.current.mode === 'edge') {
        ray.params.Line.threshold = camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 16 / rect.height;
        hit = ray.intersectObjects(state.edges).find(e => !faceHit || e.distance <= faceHit.distance + state.size * 0.015);
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
      if (callbacks.current.paint && pointers.size === 1 && !multiTouch && start
        && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) pick(e);
    };
    const up = e => {
      if (start && !multiTouch && (callbacks.current.paint || Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6)) pick(e);
      pointers.delete(e.pointerId);
      if (!pointers.size) { start = null; multiTouch = false; }
    };
    const cancel = () => { pointers.clear(); start = null; multiTouch = false; };
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
    let animation;
    const render = () => { animation = requestAnimationFrame(render); controls.update(); renderer.render(scene, camera); }; render();
    return () => {
      cancelAnimationFrame(animation); observer.disconnect(); controls.dispose();
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
      disposeGroup(objects); disposeGroup(ghosts); renderer.dispose(); host.removeChild(canvas); sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    s.controls.mouseButtons.LEFT = paint ? null : THREE.MOUSE.ROTATE;
    s.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    s.controls.touches.ONE = paint ? null : THREE.TOUCH.ROTATE;
  }, [paint]);

  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    disposeGroup(s.objects); s.faces = []; s.edges = [];
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
        const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#374f6b', depthTest: true }));
        line.userData = { reference: edge.reference, lineage: body.lineage, bodyReference: body.bodyReference };
        s.objects.add(line); s.edges.push(line);
      });
    });
    if (mesh.bodies.length) {
      const bounds = new THREE.Box3().setFromObject(s.objects), center = bounds.getCenter(new THREE.Vector3());
      s.size = Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
      if (!s.fitted) {
        s.controls.target.copy(center);
        s.camera.position.copy(center).add(new THREE.Vector3(1, -1.4, 1).multiplyScalar(s.size * 1.8));
        s.camera.near = Math.max(0.01, s.size / 1000); s.camera.far = Math.max(10000, s.size * 100);
        s.camera.updateProjectionMatrix(); s.controls.update(); s.fitted = true;
      }
    }
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
      } catch { /* stale marks stay in the document but are never guessed */ }
    }));
    s.faces.forEach(o => { o.material.color.set(colors.get(o) || '#adc5df'); });
    s.edges.forEach(o => { o.material.color.set(colors.get(o) || '#374f6b'); });
  }, [groups, mesh]);

  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    disposeGroup(s.ghosts);
    ghost?.bodies.forEach(body => body.faces.forEach(face => s.ghosts.add(faceObject(face, true))));
  }, [ghost]);

  return <div className="native-viewer">
    <div ref={container} className="native-canvas" aria-label="Face・Edgeを選択できる3Dモデル" />
    <div className="native-viewer-note">{error || status || (paint ? '1本指で塗る・2本指で回転 / 拡大' : 'タップで選択・ドラッグで回転・ピンチで拡大')}</div>
    <button className="native-fit" type="button" onClick={() => {
      const s = sceneRef.current; if (!s || !s.faces.length) return;
      const center = new THREE.Box3().setFromObject(s.objects).getCenter(new THREE.Vector3());
      s.controls.target.copy(center); s.camera.position.copy(center).add(new THREE.Vector3(1, -1.4, 1).multiplyScalar(s.size * 1.8));
    }}>全体表示</button>
  </div>;
}

function faceObject(face, ghost) {
  const positions = face.triangles.flatMap(i => face.vertices.slice(i * 3, i * 3 + 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: ghost ? '#f6a623' : '#adc5df', roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
    transparent: ghost, opacity: ghost ? 0.35 : 1, depthWrite: !ghost, polygonOffset: true, polygonOffsetFactor: ghost ? -2 : 1, polygonOffsetUnits: 1,
  }));
}
function disposeGroup(group) {
  group.children.slice().forEach(o => { o.geometry.dispose(); o.material.dispose(); group.remove(o); });
}
