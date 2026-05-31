import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const APP_VERSION = 'proto-2026-05-31-plan-08';
const FACE_ORDER = ['top', 'front', 'right'];
const FACE_LABELS = {
  top: '上面',
  front: '正面',
  right: '右側面',
};
const FACE_AXES = {
  top: { x: 'width', y: 'depth' },
  front: { x: 'width', y: 'height' },
  right: { x: 'depth', y: 'height' },
};
const DEFAULT_AREA_LOCKS = {
  top: false,
  front: false,
  right: false,
};
const DEFAULT_AREA_LOCK_CONSTRAINTS = {
  top: null,
  front: null,
  right: null,
};

const initialDocument = {
  extrude: 12,
  activeFace: 'top',
  areaLocks: DEFAULT_AREA_LOCKS,
  areaLockConstraints: DEFAULT_AREA_LOCK_CONSTRAINTS,
  viewMode: 'faces',
  rotation: { x: 24, y: -34, z: 0 },
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top' },
  ],
};

function normalizeFace(face) {
  if (face === 'left') {
    return 'front';
  }
  return FACE_ORDER.includes(face) ? face : 'top';
}

function normalizeDocument(document) {
  const activeFace = normalizeFace(document?.activeFace);
  const viewMode = document?.viewMode === '3d' ? '3d' : 'faces';
  const rotation = normalizeRotation(document?.rotation);
  const areaLocks = FACE_ORDER.reduce((locks, face) => ({
    ...locks,
    [face]: Boolean(document?.areaLocks?.[face]),
  }), DEFAULT_AREA_LOCKS);
  const areaLockConstraints = FACE_ORDER.reduce((constraints, face) => ({
    ...constraints,
    [face]: normalizeConstraint(document?.areaLockConstraints?.[face]),
  }), DEFAULT_AREA_LOCK_CONSTRAINTS);
  const shapes = Array.isArray(document?.shapes)
    ? document.shapes.map((shape) => ({
        ...shape,
        face: normalizeFace(shape.face ?? activeFace),
      }))
    : initialDocument.shapes;

  return {
    ...initialDocument,
    ...document,
    activeFace,
    areaLocks,
    areaLockConstraints,
    viewMode,
    rotation,
    shapes,
  };
}

function normalizeRotation(rotation) {
  return {
    x: clampValue(Number(rotation?.x) || 0, -180, 180),
    y: clampValue(Number(rotation?.y) || 0, -180, 180),
    z: clampValue(Number(rotation?.z) || 0, -180, 180),
  };
}

function loadDocument() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeDocument(JSON.parse(saved)) : normalizeDocument(initialDocument);
  } catch {
    return normalizeDocument(initialDocument);
  }
}

function getNextId(shapes) {
  return Math.max(0, ...shapes.map((shape) => shape.id)) + 1;
}

function getShapeLabel(shape) {
  return `${shape.type === 'rect' ? 'Rect' : 'Circle'} ${shape.id}`;
}

function clampRangeValue(value) {
  return Math.min(120, Math.max(0, value));
}

function getShapeBounds(shape) {
  if (shape.type === 'circle') {
    return {
      minX: clampRangeValue(shape.x - shape.r),
      maxX: clampRangeValue(shape.x + shape.r),
      minY: clampRangeValue(shape.y - shape.r),
      maxY: clampRangeValue(shape.y + shape.r),
    };
  }

  return {
    minX: clampRangeValue(shape.x),
    maxX: clampRangeValue(shape.x + shape.w),
    minY: clampRangeValue(shape.y),
    maxY: clampRangeValue(shape.y + shape.h),
  };
}

function getFaceBounds(shapes, face) {
  const addShapes = shapes.filter(
    (shape) => normalizeFace(shape.face) === face && shape.mode === 'add',
  );
  if (!addShapes.length) {
    return null;
  }

  return addShapes.reduce((bounds, shape) => {
    const shapeBounds = getShapeBounds(shape);
    if (!bounds) {
      return shapeBounds;
    }

    return {
      minX: Math.min(bounds.minX, shapeBounds.minX),
      maxX: Math.max(bounds.maxX, shapeBounds.maxX),
      minY: Math.min(bounds.minY, shapeBounds.minY),
      maxY: Math.max(bounds.maxY, shapeBounds.maxY),
    };
  }, null);
}

function getAllFaceBounds(shapes) {
  return Object.fromEntries(FACE_ORDER.map((face) => [face, getFaceBounds(shapes, face)]));
}

function getFaceConstraint(face, faceBounds) {
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => [
      sourceFace,
      sourceFace === face ? null : faceBounds[sourceFace],
    ]),
  );

  return getProjectedConstraint(face, sourceBoundsByFace);
}

