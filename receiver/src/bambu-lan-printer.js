import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPrinterStatus,
  isPrinterBusy,
  publishPrintCommand,
  selectAmsTray,
  summarizePrinterStatus,
  waitForPrintOutcome,
} from './bambu-mqtt.js';

function assertPrintConfig(config) {
  const missing = [];
  if (!config.bambuPrinterHost) missing.push('BAMBU_PRINTER_HOST');
  if (!config.bambuPrinterSerial) missing.push('BAMBU_PRINTER_SERIAL');
  if (!config.bambuAccessCode) missing.push('BAMBU_ACCESS_CODE');
  if (missing.length > 0) {
    throw new Error(`Missing print configuration: ${missing.join(', ')}`);
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function uploadFtps({ config, localPath, remotePath }) {
  const result = await runProcess(
    config.bambuPythonPath,
    [
      join(SCRIPT_DIR, 'ftps-upload.py'),
      config.bambuPrinterHost,
      String(config.bambuFtpPort),
      config.bambuFtpUser,
      localPath,
      remotePath,
    ],
    {
      cwd: SCRIPT_DIR,
      timeoutMs: config.printTimeoutMs,
      env: {
        ...process.env,
        BAMBU_ACCESS_CODE: config.bambuAccessCode,
      },
    },
  );

  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `FTPS upload failed: exit=${result.code} timedOut=${result.timedOut} stderr=${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export function buildPrintPayload(config, remotePath, amsTray = null) {
  if (config.bambuPrintCommand === 'project_file') {
    return {
      print: {
        command: 'project_file',
        sequence_id: Date.now().toString(),
        param: 'Metadata/plate_1.gcode',
        project_id: '0',
        profile_id: '0',
        task_id: '0',
        subtask_id: '0',
        subtask_name: basename(remotePath),
        url: `file://${remotePath}`,
        timelapse: false,
        bed_type: 'auto',
        bed_leveling: config.bambuBedLeveling,
        flow_cali: config.bambuFlowCali,
        vibration_cali: config.bambuVibrationCali,
        layer_inspect: config.bambuLayerInspect,
        use_ams: Boolean(amsTray),
        ...(amsTray
          ? {
              ams_mapping: [amsTray.globalTrayId],
              ams_mapping2: [{ ams_id: amsTray.amsId, slot_id: amsTray.slotId }],
            }
          : {}),
      },
    };
  }

  return {
    print: {
      command: config.bambuPrintCommand,
      sequence_id: Date.now().toString(),
      param: remotePath,
    },
  };
}

async function packageGcode3mf(config, gcodePath, outputDir, remoteName) {
  if (config.bambuPrintCommand !== 'project_file') {
    return {
      path: gcodePath,
      remoteName,
    };
  }
  if (!config.bambuGcode3mfTemplate) {
    throw new Error('BAMBU_GCODE_3MF_TEMPLATE is required when BAMBU_PRINT_COMMAND=project_file');
  }

  const outputPath = join(outputDir, `${remoteName}.3mf`);
  const result = await runProcess(
    config.bambuPythonPath,
    [join(SCRIPT_DIR, 'package-gcode-3mf.py'), config.bambuGcode3mfTemplate, gcodePath, outputPath],
    {
      cwd: SCRIPT_DIR,
      timeoutMs: config.printTimeoutMs,
      env: process.env,
    },
  );

  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `G-code 3MF package failed: exit=${result.code} timedOut=${result.timedOut} stderr=${result.stderr.trim()}`,
    );
  }

  return {
    path: outputPath,
    remoteName: `${remoteName}.3mf`,
  };
}

