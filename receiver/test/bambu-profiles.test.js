import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveMachineProfile } from '../src/bambu-profiles.js';

async function writeProfile(root, name, value) {
  const machineDir = join(root, 'machine');
  await mkdir(machineDir, { recursive: true });
  await writeFile(join(machineDir, `${name}.json`), JSON.stringify(value), 'utf8');
}

test('machine profile inheritance preserves the X1C printable area', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bambu-profiles-'));
  await writeProfile(root, 'fdm_machine_common', {
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '256',
    inherited_only: 'base',
  });
  await writeProfile(root, 'fdm_bbl_3dp_001_common', {
    inherits: 'fdm_machine_common',
    bed_exclude_area: ['0x0', '28x0', '28x28', '0x28'],
    inherited_only: 'bambu',
  });
  await writeProfile(root, 'Bambu Lab X1 Carbon 0.4 nozzle', {
    inherits: 'fdm_bbl_3dp_001_common',
    bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
    name: 'Bambu Lab X1 Carbon 0.4 nozzle',
  });

  const resolved = await resolveMachineProfile(root, 'Bambu Lab X1 Carbon 0.4 nozzle');

  assert.deepEqual(resolved.printable_area, ['0x0', '256x0', '256x256', '0x256']);
  assert.equal(resolved.printable_height, '256');
  assert.equal(resolved.inherited_only, 'bambu');
  assert.deepEqual(resolved.bed_exclude_area, ['0x0', '18x0', '18x28', '0x28']);
});

test('circular machine profile inheritance is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bambu-profiles-'));
  await writeProfile(root, 'a', { inherits: 'b' });
  await writeProfile(root, 'b', { inherits: 'a' });

  await assert.rejects(
    resolveMachineProfile(root, 'a'),
    /Circular Bambu machine profile inheritance: a -> b -> a/,
  );
});