function createEmptyConstraint() {
  return {
    minX: 0,
    maxX: 120,
    minY: 0,
    maxY: 120,
    constrainedX: false,
    constrainedY: false,
  };
}

function getProjectedConstraint(targetFace, sourceBoundsByFace) {
  const constraint = createEmptyConstraint();

  FACE_ORDER.forEach((sourceFace) => {
    const sourceBounds = sourceBoundsByFace[sourceFace];
    if (!sourceBounds) {
      return;
    }

    applyProjectedAxisConstraint(constraint, targetFace, sourceFace, 'x', sourceBounds);
    applyProjectedAxisConstraint(constraint, targetFace, sourceFace, 'y', sourceBounds);
  });

  return constraint;
}

function applyProjectedAxisConstraint(constraint, targetFace, sourceFace, sourceAxis, sourceBounds) {
  const sourceDimension = FACE_AXES[sourceFace][sourceAxis];
  const targetAxis = Object.entries(FACE_AXES[targetFace])
    .find(([, dimension]) => dimension === sourceDimension)?.[0];
  if (!targetAxis) {
    return;
  }

  const min = sourceAxis === 'x' ? sourceBounds.minX : sourceBounds.minY;
  const max = sourceAxis === 'x' ? sourceBounds.maxX : sourceBounds.maxY;
  if (targetAxis === 'x') {
    constraint.minX = Math.max(constraint.minX, min);
    constraint.maxX = Math.min(constraint.maxX, max);
    constraint.constrainedX = true;
  } else {
    constraint.minY = Math.max(constraint.minY, min);
    constraint.maxY = Math.min(constraint.maxY, max);
    constraint.constrainedY = true;
  }
}

function getLockConstraintForBounds(bounds) {
  if (!bounds) {
    return null;
  }

  return {
    ...bounds,
    constrainedX: true,
    constrainedY: true,
  };
}

function normalizeConstraint(constraint) {
  if (!constraint) {
    return null;
  }

  return {
    minX: clampRangeValue(Number(constraint.minX) || 0),
    maxX: clampRangeValue(Number(constraint.maxX) || 120),
    minY: clampRangeValue(Number(constraint.minY) || 0),
    maxY: clampRangeValue(Number(constraint.maxY) || 120),
    constrainedX: Boolean(constraint.constrainedX),
    constrainedY: Boolean(constraint.constrainedY),
  };
}

function getDocumentFaceConstraint(document, face, faceBounds = getAllFaceBounds(document.shapes)) {
  const normalizedFace = normalizeFace(face);
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => {
      const savedConstraint = normalizeConstraint(document.areaLockConstraints?.[sourceFace]);
      if (document.areaLocks?.[sourceFace] && savedConstraint) {
        return [sourceFace, savedConstraint];
      }
      return [sourceFace, sourceFace === normalizedFace ? null : faceBounds[sourceFace]];
    }),
  );

  return getProjectedConstraint(normalizedFace, sourceBoundsByFace);
}

function getLockedFaceConstraint(document, face) {
  const normalizedFace = normalizeFace(face);
  const sourceBoundsByFace = Object.fromEntries(
    FACE_ORDER.map((sourceFace) => [
      sourceFace,
      document.areaLocks?.[sourceFace]
        ? normalizeConstraint(document.areaLockConstraints?.[sourceFace])
        : null,
    ]),
  );

  return getProjectedConstraint(normalizedFace, sourceBoundsByFace);
}

function getAllDisplayConstraints(document, faceBounds = getAllFaceBounds(document.shapes)) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [face, getDocumentFaceConstraint(document, face, faceBounds)]),
  );
}

function getAllLockedConstraints(document) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [face, getLockedFaceConstraint(document, face)]),
  );
}

function hasAreaConstraint(constraint) {
  return (
    (constraint.constrainedX && constraint.maxX > constraint.minX) ||
    (constraint.constrainedY && constraint.maxY > constraint.minY)
  );
}

function isShapeWithinConstraint(shape, constraint) {
  const bounds = getShapeBounds(shape);
  return (
    bounds.minX >= constraint.minX &&
    bounds.maxX <= constraint.maxX &&
    bounds.minY >= constraint.minY &&
    bounds.maxY <= constraint.maxY
  );
}

