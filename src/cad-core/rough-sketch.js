export const SKETCH_VIEWS = ['top', 'front', 'right'];
export const VIEW_LABELS = { top: '上から', front: '正面', right: '右から' };
export const VIEW_AXES = { top: ['width', 'depth'], front: ['width', 'height'], right: ['depth', 'height'] };
export const emptyDraft = () => ({ schemaVersion: 1, views: Object.fromEntries(SKETCH_VIEWS.map(v => [v, { strokes: [], comments: [] }])), dimensions: { width: 80, depth: 50, height: 20 }, notes: '' });
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => { if (!record(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('スケッチの項目が不正です'); };
const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
const point = p => Array.isArray(p) && p.length === 2 && p.every(unit);
const positive = n => Number.isFinite(n) && n > 0 && n <= 10000;
export function validateDimensions(d) {
  keys(d, ['width', 'depth', 'height']);
  if (!['width', 'depth', 'height'].every(k => positive(d[k]))) throw new Error('幅・奥行き・高さには0より大きいmm値を指定してください');
}
export function validateDraft(draft) {
  keys(draft, ['schemaVersion', 'views', 'dimensions', 'notes']);
  if (draft.schemaVersion !== 1 || typeof draft.notes !== 'string' || draft.notes.length > 4000) throw new Error('スケッチの形式が不正です');
  validateDimensions(draft.dimensions); keys(draft.views, SKETCH_VIEWS);
  const ids = new Set();
  const id = v => { if (typeof v !== 'string' || !/^[\w-]{1,100}$/.test(v) || ids.has(v)) throw new Error('スケッチのIDが不正です'); ids.add(v); };
  for (const view of SKETCH_VIEWS) {
    const data = draft.views[view]; keys(data, ['strokes', 'comments']);
    if (!Array.isArray(data.strokes) || data.strokes.length > 100 || !Array.isArray(data.comments) || data.comments.length > 100) throw new Error('スケッチが大きすぎます');
    for (const s of data.strokes) {
      keys(s, ['id', 'tool', 'role', 'points']); id(s.id);
      if (!['pen', 'rect', 'ellipse'].includes(s.tool) || !['outline', 'cut', 'guide'].includes(s.role)
        || !Array.isArray(s.points) || s.points.length < 2 || s.points.length > 600 || !s.points.every(point)
        || s.tool !== 'pen' && s.points.length !== 2) throw new Error('描いた線の形式が不正です');
    }
    for (const c of data.comments) {
      keys(c, ['id', 'position', 'text']); id(c.id);
      if (!point(c.position) || typeof c.text !== 'string' || c.text.length > 2000) throw new Error('コメントの形式が不正です');
    }
  }
  return draft;
}
export function validateContour(c) {
  if (c?.type === 'polygon') {
    keys(c, ['type', 'points']);
    if (!Array.isArray(c.points) || c.points.length < 3 || c.points.length > 128 || !c.points.every(point)) throw new Error('輪郭には3〜128点が必要です');
    let area = 0;
    c.points.forEach((p, i) => { const n = c.points[(i + 1) % c.points.length]; if (Math.hypot(p[0]-n[0],p[1]-n[1]) < 1e-6) throw new Error('輪郭の点が重複しています'); area += p[0]*n[1]-n[0]*p[1]; });
    if (Math.abs(area) < 1e-5) throw new Error('輪郭に面積がありません');
    const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for (let i=0;i<c.points.length;i++) for(let j=i+2;j<c.points.length;j++) {
      if (i===0 && j===c.points.length-1) continue;
      const [a,b,p,q]=[c.points[i],c.points[(i+1)%c.points.length],c.points[j],c.points[(j+1)%c.points.length]];
      if(cross(a,b,p)*cross(a,b,q)<-1e-12 && cross(p,q,a)*cross(p,q,b)<-1e-12) throw new Error('輪郭が交差しています。交差をほどいて描き直してください');
    }
  } else if (c?.type === 'ellipse') {
    keys(c, ['type', 'center', 'radii']);
    if (!point(c.center) || !Array.isArray(c.radii) || c.radii.length !== 2 || !c.radii.every(n => unit(n) && n > 0)) throw new Error('円・楕円の寸法が不正です');
  } else throw new Error('未対応の輪郭です');
}
export function validateProfiles(profiles) {
  keys(profiles, SKETCH_VIEWS);
  if (!Object.keys(profiles).length) throw new Error('少なくとも1面の輪郭が必要です');
  for (const p of Object.values(profiles)) {
    keys(p, ['outer', 'holes']); validateContour(p.outer);
    if (!Array.isArray(p.holes) || p.holes.length > 20) throw new Error('穴の形式が不正です');
    p.holes.forEach(validateContour);
  }
}

export function dimensionHints(text) {
  const result = {}, s = text.normalize('NFKC').replace(/ミリ(?:メートル)?/g, 'mm');
  for (const [key, label] of [['width', '幅|横幅'], ['depth', '奥行き|奥行'], ['height', '高さ|厚さ']]) {
    const m=s.match(new RegExp(`(?:${label})\\s*(?:は|を|:|=)?\\s*(\\d+(?:\\.\\d+)?)\\s*mm`));
    if(m && positive(+m[1])) result[key]=+m[1];
  }
  return result;
}
export function strokePoints(s) {
  if (s.tool==='pen') return s.points;
  const [a,b]=s.points, x=Math.min(a[0],b[0]), y=Math.min(a[1],b[1]), w=Math.abs(a[0]-b[0]), h=Math.abs(a[1]-b[1]);
  return s.tool==='rect' ? [[x,y],[x+w,y],[x+w,y+h],[x,y+h]]
    : Array.from({length:48},(_,i)=>[x+w/2+Math.cos(i*Math.PI/24)*w/2,y+h/2+Math.sin(i*Math.PI/24)*h/2]);
}
function simplify(points, epsilon=0.008) {
  if(points.length<=2)return points;
  const a=points[0],b=points.at(-1),dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
  let max=0,index=0;
  points.slice(1,-1).forEach((p,i)=>{const t=len?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/len)):0;const d=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);if(d>max){max=d;index=i+1;}});
  if(max<=epsilon)return[a,b];
  return [...simplify(points.slice(0,index+1),epsilon).slice(0,-1),...simplify(points.slice(index),epsilon)];
}
export function draftCommand(draft, origin=[0,0,0]) {
  validateDraft(draft); const profiles={};
  for(const view of SKETCH_VIEWS) {
    const strokes=draft.views[view].strokes, outer=strokes.filter(s=>s.role==='outline');
    if(!outer.length)continue;
    if(outer.length!==1)throw new Error(`${VIEW_LABELS[view]}の外形は1本の閉じた輪郭にしてください。複数の外形はCodexに相談できます。`);
    const points=strokePoints(outer[0]), min=[0,1].map(i=>Math.min(...points.map(p=>p[i]))), span=[0,1].map(i=>Math.max(...points.map(p=>p[i]))-min[i]);
    if(span.some(n=>n<0.01))throw new Error('輪郭の幅・高さが小さすぎます');
    const contour=s=>{
      if(s.tool==='ellipse') {const [a,b]=s.points;return {type:'ellipse',center:[0,1].map(i=>((a[i]+b[i])/2-min[i])/span[i]),radii:[0,1].map(i=>Math.abs(a[i]-b[i])/2/span[i])};}
      let p=strokePoints(s); if(s.tool==='pen')p=simplify(p);
      p=p.filter((a,i)=>!i || Math.hypot(a[0]-p[i-1][0],a[1]-p[i-1][1])>0.002);
      if(p.length>3 && Math.hypot(p[0][0]-p.at(-1)[0],p[0][1]-p.at(-1)[1])<0.025)p.pop();
      return {type:'polygon',points:p.map(p=>p.map((n,i)=>Math.max(0,Math.min(1,(n-min[i])/span[i]))))};
    };
    profiles[view]={outer:contour(outer[0]),holes:strokes.filter(s=>s.role==='cut').map(contour)};
  }
  validateProfiles(profiles);
  return {operation:'addSketchSolid',profiles,dimensions:{...draft.dimensions},origin};
}

const normalizedPointSchema = {type:'array',items:{type:'number',minimum:0,maximum:1},minItems:2,maxItems:2};
export const DIMENSIONS_SCHEMA = {type:'object',properties:Object.fromEntries(['width','depth','height'].map(k=>[k,{type:'number',exclusiveMinimum:0,maximum:10000}])),required:['width','depth','height'],additionalProperties:false};
const contourSchema = {oneOf:[
  {type:'object',properties:{type:{const:'polygon'},points:{type:'array',items:normalizedPointSchema,minItems:3,maxItems:128}},required:['type','points'],additionalProperties:false},
  {type:'object',properties:{type:{const:'ellipse'},center:normalizedPointSchema,radii:{...normalizedPointSchema,items:{type:'number',exclusiveMinimum:0,maximum:1}}},required:['type','center','radii'],additionalProperties:false}
]};
export const PROFILES_SCHEMA = {type:'object',minProperties:1,additionalProperties:false,properties:Object.fromEntries(SKETCH_VIEWS.map(v=>[v,{type:'object',properties:{outer:contourSchema,holes:{type:'array',items:contourSchema,maxItems:20}},required:['outer','holes'],additionalProperties:false}]))};
