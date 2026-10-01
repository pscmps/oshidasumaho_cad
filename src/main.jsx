import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AI_MODEL_JSON_PROMPT,
  MODEL_SCHEMA_VERSION,
  parseModelJson,
  readModelJsonFile,
  serializeModelJson,
  validateAndMigrateModelDocument,
} from './model-json.js';
import { parseUrlAutomationRequest } from './url-automation.js';
import {
  createLockedDocumentFromBounds,
  diagnoseProjectionConsistency,
  getProjectionReadiness,
  projectionRangesMatch,
} from './projection-consistency.js';
import {
  GEAR_MODULE_MAX,
  GEAR_MODULE_MIN,
  GEAR_TEETH_MAX,
  GEAR_TEETH_MIN,
  getGearBoreMax,
  getGearBoreRing,
  getGearBoreSignedDistance,
  getGearOuterSignedDistance,
  getGearOutlineRing,
  getGearRadii,
  pointInGearOuter,
} from './gear-geometry.js';
import {
  RACK_HEIGHT_MAX,
  RACK_TEETH_MAX,
  RACK_TEETH_MIN,
  getRackGearDimensions,
  getRackGearOutlineRing,
  getRackGearSignedDistance,
  normalizeRackRotation,
  pointInRackGear,
} from './rack-gear-geometry.js';
import {
  INTERNAL_GEAR_TEETH_MAX,
  INTERNAL_GEAR_TEETH_MIN,
  getInternalGearInnerRing,
  getInternalGearInnerSignedDistance,
  getInternalGearMaximumModule,
  getInternalGearMaximumTeeth,
  getInternalGearMinimumOuterDiameter,
  getInternalGearOuterRing,
  getInternalGearOuterSignedDistance,
  getInternalGearRadii,
  pointInInternalGear,
} from './internal-gear-geometry.js';
import {
  ceilToModelPrecision,
  createDiscreteSliderScale,
  floorToModelPrecision,
  normalizeModelPrecision,
  normalizeShapePrecision,
  roundToModelPrecision,
} from './numeric-precision.js';
import {
  extractAxisFitTargets,
  findFitValue,
  getShapeBounds2D,
  includeShapeFitTargets,
  isFitBypassActive,
} from './fit-assist.js';
import {
  getFaceBounds,
  getAllFaceBounds,
  getFitTargetsForFace,
  getLockConstraintForBounds,
  normalizeConstraint,
  getLockedFaceConstraint,
  getAllDisplayConstraints,
  getAllLockedConstraints,
  hasAreaConstraint,
  areLockedFaceBoundsValid,
  getAreaLockDiagnostic,
  formatRange,
  clampValue,
  constrainShape,
  constrainEditedShape,
  applyAreaLocks,
  getShapeControlLimits,
  getLockedPreviewDimensions,
  getDocumentPreviewDimensions,
  getAutomaticExportPreparation,
  getFaceBooleanPolygons,
  getBooleanPolygonBounds,
  buildSurfacePreviewFaces,
  getOutputBaseName,
  STL_MESH_OPTIONS,
  getMeshResolutionMax,
  buildStlText
} from './cad-core/projection.js';
import { cadOf, emptyCad } from './cad-core/document.js';
import { normalizeAssemblyStructure } from './cad-core/assembly.js';
import { buildReplicadStepBlob, evaluateInWorker, exportInWorker } from './cad-core/client.js';
import { hasNativeGeometry, meshToSurfaces } from './cad-core/mesh.js';
import NativeViewer from './ui/NativeViewer.jsx';
import CommandPanel from './ui/CommandPanel.jsx';
import RoughSketchViewer from './ui/RoughSketchViewer.jsx';
import SketchPanel from './ui/SketchPanel.jsx';
import SelectionToolbar from './ui/SelectionToolbar.jsx';
import { useCadWorkspace } from './ui/useCadWorkspace.js';
import './style.css';

const STORAGE_KEY = 'oshidasumaho-cad-document-v1';
const SAVED_PARTS_KEY = 'oshidasumaho-cad-saved-parts-v1';
const ASSEMBLY_STORAGE_KEY = 'oshidasumaho-cad-assembly-v1';
const RECEIVER_TOKEN_KEY = 'oshidasumaho-cad-receiver-token-v1';
const APP_VERSION = 'ai-native-2026-10-01-ui2';
const SOLID_PREVIEW_STEPS = 18;
const CIRCLE_MESH_SEGMENTS = 64;
const STL_VOXEL_CELL_SIZE = 0.5;
const STL_VOXEL_MAX_AXIS_STEPS = 180;
const STL_VOXEL_MAX_CELLS = 12_000_000;
const STL_RESOLUTION_MAX = 20;
const SECTION_SAMPLE_EPSILON = 0.001;
const DEFAULT_ROTATION = { x: 24, y: -34, z: 0 };
const FACE_VIEW_ROTATIONS = {
  top: { x: 90, y: 0, z: 0 },
  front: { x: 0, y: 0, z: 0 },
  right: { x: 0, y: 0, z: -90 },
  left: { x: 0, y: 0, z: 90 },
  back: { x: 0, y: 0, z: 180 },
  bottom: { x: -90, y: 0, z: 0 },
};
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
const DIMENSION_LABELS = {
  width: '幅',
  depth: '奥行',
  height: '高さ',
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
  schemaVersion: MODEL_SCHEMA_VERSION,
  extrude: 12,
  activeFace: 'top',
  areaLocks: DEFAULT_AREA_LOCKS,
  areaLockConstraints: DEFAULT_AREA_LOCK_CONSTRAINTS,
  viewMode: 'faces',
  rotation: DEFAULT_ROTATION,
  transparent3D: true,
  show3DGrid: false,
  show3DEdges: true,
  showAllDimensions: false,
  fitAssist: true,
  showQuickHelp: true,
  shapes: [
    { id: 1, type: 'rect', x: 10, y: 10, w: 70, h: 42, mode: 'add', face: 'top' },
    { id: 2, type: 'circle', x: 42, y: 31, r: 9, mode: 'cut', face: 'top' },
  ],
};

const ASSEMBLY_COLORS = [
  '#5b8def',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#64748b',
];

const initialAssemblyDocument = {
  viewRotation: DEFAULT_ROTATION,
  activeFace: 'top',
  instances: [],
};

function normalizeFace(face) {
  if (face === 'left') {
    return 'front';
  }
  return FACE_ORDER.includes(face) ? face : 'top';
}

function normalizeDocument(document) {
  document = normalizeModelPrecision(document);
  const activeFace = normalizeFace(document?.activeFace);
  const viewMode = document?.viewMode === '3d' ? '3d' : 'faces';
  const rotation = normalizeRotation(document?.rotation);
  const transparent3D = document?.transparent3D !== false;
  const show3DGrid = Boolean(document?.show3DGrid);
  const show3DEdges = document?.show3DEdges !== false;
  const showAllDimensions = Boolean(document?.showAllDimensions);
  const fitAssist = document?.fitAssist !== false;
  const showQuickHelp = document?.showQuickHelp !== false;
  const areaLocks = FACE_ORDER.reduce((locks, face) => ({
    ...locks,
    [face]: Boolean(document?.areaLocks?.[face]),
  }), DEFAULT_AREA_LOCKS);
  const areaLockConstraints = FACE_ORDER.reduce((constraints, face) => ({
    ...constraints,
    [face]: normalizeConstraint(document?.areaLockConstraints?.[face]),
  }), DEFAULT_AREA_LOCK_CONSTRAINTS);
  const shapes = Array.isArray(document?.shapes)
    ? document.shapes.map((shape) => {
        const normalizedShape = {
          ...shape,
          face: normalizeFace(shape.face ?? activeFace),
          showDimensions: Boolean(shape.showDimensions),
        };
        if (normalizedShape.type !== 'rack') {
          return normalizedShape;
        }
        const dimensions = getRackGearDimensions(normalizedShape);
        return {
          ...normalizedShape,
          width: dimensions.width,
          rotation: dimensions.rotation,
        };
      })
    : initialDocument.shapes;

  return {
    ...initialDocument,
    ...document,
    activeFace,
    areaLocks,
    areaLockConstraints,
    viewMode,
    rotation,
    transparent3D,
    show3DGrid,
    show3DEdges,
    showAllDimensions,
    fitAssist,
    showQuickHelp,
    shapes,
    cad: cadOf(document),
  };
}

function snapRightAngle(value) {
  return clampValue(Math.round((Number(value) || 0) / 90) * 90, -180, 180);
}

function normalizeAssemblyRotation(rotation) {
  return {
    x: snapRightAngle(rotation?.x),
    y: snapRightAngle(rotation?.y),
    z: snapRightAngle(rotation?.z),
  };
}

function normalizeAssemblyPosition(position) {
  return {
    x: roundToModelPrecision(clampValue(Number(position?.x ?? 0), -120, 120)),
    y: roundToModelPrecision(clampValue(Number(position?.y ?? 0), -120, 120)),
    z: roundToModelPrecision(clampValue(Number(position?.z ?? 0), -120, 120)),
  };
}

function normalizeAssemblyDocument(document) {
  const instances = Array.isArray(document?.instances)
    ? document.instances
        .filter((instance) => instance?.document)
        .map((instance, index) => ({
          id: instance.id || `assembly-part-${Date.now()}-${index}`,
          sourcePartId: instance.sourcePartId || '',
          name: instance.name || instance.document?.partName || `部品 ${index + 1}`,
          color: instance.color || ASSEMBLY_COLORS[index % ASSEMBLY_COLORS.length],
          position: normalizeAssemblyPosition(instance.position),
          rotation: normalizeAssemblyRotation(instance.rotation),
          document: normalizeDocument(instance.document),
        }))
    : [];

  return normalizeAssemblyStructure({
    ...initialAssemblyDocument,
    ...document,
    activeFace: normalizeFace(document?.activeFace),
    viewRotation: normalizeRotation(document?.viewRotation),
    instances,
  });
}

function normalizeRotation(rotation) {
  return {
    x: clampValue(Number(rotation?.x ?? DEFAULT_ROTATION.x), -180, 180),
    y: clampValue(Number(rotation?.y ?? DEFAULT_ROTATION.y), -180, 180),
    z: clampValue(Number(rotation?.z ?? DEFAULT_ROTATION.z), -180, 180),
  };
}

function loadDocument() {
  const fallback = (import.meta.env.VITE_AI_NATIVE_START === '1' || new URLSearchParams(window.location.search).get('ai') === '1')
    ? { ...initialDocument, shapes: [], cad: emptyCad() }
    : initialDocument;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved
      ? normalizeDocument(validateAndMigrateModelDocument(JSON.parse(saved)))
      : normalizeDocument(fallback);
  } catch {
    return normalizeDocument(fallback);
  }
}

function loadAssemblyDocument() {
  try {
    const saved = localStorage.getItem(ASSEMBLY_STORAGE_KEY);
    return saved ? normalizeAssemblyDocument(JSON.parse(saved)) : normalizeAssemblyDocument(initialAssemblyDocument);
  } catch {
    return normalizeAssemblyDocument(initialAssemblyDocument);
  }
}

function loadSavedParts() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_PARTS_KEY) || '[]');
    if (!Array.isArray(saved)) {
      return [];
    }
    return saved
      .filter((item) => item?.id && item?.name && item?.document)
      .map((item) => ({
        ...item,
        document: normalizeDocument(item.document),
      }));
  } catch {
    return [];
  }
}

function storeSavedParts(parts) {
  localStorage.setItem(SAVED_PARTS_KEY, JSON.stringify(parts));
}

function getNextId(shapes) {
  return Math.max(0, ...shapes.map((shape) => shape.id)) + 1;
}

function getShapeLabel(shape) {
  const typeLabel = shape.type === 'rect'
    ? 'Rect'
    : shape.type === 'circle'
      ? 'Circle'
      : shape.type === 'gear'
        ? 'Gear'
        : shape.type === 'rack'
          ? 'Rack'
          : 'Internal Gear';
  return `${typeLabel} ${shape.id}`;
}

function clampRangeValue(value) {
  return roundToModelPrecision(Math.min(120, Math.max(0, value)));
}