function canLockFace(document, face, faceBounds = getAllFaceBounds(document.shapes)) {
  const normalizedFace = normalizeFace(face);
  const sourceConstraint = getLockConstraintForBounds(faceBounds[normalizedFace]);
  if (!sourceConstraint) {
    return false;
  }

  const proposedDocument = {
    ...document,
    areaLocks: {
      ...DEFAULT_AREA_LOCKS,
      ...document.areaLocks,
      [normalizedFace]: true,
    },
    areaLockConstraints: {
      ...DEFAULT_AREA_LOCK_CONSTRAINTS,
      ...document.areaLockConstraints,
      [normalizedFace]: sourceConstraint,
    },
  };
  const lockedConstraints = getAllLockedConstraints(proposedDocument);

  return document.shapes.every((shape) =>
    isShapeWithinConstraint(shape, lockedConstraints[normalizeFace(shape.face)]),
  );
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function constrainShape(shape, constraint) {
  if (!constraint) {
    return shape;
  }

  if (shape.type === 'circle') {
    const maxR = Math.max(
      1,
      Math.min(
        60,
        (constraint.maxX - constraint.minX) / 2,
        (constraint.maxY - constraint.minY) / 2,
      ),
    );
    const r = clampValue(shape.r, 1, maxR);
    return {
      ...shape,
      r,
      x: clampValue(shape.x, constraint.minX + r, constraint.maxX - r),
      y: clampValue(shape.y, constraint.minY + r, constraint.maxY - r),
    };
  }

  const w = clampValue(shape.w, 1, Math.max(1, constraint.maxX - constraint.minX));
  const h = clampValue(shape.h, 1, Math.max(1, constraint.maxY - constraint.minY));
  return {
    ...shape,
    w,
    h,
    x: clampValue(shape.x, constraint.minX, constraint.maxX - w),
    y: clampValue(shape.y, constraint.minY, constraint.maxY - h),
  };
}

function applyAreaLocks(document) {
  const lockedConstraints = getAllLockedConstraints(document);
  return {
    ...document,
    shapes: document.shapes.map((shape) => {
      const face = normalizeFace(shape.face);
      const constraint = lockedConstraints[face];
      if (!hasAreaConstraint(constraint)) {
        return shape;
      }
      return constrainShape(shape, constraint);
    }),
  };
}

function getShapeControlLimits(shape, constraint, locked) {
  const fullConstraint = locked
    ? constraint
    : { minX: 0, maxX: 120, minY: 0, maxY: 120 };

  if (shape.type === 'circle') {
    const rMax = Math.max(
      1,
      Math.min(
        60,
        shape.x - fullConstraint.minX,
        fullConstraint.maxX - shape.x,
        shape.y - fullConstraint.minY,
        fullConstraint.maxY - shape.y,
      ),
    );
    return {
      x: { min: fullConstraint.minX + shape.r, max: fullConstraint.maxX - shape.r },
      y: { min: fullConstraint.minY + shape.r, max: fullConstraint.maxY - shape.r },
      r: { min: 1, max: rMax },
    };
  }

  return {
    x: { min: fullConstraint.minX, max: Math.max(fullConstraint.minX, fullConstraint.maxX - shape.w) },
    y: { min: fullConstraint.minY, max: Math.max(fullConstraint.minY, fullConstraint.maxY - shape.h) },
    w: { min: 1, max: Math.max(1, fullConstraint.maxX - shape.x) },
    h: { min: 1, max: Math.max(1, fullConstraint.maxY - shape.y) },
  };
}

function getLockedRangeForDimension(document, dimension) {
  const ranges = FACE_ORDER.flatMap((face) => {
    if (!document.areaLocks?.[face]) {
      return [];
    }
    const constraint = normalizeConstraint(document.areaLockConstraints?.[face]);
    if (!constraint) {
      return [];
    }

    return Object.entries(FACE_AXES[face])
      .filter(([, axisDimension]) => axisDimension === dimension)
      .map(([axis]) => ({
        min: axis === 'x' ? constraint.minX : constraint.minY,
        max: axis === 'x' ? constraint.maxX : constraint.maxY,
      }));
  });

  if (!ranges.length) {
    return null;
  }

  const min = Math.max(...ranges.map((range) => range.min));
  const max = Math.min(...ranges.map((range) => range.max));
  return max > min ? { min, max, size: max - min } : null;
}

function getLockedPreviewDimensions(document) {
  if (!FACE_ORDER.every((face) => document.areaLocks?.[face])) {
    return null;
  }

  const width = getLockedRangeForDimension(document, 'width');
  const depth = getLockedRangeForDimension(document, 'depth');
  const height = getLockedRangeForDimension(document, 'height');
  if (!width || !depth || !height) {
    return null;
  }

  return { width, depth, height };
}

function App() {
  const [document, setDocument] = useState(loadDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [preview3DSelected, setPreview3DSelected] = useState(false);
  const [fullPreviewFace, setFullPreviewFace] = useState(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const activeFace = normalizeFace(document.activeFace);
  const activeShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === activeFace);
  const faceBounds = useMemo(() => getAllFaceBounds(document.shapes), [document.shapes]);
  const lockedConstraints = useMemo(() => getAllLockedConstraints(document), [document]);
  const areaLockAvailability = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, canLockFace(document, face, faceBounds)])),
    [document, faceBounds],
  );
  const previewDimensions = useMemo(() => getLockedPreviewDimensions(document), [document]);
  const jsonText = useMemo(() => JSON.stringify(document, null, 2), [document]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

  useEffect(() => {
    const editor = editorRefs.current.get(selectedId);
    const panel = controlPanelRef.current;
    if (!selectedId && panel) {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (editor && panel) {
      const panelRect = panel.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const targetTop = panel.scrollTop + editorRect.top - panelRect.top - 18;
      panel.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }, [selectedId, activeFace]);

  function updateDocument(patch) {
    setDocument((current) => ({ ...current, ...patch }));
  }

  function updateRotation(axis, value) {
    setDocument((current) => ({
      ...current,
      rotation: normalizeRotation({
        ...current.rotation,
        [axis]: value,
      }),
    }));
  }

  function updateShape(id, patch) {
    setPreview3DSelected(false);
    setDocument((current) => applyAreaLocks({
      ...current,
      activeFace: patch.face ? normalizeFace(patch.face) : current.activeFace,
      shapes: current.shapes.map((shape) => {
        if (shape.id !== id) {
          return shape;
        }
        const nextShape = { ...shape, ...patch };
        const face = normalizeFace(nextShape.face);
        const constraint = getLockedFaceConstraint(current, face);
        if (!hasAreaConstraint(constraint)) {
          return nextShape;
        }
        return constrainShape(nextShape, constraint);
      }),
    }));
  }

  function addShape(type) {
    setPreview3DSelected(false);
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shapeBase =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face };
      const constraint = getLockedFaceConstraint(current, face);
      const shape = hasAreaConstraint(constraint)
        ? constrainShape(shapeBase, constraint)
        : shapeBase;
      setSelectedId(id);
      return applyAreaLocks({ ...current, shapes: [...current.shapes, shape] });
    });
  }

  function removeShape(id) {
    setPreview3DSelected(false);
    setDocument((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== id);
      if (selectedId === id) {
        setSelectedId(nextShapes[0]?.id ?? null);
      }
      return applyAreaLocks({ ...current, shapes: nextShapes });
    });
  }

  function selectShape(id) {
    setPreview3DSelected(false);
    if (!id) {
      setSelectedId(null);
      return;
    }

    const shape = document.shapes.find((item) => item.id === id);
    if (shape) {
      updateDocument({ activeFace: normalizeFace(shape.face) });
    }
    setSelectedId(id);
  }

  function moveShape(id, direction) {
    setDocument((current) => {
      const shape = current.shapes.find((item) => item.id === id);
      if (!shape) {
        return current;
      }

      const faceShapes = current.shapes.filter((item) => normalizeFace(item.face) === normalizeFace(shape.face));
      const faceIndex = faceShapes.findIndex((item) => item.id === id);
      const nextFaceShape = faceShapes[faceIndex + direction];
      if (!nextFaceShape) {
        return current;
      }

      const index = current.shapes.findIndex((item) => item.id === id);
      const nextIndex = current.shapes.findIndex((item) => item.id === nextFaceShape.id);
      const shapes = [...current.shapes];
      [shapes[index], shapes[nextIndex]] = [shapes[nextIndex], shapes[index]];
      return { ...current, shapes };
    });
  }

  function toggleAreaLock(face) {
    setPreview3DSelected(false);
    const normalizedFace = normalizeFace(face);
    setDocument((current) => {
      const currentLocks = { ...DEFAULT_AREA_LOCKS, ...current.areaLocks };
      const currentConstraints = {
        ...DEFAULT_AREA_LOCK_CONSTRAINTS,
        ...current.areaLockConstraints,
      };
      const nextLockValue = !currentLocks[normalizedFace];
      const nextConstraint = getLockConstraintForBounds(getFaceBounds(current.shapes, normalizedFace));
      if (nextLockValue && !canLockFace(current, normalizedFace)) {
        return current;
      }

      return applyAreaLocks({
        ...current,
        areaLocks: {
          ...currentLocks,
          [normalizedFace]: nextLockValue,
        },
        areaLockConstraints: {
          ...currentConstraints,
          [normalizedFace]: nextLockValue ? nextConstraint : null,
        },
      });
    });
  }

  function resetDocument() {
    setDocument(initialDocument);
    setSelectedId(initialDocument.shapes[0].id);
  }

  function setActiveFace(face) {
    setPreview3DSelected(false);
    updateDocument({ activeFace: normalizeFace(face) });
    setSelectedId(null);
  }

  function toggleFullPreview(face) {
    setPreview3DSelected(false);
    const normalizedFace = normalizeFace(face);
    updateDocument({ activeFace: normalizedFace });
    setSelectedId(null);
    setFullPreviewFace((current) => (current === normalizedFace ? null : normalizedFace));
  }

  function toggle3DPreview() {
    if (!previewDimensions) {
      return;
    }
    setDocument((current) => ({
      ...current,
      viewMode: current.viewMode === '3d' ? 'faces' : '3d',
    }));
    setFullPreviewFace(null);
    setSelectedId(null);
    setPreview3DSelected(true);
  }

  function select3DPreview() {
    if (!previewDimensions) {
      return;
    }
    setPreview3DSelected(true);
    setFullPreviewFace(null);
    setSelectedId(null);
  }

  return (
    <main className="app-shell">
      <section className="viewer-panel" aria-label="CAD viewer">
        <Viewer
          document={document}
          selectedId={selectedId}
          fullPreviewFace={fullPreviewFace}
          areaLocks={document.areaLocks}
          areaLockConstraints={document.areaLockConstraints}
          areaLockAvailability={areaLockAvailability}
          previewDimensions={previewDimensions}
          rotation={document.rotation}
          viewMode={document.viewMode}
          preview3DSelected={preview3DSelected}
          onSelect={selectShape}
          onFaceSelect={setActiveFace}
          onFaceDoubleSelect={toggleFullPreview}
          onAreaLockToggle={toggleAreaLock}
          on3DSelect={select3DPreview}
          on3DDoubleSelect={toggle3DPreview}
        />
      </section>

      <section ref={controlPanelRef} className="control-panel" aria-label="CAD controls">
        <header className="control-header">
          <div>
            <p className="eyebrow">Oshida Smartphone CAD</p>
            <h1>図形配置</h1>
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => addShape('rect')}>+四角</button>
            <button type="button" onClick={() => addShape('circle')}>+円</button>
          </div>
        </header>

        <div className="document-controls">
          <div className="active-face-control" aria-label="配置面">
            <span>配置面</span>
            <strong className={`face-label face-${activeFace}`}>
              {FACE_LABELS[activeFace]}
            </strong>
          </div>
          <label>
            押し出し
            <input
              type="number"
              min="1"
              value={document.extrude}
              onChange={(event) =>
                updateDocument({ extrude: Number(event.target.value) || 1 })
              }
            />
            <span>mm</span>
          </label>
          <button type="button" onClick={resetDocument}>初期化</button>
          <button type="button" onClick={() => setJsonOpen((open) => !open)}>
            JSON
          </button>
        </div>

        <div className="shape-list">
          {activeShapes.map((shape, index) => (
            <ShapeEditor
              key={shape.id}
              editorRef={(node) => {
                if (node) {
                  editorRefs.current.set(shape.id, node);
                } else {
                  editorRefs.current.delete(shape.id);
                }
              }}
              shape={shape}
              index={index}
              total={activeShapes.length}
              selected={shape.id === selectedId}
              locked={hasAreaConstraint(lockedConstraints[normalizeFace(shape.face)])}
              constraint={lockedConstraints[normalizeFace(shape.face)]}
              onSelect={() => selectShape(shape.id)}
              onChange={(patch) => updateShape(shape.id, patch)}
              onMove={moveShape}
              onRemove={removeShape}
            />
          ))}
        </div>

        {selectedShape ? (
          <p className="selection-note">
            選択中: {FACE_LABELS[normalizeFace(selectedShape.face)]} / {getShapeLabel(selectedShape)}
          </p>
        ) : (
          <p className="selection-note">
            {FACE_LABELS[activeFace]}の図形: {activeShapes.length}件
          </p>
        )}

        {(document.viewMode === '3d' || preview3DSelected) && previewDimensions ? (
          <RotationControls rotation={document.rotation} onChange={updateRotation} />
        ) : null}

        {jsonOpen ? <pre className="json-view">{jsonText}</pre> : null}
      </section>
    </main>
  );
}

