import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';

const initialDocument = {
  extrude: 12,
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut' },
  ],
};

function loadDocument() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : initialDocument;
  } catch {
    return initialDocument;
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
  const editorRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const jsonText = useMemo(() => JSON.stringify(document, null, 2), [document]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

  useEffect(() => {
    const editor = editorRefs.current.get(selectedId);
    if (editor) {
      editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      const shape =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add' }
          : { id, type: 'circle', x: 44, y: 32, r: 10, mode: 'cut' };
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

  return (
    <main className="app-shell">
      <section className="viewer-panel" aria-label="CAD viewer">
        <Viewer document={document} selectedId={selectedId} onSelect={setSelectedId} />
      </section>

      <section className="control-panel" aria-label="CAD controls">
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

function Viewer({ document, selectedId, onSelect }) {
  const maskId = 'body-mask';

  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <span>2D preview</span>
        <span>{document.extrude}mm extrude</span>
      </div>
      <svg viewBox="0 0 120 80" role="img" aria-label="配置図形プレビュー">
        <defs>
          <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee9" strokeWidth="0.35" />
          </pattern>
          <mask id={maskId}>
            <rect width="120" height="80" fill="black" />
            {document.shapes.map((shape) => (
              <MaskShape key={shape.id} shape={shape} />
            ))}
          </mask>
        </defs>
        <rect width="120" height="80" fill="url(#grid)" />
        <line x1="0" y1="40" x2="120" y2="40" stroke="#bac6d3" strokeWidth="0.5" />
        <line x1="60" y1="0" x2="60" y2="80" stroke="#bac6d3" strokeWidth="0.5" />
        <rect className="final-face" width="120" height="80" mask={`url(#${maskId})`} />
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
        <span><i className="face-swatch" /> body face</span>
        <span><i className="outline-swatch" /> final edge</span>
      </div>
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
  if (shape.type === 'circle') {
    return (
      <circle
        className="final-outline"
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
      />
    );
  }

  return (
    <rect
      className="final-outline"
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      rx="1.4"
    />
  );
}

function ShapePreview({ shape, selected, onSelect }) {
  const className = `shape-preview ${shape.mode} ${selected ? 'selected' : ''}`;
  if (shape.type === 'circle') {
    return (
      <circle
        className={className}
        cx={shape.x}
        cy={shape.y}
        r={shape.r}
        onClick={onSelect}
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
      onClick={onSelect}
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

      <div className="shape-compact-controls">
        <SlideField
          axis="x"
          label="X"
          value={shape.x}
          min={0}
          max={120}
          onChange={(x) => onChange({ x })}
        />
        <SlideField
          axis="y"
          label="Y"
          value={shape.y}
          min={0}
          max={80}
          onChange={(y) => onChange({ y })}
        />
        <div className="size-fields">
        {shape.type === 'rect' ? (
          <>
            <NumberField label="W" value={shape.w} min={1} max={120} onChange={(w) => onChange({ w })} />
            <NumberField label="H" value={shape.h} min={1} max={80} onChange={(h) => onChange({ h })} />
          </>
        ) : (
          <NumberField label="R" value={shape.r} min={1} max={40} onChange={(r) => onChange({ r })} />
        )}
        </div>
      </div>
    </article>
  );
}

function SlideField({ axis, label, value, min, max, onChange }) {
  return (
    <label className={`slide-field ${axis === 'y' ? 'axis-y' : 'axis-x'}`}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step="0.5"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
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
        step="0.5"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