function App() {
  const [appMode, setAppMode] = useState('part');
  const [document, setDocument] = useState(loadDocument);
  const [nativeOpen, setNativeOpen] = useState(() => import.meta.env.VITE_AI_NATIVE_START === '1' || new URLSearchParams(window.location.search).get('ai') === '1');
  const [nativeView, setNativeView] = useState(() => { const p = new URLSearchParams(window.location.search); return p.has('json') || p.get('cadView') === 'model' ? '3d' : 'sketch'; });
  const [selectedComment, setSelectedComment] = useState(null);
  const [nativeMenuOpen, setNativeMenuOpen] = useState(false);
  const workspace = useCadWorkspace(document, setDocument, nativeOpen || hasNativeGeometry(document));
  useEffect(() => { if (workspace.proposal?.commands.some(c => c.operation === 'addSketchSolid')) setNativeView('3d'); }, [workspace.proposal]);
  const outputReady = Boolean((!document.cad?.suppressedProjection && getLockedPreviewDimensions(document)) || document.cad?.features.length);
  const [assembly, setAssembly] = useState(loadAssemblyDocument);
  const [selectedId, setSelectedId] = useState(document.shapes[0]?.id ?? null);
  const [selectedAssemblyId, setSelectedAssemblyId] = useState(null);
  const [assemblyViewport, setAssemblyViewport] = useState('3d');
  const [fullAssemblyPreview, setFullAssemblyPreview] = useState(null);
  const [preview3DSelected, setPreview3DSelected] = useState(false);
  const [fullPreviewFace, setFullPreviewFace] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputFormat, setOutputFormat] = useState('json');
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  const [savedParts, setSavedParts] = useState(loadSavedParts);
  const [saveName, setSaveName] = useState(document.partName ?? '');
  const [loadPartId, setLoadPartId] = useState('');
  const [stlSaving, setStlSaving] = useState(false);
  const [stepSaving, setStepSaving] = useState(false);
  const [stlResolution, setStlResolution] = useState(1);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [localPrintInfo, setLocalPrintInfo] = useState(null);
  const [localPrintOpen, setLocalPrintOpen] = useState(false);
  const [localPrintSource, setLocalPrintSource] = useState('current');
  const [localPrintFile, setLocalPrintFile] = useState(null);
  const [localPrintToken, setLocalPrintToken] = useState(() => localStorage.getItem(RECEIVER_TOKEN_KEY) || '');
  const [localPrintStatus, setLocalPrintStatus] = useState(null);
  const [localPrintSubmitting, setLocalPrintSubmitting] = useState(false);
  const [localPrintLayerHeight, setLocalPrintLayerHeight] = useState('0.20');
  const [localPrintSupport, setLocalPrintSupport] = useState(false);
  const [jsonImportStatus, setJsonImportStatus] = useState(null);
  const [areaLockFeedback, setAreaLockFeedback] = useState(null);
  const [urlAutomationStatus, setUrlAutomationStatus] = useState(null);
  const [urlAutomationMode, setUrlAutomationMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode')?.trim().toLowerCase() === 'automation'
      || params.get('ui')?.trim().toLowerCase() === 'none';
  });
  const [urlDownloadArtifact, setUrlDownloadArtifact] = useState(null);
  const urlAutomationStartedRef = useRef(false);
  const fitAssistBypassRef = useRef(new Map());
  const fitAssistFeedbackRef = useRef(null);
  const controlPanelRef = useRef(null);
  const editorRefs = useRef(new Map());
  const assemblyRefs = useRef(new Map());

  const selectedShape = document.shapes.find((shape) => shape.id === selectedId);
  const activeFace = normalizeFace(document.activeFace);
  const activeShapes = document.shapes.filter((shape) => normalizeFace(shape.face) === activeFace);
  const faceBounds = useMemo(() => getAllFaceBounds(document.shapes), [document.shapes]);
  const lockedConstraints = useMemo(() => getAllLockedConstraints(document), [document]);
  const areaLockDiagnostics = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, getAreaLockDiagnostic(document, face, faceBounds)])),
    [document, faceBounds],
  );
  const areaLockAvailability = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [face, areaLockDiagnostics[face].canLock])),
    [areaLockDiagnostics],
  );
  const previewDimensions = useMemo(() => getLockedPreviewDimensions(document), [document]);
  const stlResolutionMax = useMemo(() => getMeshResolutionMax(previewDimensions, STL_MESH_OPTIONS), [previewDimensions]);
  const showing3DControls = !nativeOpen && !outputOpen && Boolean((document.viewMode === '3d' || preview3DSelected) && previewDimensions);
  const showingFaceControls = !nativeOpen && !showing3DControls && !outputOpen;
  const jsonText = useMemo(() => serializeModelJson(document), [document]);
  const selectedAssemblyInstance = assembly.instances.find((instance) => instance.id === selectedAssemblyId);

  useEffect(() => { if (nativeOpen) controlPanelRef.current?.scrollTo({ top: 0 }); }, [nativeOpen]);
  useEffect(() => {
    if (!nativeOpen || appMode !== 'part') return;
    const viewport = window.visualViewport, style = window.document.documentElement.style;
    const resize = () => {
      style.setProperty('--workspace-height', `${viewport?.height || window.innerHeight}px`);
      style.setProperty('--workspace-top', `${viewport?.offsetTop || 0}px`);
    };
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize); style.removeProperty('--workspace-height'); style.removeProperty('--workspace-top');
    };
  }, [nativeOpen, appMode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }, [document]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/health', { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((info) => {
        if (info?.localPrintUi === true) setLocalPrintInfo(info);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (urlAutomationStartedRef.current) {
      return;
    }
    urlAutomationStartedRef.current = true;
    void runUrlAutomation();
  }, []);

  useEffect(() => {
    localStorage.setItem(ASSEMBLY_STORAGE_KEY, JSON.stringify(assembly));
  }, [assembly]);

  useEffect(() => {
    setSaveName(document.partName ?? '');
  }, [document.partName]);

  useEffect(() => {
    setStlResolution((current) => Math.min(current, stlResolutionMax));
  }, [stlResolutionMax]);

  useEffect(() => {
    if (appMode !== 'part') {
      return;
    }
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

  useEffect(() => {
    if (appMode !== 'assembly') {
      return;
    }
    const editor = assemblyRefs.current.get(selectedAssemblyId);
    const panel = controlPanelRef.current;
    if (!selectedAssemblyId && panel) {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (editor && panel) {
      const panelRect = panel.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const targetTop = panel.scrollTop + editorRect.top - panelRect.top - 18;
      panel.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }, [selectedAssemblyId, assembly.activeFace, appMode]);

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

  function setRotation(rotation) {
    setDocument((current) => ({
      ...current,
      rotation: normalizeRotation(rotation),
    }));
  }

  function setTransparent3D(transparent3D) {
    setDocument((current) => ({
      ...current,
      transparent3D,
    }));
  }

  function setShow3DGrid(show3DGrid) {
    setDocument((current) => ({
      ...current,
      show3DGrid,
    }));
  }

  function setShow3DEdges(show3DEdges) {
    setDocument((current) => ({
      ...current,
      show3DEdges,
    }));
  }

  function applyFitAssistToPatch(current, shape, patch, interaction) {
    fitAssistFeedbackRef.current = null;
    const field = interaction?.field;
    const rawValue = Number(field ? patch[field] : NaN);
    if (!field || !Number.isFinite(rawValue)) {
      return patch;
    }

    const bypassKey = `${shape.id}:${field}`;
    const bypass = fitAssistBypassRef.current.get(bypassKey);
    if (bypass) {
      if (!isFitBypassActive(rawValue, bypass.snappedValue)) {
        fitAssistBypassRef.current.delete(bypassKey);
      }
      return patch;
    }
    if (!current.fitAssist || interaction.source !== 'slider') {
      return patch;
    }

    const localShapes = current.shapes.filter((item) => (
      item.id !== shape.id
      && normalizeFace(item.face) === normalizeFace(shape.face)
    ));
    const adjacentTargets = getFitTargetsForFace(current, shape.face);
    const targetsByAxis = Object.fromEntries(['x', 'y'].map((axis) => [
      axis,
      includeShapeFitTargets(adjacentTargets[axis], localShapes, axis),
    ]));
    const constraint = getLockedFaceConstraint(current, normalizeFace(shape.face));
    const limits = getShapeControlLimits(
      shape,
      constraint,
      shape.mode !== 'cut' && hasAreaConstraint(constraint),
    );
    const fieldLimits = limits[field];
    const fit = findFitValue({
      shape,
      field,
      rawValue,
      targetsByAxis,
      evaluateShape: (value) => constrainEditedShape(current, {
        ...shape,
        ...patch,
        [field]: value,
      }),
      minValue: fieldLimits?.min,
      maxValue: fieldLimits?.max,
    });
    if (!fit) {
      return patch;
    }
    fitAssistBypassRef.current.set(bypassKey, { snappedValue: fit.value });
    fitAssistFeedbackRef.current = {
      shapeId: shape.id,
      face: normalizeFace(shape.face),
      axis: fit.axis,
      kind: fit.kind,
      target: fit.target,
    };
    return { ...patch, [field]: fit.value };
  }

  function updateShape(id, patch, interaction) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    setDocument((current) => {
      const nextDocument = applyAreaLocks({
        ...current,
        activeFace: patch.face ? normalizeFace(patch.face) : current.activeFace,
        shapes: current.shapes.map((shape) => {
          if (shape.id !== id) {
            return shape;
          }
          const assistedPatch = applyFitAssistToPatch(current, shape, patch, interaction);
          return constrainEditedShape(current, { ...shape, ...assistedPatch });
        }),
      });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function toggleAllDimensions() {
    setDocument((current) => ({
      ...current,
      showAllDimensions: !current.showAllDimensions,
    }));
  }

  function toggleFitAssist() {
    fitAssistBypassRef.current.clear();
    fitAssistFeedbackRef.current = null;
    setDocument((current) => ({
      ...current,
      fitAssist: !current.fitAssist,
    }));
  }

  function toggleQuickHelp() {
    setDocument((current) => ({
      ...current,
      showQuickHelp: !current.showQuickHelp,
    }));
  }

  function addShape(type) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    fitAssistFeedbackRef.current = null;
    setDocument((current) => {
      const id = getNextId(current.shapes);
      const face = normalizeFace(current.activeFace);
      const shapeBase =
        type === 'rect'
          ? { id, type: 'rect', x: 18, y: 16, w: 42, h: 28, mode: 'add', face }
          : type === 'circle'
            ? { id, type: 'circle', x: 44, y: 32, r: 3, mode: 'cut', face }
            : type === 'gear'
              ? { id, type: 'gear', x: 45, y: 45, module: 1, teeth: 24, bore: 6, mode: 'add', face }
              : type === 'rack'
                ? { id, type: 'rack', x: 20, y: 45, module: 1, teeth: 20, width: 62.8, height: 10, rotation: 0, mode: 'add', face }
                : { id, type: 'internalGear', x: 60, y: 60, module: 1, teeth: 50, outerDiameter: 68, mode: 'add', face };
      const constraint = getLockedFaceConstraint(current, face);
      const shape = shapeBase.mode !== 'cut' && hasAreaConstraint(constraint)
        ? constrainShape(shapeBase, constraint)
        : shapeBase;
      setSelectedId(id);
      const nextDocument = applyAreaLocks({ ...current, shapes: [...current.shapes, shape] });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function removeShape(id) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    fitAssistFeedbackRef.current = null;
    [...fitAssistBypassRef.current.keys()]
      .filter((key) => key.startsWith(`${id}:`))
      .forEach((key) => fitAssistBypassRef.current.delete(key));
    setDocument((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== id);
      if (selectedId === id) {
        setSelectedId(nextShapes[0]?.id ?? null);
      }
      const nextDocument = applyAreaLocks({ ...current, shapes: nextShapes });
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function selectShape(id) {
    setPreview3DSelected(false);
    setOutputOpen(false);
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
    setAreaLockFeedback(null);
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
      const nextDocument = { ...current, shapes };
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function toggleAreaLock(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    fitAssistBypassRef.current.clear();
    fitAssistFeedbackRef.current = null;
    const normalizedFace = normalizeFace(face);
    setDocument((current) => {
      const currentLocks = { ...DEFAULT_AREA_LOCKS, ...current.areaLocks };
      const currentConstraints = {
        ...DEFAULT_AREA_LOCK_CONSTRAINTS,
        ...current.areaLockConstraints,
      };
      const nextLockValue = !currentLocks[normalizedFace];
      const nextConstraint = getLockConstraintForBounds(getFaceBounds(current.shapes, normalizedFace));
      const diagnostic = getAreaLockDiagnostic(current, normalizedFace);
      if (nextLockValue && !diagnostic.canLock) {
        setAreaLockFeedback(diagnostic);
        return current;
      }
      setAreaLockFeedback(null);

      const nextDocument = {
        ...current,
        areaLocks: {
          ...currentLocks,
          [normalizedFace]: nextLockValue,
        },
        areaLockConstraints: {
          ...currentConstraints,
          [normalizedFace]: nextLockValue ? nextConstraint : null,
        },
      };
      return areLockedFaceBoundsValid(nextDocument) ? nextDocument : current;
    });
  }

  function resetDocument() {
    fitAssistBypassRef.current.clear();
    fitAssistFeedbackRef.current = null;
    setDocument(initialDocument);
    setSelectedId(initialDocument.shapes[0].id);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setOutputOpen(false);
    setPreviewMenuOpen(false);
    setResetConfirmOpen(false);
    setAreaLockFeedback(null);
  }

  function openSavePanel(format = 'json') {
    setOutputOpen(true);
    setOutputFormat(format);
    setSelectedId(null);
    setPreview3DSelected(false);
    setPreviewMenuOpen(false);
  }

  function openHelpPanel() {
    openSavePanel('help');
  }

  function openLoadPanel() {
    openSavePanel('load');
    setLoadPartId((current) => current || savedParts[0]?.id || '');
    setJsonImportStatus(null);
  }

  function requestScreenReset() {
    setResetConfirmOpen(true);
    setPreviewMenuOpen(false);
  }

  function updatePartName(name) {
    setSaveName(name);
    setDocument((current) => ({ ...current, partName: name }));
  }

  function savePartToWeb() {
    const name = saveName.trim();
    if (!name) {
      return;
    }
    const savedAt = new Date().toISOString();
    const nextDocument = normalizeDocument({ ...document, partName: name });
    const existing = savedParts.find((part) => part.name === name);
    const nextPart = {
      id: existing?.id ?? `part-${Date.now()}`,
      name,
      savedAt,
      document: nextDocument,
    };
    const nextSavedParts = [
      ...savedParts.filter((part) => part.id !== nextPart.id && part.name !== name),
      nextPart,
    ].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    setSavedParts(nextSavedParts);
    storeSavedParts(nextSavedParts);
    setDocument(nextDocument);
    setLoadPartId(nextPart.id);
  }

  function loadPart() {
    const part = savedParts.find((item) => item.id === loadPartId);
    if (!part) {
      return;
    }
    fitAssistBypassRef.current.clear();
    fitAssistFeedbackRef.current = null;
    const nextDocument = normalizeDocument(part.document);
    setDocument(nextDocument);
    setSelectedId(nextDocument.shapes[0]?.id ?? null);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setPreviewMenuOpen(false);
  }

  function restoreImportedDocument(importedDocument, sourceLabel) {
    fitAssistBypassRef.current.clear();
    fitAssistFeedbackRef.current = null;
    const nextDocument = normalizeDocument(importedDocument);
    setDocument(nextDocument);
    setSelectedId(null);
    setPreview3DSelected(false);
    setFullPreviewFace(null);
    setAreaLockFeedback(null);
    setJsonImportStatus({
      type: 'success',
      message: `「${nextDocument.partName || sourceLabel}」を読み込みました。`,
    });
  }

  async function importJsonFile(file) {
    setJsonImportStatus({ type: 'loading', message: 'JSONを読み込んでいます...' });
    try {
      const importedDocument = await readModelJsonFile(file);
      restoreImportedDocument(importedDocument, file.name);
    } catch (error) {
      setJsonImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'JSONの読み込みに失敗しました。',
      });
    }
  }

  function importJsonText(text) {
    setJsonImportStatus(null);
    try {
      restoreImportedDocument(parseModelJson(text), '貼り付けJSON');
    } catch (error) {
      setJsonImportStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'JSONの読み込みに失敗しました。',
      });
    }
  }

  function deleteSavedPart() {
    if (!loadPartId) {
      return;
    }
    const nextSavedParts = savedParts.filter((part) => part.id !== loadPartId);
    setSavedParts(nextSavedParts);
    storeSavedParts(nextSavedParts);
    setLoadPartId(nextSavedParts[0]?.id ?? '');
  }

  function openAssemblyMode() {
    setAppMode('assembly');
    setPreviewMenuOpen(false);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
    setSelectedAssemblyId(null);
    setOutputOpen(false);
    setPreview3DSelected(false);
  }

  function openPartMode() {
    setAppMode('part');
    setPreviewMenuOpen(false);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
  }

  function addAssemblyInstance(partId) {
    const part = savedParts.find((item) => item.id === partId);
    if (!part) {
      return;
    }
    const documentSnapshot = normalizeDocument(part.document);
    const id = `assembly-${Date.now()}`;
    const instance = {
      id,
      sourcePartId: part.id,
      name: part.name,
      color: ASSEMBLY_COLORS[assembly.instances.length % ASSEMBLY_COLORS.length],
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      document: documentSnapshot,
    };
    setAssembly((current) => normalizeAssemblyDocument({
      ...current,
      instances: [...current.instances, instance],
    }));
    setSelectedAssemblyId(id);
    setAssemblyViewport('3d');
    setFullAssemblyPreview(null);
  }

  function updateAssemblyViewRotation(axis, value) {
    setAssembly((current) => ({
      ...current,
      viewRotation: normalizeRotation({
        ...current.viewRotation,
        [axis]: value,
      }),
    }));
  }

  function setAssemblyViewRotation(rotation) {
    setAssembly((current) => ({
      ...current,
      viewRotation: normalizeRotation(rotation),
    }));
    setAssemblyViewport('3d');
    setFullAssemblyPreview((current) => (current === '3d' ? '3d' : null));
  }

  function resetAssemblyViewRotation() {
    setAssembly((current) => ({
      ...current,
      viewRotation: DEFAULT_ROTATION,
    }));
    setAssemblyViewport('3d');
    setFullAssemblyPreview((current) => (current === '3d' ? '3d' : null));
  }

  function selectAssemblyViewport(viewport) {
    setAssemblyViewport(viewport);
    if (viewport !== '3d') {
      setAssembly((current) => ({
        ...current,
        activeFace: normalizeFace(viewport),
      }));
    }
  }

  function toggleFullAssemblyPreview(viewport) {
    const nextViewport = viewport === '3d' ? '3d' : normalizeFace(viewport);
    selectAssemblyViewport(nextViewport);
    setFullAssemblyPreview((current) => (current === nextViewport ? null : nextViewport));
  }

  function selectAssemblyInstance(id, viewport = assemblyViewport) {
    setSelectedAssemblyId(id);
    selectAssemblyViewport(viewport);
  }

  function updateAssemblyInstance(id, patch) {
    setAssembly((current) => normalizeAssemblyDocument({
      ...current,
      instances: current.instances.map((instance) => (
        instance.id === id
          ? {
              ...instance,
              ...patch,
              position: patch.position ? normalizeAssemblyPosition(patch.position) : instance.position,
              rotation: patch.rotation ? normalizeAssemblyRotation(patch.rotation) : instance.rotation,
            }
          : instance
      )),
    }));
  }

  function removeAssemblyInstance(id) {
    setAssembly((current) => ({
      ...current,
      instances: current.instances.filter((instance) => instance.id !== id),
    }));
    if (selectedAssemblyId === id) {
      setSelectedAssemblyId(null);
    }
  }

  function setActiveFace(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
    setAreaLockFeedback(null);
    updateDocument({ activeFace: normalizeFace(face) });
    setSelectedId(null);
  }

  function toggleFullPreview(face) {
    setPreview3DSelected(false);
    setOutputOpen(false);
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
    setOutputOpen(false);
  }

  function select3DPreview() {
    if (!previewDimensions) {
      return;
    }
    setPreview3DSelected(true);
    setFullPreviewFace(null);
    setSelectedId(null);
    setOutputOpen(false);
  }

  async function copyTextOutput(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textArea = window.document.createElement('textarea');
    textArea.value = text;
    window.document.body.appendChild(textArea);
    textArea.select();
    window.document.execCommand('copy');
    window.document.body.removeChild(textArea);
  }

  function saveTextOutput(text, extension, type) {
    const blob = new Blob([text], { type });
    saveBlobOutput(blob, extension);
  }

  function saveBlobOutput(blob, extension) {
    saveBlobOutputForDocument(blob, extension, document);
  }

  function saveBlobOutputForDocument(blob, extension, documentData) {
    const fileNameBase = getOutputBaseName(documentData);
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileNameBase}.${extension}`;
    anchor.style.display = 'none';
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runUrlAutomation() {
    let request;
    const queryParams = new URLSearchParams(window.location.search);
    const explicitAutomationMode = queryParams.get('mode')?.trim().toLowerCase() === 'automation'
      || queryParams.get('ui')?.trim().toLowerCase() === 'none';
    setUrlAutomationMode(explicitAutomationMode);
    setUrlDownloadArtifact(null);
    try {
      request = parseUrlAutomationRequest(window.location.search);
      if (!request) {
        return;
      }
      setUrlAutomationMode(request.automationMode);
      fitAssistBypassRef.current.clear();
      fitAssistFeedbackRef.current = null;
      const importedDocument = normalizeDocument(request.document);
      setDocument(importedDocument);
      setSelectedId(null);
      setPreview3DSelected(false);
      setFullPreviewFace(null);
      setAreaLockFeedback(null);
      console.log('[Oshida CAD URL] JSON loaded', {
        source: request.source,
        format: request.format,
        download: request.download,
        mode: request.automationMode ? 'automation' : 'normal',
      });

      if (!request.format) {
        setUrlAutomationStatus({
          type: 'success',
          message: 'URLからJSONを読み込みました。',
        });
        return;
      }

      setUrlAutomationStatus({
        type: 'loading',
        message: `${request.format.toUpperCase()}を生成しています...`,
      });
      const prepared = getAutomaticExportPreparation(importedDocument);
      setDocument(prepared.document);
      await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));

      let artifact;
      if (request.format === 'stl') {
        const stlText = hasNativeGeometry(prepared.document)
          ? await (await exportInWorker(prepared.document, 'stl', prepared.document.partName, 1)).text()
          : buildStlText(prepared.document, prepared.dimensions, 1);
        if (!stlText.includes('facet normal')) {
          throw new Error('STLメッシュに有効な三角形がありません。');
        }
        artifact = {
          blob: new Blob([stlText], { type: 'model/stl' }),
          extension: 'stl',
          document: prepared.document,
        };
      } else {
        const stepBlob = await buildReplicadStepBlob(prepared.document, prepared.dimensions);
        if (!stepBlob || stepBlob.size === 0) {
          throw new Error('STEPデータを生成できませんでした。');
        }
        artifact = {
          blob: stepBlob,
          extension: 'step',
          document: prepared.document,
        };
      }
      console.log('[Oshida CAD URL] Export generated', {
        format: artifact.extension,
        bytes: artifact.blob.size,
      });

      if (!request.automationMode) {
        setUrlDownloadArtifact(artifact);
      }
      if (request.download) {
        saveBlobOutputForDocument(artifact.blob, artifact.extension, artifact.document);
        console.log('[Oshida CAD URL] Automatic download requested', {
          format: artifact.extension,
          fileName: `${getOutputBaseName(artifact.document)}.${artifact.extension}`,
        });
      }
      setUrlAutomationStatus({
        type: 'success',
        message: request.automationMode
          ? `${request.format.toUpperCase()} ${request.download ? 'download requested' : 'generated'}`
          : request.download
            ? `${request.format.toUpperCase()}の自動保存を試行しました。開始されない場合は手動保存してください。`
            : `${request.format.toUpperCase()}を生成しました。`,
      });
    } catch (error) {
      console.error('[Oshida CAD URL] Automation failed', error);
      setUrlAutomationStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'URL自動出力に失敗しました。',
      });
    }
  }

  function saveUrlDownloadArtifact() {
    if (!urlDownloadArtifact) {
      return;
    }
    saveBlobOutputForDocument(
      urlDownloadArtifact.blob,
      urlDownloadArtifact.extension,
      urlDownloadArtifact.document,
    );
    console.log('[Oshida CAD URL] Manual download requested', {
      format: urlDownloadArtifact.extension,
    });
  }

  async function saveStlOutput() {
    if (!outputReady || stlSaving) {
      return;
    }

    setStlSaving(true);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      if (hasNativeGeometry(document)) saveBlobOutput(await exportInWorker(document, 'stl', document.partName, stlResolution), 'stl');
      else saveTextOutput(buildStlText(document, previewDimensions, stlResolution), 'stl', 'model/stl');
    } catch (error) {
      window.alert(`STL生成に失敗しました: ${error.message}`);
    } finally {
      setStlSaving(false);
    }
  }

  async function saveStepOutput() {
    if (!outputReady || stepSaving) {
      return;
    }

    setStepSaving(true);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const stepBlob = await buildReplicadStepBlob(document, previewDimensions);
      if (stepBlob) {
        saveBlobOutput(stepBlob, 'step');
      }
    } catch (error) {
      window.alert(`STEP生成に失敗しました: ${error.message}`);
    } finally {
      setStepSaving(false);
    }
  }

  function openLocalPrintDialog() {
    setPreviewMenuOpen(false);
    setLocalPrintSource(outputReady ? 'current' : 'file');
    setLocalPrintFile(null);
    setLocalPrintStatus(null);
    setLocalPrintOpen(true);
  }

  async function submitLocalPrint() {
    if (localPrintSubmitting) return;
    setLocalPrintSubmitting(true);
    setLocalPrintStatus({ type: 'working', message: 'STLを送信し、印刷開始を待っています...' });

    try {
      let blob;
      let filename;
      if (localPrintSource === 'current') {
        if (!outputReady) throw new Error('現在のモデルはまだSTLを生成できません。');
        await new Promise((resolveFrame) => window.requestAnimationFrame(resolveFrame));
        const stlText = hasNativeGeometry(document) ? await (await exportInWorker(document, 'stl', document.partName, stlResolution)).text() : buildStlText(document, previewDimensions, stlResolution);
        if (!stlText.includes('facet normal')) throw new Error('STLに有効な三角形がありません。');
        blob = new Blob([stlText], { type: 'model/stl' });
        filename = `${getOutputBaseName(document)}.stl`;
      } else {
        if (!localPrintFile) throw new Error('STLファイルを選択してください。');
        blob = localPrintFile;
        filename = localPrintFile.name;
      }

      if (localPrintInfo?.tokenRequired && !localPrintToken.trim()) {
        throw new Error('Receiver tokenを入力してください。');
      }
      if (localPrintToken.trim()) localStorage.setItem(RECEIVER_TOKEN_KEY, localPrintToken.trim());

      const response = await fetch('/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'model/stl',
          'X-Filename': filename,
          'X-Layer-Height': localPrintLayerHeight,
          'X-Enable-Support': localPrintSupport ? '1' : '0',
          ...(localPrintToken.trim() ? { 'X-Receiver-Token': localPrintToken.trim() } : {}),
        },
        body: blob,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `送信に失敗しました (${response.status})`);
      const pipelineStatus = result.pipeline?.status || 'completed';
      setLocalPrintStatus({
        type: 'success',
        message: `処理完了: ${pipelineStatus} / ${localPrintLayerHeight} mm / サポート${localPrintSupport ? 'あり' : 'なし'}`,
      });
    } catch (error) {
      setLocalPrintStatus({ type: 'error', message: error instanceof Error ? error.message : '送信に失敗しました。' });
    } finally {
      setLocalPrintSubmitting(false);
    }
  }

  if (urlAutomationMode) {
    return (
      <main className="url-automation-shell">
        <output
          className={`url-automation-minimal-status ${urlAutomationStatus?.type ?? 'loading'}`}
          aria-live="polite"
        >
          {urlAutomationStatus?.message ?? 'Processing URL input...'}
        </output>
      </main>
    );
  }

  return (
    <main className={`app-shell ${nativeOpen && appMode === 'part' ? 'native-shell' : ''}`}>
      <section className="viewer-panel" aria-label="CAD viewer">
        {appMode === 'part' ? <div className="native-switch">
          {nativeOpen ? <>
            <strong className="workspace-title">AI CAD</strong>
            <div className="native-view-tabs" role="group" aria-label="モデルの表示方法">
              <button type="button" aria-pressed={nativeView === 'sketch'} className={nativeView === 'sketch' ? 'active-toggle' : ''} onClick={() => { setNativeView('sketch'); setOutputOpen(false); }}>スケッチ</button>
              <button type="button" aria-pressed={nativeView === '3d'} className={nativeView === '3d' ? 'active-toggle' : ''} onClick={() => setNativeView('3d')}>立体</button>
              <button type="button" aria-pressed={nativeView === 'projections'} className={nativeView === 'projections' ? 'active-toggle' : ''} onClick={() => setNativeView('projections')}>3面図</button>
            </div>
            <div className="native-menu">
              <button type="button" aria-label="保存・読込・その他" aria-expanded={nativeMenuOpen} onClick={() => setNativeMenuOpen(!nativeMenuOpen)}>•••</button>
              {nativeMenuOpen ? <div className="native-menu-popover">
                <button type="button" onClick={() => { setNativeMenuOpen(false); openSavePanel('json'); }}>保存・書き出し</button>
                <button type="button" onClick={() => { setNativeMenuOpen(false); openLoadPanel(); }}>部品を開く</button>
                <button type="button" onClick={() => { setNativeMenuOpen(false); setNativeOpen(false); setOutputOpen(false); }}>元の3面編集</button>
                <button type="button" onClick={() => { setNativeMenuOpen(false); openAssemblyMode(); }}>アセンブリ</button>
              </div> : null}
            </div>
          </> : <button type="button" onClick={() => { setNativeOpen(true); setOutputOpen(false); }}>AIで編集・3Dで選択</button>}
        </div> : null}
        {appMode === 'assembly' ? (
          <AssemblyViewer
            assembly={assembly}
            selectedInstanceId={selectedAssemblyId}
            viewport={assemblyViewport}
            fullPreview={fullAssemblyPreview}
            menuOpen={previewMenuOpen}
            onInstanceSelect={selectAssemblyInstance}
            onViewportSelect={selectAssemblyViewport}
            onViewportDoubleSelect={toggleFullAssemblyPreview}
            onMenuToggle={() => setPreviewMenuOpen((open) => !open)}
            onPartMode={openPartMode}
          />
        ) : nativeOpen ? (
          nativeView === 'sketch' ? <RoughSketchViewer draft={workspace.draft} updateDraft={workspace.updateDraft} selectedComment={selectedComment} onComment={setSelectedComment} />
          : <NativeViewer mesh={workspace.mesh} ghost={workspace.ghost} groups={workspace.groups} mode={workspace.mode} paint={workspace.paint} onSelect={workspace.select} status={workspace.meshStatus} view={nativeView} />
        ) : (
          <Viewer
            document={document}
            nativeMesh={workspace.mesh}
            selectedId={selectedId}
            fullPreviewFace={fullPreviewFace}
            areaLocks={document.areaLocks}
            areaLockConstraints={document.areaLockConstraints}
            areaLockAvailability={areaLockAvailability}
            areaLockDiagnostics={areaLockDiagnostics}
            previewDimensions={previewDimensions}
            rotation={document.rotation}
            transparent3D={document.transparent3D}
            show3DGrid={document.show3DGrid}
            show3DEdges={document.show3DEdges}
            viewMode={document.viewMode}
            preview3DSelected={preview3DSelected}
            fitAssistFeedback={fitAssistFeedbackRef.current}
            menuOpen={previewMenuOpen}
            onSelect={selectShape}
            onFaceSelect={setActiveFace}
            onFaceDoubleSelect={toggleFullPreview}
            onAreaLockToggle={toggleAreaLock}
            on3DSelect={select3DPreview}
            on3DDoubleSelect={toggle3DPreview}
            onMenuToggle={() => setPreviewMenuOpen((open) => !open)}
            onReset={requestScreenReset}
            onSaveOpen={() => openSavePanel('json')}
            onLoadOpen={openLoadPanel}
            onHelpOpen={openHelpPanel}
            onAssemblyOpen={openAssemblyMode}
            localPrintAvailable={Boolean(localPrintInfo)}
            onLocalPrintOpen={openLocalPrintDialog}
          />
        )}
        {appMode === 'part' && nativeOpen && nativeView !== 'sketch' ? <SelectionToolbar workspace={workspace} /> : null}
      </section>

      <section ref={controlPanelRef} className="control-panel" aria-label="CAD controls">
        {urlAutomationStatus && (!nativeOpen || urlAutomationStatus.type !== 'success' || urlDownloadArtifact) ? (
          <section
            className={`url-automation-status ${urlAutomationStatus.type}${urlAutomationMode ? ' automation' : ''}`}
            role={urlAutomationStatus.type === 'error' ? 'alert' : 'status'}
          >
            <strong>URL読込・自動出力</strong>
            <span>{urlAutomationStatus.message}</span>
            {!urlAutomationMode && urlDownloadArtifact ? (
              <button type="button" onClick={saveUrlDownloadArtifact}>
                {urlDownloadArtifact.extension.toUpperCase()}を手動保存
              </button>
            ) : null}
          </section>
        ) : null}
        {appMode === 'assembly' ? (
          <AssemblyPanel
            assembly={assembly}
            savedParts={savedParts}
            selectedInstance={selectedAssemblyInstance}
            selectedInstanceId={selectedAssemblyId}
            viewport={assemblyViewport}
            activeFace={assembly.activeFace}
            editorRefs={assemblyRefs}
            onAddInstance={addAssemblyInstance}
            onSelectInstance={(id) => selectAssemblyInstance(id, assemblyViewport)}
            onUpdateInstance={updateAssemblyInstance}
            onRemoveInstance={removeAssemblyInstance}
            onViewRotationChange={updateAssemblyViewRotation}
            onViewRotationReset={resetAssemblyViewRotation}
            onViewRotationPreset={setAssemblyViewRotation}
          />
        ) : null}

        {appMode === 'part' && nativeOpen && !outputOpen ? nativeView === 'sketch' ? <SketchPanel workspace={workspace} selectedComment={selectedComment} onComment={setSelectedComment} /> : <CommandPanel document={document} workspace={workspace} /> : null}
        {appMode === 'part' && showingFaceControls ? (
          <header className="control-header">
            <div>
              <p className="eyebrow">Oshida Smartphone CAD</p>
              <h1>図形配置</h1>
            </div>
            <div className="header-actions">
              <button type="button" onClick={() => addShape('rect')}>+四角</button>
              <button type="button" onClick={() => addShape('circle')}>+円</button>
              <button type="button" onClick={() => addShape('gear')}>+ギヤ</button>
              <button type="button" onClick={() => addShape('rack')}>+ラック</button>
              <button type="button" onClick={() => addShape('internalGear')}>+内歯</button>
            </div>
          </header>
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          <section className="assist-controls" aria-label="配置アシスト">
            <span>アシスト</span>
            <button
              type="button"
              className={document.showAllDimensions ? 'active-toggle' : ''}
              aria-pressed={document.showAllDimensions}
              onClick={toggleAllDimensions}
            >
              全寸法
            </button>
            <button
              type="button"
              className={document.fitAssist ? 'active-toggle' : ''}
              aria-pressed={document.fitAssist}
              onClick={toggleFitAssist}
            >
              フィット
            </button>
            <button
              type="button"
              className={document.showQuickHelp ? 'active-toggle' : ''}
              aria-pressed={document.showQuickHelp}
              onClick={toggleQuickHelp}
            >
              簡易ヘルプ
            </button>
          </section>
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          <div className="document-controls">
            <div className="active-face-control" aria-label="配置面">
              <span>配置面</span>
              <strong className={`face-label face-${activeFace}`}>
                {FACE_LABELS[activeFace]}
              </strong>
            </div>
          </div>
        ) : null}

        {appMode === 'part' && showingFaceControls && areaLockFeedback ? (
          <AreaLockFeedback diagnostic={areaLockFeedback} />
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
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
                locked={shape.mode !== 'cut' && hasAreaConstraint(lockedConstraints[normalizeFace(shape.face)])}
                constraint={lockedConstraints[normalizeFace(shape.face)]}
                onSelect={() => selectShape(shape.id)}
                onChange={(patch, interaction) => updateShape(shape.id, patch, interaction)}
                onMove={moveShape}
                onRemove={removeShape}
              />
            ))}
          </div>
        ) : null}

        {appMode === 'part' && showingFaceControls ? (
          selectedShape ? (
            <p className="selection-note">
              選択中: {FACE_LABELS[normalizeFace(selectedShape.face)]} / {getShapeLabel(selectedShape)}
            </p>
          ) : (
            <p className="selection-note">
              {FACE_LABELS[activeFace]}の図形: {activeShapes.length}件
            </p>
          )
        ) : null}

        {appMode === 'part' && showing3DControls ? (
          <RotationControls
            rotation={document.rotation}
            transparent={document.transparent3D}
            showGrid={document.show3DGrid}
            showEdges={document.show3DEdges}
            onChange={updateRotation}
            onReset={() => setRotation(DEFAULT_ROTATION)}
            onView={(view) => setRotation(FACE_VIEW_ROTATIONS[view])}
            onTransparencyChange={setTransparent3D}
            onGridChange={setShow3DGrid}
            onEdgesChange={setShow3DEdges}
          />
        ) : null}

        {appMode === 'part' && nativeOpen && outputOpen ? <div className="native-output-back">
          <button type="button" onClick={() => { setOutputOpen(false); controlPanelRef.current?.scrollTo({ top: 0 }); }}>← 変更指示へ戻る</button>
        </div> : null}
        {appMode === 'part' && outputOpen ? (
          <OutputPanel
            format={outputFormat}
            jsonText={jsonText}
            stlReady={outputReady}
            stlSaving={stlSaving}
            stepSaving={stepSaving}
            meshResolution={stlResolution}
            meshResolutionMax={stlResolutionMax}
            partName={saveName}
            savedParts={savedParts}
            selectedSavedPartId={loadPartId}
            jsonImportStatus={jsonImportStatus}
            onFormatChange={setOutputFormat}
            onPartNameChange={updatePartName}
            onSavedPartSelect={setLoadPartId}
            onLoadPart={loadPart}
            onDeleteSavedPart={deleteSavedPart}
            onImportJson={importJsonFile}
            onImportJsonText={importJsonText}
            aiPrompt={AI_MODEL_JSON_PROMPT}
            onCopyAiPrompt={() => copyTextOutput(AI_MODEL_JSON_PROMPT)}
            onCopyJson={() => copyTextOutput(jsonText)}
            onSaveJson={() => saveTextOutput(jsonText, 'json', 'application/json')}
            onSaveWeb={savePartToWeb}
            onMeshResolutionChange={setStlResolution}
            onSaveStl={saveStlOutput}
            onSaveStep={saveStepOutput}
          />
        ) : null}
        <p className="app-credit">made by pscmps</p>
      </section>
      {resetConfirmOpen ? (
        <ConfirmDialog
          title="画面リセット"
          message="本当に画面をリセットしますか？"
          confirmLabel="はい"
          cancelLabel="いいえ"
          onConfirm={resetDocument}
          onCancel={() => setResetConfirmOpen(false)}
        />
      ) : null}
      {localPrintOpen ? (
        <LocalPrintDialog
          info={localPrintInfo}
          currentModelReady={outputReady}
          source={localPrintSource}
          file={localPrintFile}
          token={localPrintToken}
          status={localPrintStatus}
          submitting={localPrintSubmitting}
          layerHeight={localPrintLayerHeight}
          support={localPrintSupport}
          onSourceChange={setLocalPrintSource}
          onFileChange={setLocalPrintFile}
          onTokenChange={setLocalPrintToken}
          onLayerHeightChange={setLocalPrintLayerHeight}
          onSupportChange={setLocalPrintSupport}
          onSubmit={submitLocalPrint}
          onClose={() => !localPrintSubmitting && setLocalPrintOpen(false)}
        />
      ) : null}
    </main>
  );
}

function Viewer({
  document,
  nativeMesh,
  selectedId,
  fullPreviewFace,
  areaLocks,
  areaLockConstraints,
  areaLockAvailability,
  areaLockDiagnostics,
  previewDimensions,
  rotation,
  transparent3D,
  show3DGrid,
  show3DEdges,
  viewMode,
  preview3DSelected,
  fitAssistFeedback,
  menuOpen,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
  onAreaLockToggle,
  on3DSelect,
  on3DDoubleSelect,
  onMenuToggle,
  onReset,
  onSaveOpen,
  onLoadOpen,
  onHelpOpen,
  onAssemblyOpen,
  localPrintAvailable,
  onLocalPrintOpen,
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
  const projectionReadiness = useMemo(
    () => getProjectionReadiness(faceBounds, areaLocks, areaLockConstraints),
    [faceBounds, areaLocks, areaLockConstraints],
  );
  const fitTargetsByFace = useMemo(
    () => Object.fromEntries(FACE_ORDER.map((face) => [
      face,
      document.fitAssist ? getFitTargetsForFace(document, face) : { x: null, y: null },
    ])),
    [document],
  );
  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-info">
          <span>3面図</span>
          <span>{APP_VERSION}</span>
        </div>
        <div className="viewer-menu">
          <button
            type="button"
            className="viewer-menu-button"
            aria-label="プレビューメニュー"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            ☰
          </button>
          {menuOpen ? (
            <div className="viewer-menu-popover">
              <button type="button" onClick={onSaveOpen}>保存</button>
              <button type="button" onClick={onLoadOpen}>呼び出し</button>
              <button type="button" onClick={onHelpOpen}>ヘルプ</button>
              {localPrintAvailable ? (
                <button type="button" onClick={onLocalPrintOpen}>ローカル3Dプリント</button>
              ) : null}
              <button type="button" onClick={onAssemblyOpen}>アセンブリ(開発中)</button>
              <button type="button" onClick={onReset}>画面リセット</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view" viewBox="0 0 386 280" role="img" aria-label="3面配置図">
        <defs>
          <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee9" strokeWidth="0.35" />
          </pattern>
          <marker id="dimension-arrow" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto-start-reverse">
            <path d="M 0 0 L 4 2 L 0 4 Z" />
          </marker>
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
            shapes={document.shapes}
            nativeMesh={hasNativeGeometry(document) ? nativeMesh : undefined}
            rotation={rotation}
            transparent={transparent3D}
            showGrid={show3DGrid}
            showEdges={show3DEdges}
            expanded
            onDoubleSelect={on3DDoubleSelect}
          />
        ) : (
          <>
            {visibleFaces.map((face) => (
              <FacePlan
                key={face}
                face={face}
                active={!preview3DSelected && face === activeFace}
                full={Boolean(previewFace)}
                shapes={document.shapes.filter((shape) => normalizeFace(shape.face) === face)}
                constraint={faceConstraints[face]}
                axisReadiness={projectionReadiness[face]}
                fitTargets={fitTargetsByFace[face]}
                fitFeedback={fitAssistFeedback?.face === face ? fitAssistFeedback : null}
                showAllDimensions={document.showAllDimensions}
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
                diagnostic={areaLockDiagnostics?.[face]}
                onToggle={onAreaLockToggle}
              />
            ))}
            {visibleFaces.map((face) => (
              <PreviewScaleButton
                key={`scale-${face}`}
                face={face}
                full={Boolean(previewFace)}
                expanded={Boolean(previewFace)}
                onToggle={() => onFaceDoubleSelect(face)}
              />
            ))}
            {!previewFace && previewDimensions ? (
              <>
                <IsometricPreview
                  dimensions={previewDimensions}
                  shapes={document.shapes}
                  nativeMesh={hasNativeGeometry(document) ? nativeMesh : undefined}
                  rotation={rotation}
                  transparent={transparent3D}
                  showGrid={show3DGrid}
                  showEdges={show3DEdges}
                  selected={preview3DSelected}
                  onSelect={on3DSelect}
                  onDoubleSelect={on3DDoubleSelect}
                />
                <PreviewScaleButton is3D onToggle={on3DDoubleSelect} />
              </>
            ) : null}
            {!previewFace && !previewDimensions && document.showQuickHelp ? (
              <QuickHelpCard />
            ) : null}
          </>
        )}
        {is3DMode ? (
          <PreviewScaleButton is3D expanded onToggle={on3DDoubleSelect} />
        ) : null}
      </svg>
    </div>
  );
}

function QuickHelpCard() {
  return (
    <g className="quick-help-card" role="img" aria-label="3D表示までの簡易手順">
      <rect x="198" y="6" width="120" height="120" rx="4" />
      <text className="quick-help-title" x="258" y="27">かんたん手順</text>
      <text x="211" y="49">1  図形を配置</text>
      <text x="211" y="68">2  面をロック</text>
      <text x="211" y="87">3  次の面を合わせる</text>
      <text className="quick-help-finish" x="258" y="110">3面ロックで3D表示</text>
    </g>
  );
}

function getAssemblyInstanceSurfaces(instance, nativeMesh) {
  const documentData = normalizeDocument(instance.document);
  const dimensions = getDocumentPreviewDimensions(documentData);
  if (!dimensions && !nativeMesh) {
    return [];
  }

  return (hasNativeGeometry(documentData) ? meshToSurfaces(nativeMesh) : buildSurfacePreviewFaces(documentData.shapes, dimensions)).map((surface) => ({
    ...surface,
    instanceId: instance.id,
    instanceName: instance.name,
    color: instance.color,
    rings: surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint(point, instance.rotation);
      return {
        x: rotated.x + instance.position.x,
        y: rotated.y + instance.position.y,
        z: rotated.z + instance.position.z,
      };
    })),
  }));
}

function getAssemblySurfaces(instances, nativeMeshes) {
  return instances.flatMap(instance => getAssemblyInstanceSurfaces(instance, nativeMeshes[instance.id]));
}

function getAssemblyBoundsFromSurfaces(surfaces) {
  const points = surfaces.flatMap((surface) => surface.rings.flat());
  const bounds = {};
  ['x', 'y', 'z'].forEach((axis) => {
    const values = [-180, 180, ...points.map((point) => point[axis])];
    const limit = Math.max(180, ...values.map((value) => Math.abs(value))) + 8;
    bounds[axis] = {
      min: -limit,
      max: limit,
      size: limit * 2,
    };
  });
  return bounds;
}

function getAssemblyFitBoundsFromSurfaces(surfaces) {
  const points = surfaces.flatMap((surface) => surface.rings.flat());
  if (!points.length) {
    return {
      x: { min: -60, max: 60, size: 120 },
      y: { min: -60, max: 60, size: 120 },
      z: { min: -60, max: 60, size: 120 },
    };
  }

  const bounds = {};
  ['x', 'y', 'z'].forEach((axis) => {
    const values = points.map((point) => point[axis]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max(4, (max - min) * 0.08);
    bounds[axis] = {
      min: min - padding,
      max: max + padding,
      size: Math.max(1, max - min + padding * 2),
    };
  });
  return bounds;
}

function getAssemblyProjectionAxes(face) {
  if (face === 'top') {
    return { horizontal: 'x', vertical: 'y' };
  }
  if (face === 'front') {
    return { horizontal: 'x', vertical: 'z' };
  }
  return { horizontal: 'y', vertical: 'z' };
}

function getAssemblyProjectedPoint(point, face, bounds) {
  const axes = getAssemblyProjectionAxes(face);
  const horizontalBounds = bounds[axes.horizontal];
  const verticalBounds = bounds[axes.vertical];
  return {
    sx: 10 + ((point[axes.horizontal] - horizontalBounds.min) / horizontalBounds.size) * 100,
    sy: 110 - ((point[axes.vertical] - verticalBounds.min) / verticalBounds.size) * 100,
  };
}

function getProjectedRingPath(ring) {
  return ring
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.sx} ${point.sy}`)
    .join(' ') + ' Z';
}

function getProjectedSurfacePathFrom3D(surface, face, bounds) {
  return surface.rings
    .map((ring) => getProjectedRingPath(ring.map((point) => getAssemblyProjectedPoint(point, face, bounds))))
    .join(' ');
}

function getProjectedInstanceBounds(surfaces, face, bounds) {
  const points = surfaces
    .flatMap((surface) => surface.rings.flat())
    .map((point) => getAssemblyProjectedPoint(point, face, bounds));
  if (!points.length) {
    return null;
  }
  return {
    minX: Math.min(...points.map((point) => point.sx)),
    maxX: Math.max(...points.map((point) => point.sx)),
    minY: Math.min(...points.map((point) => point.sy)),
    maxY: Math.max(...points.map((point) => point.sy)),
  };
}

function AssemblyViewer({
  assembly,
  selectedInstanceId,
  viewport,
  fullPreview,
  menuOpen,
  onInstanceSelect,
  onViewportSelect,
  onViewportDoubleSelect,
  onMenuToggle,
  onPartMode,
}) {
  const [nativeMeshes, setNativeMeshes] = useState({});
  const [nativeError, setNativeError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.all(assembly.instances.filter(i => hasNativeGeometry(i.document)).map(async i => [i.id, await evaluateInWorker(i.document)]))
      .then(items => { if (!cancelled) { setNativeMeshes(Object.fromEntries(items)); setNativeError(''); } })
      .catch(e => { if (!cancelled) setNativeError(e.message); });
    return () => { cancelled = true; };
  }, [assembly.instances]);
  const surfaces = useMemo(() => getAssemblySurfaces(assembly.instances, nativeMeshes), [assembly.instances, nativeMeshes]);
  const bounds = useMemo(() => getAssemblyBoundsFromSurfaces(surfaces), [surfaces]);
  const fitBounds = useMemo(() => getAssemblyFitBoundsFromSurfaces(surfaces), [surfaces]);
  const fullFace = fullPreview && fullPreview !== '3d' ? normalizeFace(fullPreview) : null;

  return (
    <div className="viewer-frame">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-info">
          <span>アセンブリ{nativeError ? `: ${nativeError}` : ''}</span>
          <span>{APP_VERSION}</span>
        </div>
        <div className="viewer-menu">
          <button
            type="button"
            className="viewer-menu-button"
            aria-label="プレビューメニュー"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            ☰
          </button>
          {menuOpen ? (
            <div className="viewer-menu-popover">
              <button type="button" onClick={onPartMode}>単品部品</button>
            </div>
          ) : null}
        </div>
      </div>
      <svg className="tri-view assembly-view" viewBox="0 0 378 268" role="img" aria-label="アセンブリ配置図">
        {fullPreview === '3d' ? (
          <AssemblyIsoPreview
            surfaces={surfaces}
            bounds={fitBounds}
            rotation={assembly.viewRotation}
            selected
            expanded
            selectedInstanceId={selectedInstanceId}
            onSelect={() => onViewportSelect('3d')}
            onDoubleSelect={() => onViewportDoubleSelect('3d')}
            onInstanceSelect={(id) => onInstanceSelect(id, '3d')}
          />
        ) : (
          <>
            {(fullFace ? [fullFace] : FACE_ORDER).map((face) => (
              <AssemblyFaceProjection
                key={face}
                face={face}
                active={viewport === face}
                full={Boolean(fullFace)}
                surfaces={surfaces}
                bounds={bounds}
                selectedInstanceId={selectedInstanceId}
                onInstanceSelect={onInstanceSelect}
                onViewportSelect={onViewportSelect}
                onViewportDoubleSelect={onViewportDoubleSelect}
              />
            ))}
            {!fullFace ? (
              <AssemblyIsoPreview
                surfaces={surfaces}
                bounds={fitBounds}
                rotation={assembly.viewRotation}
                selected={viewport === '3d'}
                selectedInstanceId={selectedInstanceId}
                onSelect={() => onViewportSelect('3d')}
                onDoubleSelect={() => onViewportDoubleSelect('3d')}
                onInstanceSelect={(id) => onInstanceSelect(id, '3d')}
              />
            ) : null}
          </>
        )}
      </svg>
    </div>
  );
}

function AssemblyFaceProjection({
  face,
  active,
  full = false,
  surfaces,
  bounds,
  selectedInstanceId,
  onInstanceSelect,
  onViewportSelect,
  onViewportDoubleSelect,
}) {
  const instanceIds = [...new Set(surfaces.map((surface) => surface.instanceId))];

  return (
    <g
      className={`face-plan assembly-face face-${face} ${active ? 'active' : ''}`}
      transform={getFaceTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={`アセンブリ ${FACE_LABELS[face]}`}
      onClick={() => onViewportSelect(face)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onViewportDoubleSelect(face);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onViewportSelect(face);
        }
      }}
    >
      <rect className="face-plan-bg" width="120" height="120" rx="2" />
      <rect className="face-plan-surface" width="120" height="120" />
      <line x1="0" y1="60" x2="120" y2="60" className="face-axis" />
      <line x1="60" y1="0" x2="60" y2="120" className="face-axis" />
      {surfaces.map((surface, index) => (
        <path
          key={`${face}-${surface.instanceId}-${index}`}
          className="assembly-projection-surface"
          d={getProjectedSurfacePathFrom3D(surface, face, bounds)}
          fill={surface.color}
          stroke={surface.color}
        />
      ))}
      {instanceIds.map((instanceId) => {
        const instanceSurfaces = surfaces.filter((surface) => surface.instanceId === instanceId);
        const projectedBounds = getProjectedInstanceBounds(instanceSurfaces, face, bounds);
        if (!projectedBounds) {
          return null;
        }
        const selected = instanceId === selectedInstanceId;
        return (
          <rect
            key={`${face}-hit-${instanceId}`}
            className={`assembly-hit-area ${selected ? 'selected' : ''}`}
            x={projectedBounds.minX}
            y={projectedBounds.minY}
            width={projectedBounds.maxX - projectedBounds.minX}
            height={projectedBounds.maxY - projectedBounds.minY}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(instanceId, face);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onViewportDoubleSelect(face);
            }}
          />
        );
      })}
      <text className="face-plan-label" x="60" y="112">{FACE_LABELS[face]}</text>
    </g>
  );
}