function Viewer({
  document,
  selectedId,
  fullPreviewFace,
  areaLocks,
  areaLockConstraints,
  areaLockAvailability,
  previewDimensions,
  rotation,
  viewMode,
  preview3DSelected,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
  onAreaLockToggle,
  on3DSelect,
  on3DDoubleSelect,
}) {
  const activeFace = normalizeFace(document.activeFace);
  const previewFace = fullPreviewFace ? normalizeFace(fullPreviewFace) : null;
  const is3DMode = viewMode === '3d' && previewDimensions;
  const visibleFaces = previewFace ? [previewFace] : FACE_ORDER;
  const faceBounds = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, getFaceBounds(document.shapes, face)])),
    [document.shapes],
  );
  const faceConstraints = useMemo(
    () => getAllDisplayConstraints({ ...document, areaLocks, areaLockConstraints }, faceBounds),
    [document, areaLocks, areaLockConstraints, faceBounds],
  );
  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <span>3面図</span>
        <span>{APP_VERSION}</span>
        <span>{document.extrude}mm extrude</span>
      </div>
      <svg className="tri-view" viewBox="0 0 326 268" role="img" aria-label="3面配置図">
        <defs>
          <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee9" strokeWidth="0.35" />
          </pattern>
          {FACE_ORDER.map((face) => (
            <mask key={face} id={`body-mask-${face}`}>
              <rect width="120" height="120" fill="black" />
              {document.shapes
                .filter((shape) => normalizeFace(shape.face) === face)
                .map((shape) => (
                  <MaskShape key={shape.id} shape={shape} />
                ))}
            </mask>
          ))}
        </defs>
        {is3DMode ? (
          <IsometricPreview
            dimensions={previewDimensions}
            rotation={rotation}
            expanded
            onDoubleSelect={on3DDoubleSelect}
          />
        ) : (
          <>
            {visibleFaces.map((face) => (
              <FacePlan
                key={face}
                face={face}
                active={face === activeFace}
                full={Boolean(previewFace)}
                shapes={document.shapes.filter((shape) => normalizeFace(shape.face) === face)}
                constraint={faceConstraints[face]}
                selectedId={selectedId}
                onSelect={onSelect}
                onFaceSelect={onFaceSelect}
                onFaceDoubleSelect={onFaceDoubleSelect}
              />
            ))}
            {visibleFaces.map((face) => (
              <AreaLockButton
                key={`lock-${face}`}
                face={face}
                full={Boolean(previewFace)}
                locked={Boolean(areaLocks?.[face])}
                disabled={!areaLocks?.[face] && !areaLockAvailability?.[face]}
                onToggle={onAreaLockToggle}
              />
            ))}
            {!previewFace && previewDimensions ? (
              <IsometricPreview
                dimensions={previewDimensions}
                rotation={rotation}
                selected={preview3DSelected}
                onSelect={on3DSelect}
                onDoubleSelect={on3DDoubleSelect}
              />
            ) : null}
          </>
        )}
      </svg>
      <div className="viewer-legend">
        {FACE_ORDER.map((face) => (
          <span key={face}><i className={`face-swatch face-${face}`} /> {FACE_LABELS[face]}</span>
        ))}
      </div>
    </div>
  );
}

