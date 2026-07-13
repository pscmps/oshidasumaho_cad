import { readFile, writeFile } from 'node:fs/promises';

function replaceLine(text, pattern, replacement) {
  if (pattern.test(text)) {
    return text.replace(pattern, replacement);
  }
  return text;
}

function formatWeightFromVolume(text, density) {
  const match = text.match(/^; total filament volume \[cm\^3\] : ([0-9.]+)/m);
  if (!match) return null;

  const volumeMm3 = Number.parseFloat(match[1]);
  if (!Number.isFinite(volumeMm3)) return null;

  return ((volumeMm3 / 1000) * density).toFixed(2);
}

export async function postprocessGcodeForBambu(gcodePath, config) {
  const filamentName = config.bambuFilamentProfile || 'Bambu PLA Basic @BBL X1C';
  const density = 1.26;
  const nozzleTemperature = 220;
  const filamentFlowRatio = 0.98;
  const maxVolumetricSpeed = 21;
  const weight = formatWeightFromVolume(await readFile(gcodePath, 'utf8'), density);

  let text = await readFile(gcodePath, 'utf8');
  text = replaceLine(text, /^; filament_density: .+$/m, `; filament_density: ${density}`);
  text = replaceLine(text, /^; filament_settings_id = .*$/m, `; filament_settings_id = ${filamentName}`);
  text = replaceLine(text, /^; filament_ids = .*$/m, '; filament_ids = GFA00');
  text = replaceLine(text, /^; filament_vendor = .*$/m, '; filament_vendor = Bambu Lab');
  text = replaceLine(text, /^; filament_density = .*$/m, `; filament_density = ${density}`);
  text = replaceLine(text, /^; filament_flow_ratio = .*$/m, `; filament_flow_ratio = ${filamentFlowRatio}`);
  text = replaceLine(text, /^; filament_max_volumetric_speed = .*$/m, `; filament_max_volumetric_speed = ${maxVolumetricSpeed}`);
  text = replaceLine(text, /^; nozzle_temperature = .*$/m, `; nozzle_temperature = ${nozzleTemperature}`);
  text = replaceLine(text, /^; nozzle_temperature_initial_layer = .*$/m, `; nozzle_temperature_initial_layer = ${nozzleTemperature}`);
  text = replaceLine(text, /^M104 S200\b/gm, `M104 S${nozzleTemperature}`);
  text = replaceLine(text, /^M109 S200\b/gm, `M109 S${nozzleTemperature}`);

  if (weight) {
    text = replaceLine(text, /^; total filament weight \[g\] : .+$/m, `; total filament weight [g] : ${weight}`);
  }

  await writeFile(gcodePath, text, 'utf8');
  const finalText = text;
  return {
    filamentName,
    filamentId: 'GFA00',
    density,
    filamentFlowRatio,
    maxVolumetricSpeed,
    nozzleTemperature,
    estimatedWeightGram: weight,
    hasX1StartGcode: finalText.includes(';===== machine: X1-0.4'),
    hasBedLevelingGcode: finalText.includes('g29_before_print_flag') && finalText.includes('G29 A '),
    hasFlowCalibrationGcode: finalText.includes('extrude_cali_flag'),
    hasNozzleWipeGcode: finalText.includes(';===== wipe nozzle'),
    hasPurgeLineGcode: finalText.includes(';===== nozzle load line'),
  };
}