function AssemblyIsoPreview({
  surfaces,
  bounds,
  rotation,
  selected,
  expanded = false,
  selectedInstanceId,
  onSelect,
  onDoubleSelect,
  onInstanceSelect,
}) {
  const box = expanded
    ? { x: 30, y: 12, width: 266, height: 240, labelY: 238 }
    : { x: 198, y: 6, width: 120, height: 120, labelY: 116 };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (expanded ? 12 : 4) };
  const contentCenter = {
    x: (bounds.x.min + bounds.x.max) / 2,
    y: (bounds.y.min + bounds.y.max) / 2,
    z: (bounds.z.min + bounds.z.max) / 2,
  };
  const maxSize = Math.max(bounds.x.size, bounds.y.size, bounds.z.size);
  const scale = (expanded ? 104 : 50) / Math.max(1, maxSize);
  const projectedSurfaces = surfaces.map((surface) => {
    const projectedRings = surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint({
        x: point.x - contentCenter.x,
        y: point.y - contentCenter.y,
        z: point.z - contentCenter.z,
      }, rotation);
      return {
        ...rotated,
        sx: center.x + rotated.x * scale,
        sy: center.y - rotated.z * scale,
      };
    }));
    const projectedPoints = projectedRings.flat();
    const depth = projectedPoints.reduce((sum, point) => sum + point.y, 0) / projectedPoints.length;
    return {
      ...surface,
      depth,
      projectedRings,
      path: getProjectedSurfacePath(projectedRings),
    };
  }).sort((a, b) => b.depth - a.depth);

  const instanceIds = [...new Set(projectedSurfaces.map((surface) => surface.instanceId))];

  return (
    <g
      className={`iso-preview assembly-iso ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''}`}
      aria-label="アセンブリ3Dプレビュー"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleSelect();
      }}
    >
      <rect className="iso-preview-frame" x={box.x} y={box.y} width={box.width} height={box.height} rx="4" />
      {projectedSurfaces.map((surface, index) => (
        <g key={`assembly-iso-${surface.instanceId}-${index}`}>
          <path
            className="assembly-iso-surface"
            d={surface.path}
            fill={surface.color}
            stroke={surface.color}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(surface.instanceId);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onDoubleSelect();
            }}
          />
          {surface.projectedRings.flatMap((ring, ringIndex) =>
            ring.map((point, pointIndex) => {
              const next = ring[(pointIndex + 1) % ring.length];
              return (
                <line
                  key={`${index}-${ringIndex}-${pointIndex}`}
                  className="iso-preview-outline-edge"
                  x1={point.sx}
                  y1={point.sy}
                  x2={next.sx}
                  y2={next.sy}
                />
              );
            }),
          )}
        </g>
      ))}
      {instanceIds.map((instanceId) => {
        const points = projectedSurfaces
          .filter((surface) => surface.instanceId === instanceId)
          .flatMap((surface) => surface.projectedRings.flat());
        if (!points.length) {
          return null;
        }
        const minX = Math.min(...points.map((point) => point.sx));
        const maxX = Math.max(...points.map((point) => point.sx));
        const minY = Math.min(...points.map((point) => point.sy));
        const maxY = Math.max(...points.map((point) => point.sy));
        return (
          <rect
            key={`assembly-iso-hit-${instanceId}`}
            className={`assembly-hit-area ${instanceId === selectedInstanceId ? 'selected' : ''}`}
            x={minX}
            y={minY}
            width={maxX - minX}
            height={maxY - minY}
            onClick={(event) => {
              event.stopPropagation();
              onInstanceSelect(instanceId);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onDoubleSelect();
            }}
          />
        );
      })}
      <text x={box.x + box.width / 2} y={box.labelY}>3D assembly</text>
    </g>
  );
}

