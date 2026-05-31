import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const APP_VERSION = 'proto-2026-05-31-plan-05';
const FACE_ORDER = ['top', 'front', 'right'];
const FACE_LABELS = {
  top: '上面',
  front: '正面',
  right: '右側面',
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
    shapes,
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
  const constraint = {
    minX: 0,
    maxX: 120,
    minY: 0,
    maxY: 120,
    constrainedX: false,
    constrainedY: false,
  };
  const topBounds = faceBounds.top;
  const frontBounds = faceBounds.front;
  const rightBounds = faceBounds.right;

  if (face === 'top' && frontBounds) {
    constraint.minX = frontBounds.minX;
    constraint.maxX = frontBounds.maxX;
    constraint.constrainedX = true;
  }
  if (face === 'front') {
    if (topBounds) {
      constraint.minX = topBounds.minX;
      constraint.maxX = topBounds.maxX;
      constraint.constrainedX = true;
    }
    if (rightBounds) {
      constraint.minY = rightBounds.minY;
      constraint.maxY = rightBounds.maxY;
      constraint.constrainedY = true;
    }
  }
  if (face === 'right' && frontBounds) {
    constraint.minY = frontBounds.minY;
    constraint.maxY = frontBounds.maxY;
    constraint.constrainedY = true;
  }

  return constraint;
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
  const savedConstraint = normalizeConstraint(document.areaLockConstraints?.[normalizedFace]);
  if (document.areaLocks?.[normalizedFace] && savedConstraint) {
    return savedConstraint;
  }

  return getFaceConstraint(normalizedFace, faceBounds);
}

function getAllDisplayConstraints(document, faceBounds = getAllFaceBounds(document.shapes)) {
  return Object.fromEntries(
    FACE_ORDER.map((face) => [face, getDocumentFaceConstraint(document, face, faceBounds)]),
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

function canLockFace(shapes, face, faceBounds = getAllFaceBounds(shapes)) {
  const constraint = getFaceConstraint(face, faceBounds);
  if (!hasAreaConstraint(constraint)) {
    return false;
  }

  return shapes
    .filter((shape) => normalizeFace(shape.face) === face)
    .every((shape) => isShapeWithinConstraint(shape, constraint));
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
  const faceBounds = getAllFaceBounds(document.shapes);
  return {
    ...document,
    shapes: document.shapes.map((shape) => {
      const face = normalizeFace(shape.face);
      if (!document.areaLocks?.[face]) {
        return shape;
      }
      return constrainShape(shape, getDocumentFaceConstraint(document, face, faceBounds));
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

function App() {
  const [document, setDocument] = useState(loadDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [fullPreviewFace, setFullPreviewFace] = useState(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const activeFace = normalizeFace(document.activeFace);
  const activeShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === activeFace);
  const faceBounds = useMemo(() => getAllFaceBounds(document.shapes), [document.shapes]);
  const faceConstraints = useMemo(
    () => getAllDisplayConstraints(document, faceBounds),
    [document, faceBounds],
  );
  const areaLockAvailability = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, canLockFace(document.shapes, face, faceBounds)])),
    [document.shapes, faceBounds],
  );
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

  function updateShape(id, patch) {
    setDocument((current) => applyAreaLocks({
      ...current,
      activeFace: patch.face ? normalizeFace(patch.face) : current.activeFace,
      shapes: current.shapes.map((shape) => {
        if (shape.id !== id) {
          return shape;
        }
        const nextShape = { ...shape, ...patch };
        const face = normalizeFace(nextShape.face);
        if (!current.areaLocks?.[face]) {
          return nextShape;
        }
        return constrainShape(nextShape, getDocumentFaceConstraint(current, face, getAllFaceBounds(current.shapes)));
      }),
    }));
  }

  function addShape(type) {
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shapeBase =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face };
      const shape = current.areaLocks?.[face]
        ? constrainShape(shapeBase, getDocumentFaceConstraint(current, face, getAllFaceBounds(current.shapes)))
        : shapeBase;
      setSelectedId(id);
      return applyAreaLocks({ ...current, shapes: [...current.shapes, shape] });
    });
  }

  function removeShape(id) {
    setDocument((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== id);
      if (selectedId === id) {
        setSelectedId(nextShapes[0]?.id ?? null);
      }
      return applyAreaLocks({ ...current, shapes: nextShapes });
    });
  }

  function selectShape(id) {
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
    const normalizedFace = normalizeFace(face);
    setDocument((current) => {
      const currentLocks = { ...DEFAULT_AREA_LOCKS, ...current.areaLocks };
      const currentConstraints = {
        ...DEFAULT_AREA_LOCK_CONSTRAINTS,
        ...current.areaLockConstraints,
      };
      const nextLockValue = !currentLocks[normalizedFace];
      const nextConstraint = getFaceConstraint(normalizedFace, getAllFaceBounds(current.shapes));
      if (nextLockValue && !canLockFace(current.shapes, normalizedFace)) {
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
    updateDocument({ activeFace: normalizeFace(face) });
    setSelectedId(null);
  }

  function toggleFullPreview(face) {
    const normalizedFace = normalizeFace(face);
    updateDocument({ activeFace: normalizedFace });
    setSelectedId(null);
    setFullPreviewFace((current) => (current === normalizedFace ? null : normalizedFace));
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
          onSelect={selectShape}
          onFaceSelect={setActiveFace}
          onFaceDoubleSelect={toggleFullPreview}
          onAreaLockToggle={toggleAreaLock}
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
              locked={Boolean(document.areaLocks?.[normalizeFace(shape.face)])}
              constraint={faceConstraints[normalizeFace(shape.face)]}
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
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
  onAreaLockToggle,
}) {
  const activeFace = normalizeFace(document.activeFace);
  const previewFace = fullPreviewFace ? normalizeFace(fullPreviewFace) : null;
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
