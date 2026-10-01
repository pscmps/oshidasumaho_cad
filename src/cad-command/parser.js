// Deliberately small grammar: unrecognised or ambiguous text goes to the adapter.
export function parseLocalCommand(text, { group = 'red', featureId, featureType } = {}) {
  const raw = text.normalize('NFKC').trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const value = JSON.parse(raw);
    return { commands: Array.isArray(value) ? value : [value] };
  }
  const color = raw.match(/^(赤|緑|青|red|green|blue)(?:(?:い|色の|の)?(?:ところ|部分|面|ふち|部品)|い|色)?(?:だけ|を|の)?\s*/i);
  if (color) group = ({ 赤: 'red', 緑: 'green', 青: 'blue' })[color[1]] || color[1].toLowerCase();
  const s = (color ? raw.slice(color[0].length) : raw).replace(/\s+/g, '').replace(/ミリ(?:メートル)?/g, 'mm')
    .replace(/^(?:選んだ|この)(?:面|ふち|部品|部分)(?:を|の)?/, '').replace(/ください[。！!]?$/, '').replace(/[。！!]$/, '');
  let m, command;
  if (/^(削除|消す|remove|delete)$/i.test(s)) command = { operation: 'removeSelected', selectionGroup: group };
  else if ((m = s.match(/^(?:(?:角|ふち)を)?(?:半径|R)(\d+(?:\.\d+)?)(?:mm)?(?:で|に)?(?:丸める|丸めて|丸くする|丸くして)$/i))) command = { operation: 'fillet', selectionGroup: group, radius: +m[1] };
  else if ((m = s.match(/^(\d+(?:\.\d+)?)mm(?:で|の)?面取り(?:する|して)?$/))) command = { operation: 'chamfer', selectionGroup: group, distance: +m[1] };
  else if ((m = s.match(/^R(\d+(?:\.\d+)?)(?:にして|にする)?$/i))) command = !color && featureId && featureType === 'fillet'
    ? { operation: 'modifyFeature', featureId, changes: { radius: +m[1] } } : { operation: 'fillet', selectionGroup: group, radius: +m[1] };
  else if ((m = s.match(/^(?:面取り|C)(\d+(?:\.\d+)?)(?:mm)?$/i))) command = !color && featureId && featureType === 'chamfer'
    ? { operation: 'modifyFeature', featureId, changes: { distance: +m[1] } } : { operation: 'chamfer', selectionGroup: group, distance: +m[1] };
  else if ((m = s.match(/^R\d+(?:\.\d+)?をR(\d+(?:\.\d+)?)(?:にして|にする)?$/i)) && featureId) command = { operation: 'modifyFeature', featureId, changes: { radius: +m[1] } };
  else if ((m = s.match(/^(-?\d+(?:\.\d+)?)(?:mm)(?:にして|にする)?$/))) command = !color && featureId && ['extrude', 'faceExtrude', 'chamfer'].includes(featureType)
    ? { operation: 'modifyFeature', featureId, changes: { distance: +m[1] } } : { operation: 'changeDistance', selectionGroup: group, distance: +m[1], relative: false };
  else if ((m = s.match(/^(?:厚さ|距離)(?:を)?(-?\d+(?:\.\d+)?)mm(?:にして|にする)?$/))) command = !color && featureId && ['extrude', 'faceExtrude'].includes(featureType)
    ? { operation: 'modifyFeature', featureId, changes: { distance: +m[1] } } : { operation: 'changeDistance', selectionGroup: group, distance: +m[1], relative: false };
  else if ((m = s.match(/^(\d+(?:\.\d+)?)mm(薄く|厚く)(?:して|する)$/))) command = { operation: 'changeDistance', selectionGroup: group, distance: +m[1] * (m[2] === '薄く' ? -1 : 1), relative: true };
  else if ((m = s.match(/^(\d+(?:\.\d+)?)(?:mm)(伸ばす|伸ばして|削る|削って|へこませる|へこませて)$/))) command = { operation: 'extrudeSelectedFaces', selectionGroup: group, distance: +m[1] * (/伸ば/.test(m[2]) ? 1 : -1) };
  else if ((m = s.match(/^([XYZ])(?:方向に|軸方向に)?(-?\d+(?:\.\d+)?)mm(?:移動|移動して|動かす|動かして)$/i))) {
    const axis = 'xyz'.indexOf(m[1].toLowerCase());
    const translation = [0, 0, 0], rotation = [0, 0, 0];
    translation[axis] = +m[2];
    command = { operation: 'transform', selectionGroup: group, translation, rotation };
  }
  else if ((m = s.match(/^([XYZ])(?:軸(?:まわり|周り)に|軸で)?(-?\d+(?:\.\d+)?)度(?:回転|回転して|回す|回して)$/i))) {
    const translation = [0, 0, 0], rotation = [0, 0, 0];
    rotation['xyz'.indexOf(m[1].toLowerCase())] = +m[2];
    command = { operation: 'transform', selectionGroup: group, translation, rotation };
  }
  return command ? { commands: [command] } : null;
}
