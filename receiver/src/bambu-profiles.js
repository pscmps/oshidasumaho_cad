import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function withoutJson(value) {
  return value.toLowerCase().endsWith('.json') ? value.slice(0, -5) : value;
}

function profilePath(root, type, name) {
  return join(root, type, `${withoutJson(name)}.json`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function resolveMachineProfile(root, name, resolving = []) {
  const normalizedName = withoutJson(name);
  if (resolving.includes(normalizedName)) {
    throw new Error(`Circular Bambu machine profile inheritance: ${[...resolving, normalizedName].join(' -> ')}`);
  }

  const machine = await readJson(profilePath(root, 'machine', normalizedName));
  if (!machine.inherits) return machine;

  const parent = await resolveMachineProfile(root, machine.inherits, [...resolving, normalizedName]);
  return {
    ...parent,
    ...machine,
  };
}

async function writeResolvedMachineProfile(config, outputDir, selected) {
  const machine = await resolveMachineProfile(config.bambuProfileRoot, selected.machine);

  for (const includeName of machine.include || []) {
    const include = await readJson(profilePath(config.bambuProfileRoot, 'machine', includeName));
    if (include.machine_start_gcode) machine.machine_start_gcode = include.machine_start_gcode;
    if (include.machine_end_gcode) machine.machine_end_gcode = include.machine_end_gcode;
    if (include.layer_change_gcode) machine.layer_change_gcode = include.layer_change_gcode;
    if (include.change_filament_gcode) machine.change_filament_gcode = include.change_filament_gcode;
    if (include.time_lapse_gcode) machine.time_lapse_gcode = include.time_lapse_gcode;
  }

  const resolvedPath = join(outputDir, 'bambu-resolved-machine-profile.json');
  await writeFile(resolvedPath, `${JSON.stringify(machine, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

async function writeJobProcessProfile(config, outputDir, selected, sliceOptions) {
  const jobProfilePath = join(outputDir, 'bambu-job-process-profile.json');
  const process = await readJson(profilePath(config.bambuProfileRoot, 'process', selected.process));
  process.name = `${process.name} - Oshida receiver job`;
  process.from = 'user';
  process.layer_height = sliceOptions.layerHeight;
  process.enable_support = sliceOptions.enableSupport ? '1' : '0';
  await writeFile(jobProfilePath, `${JSON.stringify(process, null, 2)}\n`, 'utf8');
  return jobProfilePath;
}

export async function writeBambuLoadSettings(config, outputDir, sliceOptions) {
  if (!config.bambuProfileRoot) {
    throw new Error('BAMBU_PROFILE_ROOT is required to build Bambu load settings');
  }

  const selected = {
    machine: config.bambuMachineProfile,
    process: config.bambuProcessProfile,
    filament: config.bambuFilamentProfile,
  };
  const resolvedMachineProfile = await writeResolvedMachineProfile(config, outputDir, selected);
  const jobProcessProfile = await writeJobProcessProfile(config, outputDir, selected, sliceOptions);

  return {
    paths: [
      resolvedMachineProfile,
      jobProcessProfile,
    ],
    profiles: selected,
    sliceOptions,
  };
}