function getAreaLockTransform(face, full) {
  if (full) {
    return 'translate(48 22)';
  }
  if (face === 'right') {
    return 'translate(270 190)';
  }
  if (face === 'front') {
    return 'translate(6 190)';
  }
  return 'translate(6 54)';
}

function AreaLockButton({ face, full, locked, disabled, onToggle }) {
  return (
    <g
      className={`area-lock-button face-${face} ${locked ? 'locked' : ''} ${disabled ? 'disabled' : ''}`}
      transform={getAreaLockTransform(face, full)}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${FACE_LABELS[face]} エリアロック`}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) {
          onToggle(face);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
          event.preventDefault();
          onToggle(face);
        }
      }}
    >
      <rect width="50" height="24" rx="5" />
      <text x="25" y="16">エリア</text>
      <text x="43" y="16">🔒</text>
    </g>
  );
}

function rotatePoint(point, rotation) {
  const xRad = (rotation.x * Math.PI) / 180;
  const yRad = (rotation.y * Math.PI) / 180;
  const zRad = (rotation.z * Math.PI) / 180;
  let { x, y, z } = point;
  let nextY = y * Math.cos(xRad) - z * Math.sin(xRad);
  let nextZ = y * Math.sin(xRad) + z * Math.cos(xRad);
  y = nextY;
  z = nextZ;

  let nextX = x * Math.cos(yRad) + z * Math.sin(yRad);
  nextZ = -x * Math.sin(yRad) + z * Math.cos(yRad);
  x = nextX;
  z = nextZ;

  nextX = x * Math.cos(zRad) - y * Math.sin(zRad);
  nextY = x * Math.sin(zRad) + y * Math.cos(zRad);
  return { x: nextX, y: nextY, z };
}

function IsometricPreview({
  dimensions,
  rotation,
  expanded = false,
  selected = false,
  onSelect,
  onDoubleSelect,
}) {
  const box = expanded
    ? { x: 30, y: 12, width: 266, height: 240, labelY: 238 }
    : { x: 198, y: 6, width: 120, height: 120, labelY: 116 };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (expanded ? 12 : 4) };
  const maxSize = Math.max(dimensions.width.size, dimensions.depth.size, dimensions.height.size);
  const scale = (expanded ? 96 : 48) / maxSize;
  const width = dimensions.width.size;
  const depth = dimensions.depth.size;
  const height = dimensions.height.size;
  const vertices = [
    { x: -width / 2, y: -depth / 2, z: -height / 2 },
    { x: width / 2, y: -depth / 2, z: -height / 2 },
    { x: width / 2, y: depth / 2, z: -height / 2 },
    { x: -width / 2, y: depth / 2, z: -height / 2 },
    { x: -width / 2, y: -depth / 2, z: height / 2 },
    { x: width / 2, y: -depth / 2, z: height / 2 },
    { x: width / 2, y: depth / 2, z: height / 2 },
    { x: -width / 2, y: depth / 2, z: height / 2 },
  ].map((point) => {
    const rotated = rotatePoint(point, rotation);
    return {
      ...rotated,
      sx: center.x + rotated.x * scale,
      sy: center.y - rotated.z * scale,
    };
  });
  const faces = [
    { className: 'iso-preview-top', indexes: [4, 5, 6, 7] },
    { className: 'iso-preview-right', indexes: [1, 2, 6, 5] },
    { className: 'iso-preview-front', indexes: [0, 1, 5, 4] },
  ].sort((a, b) => {
    const aDepth = a.indexes.reduce((sum, index) => sum + vertices[index].y, 0) / a.indexes.length;
    const bDepth = b.indexes.reduce((sum, index) => sum + vertices[index].y, 0) / b.indexes.length;
    return bDepth - aDepth;
  });
  const points = (indexes) => indexes.map((index) => `${vertices[index].sx},${vertices[index].sy}`).join(' ');

  return (
    <g
      className={`iso-preview ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''}`}
      aria-label="3Dプレビュー"
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleSelect();
      }}
    >
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx="4" />
      {faces.map((face) => (
        <polygon key={face.className} className={face.className} points={points(face.indexes)} />
      ))}
      <polyline className="iso-preview-edge" points={points([0, 1, 2, 3, 0, 4, 5, 6, 7, 4])} />
      <line className="iso-preview-edge" x1={vertices[1].sx} y1={vertices[1].sy} x2={vertices[5].sx} y2={vertices[5].sy} />
      <line className="iso-preview-edge" x1={vertices[2].sx} y1={vertices[2].sy} x2={vertices[6].sx} y2={vertices[6].sy} />
      <line className="iso-preview-edge" x1={vertices[3].sx} y1={vertices[3].sy} x2={vertices[7].sx} y2={vertices[7].sy} />
      <text x={box.x + box.width / 2} y={box.labelY}>3D preview</text>
    </g>
  );
}

function getFaceTransform(face, full) {
  if (full) {
    return 'translate(43 14) scale(2)';
  }
  if (face === 'top') {
    return 'translate(62 6)';
  }
  if (face === 'right') {
    return 'translate(198 142)';
  }
  return 'translate(62 142)';
}

function FacePlan({
  face,
  active,
  full,
  shapes,
  constraint,
  selectedId,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
}) {
  return (
    <g
      className={`face-plan face-${face} ${active ? 'active' : ''} ${full ? 'full' : ''}`}
      transform={getFaceTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={FACE_LABELS[face]}
      onClick={() => {
        onFaceSelect(face);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onFaceDoubleSelect(face);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onFaceSelect(face);
        }
      }}
    >
      <rect className="face-plan-bg" width="120" height="120" rx="2" />
      <rect width="120" height="120" fill="url(#grid)" />
      <line x1="0" y1="60" x2="120" y2="60" className="face-axis" />
      <line x1="60" y1="0" x2="60" y2="120" className="face-axis" />
      <rect
        className={`final-face face-${face}`}
        width="120"
        height="120"
        mask={`url(#body-mask-${face})`}
      />
      <ConstraintOverlay constraint={constraint} />
      {shapes.map((shape) => (
        <FinalOutline key={`outline-${shape.id}`} shape={shape} />
      ))}
      {shapes.map((shape) => (
        <ShapePreview
          key={shape.id}
          shape={shape}
          selected={shape.id === selectedId}
          onSelect={() => onSelect(shape.id)}
        />
      ))}
      <text className="face-plan-label" x="60" y="112">{FACE_LABELS[face]}</text>
    </g>
  );
}

