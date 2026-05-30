import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const APP_VERSION = 'proto-2026-05-30-face-01';
const FACE_ORDER = ['top', 'right', 'left'];
const FACE_LABELS = {
  top: '上',
  right: '右',
  left: '左',
};

const initialDocument = {
  extrude: 12,
  activeFace: 'top',
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top' },
  ],
};

function normalizeFace(face) {
  return FACE_ORDER.includes(face) ? face : 'top';
}

function normalizeDocument(document) {
  const activeFace = normalizeFace(document?.activeFace);
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

function App() {
  const [document, setDocument] = useState(loadDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
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
  }, [selectedId]);

  function updateDocument(patch) {
    setDocument((current) => ({ ...current, ...patch }));
  }

  function updateShape(id, patch) {
    setDocument((current) => ({
      ...current,
      shapes: current.shapes.map((shape) =>
        shape.id === id ? { ...shape, ...patch } : shape,
      ),
    }));
  }

  function addShape(type) {
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shape =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face };
      setSelectedId(id);
      return { ...current, shapes: [...current.shapes, shape] };
    });
  }

  function removeShape(id) {
    setDocument((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== id);
      if (selectedId === id) {
        setSelectedId(nextShapes[0]?.id ?? null);
      }
      return { ...current, shapes: nextShapes };
    });
  }

  function moveShape(id, direction) {
    setDocument((current) => {
      const index = current.shapes.findIndex((shape) => shape.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.shapes.length) {
        return current;
      }
      const shapes = [...current.shapes];
      const [shape] = shapes.splice(index, 1);
      shapes.splice(nextIndex, 0, shape);
      return { ...current, shapes };
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

  return (
    <main className="app-shell">
      <section className="viewer-panel" aria-label="CAD viewer">
        <Viewer
          document={document}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onFaceSelect={setActiveFace}
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
            <strong className={`face-label face-${document.activeFace}`}>
              {FACE_LABELS[document.activeFace]}
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
          {document.shapes.map((shape, index) => (
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
              total={document.shapes.length}
              selected={shape.id === selectedId}
              onSelect={() => setSelectedId(shape.id)}
              onChange={(patch) => updateShape(shape.id, patch)}
              onMove={moveShape}
              onRemove={removeShape}
            />
          ))}
        </div>

        {selectedShape ? (
          <p className="selection-note">
            選択中: {getShapeLabel(selectedShape)}
          </p>
        ) : (
          <p className="selection-note">図形を追加してください。</p>
        )}

        {jsonOpen ? <pre className="json-view">{jsonText}</pre> : null}
      </section>
    </main>
  );
}

function Viewer({ document, selectedId, onSelect, onFaceSelect }) {
  const activeFace = normalizeFace(document.activeFace);

  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <span>2D preview</span>
        <span>{APP_VERSION}</span>
        <span>{document.extrude}mm extrude</span>
      </div>
      <FaceSelector activeFace={activeFace} onSelect={onFaceSelect} />
      <svg viewBox="0 0 120 120" role="img" aria-label="配置図形プレビュー" onClick={() => onSelect(null)}>
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
        <rect width="120" height="120" fill="url(#grid)" />
        <line x1="0" y1="60" x2="120" y2="60" stroke="#bac6d3" strokeWidth="0.5" />
        <line x1="60" y1="0" x2="60" y2="120" stroke="#bac6d3" strokeWidth="0.5" />
        {FACE_ORDER.map((face) => (
          <rect
            key={face}
            className={`final-face face-${face}`}
            width="120"
            height="120"
            mask={`url(#body-mask-${face})`}
          />
        ))}
        {document.shapes.map((shape) => (
          <FinalOutline key={`outline-${shape.id}`} shape={shape} />
        ))}
        {document.shapes.map((shape) => (
          <ShapePreview
            key={shape.id}
            shape={shape}
            selected={shape.id === selectedId}
            onSelect={() => onSelect(shape.id)}
          />
        ))}
      </svg>
      <div className="viewer-legend">
        {FACE_ORDER.map((face) => (
          <span key={face}><i className={`face-swatch face-${face}`} /> {FACE_LABELS[face]}面</span>
        ))}
      </div>
    </div>
  );
}

function FaceSelector({ activeFace, onSelect }) {
  const faces = [
    { id: 'left', points: '70,44 20,24 20,70 70,96' },
    { id: 'right', points: '70,44 120,24 120,70 70,96' },
    { id: 'top', points: '70,44 20,24 70,4 120,24' },
  ];
  const orderedFaces = [
    ...faces.filter((face) => face.id !== activeFace),
    faces.find((face) => face.id === activeFace),
  ].filter(Boolean);

  return (
    <div className="face-selector-wrap" aria-label="配置面選択">
      <svg className="face-selector" viewBox="0 0 140 104" role="img" aria-label="上・右・左の面選択">
        {orderedFaces.map((face) => (
          <g
            key={face.id}
            className={`iso-face face-${face.id} ${face.id === activeFace ? 'active' : ''}`}
            role="button"
            tabIndex="0"
            aria-label={`${FACE_LABELS[face.id]}面を選択`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(face.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(face.id);
              }
            }}
          >
            <polygon points={face.points} />
            <text x={face.id === 'left' ? 42 : face.id === 'right' ? 98 : 70} y={face.id === 'top' ? 26 : 66}>
              {FACE_LABELS[face.id]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
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

  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
        onClick={handleSelect}
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
    />
  );
}

function ShapeEditor({
  editorRef,
  shape,
  index,
  total,
  selected,
  onSelect,
  onChange,
  onMove,
  onRemove,
}) {
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
          min={0}
          max={120}
          onChange={(x) => onChange({ x })}
        />
        <ControlField
          axis="y"
          label="Y"
          value={shape.y}
          min={0}
          max={120}
          invert
          onChange={(y) => onChange({ y })}
        />
        {shape.type === 'rect' ? (
          <>
            <ControlField
              axis="x"
              label="W"
              value={shape.w}
              min={1}
              max={120}
              onChange={(w) => onChange({ w })}
            />
            <ControlField
              axis="y"
              label="H"
              value={shape.h}
              min={1}
              max={120}
              onChange={(h) => onChange({ h })}
            />
          </>
        ) : (
          <>
            <ControlField
              axis="x"
              label="R"
              value={shape.r}
              min={1}
              max={60}
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