function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="part-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
        </header>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}

function LocalPrintDialog({
  info,
  currentModelReady,
  source,
  file,
  token,
  status,
  submitting,
  layerHeight,
  support,
  onSourceChange,
  onFileChange,
  onTokenChange,
  onLayerHeightChange,
  onSupportChange,
  onSubmit,
  onClose,
}) {
  const canSubmit = !submitting
    && (source === 'current' ? currentModelReady : Boolean(file))
    && (!info?.tokenRequired || Boolean(token.trim()));

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="part-dialog local-print-dialog" role="dialog" aria-modal="true" aria-label="ローカル3Dプリント">
        <header><h2>ローカル3Dプリント</h2></header>
        <p className="local-print-printer">送信先: {info?.printerName || 'ローカルプリンタ'}</p>
        <div className="local-print-source" role="radiogroup" aria-label="印刷データ">
          <label>
            <input
              type="radio"
              name="local-print-source"
              value="current"
              checked={source === 'current'}
              disabled={!currentModelReady || submitting}
              onChange={() => onSourceChange('current')}
            />
            現在のCADモデル
          </label>
          <label>
            <input
              type="radio"
              name="local-print-source"
              value="file"
              checked={source === 'file'}
              disabled={submitting}
              onChange={() => onSourceChange('file')}
            />
            STLファイル
          </label>
        </div>
        {source === 'file' ? (
          <label className="dialog-field">
            STLファイル
            <input
              type="file"
              accept=".stl,model/stl,application/octet-stream"
              disabled={submitting}
              onChange={(event) => onFileChange(event.target.files?.[0] || null)}
            />
          </label>
        ) : null}
        {info?.tokenRequired ? (
          <label className="dialog-field">
            Receiver token
            <input
              type="password"
              value={token}
              autoComplete="current-password"
              disabled={submitting}
              onChange={(event) => onTokenChange(event.target.value)}
            />
          </label>
        ) : null}
        <div className="local-print-settings">
          <label className="dialog-field">
            レイヤー高さ
            <select
              value={layerHeight}
              disabled={submitting}
              onChange={(event) => onLayerHeightChange(event.target.value)}
            >
              <option value="0.08">0.08 mm（高精細）</option>
              <option value="0.12">0.12 mm</option>
              <option value="0.16">0.16 mm</option>
              <option value="0.20">0.20 mm（標準）</option>
              <option value="0.24">0.24 mm</option>
              <option value="0.28">0.28 mm（高速）</option>
            </select>
          </label>
          <label className="local-print-support">
            <input
              type="checkbox"
              checked={support}
              disabled={submitting}
              onChange={(event) => onSupportChange(event.target.checked)}
            />
            サポートを自動生成
          </label>
        </div>
        <p className="local-print-warning">送信するとスライス後に実際の印刷を開始します。プリンタとベッドを確認してください。</p>
        {status ? <output className={`local-print-status ${status.type}`} aria-live="polite">{status.message}</output> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>閉じる</button>
          <button type="button" onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? '処理中...' : '送信して印刷'}
          </button>
        </div>
      </div>
    </div>
  );
}