function ConstraintOverlay({ constraint }) {
  const overlays = [];
  if (constraint?.constrainedX) {
    overlays.push(...getOutsideXRects(constraint));
  }
  if (constraint?.constrainedY) {
    overlays.push(...getOutsideYRects(constraint));
  }

  return overlays.map((rect, index) => (
    <rect
      key={`${rect.type}-${index}`}
      className={`constraint-mask ${rect.type}`}
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
    />
  ));
}

function getOutsideXRects(bounds) {
  return [
    { type: 'x', x: 0, y: 0, width: bounds.minX, height: 120 },
    { type: 'x', x: bounds.maxX, y: 0, width: 120 - bounds.maxX, height: 120 },
  ].filter((rect) => rect.width > 0.01);
}

function getOutsideYRects(bounds) {
  return [
    { type: 'y', x: 0, y: 0, width: 120, height: bounds.minY },
    { type: 'y', x: 0, y: bounds.maxY, width: 120, height: 120 - bounds.maxY },
  ].filter((rect) => rect.height > 0.01);
}

function MaskShape({ shape }) {
  const fill = shape.mode === 'cut' ? 'black' : 'white';
  if (shape.type === 'circle') {
    return <circle cx={shape.x} cy={shape.y} r={shape.r} fill={fill} />;
  }

  return (
    <rect
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
      fill={fill}
    />
  );
}

