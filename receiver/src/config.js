import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_BAMBU_STUDIO_PATH = 'D:\\bambu\\Bambu Studio\\bambu-studio.exe';
const DEFAULT_SLICE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRINT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BAMBU_PROFILE_ROOT = 'BambuStudio\\system\\BBL';

function parseIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseOptionalIntegerEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadConfig() {
  const appData = process.env.APPDATA || '';
  const profileRoot = process.env.BAMBU_PROFILE_ROOT || (appData ? resolve(appData, DEFAULT_BAMBU_PROFILE_ROOT) : '');

  return {
    host: process.env.RECEIVER_HOST || '127.0.0.1',
    port: parseIntegerEnv('RECEIVER_PORT', 8787),
    token: process.env.RECEIVER_TOKEN || '',
    uploadDir: resolve(process.env.RECEIVER_UPLOAD_DIR || fileURLToPath(new URL('../uploads', import.meta.url))),
    outputDir: resolve(process.env.RECEIVER_OUTPUT_DIR || fileURLToPath(new URL('../outputs', import.meta.url))),
    webRoot: resolve(process.env.RECEIVER_WEB_ROOT || fileURLToPath(new URL('../../dist', import.meta.url))),
    maxUploadBytes: parseIntegerEnv('RECEIVER_MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES),
    bambuStudioPath: process.env.BAMBU_STUDIO_PATH || DEFAULT_BAMBU_STUDIO_PATH,
    sliceTimeoutMs: parseIntegerEnv('BAMBU_SLICE_TIMEOUT_MS', DEFAULT_SLICE_TIMEOUT_MS),
    bambuProfileRoot: profileRoot,
    bambuMachineProfile: process.env.BAMBU_MACHINE_PROFILE || 'Bambu Lab X1 Carbon 0.4 nozzle',
    bambuProcessProfile: process.env.BAMBU_PROCESS_PROFILE || '0.20mm Standard @BBL X1C',
    bambuFilamentProfile: process.env.BAMBU_FILAMENT_PROFILE || 'Bambu PLA Basic @BBL X1C',
    autoPrint: parseBooleanEnv('BAMBU_AUTO_PRINT', false),
    printTestOnly: parseBooleanEnv('BAMBU_PRINT_TEST_ONLY', true),
    printTimeoutMs: parseIntegerEnv('BAMBU_PRINT_TIMEOUT_MS', DEFAULT_PRINT_TIMEOUT_MS),
    bambuPrinterHost: process.env.BAMBU_PRINTER_HOST || '',
    bambuPrinterSerial: process.env.BAMBU_PRINTER_SERIAL || '',
    bambuPrinterName: process.env.BAMBU_PRINTER_NAME || '',
    bambuAccessCode: process.env.BAMBU_ACCESS_CODE || '',
    bambuFtpUser: process.env.BAMBU_FTP_USER || 'bblp',
    bambuFtpPort: parseIntegerEnv('BAMBU_FTP_PORT', 990),
    bambuMqttPort: parseIntegerEnv('BAMBU_MQTT_PORT', 8883),
    bambuStorageRoot: process.env.BAMBU_STORAGE_ROOT || '/sdcard',
    bambuFtpStorageRoot: process.env.BAMBU_FTP_STORAGE_ROOT || '',
    bambuPythonPath: process.env.BAMBU_PYTHON_PATH || 'python',
    bambuPrintCommand: process.env.BAMBU_PRINT_COMMAND || 'project_file',
    bambuGcode3mfTemplate: process.env.BAMBU_GCODE_3MF_TEMPLATE || '',
    bambuBedLeveling: parseBooleanEnv('BAMBU_BED_LEVELING', true),
    bambuFlowCali: parseBooleanEnv('BAMBU_FLOW_CALI', false),
    bambuVibrationCali: parseBooleanEnv('BAMBU_VIBRATION_CALI', false),
    bambuLayerInspect: parseBooleanEnv('BAMBU_LAYER_INSPECT', false),
    bambuUseAms: parseBooleanEnv('BAMBU_USE_AMS', true),
    bambuAmsAutoSelect: parseBooleanEnv('BAMBU_AMS_AUTO_SELECT', true),
    bambuAmsFilamentType: process.env.BAMBU_AMS_FILAMENT_TYPE || 'PLA',
    bambuAmsSlot: parseOptionalIntegerEnv('BAMBU_AMS_SLOT'),
    bambuPrintConfirmTimeoutMs: parseIntegerEnv('BAMBU_PRINT_CONFIRM_TIMEOUT_MS', 45_000),
    bambuStatusPollMs: parseIntegerEnv('BAMBU_STATUS_POLL_MS', 3_000),
  };
}