function getAssemblyMoveAxes(viewport) {
  if (viewport === '3d') {
    return ['x', 'y', 'z'];
  }
  if (viewport === 'top') {
    return ['x', 'y'];
  }
  if (viewport === 'front') {
    return ['x', 'z'];
  }
  return ['y', 'z'];
}

function getAssemblyControlAxis(axis, viewport) {
  if (viewport === '3d') {
    return 'x';
  }
  return axis === 'z' ? 'y' : 'x';
}

function getAssemblyAxisLabel(axis) {
  return axis.toUpperCase();
}

function AssemblyPanel({
  assembly,
  savedParts,
  selectedInstance,
  selectedInstanceId,
  viewport,
  activeFace,
  editorRefs,
  onAddInstance,
  onSelectInstance,
  onUpdateInstance,
  onRemoveInstance,
  onViewRotationChange,
  onViewRotationReset,
  onViewRotationPreset,
}) {
  const [selectedPartId, setSelectedPartId] = useState(savedParts[0]?.id ?? '');
  const hasSavedParts = savedParts.length > 0;
  const selectedPart = savedParts.find((part) => part.id === selectedPartId);
  const selectedPartReady = Boolean(selectedPart && (getDocumentPreviewDimensions(selectedPart.document) || selectedPart.document.cad?.features.length));
  const activeViewLabel = viewport === '3d' ? '3D' : FACE_LABELS[activeFace];

  useEffect(() => {
    if (savedParts.length && !savedParts.some((part) => part.id === selectedPartId)) {
      setSelectedPartId(savedParts[0].id);
      return;
    }
    if (!savedParts.length && selectedPartId) {
      setSelectedPartId('');
    }
  }, [savedParts, selectedPartId]);

  return (
    <section className="assembly-panel" aria-label="アセンブリ">
      <header className="control-header">
        <div>
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>アセンブリ</h1>
        </div>
      </header>

      <AssemblyViewControls
        rotation={assembly.viewRotation}
        onChange={onViewRotationChange}
        onReset={onViewRotationReset}
        onView={(view) => onViewRotationPreset(FACE_VIEW_ROTATIONS[view])}
      />

      <div className="part-storage-panel assembly-load-panel">
        <h2>部品配置</h2>
        <label className="saved-part-field">
          <span>web保存データ</span>
          <select
            value={selectedPartId}
            disabled={!hasSavedParts}
            onChange={(event) => setSelectedPartId(event.target.value)}
          >
            {hasSavedParts ? savedParts.map((part) => (
              <option key={part.id} value={part.id}>{part.name}</option>
            )) : (
              <option value="">保存データなし</option>
            )}
          </select>
        </label>
        <div className="saved-part-actions">
          <button
            type="button"
            onClick={() => onAddInstance(selectedPartId)}
            disabled={!hasSavedParts || !selectedPartId || !selectedPartReady}
          >
            配置
          </button>
        </div>
        {!hasSavedParts ? (
          <p className="assembly-note">単品部品をweb保存するとここから配置できます。</p>
        ) : null}
        {selectedPart && !selectedPartReady ? (
          <p className="assembly-note danger-text">この部品は3面寸法を決められないため配置できません。</p>
        ) : null}
      </div>

      <div className="active-face-control assembly-active-face">
        <span>{viewport === '3d' ? '操作ビュー' : '操作面'}</span>
        <strong className={`face-label ${viewport === '3d' ? 'assembly-view-label' : `face-${activeFace}`}`}>
          {activeViewLabel}
        </strong>
      </div>

      <div className="assembly-list">
        {assembly.instances.length ? assembly.instances.map((instance) => (
          <AssemblyInstanceEditor
            key={instance.id}
            editorRef={(node) => {
              if (node) {
                editorRefs.current.set(instance.id, node);
              } else {
                editorRefs.current.delete(instance.id);
              }
            }}
            instance={instance}
            selected={instance.id === selectedInstanceId}
            viewport={viewport}
            onSelect={() => onSelectInstance(instance.id)}
            onChange={(patch) => onUpdateInstance(instance.id, patch)}
            onRemove={() => onRemoveInstance(instance.id)}
          />
        )) : (
          <div className="output-placeholder">
            部品を配置するとここに一覧表示されます。
          </div>
        )}
      </div>

      {selectedInstance ? (
        <p className="selection-note">選択中: {selectedInstance.name}</p>
      ) : (
        <p className="selection-note">右上の3D、または各面の部品をタップして選択できます。</p>
      )}
    </section>
  );
}

