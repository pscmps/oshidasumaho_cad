import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeBambuLoadSettings } from './bambu-profiles.js';
import { postprocessGcodeForBambu } from './gcode-postprocess.js';
import { printGcodeWithBambuLan } from './bambu-lan-printer.js';

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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

async function readResultJson(outputDir) {
  const resultPath = join(outputDir, 'result.json');
  const raw = await readFile(resultPath, 'utf8');
  return {
    path: resultPath,
    data: JSON.parse(raw),
  };
}

async function listGcodeFiles(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gcode'))
    .map((entry) => join(outputDir, entry.name));
}

export async function handleUploadedStl(upload, config, sliceOptions = { layerHeight: '0.20', enableSupport: false }) {
  const jobOutputDir = join(config.outputDir, upload.id);
  await mkdir(jobOutputDir, { recursive: true });
  await access(config.bambuStudioPath, constants.F_OK);
  const loadSettings = await writeBambuLoadSettings(config, jobOutputDir, sliceOptions);

  const args = [
    ...loadSettings.paths.flatMap((settingsPath) => ['--load-settings', settingsPath]),
    '--slice=0',
    '--outputdir',
    jobOutputDir,
    upload.path,
  ];
  console.log('[print-pipeline] slicing STL with Bambu Studio CLI', {
    id: upload.id,
    bambuStudioPath: config.bambuStudioPath,
    input: upload.path,
    outputDir: jobOutputDir,
    profiles: loadSettings.profiles,
    sliceOptions,
    args,
  });

  const processResult = await runProcess(config.bambuStudioPath, args, {
    cwd: dirname(config.bambuStudioPath),
    timeoutMs: config.sliceTimeoutMs,
  });

  let resultJson = null;
  let gcodeFiles = [];
  try {
    resultJson = await readResultJson(jobOutputDir);
    gcodeFiles = await listGcodeFiles(jobOutputDir);
  } catch (error) {
    console.error('[print-pipeline] failed to read slice outputs', {
      id: upload.id,
      outputDir: jobOutputDir,
      error: error.message,
    });
  }

  const cliSucceeded = processResult.code === 0 && !processResult.timedOut;
  const resultSucceeded = resultJson?.data?.return_code === 0;
  const succeeded = cliSucceeded && resultSucceeded && gcodeFiles.length > 0;
  const postprocess = [];

  if (succeeded) {
    for (const gcodeFile of gcodeFiles) {
      postprocess.push({
        path: gcodeFile,
        ...(await postprocessGcodeForBambu(gcodeFile, config)),
      });
    }
  }
  const gcodeSafety = postprocess[0] || {};
  const canAutoPrint =
    !config.autoPrint ||
    (gcodeSafety.hasX1StartGcode &&
      gcodeSafety.hasBedLevelingGcode &&
      gcodeSafety.hasFlowCalibrationGcode &&
      gcodeSafety.hasNozzleWipeGcode &&
      gcodeSafety.hasPurgeLineGcode);

  const summary = {
    status: succeeded ? 'sliced' : 'slice_failed',
    outputDir: jobOutputDir,
    exitCode: processResult.code,
    timedOut: processResult.timedOut,
    resultJson: resultJson
      ? {
          path: resultJson.path,
          returnCode: resultJson.data.return_code,
          errorString: resultJson.data.error_string,
        }
      : null,
    gcodeFiles,
    postprocess,
    stdout: processResult.stdout.trim(),
    stderr: processResult.stderr.trim(),
    sliceOptions,
  };

  if (succeeded) {
    console.log('[print-pipeline] slice succeeded', {
      id: upload.id,
      gcodeFiles,
      postprocess,
      resultJson: summary.resultJson,
    });
    if (config.autoPrint && !canAutoPrint) {
      summary.print = {
        status: 'print_skipped',
        reason: 'Generated G-code does not contain required Bambu X1C start, bed leveling, flow calibration, wipe, and purge markers',
        gcodeSafety,
      };
      console.error('[print-pipeline] print skipped by G-code safety check', {
        id: upload.id,
        print: summary.print,
      });
    } else if (config.autoPrint) {
      try {
        summary.print = await printGcodeWithBambuLan(gcodeFiles[0], upload, config);
        if (summary.print.status === 'print_started') {
          summary.status = 'print_started';
          console.log('[print-pipeline] print start confirmed', {
            id: upload.id,
            print: summary.print,
          });
        } else {
          summary.status = summary.print.status;
          console.log('[print-pipeline] print not started', {
            id: upload.id,
            print: summary.print,
          });
        }
      } catch (error) {
        summary.print = {
          status: 'print_failed',
          error: error.message,
        };
        console.error('[print-pipeline] print failed', {
          id: upload.id,
          print: summary.print,
        });
      }
    } else {
      summary.print = {
        status: 'print_disabled',
        reason: 'Set BAMBU_AUTO_PRINT=1 to upload G-code and start a print',
      };
    }
  } else {
    console.error('[print-pipeline] slice failed', {
      id: upload.id,
      summary,
    });
  }

  return summary;
}