function safeRemoteFilename(localPath, upload) {
  const idPrefix = upload.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const fileName = basename(localPath).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${idPrefix}-${fileName}`;
}

async function recoverFromFilamentRunout(config, initialStatus, usedTray) {
  const excluded = new Set(usedTray ? [usedTray.globalTrayId] : []);
  const replacement = selectAmsTray(initialStatus, config, excluded);
  if (!replacement) return null;

  await publishPrintCommand(config, {
    print: {
      command: 'ams_change_filament',
      sequence_id: Date.now().toString(),
      curr_temp: 220,
      tar_temp: 220,
      ams_id: replacement.amsId,
      target: replacement.globalTrayId,
      slot_id: replacement.slotId,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await publishPrintCommand(config, {
    print: { command: 'ams_control', sequence_id: Date.now().toString(), param: 'resume' },
  });
  await new Promise((resolve) => setTimeout(resolve, config.bambuStatusPollMs));
  await publishPrintCommand(config, {
    print: { command: 'resume', sequence_id: Date.now().toString() },
  });
  return replacement;
}

export function isAllowedTestPrint(upload) {
  const name = `${upload.originalName || ''} ${upload.savedName || ''} ${upload.filename || ''}`.toLowerCase();
  return name.includes('test') || name.includes('cube') || name.includes('20mm');
}

export async function printGcodeWithBambuLan(gcodePath, upload, config) {
  assertPrintConfig(config);
  await access(gcodePath, constants.F_OK);

  if (config.printTestOnly && !isAllowedTestPrint(upload)) {
    return {
      status: 'print_skipped',
      reason: 'BAMBU_PRINT_TEST_ONLY is enabled and the upload name does not look like a test cube',
    };
  }

  const preflight = await getPrinterStatus(config);
  const preflightSummary = summarizePrinterStatus(preflight);
  if (isPrinterBusy(preflight)) {
    return {
      status: 'print_skipped',
      reason: 'Printer is busy',
      printerStatus: preflightSummary,
    };
  }

  let amsTray = null;
  if (config.bambuUseAms && config.bambuAmsAutoSelect) {
    amsTray = selectAmsTray(preflight, config);
    if (!amsTray) {
      return {
        status: 'print_skipped',
        reason: `No ${config.bambuAmsFilamentType} filament was found in AMS`,
        printerStatus: preflightSummary,
      };
    }
  }

  const remoteName = safeRemoteFilename(gcodePath, upload);
  const packaged = await packageGcode3mf(config, gcodePath, dirname(gcodePath), remoteName);
  const ftpRemotePath = config.bambuFtpStorageRoot
    ? posix.join(config.bambuFtpStorageRoot, packaged.remoteName)
    : packaged.remoteName;
  const printRemotePath = posix.join(config.bambuStorageRoot, packaged.remoteName);
  console.log('[bambu-lan-printer] target printer', {
    printerName: config.bambuPrinterName || '(not set)',
    printerHost: config.bambuPrinterHost,
    printerSerial: config.bambuPrinterSerial,
    ftpPort: config.bambuFtpPort,
    mqttPort: config.bambuMqttPort,
    ftpRemotePath,
    printRemotePath,
    printCommand: config.bambuPrintCommand,
    testOnly: config.printTestOnly,
    amsTray,
  });

  try {
    await uploadFtps({
      config,
      localPath: packaged.path,
      remotePath: ftpRemotePath,
    });
  } catch (error) {
    return {
      status: 'print_failed',
      stage: 'upload_gcode',
      error: error.message,
    };
  }

  const commandPreflight = await getPrinterStatus(config);
  if (isPrinterBusy(commandPreflight)) {
    return {
      status: 'print_skipped',
      reason: 'Printer became busy before the print command was sent',
      printerStatus: summarizePrinterStatus(commandPreflight),
      remotePath: printRemotePath,
    };
  }

  const payload = buildPrintPayload(config, printRemotePath, amsTray);
  await publishPrintCommand(config, payload);

  console.log('[bambu-lan-printer] print start command sent', {
    printerName: config.bambuPrinterName || '(not set)',
    printerHost: config.bambuPrinterHost,
    printerSerial: config.bambuPrinterSerial,
    remotePath: printRemotePath,
    amsTray,
    command: config.bambuPrintCommand,
  });

  const expectedSubtaskName = basename(printRemotePath);
  let outcome = await waitForPrintOutcome(config, expectedSubtaskName);
  let outcomeSummary = summarizePrinterStatus(outcome);
  let recoveredWithTray = null;
  if (
    outcomeSummary.gcodeState === 'PAUSE' &&
    String(outcomeSummary.printError || outcomeSummary.failReason) === '50364420'
  ) {
    recoveredWithTray = await recoverFromFilamentRunout(config, outcome, amsTray);
    if (recoveredWithTray) {
      outcome = await waitForPrintOutcome(config, expectedSubtaskName);
      outcomeSummary = summarizePrinterStatus(outcome);
    }
  }

  if (outcomeSummary.gcodeState !== 'RUNNING') {
    return {
      status: outcomeSummary.gcodeState === 'PAUSE' ? 'print_paused' : 'print_unconfirmed',
      printerName: config.bambuPrinterName || '',
      remotePath: printRemotePath,
      amsTray,
      recoveredWithTray,
      printerStatus: outcomeSummary,
    };
  }

  return {
    status: 'print_started',
    printerName: config.bambuPrinterName || '',
    printerHost: config.bambuPrinterHost,
    printerSerial: config.bambuPrinterSerial,
    remotePath: printRemotePath,
    command: config.bambuPrintCommand,
    amsTray,
    recoveredWithTray,
    printerStatus: outcomeSummary,
  };
}