function AssemblyViewControls({ rotation, onChange, onReset, onView }) {
  return (
    <section className="rotation-panel assembly-view-controls" aria-label="アセンブリ画面回転">
      <div className="rotation-header">
        <span>画面回転</span>
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
              label={`${axis} assembly view rotation`}
              value={rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => onChange(axis, value)}
            />
          </label>
        ))}
      </div>
      <div className="assembly-view-actions">
        <button type="button" onClick={onReset}>初期角度</button>
        <div className="view-net" aria-label="アセンブリ方向プリセット">
          <button type="button" className="view-top" onClick={() => onView('top')}>上面</button>
          <button type="button" className="view-left" onClick={() => onView('left')}>左側面</button>
          <button type="button" className="view-front" onClick={() => onView('front')}>正面</button>
          <button type="button" className="view-right" onClick={() => onView('right')}>右側面</button>
          <button type="button" className="view-bottom" onClick={() => onView('bottom')}>底面</button>
          <button type="button" className="view-back" onClick={() => onView('back')}>背面</button>
        </div>
      </div>
    </section>
  );
}

function AssemblyInstanceEditor({
  editorRef,
  instance,
  selected,
  viewport,
  onSelect,
  onChange,
  onRemove,
}) {
  const moveAxes = getAssemblyMoveAxes(viewport);

  function updatePosition(axis, value) {
    onChange({
      position: {
        ...instance.position,
        [axis]: value,
      },
    });
  }

  function updateRotation(axis, value) {
    onChange({
      rotation: {
        ...instance.rotation,
        [axis]: value,
      },
    });
  }

  return (
    <article ref={editorRef} className={`assembly-card ${selected ? 'selected' : ''}`}>
      <header className="assembly-card-top">
        <button type="button" className="assembly-title" onClick={onSelect}>
          <span className="assembly-color-dot" style={{ backgroundColor: instance.color }} />
          <span>{instance.name}</span>
        </button>
        <input
          className="assembly-color-input"
          type="color"
          value={instance.color}
          aria-label={`${instance.name} color`}
          onChange={(event) => onChange({ color: event.target.value })}
        />
        <button type="button" className="danger" onClick={onRemove}>削除</button>
      </header>

      <div className="assembly-section-label">位置</div>
      <div className={`shape-control-grid assembly-position-grid ${viewport === '3d' ? 'three-axis' : ''}`}>
        {moveAxes.map((axis, index) => (
          <ControlField
            key={axis}
            axis={getAssemblyControlAxis(axis, viewport)}
            label={getAssemblyAxisLabel(axis)}
            value={instance.position[axis]}
            min={-120}
            max={120}
            invert={viewport !== '3d' && index === 1}
            onChange={(value) => updatePosition(axis, value)}
          />
        ))}
      </div>

      <div className="assembly-section-label">部品回転</div>
      <div className="assembly-rotation-grid">
        {['x', 'y', 'z'].map((axis) => (
          <label key={axis} className="rotation-field assembly-rotation-field">
            <span>{axis.toUpperCase()}</span>
            <input
              type="range"
              min="-180"
              max="180"
              step="90"
              value={instance.rotation[axis]}
              onChange={(event) => updateRotation(axis, Number(event.target.value))}
            />
            <NumberField
              label={`${axis} part rotation`}
              value={instance.rotation[axis]}
              min={-180}
              max={180}
              compact
              onChange={(value) => updateRotation(axis, snapRightAngle(value))}
            />
          </label>
        ))}
      </div>
    </article>
  );
}

