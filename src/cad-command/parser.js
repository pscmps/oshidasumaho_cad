// Deliberately small grammar: unrecognised or ambiguous text goes to the adapter.
export function parseLocalCommand(text, { group = 'red', featureId, featureType } = {}) {
  const raw = text.normalize('NFKC').trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const value = JSON.parse(raw);
    return { commands: Array.isArray(value) ? value : [value] };
  }
  const color = raw.match(/^(赤|緑|青|red|green|blue)(?:い(?:ところ|部分|面)?|色)?(?:だけ|を|の)?\s*/i);
  if (color) group = ({ 赤: 'red', 緑: 'green', 青: 'blue' })[color[1]] || color[1].toLowerCase();
  const s = (color ? raw.slice(color[0].length) : raw).replace(/\s+/g, '').replace(/ミリ(?:メートル)?/g, 'mm');
  let m, command;
  if (/^(削除|消す|remove|delete)$/i.test(s)) command = { operation: 'removeSelected', selectionGroup: group };
  else if ((m = s.match(/^R(\d+(?:\.\d+)?)(?:にして|にする)?$/i))) command = !color && featureId && featureType === 'fillet'
    ? { operation: 'modifyFeature', featureId, changes: { radius: +m[1] } } : { operation: 'fillet', selectionGroup: group, radius: +m[1] };
  else if ((m = s.match(/^(?:面取り|C)(\d+(?:\.\d+)?)(?:mm)?$/i))) command = !color && featureId && featureType === 'chamfer'
    ? { operation: 'modifyFeature', featureId, changes: { distance: +m[1] } } : { operation: 'chamfer', selectionGroup: group, distance: +m[1] };
  else if ((m = s.match(/^R\d+(?:\.\d+)?をR(\d+(?:\.\d+)?)(?:にして|にする)?$/i)) && featureId) command = { operation: 'modifyFeature', featureId, changes: { radius: +m[1] } };
  else if ((m = s.match(/^(-?\d+(?:\.\d+)?)(?:mm)(?:にして|にする)?$/))) command = !color && featureId && ['extrude', 'faceExtrude', 'chamfer'].includes(featureType)
    ? { operation: 'modifyFeature', featureId, changes: { distance: +m[1] } } : { operation: 'changeDistance', selectionGroup: group, distance: +m[1], relative: false };
  else if ((m = s.match(/^(\d+(?:\.\d+)?)(?:mm)(伸ばす|伸ばして|削る|削って|へこませる|へこませて)$/))) command = { operation: 'extrudeSelectedFaces', selectionGroup: group, distance: +m[1] * (/伸ば/.test(m[2]) ? 1 : -1) };
  else if ((m = s.match(/^([XYZ])(-?\d+(?:\.\d+)?)(mm移動|度回転)$/i))) {
    const axis = 'xyz'.indexOf(m[1].toLowerCase());
    const translation = [0, 0, 0], rotation = [0, 0, 0];
    (m[3] === '度回転' ? rotation : translation)[axis] = +m[2];
    command = { operation: 'transform', selectionGroup: group, translation, rotation };
  }
  return command ? { commands: [command] } : null;
}
