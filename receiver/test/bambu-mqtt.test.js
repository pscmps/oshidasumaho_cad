import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintPayload } from '../src/bambu-lan-printer.js';
import { isPrinterBusy, listAmsTrays, selectAmsTray } from '../src/bambu-mqtt.js';

const config = {
  bambuPrintCommand: 'project_file',
  bambuBedLeveling: true,
  bambuFlowCali: true,
  bambuVibrationCali: false,
  bambuLayerInspect: false,
  bambuAmsFilamentType: 'PLA',
  bambuAmsSlot: null,
};

const printerReport = {
  gcode_state: 'FINISH',
  ams: {
    ams: [{
      id: '0',
      tray: [
        { id: '0', tray_type: 'PLA', tray_sub_brands: 'PLA Matte', tray_color: 'A3D8E1FF', remain: 50 },
        { id: '1', tray_type: 'PLA', tray_sub_brands: 'PLA Basic', tray_color: 'F4EE2AFF', remain: 0 },
        { id: '2', tray_type: 'PETG', tray_sub_brands: 'PETG Basic', tray_color: 'FFFFFFFF', remain: 80 },
      ],
    }],
  },
};

test('busy states reject new prints while terminal states allow them', () => {
  assert.equal(isPrinterBusy({ gcode_state: 'RUNNING' }), true);
  assert.equal(isPrinterBusy({ gcode_state: 'PAUSE' }), true);
  assert.equal(isPrinterBusy({ gcode_state: 'FINISH' }), false);
  assert.equal(isPrinterBusy({ gcode_state: 'FAILED' }), false);
  assert.equal(isPrinterBusy({}), true);
});

test('AMS selection prefers PLA Basic and does not treat remain=0 as definitely empty', () => {
  const trays = listAmsTrays(printerReport, 'PLA');
  assert.deepEqual(trays.map((tray) => tray.globalTrayId), [1, 0]);
  assert.equal(selectAmsTray(printerReport, config).globalTrayId, 1);
});

test('explicit AMS slot overrides automatic preference', () => {
  assert.equal(selectAmsTray(printerReport, { ...config, bambuAmsSlot: 0 }).globalTrayId, 0);
});

test('project_file payload includes AMS mapping and calibration flags', () => {
  const tray = selectAmsTray(printerReport, config);
  const payload = buildPrintPayload(config, '/sdcard/cube.gcode.3mf', tray);
  assert.equal(payload.print.use_ams, true);
  assert.deepEqual(payload.print.ams_mapping, [1]);
  assert.deepEqual(payload.print.ams_mapping2, [{ ams_id: 0, slot_id: 1 }]);
  assert.equal(payload.print.bed_leveling, true);
  assert.equal(payload.print.flow_cali, true);
});