function FinalOutline({ shape }) {
  const className = `final-outline face-${normalizeFace(shape.face)}`;
  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
      />
    );
  }

  return (
    <rect
      className={className}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
    />
  );
}

function ShapePreview({ shape, selected, onSelect }) {
  const className = `shape-preview ${shape.mode} face-${normalizeFace(shape.face)} ${selected ? 'selected' : ''}`;
  function handleSelect(event) {
    event.stopPropagation();
    onSelect();
  }

  function handleDoubleClick(event) {
    event.stopPropagation();
  }

  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }

  return (
    <rect
      className={className}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
    />
  );
}

function ShapeEditor({
  editorRef,
  shape,
  index,
  total,
  selected,
  locked,
  constraint,
  onSelect,
  onChange,
  onMove,
  onRemove,
}) {
  const limits = getShapeControlLimits(shape, constraint, locked);

  return (
    <article ref={editorRef} className={`shape-card ${selected ? 'selected' : ''}`}>
      <header className="shape-card-top">
        <button type="button" className="shape-title" onClick={onSelect}>
          {getShapeLabel(shape)}
        </button>
        <select
          className="mode-select"
          value={shape.mode}
          onChange={(event) => onChange({ mode: event.target.value })}
          aria-label={`${getShapeLabel(shape)} operation`}
        >
          <option value="add">add</option>
          <option value="cut">cut</option>
        </select>
        <select
          className="face-select"
          value={normalizeFace(shape.face)}
          onChange={(event) => onChange({ face: event.target.value })}
          aria-label={`${getShapeLabel(shape)} face`}
        >
          {FACE_ORDER.map((face) => (
            <option key={face} value={face}>{FACE_LABELS[face]}</option>
          ))}
        </select>
        <div className="shape-actions">
          <button type="button" onClick={() => onMove(shape.id, -1)} disabled={index === 0}>
            ↑
          </button>
          <button type="button" onClick={() => onMove(shape.id, 1)} disabled={index === total - 1}>
            ↓
          </button>
          <button type="button" className="danger" onClick={() => onRemove(shape.id)}>
            削除
          </button>
        </div>
      </header>

      <div className="shape-control-grid">
        <ControlField
          axis="x"
          label="X"
          value={shape.x}
          min={limits.x.min}
          max={limits.x.max}
          onChange={(x) => onChange({ x })}
        />
        <ControlField
          axis="y"
          label="Y"
          value={shape.y}
          min={limits.y.min}
          max={limits.y.max}
          invert
          onChange={(y) => onChange({ y })}
        />
        {shape.type === 'rect' ? (
          <>
            <ControlField
              axis="x"
              label="W"
              value={shape.w}
              min={limits.w.min}
              max={limits.w.max}
              onChange={(w) => onChange({ w })}
            />
            <ControlField
              axis="y"
              label="H"
              value={shape.h}
              min={limits.h.min}
              max={limits.h.max}
              onChange={(h) => onChange({ h })}
            />
          </>
        ) : (
          <>
            <ControlField
              axis="x"
              label="R"
              value={shape.r}
              min={limits.r.min}
              max={limits.r.max}
              onChange={(r) => onChange({ r })}
            />
            <div className="control-field empty" aria-hidden="true" />
          </>
        )}
      </div>
    </article>
  );
}

function RotationControls({ rotation, onChange }) {
  return (
    <section className="rotation-panel" aria-label="3D rotation controls">
      <div className="rotation-header">
        <span>3D回転</span>
      </div>
      <div className="rotation-grid">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="rotation-field">
            <span>{axis.toUpperCase()}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={rotation[axis]}
              onChange={(event) => onChange(axis, Number(event.target.value))}
            />
            <NumberField
              label={`${axis} rotation`}
              value={rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => onChange(axis, value)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function ControlField({ axis, label, value, min, max, invert = false, onChange }) {
  const sliderValue = invert ? max - value + min : value;

  function handleSliderChange(event) {
    const nextValue = Number(event.target.value);
    onChange(invert ? max - nextValue + min : nextValue);
  }

  return (
    <label className={`control-field ${axis === 'y' ? 'axis-y' : 'axis-x'}`}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={sliderValue}
        onChange={handleSliderChange}
      />
      <NumberField
        label={`${label} value`}
        value={value}
        min={min}
        max={max}
        compact
        onChange={onChange}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, compact = false, onChange }) {
  return (
    <label className={compact ? 'number-field compact' : 'number-field'}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