function OutputPanel({
  format,
  jsonText,
  stlReady,
  stlSaving,
  stepSaving,
  meshResolution,
  meshResolutionMax,
  partName,
  savedParts,
  selectedSavedPartId,
  jsonImportStatus,
  onFormatChange,
  onPartNameChange,
  onSavedPartSelect,
  onLoadPart,
  onDeleteSavedPart,
  onImportJson,
  onImportJsonText,
  aiPrompt,
  onCopyAiPrompt,
  onCopyJson,
  onSaveJson,
  onSaveWeb,
  onMeshResolutionChange,
  onSaveStl,
  onSaveStep,
}) {
  const [pastedJson, setPastedJson] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const meshSaving = stlSaving || stepSaving;
  const hasSavedParts = savedParts.length > 0;
  const meshResolutionControl = (
    <label className="stl-resolution-control">
      <span>分割</span>
      <input
        type="range"
        min="1"
        max={meshResolutionMax}
        step="0.1"
        value={meshResolution}
        disabled={meshSaving || meshResolutionMax <= 1}
        onChange={(event) => onMeshResolutionChange(Number(event.target.value))}
      />
      <strong>{meshResolution.toFixed(1)}x</strong>
    </label>
  );

  return (
    <section className="output-panel" aria-label="保存">
      <header className="output-header">
        <div>
          <p className="eyebrow">Oshida Smartphone CAD</p>
          <h1>{format === 'help' ? 'ヘルプ' : format === 'load' ? '呼び出し' : '保存'}</h1>
        </div>
      </header>
      {format !== 'help' && format !== 'load' ? (
        <>
          <div className="part-storage-panel save-panel">
            <h2>保存</h2>
            <label className="part-name-field">
              <span>名前</span>
              <input
                type="text"
                value={partName}
                onChange={(event) => onPartNameChange(event.target.value)}
              />
            </label>
            <p className="web-save-warning">
              web保存はブラウザ内に保存されます。キャッシュやサイトデータを消すと削除されます。
            </p>
          </div>
          <div className="output-tabs" role="tablist" aria-label="保存形式">
            {['json', 'stl', 'step'].map((item) => (
              <button
                key={item}
                type="button"
                className={format === item ? 'active' : ''}
                onClick={() => onFormatChange(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {format === 'load' ? (
        <div className="load-sections">
          <div className="part-storage-panel load-panel">
            <h2>JSONファイル</h2>
            <label className="json-file-field">
              <span>ローカルファイル</span>
              <input
                type="file"
                accept=".json,application/json"
                disabled={jsonImportStatus?.type === 'loading'}
                onChange={(event) => {
                  const [file] = event.target.files;
                  if (file) {
                    onImportJson(file);
                  }
                  event.target.value = '';
                }}
              />
            </label>
            <p className="load-note">JSON保存したモデル、または同じschemaに沿ったJSONを読み込めます。</p>
          </div>
          <div className="part-storage-panel load-panel">
            <h2>JSON貼り付け</h2>
            <label className="json-paste-field">
              <span>JSON</span>
              <textarea
                value={pastedJson}
                rows="10"
                spellCheck="false"
                placeholder='{"schemaVersion": 5, ...}'
                onChange={(event) => setPastedJson(event.target.value)}
              />
            </label>
            <div className="output-actions">
              <button
                type="button"
                disabled={!pastedJson.trim()}
                onClick={() => onImportJsonText(pastedJson)}
              >
                読み込む
              </button>
              <button type="button" disabled={!pastedJson} onClick={() => setPastedJson('')}>
                クリア
              </button>
            </div>
          </div>
          {jsonImportStatus ? (
            <p className={`json-import-status ${jsonImportStatus.type}`} role="status">
              {jsonImportStatus.message}
            </p>
          ) : null}
          <div className="part-storage-panel load-panel">
            <h2>web保存データ</h2>
            <label className="saved-part-field">
              <span>呼び出しデータ</span>
              <select
                value={selectedSavedPartId}
                disabled={!hasSavedParts}
                onChange={(event) => onSavedPartSelect(event.target.value)}
              >
                {hasSavedParts ? savedParts.map((part) => (
                  <option key={part.id} value={part.id}>{part.name}</option>
                )) : (
                  <option value="">保存データなし</option>
                )}
              </select>
            </label>
            <div className="saved-part-actions">
              <button type="button" onClick={onLoadPart} disabled={!hasSavedParts || !selectedSavedPartId}>
                呼び出し
              </button>
              <button type="button" onClick={onDeleteSavedPart} disabled={!hasSavedParts || !selectedSavedPartId}>
                削除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {format === 'json' ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onCopyJson}>コピー</button>
              <button type="button" onClick={onSaveJson}>保存</button>
              <button type="button" onClick={onSaveWeb} disabled={!partName.trim()}>web保存</button>
            </div>
            <pre className="json-view">{jsonText}</pre>
          </div>
      ) : null}
      {format === 'stl' ? (
        stlReady ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onSaveStl} disabled={stlSaving}>
                {stlSaving ? '生成中...' : '保存'}
              </button>
            </div>
            {meshResolutionControl}
            <div className="output-placeholder">
              STLは保存時にスライサー向けの閉じたメッシュで生成します。
            </div>
          </div>
        ) : (
          <div className="output-placeholder">
            3面をロックするとSTL保存できます。
          </div>
        )
      ) : null}
      {format === 'step' ? (
        stlReady ? (
          <div className="output-content">
            <div className="output-actions">
              <button type="button" onClick={onSaveStep} disabled={stepSaving}>
                {stepSaving ? '生成中...' : '保存'}
              </button>
            </div>
            <div className="output-placeholder">
              STEPは保存時にOpenCascadeでB-repとして生成します。
            </div>
          </div>
        ) : (
          <div className="output-placeholder">
            3面をロックするとSTEP保存できます。
          </div>
        )
      ) : null}
      {format === 'help' ? (
        <HelpPanel
          aiPrompt={aiPrompt}
          promptCopied={promptCopied}
          onCopyAiPrompt={async () => {
            await onCopyAiPrompt();
            setPromptCopied(true);
            window.setTimeout(() => setPromptCopied(false), 1800);
          }}
        />
      ) : null}
    </section>
  );
}

function HelpPanel({ aiPrompt, promptCopied, onCopyAiPrompt }) {
  return (
    <div className="help-panel">
      <div className="help-video">
        <iframe
          src="https://www.youtube-nocookie.com/embed/wOr0bMkgqu4"
          title="オシダスマホキャドの使い方"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          loading="lazy"
          allowFullScreen
        />
      </div>
      <h2>基本の流れ</h2>
      <ol>
        <li>上面に図形を置き、エリアをロックします。</li>
        <li>正面に図形を置き、エリアをロックします。</li>
        <li>右側面に図形を置き、エリアをロックします。</li>
        <li>3面すべてが成り立つと、右上に3Dプレビューが表示されます。</li>
      </ol>
      <h2>操作</h2>
      <ul>
        <li>「+四角」で四角形を追加し、X・Y位置と幅・高さを調整します。addで外形を足し、cutで切り欠きや角穴を作れます。</li>
        <li>「+円」で円を追加し、中心のX・Y位置と半径を調整します。addで円形外形を足し、cutで丸穴を作れます。</li>
        <li>「+ギヤ」では20度圧力角の平歯車を追加し、モジュール・歯数・中央穴径を調整できます。</li>
        <li>「+ラック」では20度圧力角のラックギヤを追加し、モジュール・歯数・歯先からの全高を調整できます。</li>
        <li>「+内歯」では20度圧力角の内歯車を追加し、モジュール・歯数・外径を成立範囲内で調整できます。</li>
        <li>図形をタップすると、その図形の編集UIへ移動します。</li>
        <li>図形以外をタップすると、その面の先頭へ戻ります。</li>
        <li>アシストの「フィット」をオンにすると、スライダー操作中の図形がロック済みの隣接面や同じ面にある他の図形の端・段差・中央・幅・高さへ近づいた時に吸着します。</li>
        <li>ロック面の外形中央と各配置図形の中心は、隣接面に破線で表示されます。各図形の薄い「＋」は中心位置で、フィットした図形は黒く表示されます。</li>
        <li>吸着後は同じスライダーをそのまま動かして微調整できます。数値入力欄はフィットせず、入力値をそのまま使用します。</li>
        <li>3D成立前の右上には簡単な手順を表示します。アシストの「簡易ヘルプ」で表示を切り替えられます。</li>
        <li>各面の「拡大」を押すか面をダブルタップすると、その面だけを表示します。「縮小」または再度のダブルタップで3面図へ戻ります。</li>
        <li>3Dプレビューをタップすると、回転・透過・グリッド・エッジの表示を調整できます。</li>
        <li>3Dプレビューの「拡大」を押すかダブルタップすると3D表示を拡大し、「縮小」または再度のダブルタップで戻ります。</li>
      </ul>
      <h2>保存</h2>
      <ul>
        <li>JSONは現在の編集データです。ファイル保存、ファイル読込、web保存ができます。</li>
        <li>STLはスライサー向けのメッシュとして保存します。</li>
        <li>STEPはOpenCascadeでCAD向けのB-repとして保存します。</li>
      </ul>
      <h2>AIでJSONを作る</h2>
      <p className="help-copy">下の指示文をAIへ貼り付け、最後の「作りたい部品の要件」を書き換えてください。返されたJSONは呼び出し画面へそのまま貼り付けられます。</p>
      <div className="ai-prompt-actions">
        <button type="button" onClick={onCopyAiPrompt}>
          {promptCopied ? 'コピーしました' : 'AI指示文をコピー'}
        </button>
      </div>
      <details className="ai-prompt-details">
        <summary>指示文を表示</summary>
        <pre>{aiPrompt}</pre>
      </details>
      <h2>ロックのヒント</h2>
      <ul>
        <li>ロックは、その面の外形範囲を他の面へ反映して、3Dとして矛盾しない配置範囲を固定する機能です。</li>
        <li>薄く表示されたロックボタンもタップできます。ロックできない場合は、幅・奥行・高さの不一致範囲を下に表示します。</li>
        <li>未ロック面の薄い灰色矢印は、ロック済み面が決めた固定範囲です。現在の図形範囲は赤矢印で重なり、両端が一致すると緑の矢印と○になります。図形がない時は灰色矢印だけ表示し、ロック後は消えます。</li>
        <li>ロックできない時は、他の面の図形が灰色の禁止エリアにはみ出していないか確認してください。</li>
        <li>共有範囲は、上面X＝正面X、上面Y＝右側面X、正面Y＝右側面Yです。サイズだけでなく開始・終了位置も合わせてください。</li>
        <li>JSONのextrude値は互換用で、奥行の指定には使われません。奥行は上面Yと右側面Xで決まります。</li>
        <li>cut図形で外形を凹ませる場合は、図形の順番が影響します。後ろのaddは前のcutを上書きできます。</li>
        <li>上面は幅と奥行き、正面は幅と高さ、右側面は奥行きと高さに影響します。</li>
        <li>3面すべてをロックすると、3DプレビューとSTL/STEP保存が使えるようになります。</li>
      </ul>
      <h2>Fusionアドイン（動作確認中）</h2>
      <p className="help-copy">
        保存したJSONをAutodesk Fusionへ読み込み、編集履歴付きのソリッドとして再構築するアドインを公開しています。
        導入方法とダウンロードは
        <a
          href="https://github.com/pscmps/oshidasumaho_cad/tree/main/fusion_addin"
          target="_blank"
          rel="noreferrer"
        >
          GitHubのFusion Add-inページ
        </a>
        を確認してください。
      </p>
    </div>
  );
}

function getAreaLockTransform(face, full) {
  if (full) {
    return 'translate(48 22)';
  }
  if (face === 'right') {
    return 'translate(332 190)';
  }
  if (face === 'front') {
    return 'translate(6 190)';
  }
  return 'translate(6 54)';
}

function AreaLockButton({ face, full, locked, disabled, diagnostic, onToggle }) {
  return (
    <g
      className={`area-lock-button face-${face} ${locked ? 'locked' : ''} ${disabled ? 'disabled' : ''}`}
      transform={getAreaLockTransform(face, full)}
      role="button"
      tabIndex="0"
      aria-label={`${FACE_LABELS[face]} エリアロック`}
      aria-disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(face);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle(face);
        }
      }}
    >
      <title>{disabled ? 'タップするとロックできない理由を表示します' : `${FACE_LABELS[face]}をロック`}</title>
      <rect width="50" height="24" rx="5" />
      <text x="25" y="16">エリア</text>
      <text x="43" y="16">🔒</text>
    </g>
  );
}

function getPreviewScaleTransform(face, full, is3D) {
  if (is3D) {
    return full ? 'translate(310 22)' : 'translate(330 54)';
  }
  const lockTransform = getAreaLockTransform(face, full);
  return lockTransform.replace(/translate\(([-\d.]+) ([-\d.]+)\)/, (_, x, y) => (
    `translate(${x} ${Number(y) + 28})`
  ));
}

function PreviewScaleButton({ face = 'top', full = false, expanded = false, is3D = false, onToggle }) {
  const label = expanded ? '縮小' : '拡大';
  const targetLabel = is3D ? '3Dプレビュー' : FACE_LABELS[face];
  return (
    <g
      className="preview-scale-button"
      transform={getPreviewScaleTransform(face, full, is3D)}
      role="button"
      tabIndex="0"
      aria-label={`${targetLabel}を${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <title>{targetLabel}を{label}</title>
      <rect width="50" height="22" rx="4" />
      <text x="25" y="15">{label}</text>
    </g>
  );
}

function AreaLockFeedback({ diagnostic }) {
  if (diagnostic.reason === 'missing-shape') {
    return (
      <section className="area-lock-feedback" role="alert">
        <strong>{FACE_LABELS[diagnostic.face]}をロックできません</strong>
        <p>この面に外形を作るadd図形がありません。</p>
      </section>
    );
  }

  return (
    <section className="area-lock-feedback" role="alert">
      <strong>{FACE_LABELS[diagnostic.face]}をロックできません</strong>
      {diagnostic.violations.map((violation, index) => {
        const sourceLabels = violation.sourceFaces.map((face) => FACE_LABELS[face]).join('・');
        return (
          <div key={`${violation.targetFace}-${violation.axis}-${index}`} className="area-lock-violation">
            <b>
              {violation.matchMode === 'exact-edges'
                ? `${DIMENSION_LABELS[violation.dimension]}の両端が一致していません`
                : `${DIMENSION_LABELS[violation.dimension]}範囲が一致していません`}
            </b>
            <span>{FACE_LABELS[violation.targetFace]}: {formatRange(violation.actualMin, violation.actualMax)}</span>
            <span>許容範囲: {formatRange(violation.expectedMin, violation.expectedMax)}</span>
            <small>{sourceLabels || 'ロック済み面'}と共有する{DIMENSION_LABELS[violation.dimension]}の開始・終了位置を合わせてください。</small>
          </div>
        );
      })}
    </section>
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

function getProjectedSurfacePath(rings) {
  return rings
    .map((ring) => ring
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.sx} ${point.sy}`)
      .join(' '))
    .map((path) => `${path} Z`)
    .join(' ');
}

function getSurfaceEdgeKey(surface, ringIndex, pointIndex) {
  const ring = surface.rings[ringIndex];
  const nextIndex = (pointIndex + 1) % ring.length;
  const pointKey = (point) => `${point.x.toFixed(4)}:${point.y.toFixed(4)}:${point.z.toFixed(4)}`;
  return [
    surface.className,
    [pointKey(ring[pointIndex]), pointKey(ring[nextIndex])].sort().join('|'),
  ].join('|');
}

function IsometricPreview({
  dimensions,
  nativeMesh,
  shapes,
  rotation,
  transparent = false,
  showGrid = true,
  showEdges = true,
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
  const surfaces = useMemo(() => nativeMesh !== undefined ? meshToSurfaces(nativeMesh) : buildSurfacePreviewFaces(shapes, dimensions), [shapes, dimensions, nativeMesh]);
  const projectedSurfaces = surfaces.map((surface) => {
    const projectedRings = surface.rings.map((ring) => ring.map((point) => {
      const rotated = rotatePoint(point, rotation);
      return {
        ...rotated,
        sx: center.x + rotated.x * scale,
        sy: center.y - rotated.z * scale,
      };
    }));
    const projectedPoints = projectedRings.flat();
    const depth = projectedPoints.reduce((sum, point) => sum + point.y, 0) / projectedPoints.length;
    return {
      ...surface,
      depth,
      projectedRings,
      path: getProjectedSurfacePath(projectedRings),
    };
  }).sort((a, b) => b.depth - a.depth);
  const edgeUsage = new Map();
  surfaces.forEach((surface) => {
    if (surface.edge === false) {
      return;
    }
    surface.rings.forEach((ring, ringIndex) => {
      ring.forEach((_, pointIndex) => {
        const key = getSurfaceEdgeKey(surface, ringIndex, pointIndex);
        edgeUsage.set(key, (edgeUsage.get(key) || 0) + 1);
      });
    });
  });

  return (
    <g
      className={`iso-preview ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''} ${transparent ? 'transparent' : ''} ${showGrid ? 'grid-on' : ''} ${showEdges ? 'edges-on' : ''}`}
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
      <rect className="iso-preview-frame" x={box.x} y={box.y} width={box.width} height={box.height} rx="4" />
      {projectedSurfaces.map((surface, index) => (
        <g key={`${surface.className}-${index}`}>
          <path className={surface.className} d={surface.path} fillRule="evenodd" />
          {showEdges && surface.edge !== false ? surface.projectedRings.flatMap((ring, ringIndex) =>
            ring.map((point, pointIndex) => {
              const key = getSurfaceEdgeKey(surface, ringIndex, pointIndex);
              if (edgeUsage.get(key) !== 1) {
                return null;
              }
              const next = ring[(pointIndex + 1) % ring.length];
              return (
                <line
                  key={`${index}-${ringIndex}-${pointIndex}`}
                  className="iso-preview-outline-edge"
                  x1={point.sx}
                  y1={point.sy}
                  x2={next.sx}
                  y2={next.sy}
                />
              );
            }),
          ) : null}
        </g>
      ))}
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

function formatDimensionValue(value) {
  return Number(Math.max(0, value).toFixed(1)).toString();
}

function getDimensionTextPoint(start, end, offset = 0) {
  const horizontal = Math.abs(start.y - end.y) < 0.001;
  if (horizontal) {
    return {
      x: (start.x + end.x) / 2,
      y: start.y - 2 + offset,
      rotate: null,
    };
  }
  return {
    x: start.x + 3 + offset,
    y: (start.y + end.y) / 2,
    rotate: null,
  };
}

function DimensionArrow({ start, end, value, className = '' }) {
  const textPoint = getDimensionTextPoint(start, end);
  if (value <= 0.001) {
    return null;
  }

  return (
    <g className={`dimension-line ${className}`}>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        markerStart="url(#dimension-arrow)"
        markerEnd="url(#dimension-arrow)"
      />
      <text x={textPoint.x} y={textPoint.y}>
        {formatDimensionValue(value)}
      </text>
    </g>
  );
}

function ShapeDimensions({ shape, outerBounds }) {
  if (!outerBounds) {
    return null;
  }

  const bounds = getShapeBounds2D(shape);
  const topY = clampValue(bounds.minY - 7, 7, 113);
  const bottomY = clampValue(bounds.maxY + 7, 7, 113);
  const leftX = clampValue(bounds.minX - 7, 7, 113);
  const rightX = clampValue(bounds.maxX + 7, 7, 113);
  const centerX = clampValue(bounds.centerX, 7, 113);
  const centerY = clampValue(bounds.centerY, 7, 113);

  const distanceArrows = [
    {
      key: 'left',
      start: { x: outerBounds.minX, y: topY },
      end: { x: bounds.minX, y: topY },
      value: bounds.minX - outerBounds.minX,
    },
    {
      key: 'right',
      start: { x: bounds.maxX, y: topY },
      end: { x: outerBounds.maxX, y: topY },
      value: outerBounds.maxX - bounds.maxX,
    },
    {
      key: 'top',
      start: { x: leftX, y: outerBounds.minY },
      end: { x: leftX, y: bounds.minY },
      value: bounds.minY - outerBounds.minY,
    },
    {
      key: 'bottom',
      start: { x: rightX, y: bounds.maxY },
      end: { x: rightX, y: outerBounds.maxY },
      value: outerBounds.maxY - bounds.maxY,
    },
  ];

  const shapeSizeArrows = shape.mode === 'add'
    ? [
        {
          key: 'width',
          start: { x: bounds.minX, y: bottomY },
          end: { x: bounds.maxX, y: bottomY },
          value: bounds.width,
          className: 'shape-size',
        },
        {
          key: 'height',
          start: { x: centerX, y: bounds.minY },
          end: { x: centerX, y: bounds.maxY },
          value: bounds.height,
          className: 'shape-size',
        },
      ]
    : [];

  return (
    <g className={`shape-dimensions ${shape.mode}`}>
      {[...distanceArrows, ...shapeSizeArrows].map((arrow) => (
        <DimensionArrow
          key={arrow.key}
          start={arrow.start}
          end={arrow.end}
          value={arrow.value}
          className={arrow.className}
        />
      ))}
    </g>
  );
}

function FitCenterGuides({ targets, feedback }) {
  return (
    <g className="fit-center-guides" aria-hidden="true">
      {(targets?.x?.centers ?? []).map((center) => (
        <line
          key={`x-${center}`}
          className={`fit-center-guide ${
            feedback?.kind === 'center'
            && feedback.axis === 'x'
            && Math.abs(feedback.target - center) < 0.051
              ? 'active'
              : ''
          }`}
          x1={center}
          y1="0"
          x2={center}
          y2="120"
        />
      ))}
      {(targets?.y?.centers ?? []).map((center) => (
        <line
          key={`y-${center}`}
          className={`fit-center-guide ${
            feedback?.kind === 'center'
            && feedback.axis === 'y'
            && Math.abs(feedback.target - center) < 0.051
              ? 'active'
              : ''
          }`}
          x1="0"
          y1={center}
          x2="120"
          y2={center}
        />
      ))}
    </g>
  );
}

function ShapeCenterMarker({ shape, active }) {
  const bounds = getShapeBounds2D(shape);
  return (
    <g className={`shape-center-marker ${active ? 'active' : ''}`} aria-hidden="true">
      <line x1={bounds.centerX - 3} y1={bounds.centerY} x2={bounds.centerX + 3} y2={bounds.centerY} />
      <line x1={bounds.centerX} y1={bounds.centerY - 3} x2={bounds.centerX} y2={bounds.centerY + 3} />
    </g>
  );
}

function FacePlan({
  face,
  active,
  full,
  shapes,
  constraint,
  axisReadiness,
  fitTargets,
  fitFeedback,
  showAllDimensions,
  selectedId,
  onSelect,
  onFaceSelect,
  onFaceDoubleSelect,
}) {
  const outerBounds = getBooleanPolygonBounds(getFaceBooleanPolygons(shapes));
  const dimensionShapes = shapes.filter((shape) => showAllDimensions || shape.showDimensions);

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
      <rect className="face-plan-surface" width="120" height="120" />
      <rect className="face-plan-grid" width="120" height="120" />
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
      <FitCenterGuides targets={fitTargets} feedback={fitFeedback} />
      {shapes.map((shape) => (
        <ShapeCenterMarker
          key={`center-${shape.id}`}
          shape={shape}
          active={fitFeedback?.shapeId === shape.id}
        />
      ))}
      {dimensionShapes.map((shape) => (
        <ShapeDimensions key={`dimensions-${shape.id}`} shape={shape} outerBounds={outerBounds} />
      ))}
      <text className="face-plan-label" x="60" y="112">{FACE_LABELS[face]}</text>
      <ProjectionReadinessIndicator axis="x" readiness={axisReadiness?.x} />
      <ProjectionReadinessIndicator axis="y" readiness={axisReadiness?.y} />
    </g>
  );
}

function getProjectionReadinessLabel(readiness) {
  const dimension = DIMENSION_LABELS[readiness.dimension];
  const counterpart = FACE_LABELS[readiness.counterpartFace];
  if (readiness.status === 'pass') {
    return `${dimension}: ${counterpart}の固定範囲と両端が一致しています`;
  }
  if (readiness.reason === 'missing-shape') {
    return `${dimension}: この面にadd外形がありません`;
  }
  if (readiness.status === 'fail') {
    return `${dimension}: ${counterpart}の固定範囲と両端を合わせてください`;
  }
  return `${dimension}: 補助表示なし`;
}

function ProjectionReadinessIndicator({ axis, readiness }) {
  if (!readiness || readiness.status === 'hidden') {
    return null;
  }

  const horizontal = axis === 'x';
  const markerValue = clampValue(
    readiness.actualRange?.max ?? readiness.expectedRange?.max ?? 60,
    4,
    116,
  );
  const statusX = horizontal ? markerValue : 129;
  const statusY = horizontal ? 129 : markerValue;
  const label = getProjectionReadinessLabel(readiness);
  const showActual = Boolean(readiness.actualRange);

  return (
    <g
      className={`projection-readiness ${horizontal ? 'horizontal' : 'vertical'} ${readiness.status}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <ProjectionRangeArrow axis={axis} range={readiness.expectedRange} kind="expected" />
      {showActual ? (
        <ProjectionRangeArrow axis={axis} range={readiness.actualRange} kind={`actual ${readiness.status}`} />
      ) : null}
      {showActual && readiness.status === 'pass' ? (
        <circle className="projection-readiness-pass" cx={statusX} cy={statusY} r="4.2" />
      ) : null}
      {showActual && readiness.status === 'fail' ? (
        <g className="projection-readiness-fail">
          <line x1={statusX - 3.2} y1={statusY - 3.2} x2={statusX + 3.2} y2={statusY + 3.2} />
          <line x1={statusX + 3.2} y1={statusY - 3.2} x2={statusX - 3.2} y2={statusY + 3.2} />
        </g>
      ) : null}
    </g>
  );
}

function ProjectionRangeArrow({ axis, range, kind }) {
  if (!range) {
    return null;
  }

  const min = clampValue(range.min, 0, 120);
  const max = clampValue(range.max, 0, 120);
  const headSize = Math.min(3, Math.max(1, (max - min) / 3));
  if (axis === 'x') {
    return (
      <g className={`projection-range-arrow ${kind}`}>
        <line x1={min} y1="124" x2={max} y2="124" />
        <polyline points={`${min + headSize},${124 - headSize} ${min},124 ${min + headSize},${124 + headSize}`} />
        <polyline points={`${max - headSize},${124 - headSize} ${max},124 ${max - headSize},${124 + headSize}`} />
      </g>
    );
  }

  return (
    <g className={`projection-range-arrow ${kind}`}>
      <line x1="124" y1={min} x2="124" y2={max} />
      <polyline points={`${124 - headSize},${min + headSize} 124,${min} ${124 + headSize},${min + headSize}`} />
      <polyline points={`${124 - headSize},${max - headSize} 124,${max} ${124 + headSize},${max - headSize}`} />
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

function ringToSvgPath(ring) {
  if (!ring.length) {
    return '';
  }
  return `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

function getGearBoreSvgPath(shape) {
  const { boreRadius } = getGearRadii(shape);
  if (boreRadius <= 0) {
    return '';
  }
  return [
    `M ${shape.x - boreRadius} ${shape.y}`,
    `A ${boreRadius} ${boreRadius} 0 1 0 ${shape.x + boreRadius} ${shape.y}`,
    `A ${boreRadius} ${boreRadius} 0 1 0 ${shape.x - boreRadius} ${shape.y}`,
    'Z',
  ].join(' ');
}

function getGearBodySvgPath(shape) {
  return `${ringToSvgPath(getGearOutlineRing(shape))} ${getGearBoreSvgPath(shape)}`.trim();
}

function getInternalGearBodySvgPath(shape) {
  return `${ringToSvgPath(getInternalGearOuterRing(shape))} ${ringToSvgPath(getInternalGearInnerRing(shape))}`;
}

function MaskShape({ shape }) {
  const fill = shape.mode === 'cut' ? 'black' : 'white';
  if (shape.type === 'circle') {
    return <circle cx={shape.x} cy={shape.y} r={shape.r} fill={fill} />;
  }
  if (shape.type === 'gear') {
    const { boreRadius } = getGearRadii(shape);
    return (
      <>
        <path d={ringToSvgPath(getGearOutlineRing(shape))} fill={fill} />
        {boreRadius > 0 ? <circle cx={shape.x} cy={shape.y} r={boreRadius} fill="black" /> : null}
      </>
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <>
        <path d={ringToSvgPath(getInternalGearOuterRing(shape))} fill={fill} />
        <path d={ringToSvgPath(getInternalGearInnerRing(shape))} fill="black" />
      </>
    );
  }
  if (shape.type === 'rack') {
    return <path d={ringToSvgPath(getRackGearOutlineRing(shape))} fill={fill} />;
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
  if (shape.type === 'gear') {
    const { boreRadius } = getGearRadii(shape);
    return (
      <>
        <path className={className} d={ringToSvgPath(getGearOutlineRing(shape))} />
        {boreRadius > 0 ? (
          <circle className={className} cx={shape.x} cy={shape.y} r={boreRadius} />
        ) : null}
      </>
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <>
        <path className={className} d={ringToSvgPath(getInternalGearOuterRing(shape))} />
        <path className={className} d={ringToSvgPath(getInternalGearInnerRing(shape))} />
      </>
    );
  }
  if (shape.type === 'rack') {
    return <path className={className} d={ringToSvgPath(getRackGearOutlineRing(shape))} />;
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
  if (shape.type === 'gear') {
    return (
      <path
        className={className}
        d={getGearBodySvgPath(shape)}
        fillRule="evenodd"
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }
  if (shape.type === 'internalGear') {
    return (
      <path
        className={className}
        d={getInternalGearBodySvgPath(shape)}
        fillRule="evenodd"
        onClick={handleSelect}
        onDoubleClick={handleDoubleClick}
      />
    );
  }
  if (shape.type === 'rack') {
    return (
      <path
        className={className}
        d={ringToSvgPath(getRackGearOutlineRing(shape))}
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
  const rackRotation = shape.type === 'rack' ? normalizeRackRotation(shape.rotation) : 0;

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
          disabled={shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear'}
          title={shape.type === 'gear' || shape.type === 'rack' || shape.type === 'internalGear' ? 'ギヤ形状はadd専用です' : undefined}
        >
          <option value="add">add</option>
          <option value="cut">cut</option>
        </select>
        <button
          type="button"
          className={`dimension-toggle ${shape.showDimensions ? 'active-toggle' : ''}`}
          aria-pressed={Boolean(shape.showDimensions)}
          onClick={() => onChange({ showDimensions: !shape.showDimensions })}
        >
          寸法
        </button>
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

      <div className={`shape-control-grid ${shape.type === 'gear' || shape.type === 'internalGear' ? 'gear-controls' : ''} ${shape.type === 'rack' ? 'rack-controls' : ''}`}>
        <ControlField
          axis="x"
          label="X"
          value={shape.x}
          min={limits.x.min}
          max={limits.x.max}
          onChange={(x, input) => onChange({ x }, { ...input, field: 'x' })}
        />
        <ControlField
          axis="y"
          label="Y"
          value={shape.y}
          min={limits.y.min}
          max={limits.y.max}
          invert
          onChange={(y, input) => onChange({ y }, { ...input, field: 'y' })}
        />
        {shape.type === 'rect' ? (
          <>
            <ControlField
              axis="x"
              label="W"
              value={shape.w}
              min={limits.w.min}
              max={limits.w.max}
              onChange={(w, input) => onChange({ w }, { ...input, field: 'w' })}
            />
            <ControlField
              axis="y"
              label="H"
              value={shape.h}
              min={limits.h.min}
              max={limits.h.max}
              onChange={(h, input) => onChange({ h }, { ...input, field: 'h' })}
            />
          </>
        ) : shape.type === 'circle' ? (
          <>
            <ControlField
              axis="x"
              label="R"
              value={shape.r}
              min={limits.r.min}
              max={limits.r.max}
              onChange={(r, input) => onChange({ r }, { ...input, field: 'r' })}
            />
            <div className="control-field empty" aria-hidden="true" />
          </>
        ) : shape.type === 'gear' ? (
          <>
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue, input) => onChange({ module: moduleValue }, { ...input, field: 'module' })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              onChange={(teeth, input) => onChange({ teeth: Math.round(teeth) }, { ...input, field: 'teeth' })}
            />
            <ControlField
              axis="x"
              label="穴径"
              value={shape.bore}
              min={limits.bore.min}
              max={limits.bore.max}
              onChange={(bore, input) => onChange({ bore }, { ...input, field: 'bore' })}
            />
          </>
        ) : shape.type === 'rack' ? (
          <>
            <ControlField
              axis="x"
              label="W"
              value={shape.width ?? limits.width.min}
              min={limits.width.min}
              max={limits.width.max}
              step={1}
              onChange={(width, input) => onChange({ width }, { ...input, field: 'width' })}
            />
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue, input) => onChange({ module: moduleValue }, { ...input, field: 'module' })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              step={1}
              onChange={(teeth, input) => onChange({ teeth: Math.round(teeth) }, { ...input, field: 'teeth' })}
            />
            <ControlField
              axis="y"
              label="歯先高"
              value={shape.height}
              min={limits.height.min}
              max={limits.height.max}
              step={1}
              onChange={(height, input) => onChange({ height }, { ...input, field: 'height' })}
            />
            <div className="rack-rotation-controls" aria-label={`ラック回転 ${rackRotation}度`}>
              <span>回転</span>
              <button
                type="button"
                onClick={() => onChange({ rotation: normalizeRackRotation(rackRotation + 90) })}
                title="ラックを90度回転"
              >
                +90
              </button>
              <button
                type="button"
                onClick={() => onChange({ rotation: normalizeRackRotation(rackRotation - 90) })}
                title="ラックを-90度回転"
              >
                -90
              </button>
            </div>
          </>
        ) : (
          <>
            <ControlField
              axis="x"
              label="M"
              value={shape.module}
              min={limits.module.min}
              max={limits.module.max}
              step={0.5}
              onChange={(moduleValue, input) => onChange({ module: moduleValue }, { ...input, field: 'module' })}
            />
            <ControlField
              axis="x"
              label="歯数"
              value={shape.teeth}
              min={limits.teeth.min}
              max={limits.teeth.max}
              step={1}
              onChange={(teeth, input) => onChange({ teeth: Math.round(teeth) }, { ...input, field: 'teeth' })}
            />
            <ControlField
              axis="x"
              label="外径"
              value={shape.outerDiameter}
              min={limits.outerDiameter.min}
              max={limits.outerDiameter.max}
              step={0.5}
              onChange={(outerDiameter, input) => onChange({ outerDiameter }, { ...input, field: 'outerDiameter' })}
            />
          </>
        )}
      </div>
    </article>
  );
}

function RotationControls({
  rotation,
  transparent,
  showGrid,
  showEdges,
  onChange,
  onReset,
  onView,
  onTransparencyChange,
  onGridChange,
  onEdgesChange,
}) {
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
      <div className="rotation-actions">
        <button type="button" className="rotation-reset" onClick={onReset}>
          初期角度
        </button>
        <div className="view-net" aria-label="3D view presets">
          <button type="button" className="view-top" onClick={() => onView('top')}>上面</button>
          <button type="button" className="view-left" onClick={() => onView('left')}>左側面</button>
          <button type="button" className="view-front" onClick={() => onView('front')}>正面</button>
          <button type="button" className="view-right" onClick={() => onView('right')}>右側面</button>
          <button type="button" className="view-bottom" onClick={() => onView('bottom')}>底面</button>
          <button type="button" className="view-back" onClick={() => onView('back')}>背面</button>
        </div>
        <label className="transparent-toggle">
          <input
            type="checkbox"
            checked={transparent}
            onChange={(event) => onTransparencyChange(event.target.checked)}
          />
          <span>透過</span>
        </label>
        <label className="grid-toggle">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(event) => onGridChange(event.target.checked)}
          />
          <span>グリッド</span>
        </label>
        <label className="edge-toggle">
          <input
            type="checkbox"
            checked={showEdges}
            onChange={(event) => onEdgesChange(event.target.checked)}
          />
          <span>エッジ</span>
        </label>
      </div>
    </section>
  );
}

function ControlField({ axis, label, value, min, max, step = 1, invert = false, onChange }) {
  const controlMin = ceilToModelPrecision(min);
  const controlMax = Math.max(controlMin, floorToModelPrecision(max));
  const controlValue = roundToModelPrecision(clampValue(value, controlMin, controlMax));
  const sliderScale = createDiscreteSliderScale(controlMin, controlMax, step);
  const controlPosition = sliderScale.positionFor(controlValue);
  const sliderValue = invert ? sliderScale.maxPosition - controlPosition : controlPosition;

  function handleSliderChange(event) {
    const nextPosition = Number(event.target.value);
    const controlNextPosition = invert
      ? sliderScale.maxPosition - nextPosition
      : nextPosition;
    onChange(sliderScale.valueAt(controlNextPosition), { source: 'slider' });
  }

  return (
    <label className={`control-field ${axis === 'y' ? 'axis-y' : 'axis-x'}`}>
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max={sliderScale.maxPosition}
        step="1"
        value={sliderValue}
        onChange={handleSliderChange}
      />
      <NumberField
        label={`${label} value`}
        value={controlValue}
        min={controlMin}
        max={controlMax}
        step={step}
        compact
        onChange={(nextValue) => onChange(nextValue, { source: 'number' })}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, compact = false, onChange }) {
  const normalizedMin = ceilToModelPrecision(min);
  const normalizedMax = Math.max(normalizedMin, floorToModelPrecision(max));
  const normalizedValue = roundToModelPrecision(clampValue(value, normalizedMin, normalizedMax));
  return (
    <label className={compact ? 'number-field compact' : 'number-field'}>
      <span>{label}</span>
      <input
        type="number"
        min={normalizedMin}
        max={normalizedMax}
        step={step}
        value={normalizedValue}
        onChange={(event) => onChange(roundToModelPrecision(Number(event.target.value) || 0))}
      />
    </label>
  );
}

const appRoot = import.meta.hot?.data.root ?? createRoot(document.getElementById('root'));
if (import.meta.hot) import.meta.hot.data.root = appRoot;
appRoot.render(<App />);
