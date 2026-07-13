import { randomUUID } from 'node:crypto';
import tls from 'node:tls';

function mqttString(value) {
  const body = Buffer.from(String(value));
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

function remainingLength(length) {
  const bytes = [];
  let value = length;
  do {
    let encoded = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) encoded |= 128;
    bytes.push(encoded);
  } while (value > 0);
  return Buffer.from(bytes);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), remainingLength(body.length), body]);
}

function connectPacket({ clientId, username, password }) {
  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(30, 0);
  return packet(1, 0, Buffer.concat([
    mqttString('MQTT'),
    Buffer.from([4, 0b1100_0010]),
    keepAlive,
    mqttString(clientId),
    mqttString(username),
    mqttString(password),
  ]));
}

function publishPacket(topic, payload) {
  return packet(3, 0, Buffer.concat([mqttString(topic), Buffer.from(JSON.stringify(payload))]));
}

function subscribePacket(topic) {
  return packet(8, 2, Buffer.concat([Buffer.from([0, 1]), mqttString(topic), Buffer.from([0])]));
}

function tlsOptions(host, port) {
  const options = { host, port, rejectUnauthorized: false };
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) options.servername = host;
  return options;
}

function decodeRemainingLength(buffer, offset = 1) {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  let encoded;
  do {
    if (index >= buffer.length) return null;
    encoded = buffer[index++];
    value += (encoded & 127) * multiplier;
    multiplier *= 128;
  } while ((encoded & 128) !== 0);
  return { value, bytes: index - offset };
}

function extractPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = decodeRemainingLength(buffer, offset + 1);
    if (!remaining) break;
    const headerLength = 1 + remaining.bytes;
    const totalLength = headerLength + remaining.value;
    if (buffer.length - offset < totalLength) break;
    packets.push(buffer.subarray(offset, offset + totalLength));
    offset += totalLength;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function decodePublish(buffer) {
  const remaining = decodeRemainingLength(buffer);
  const bodyStart = 1 + remaining.bytes;
  const topicLength = buffer.readUInt16BE(bodyStart);
  const payloadStart = bodyStart + 2 + topicLength;
  return JSON.parse(buffer.subarray(payloadStart).toString('utf8'));
}

async function connect(config) {
  const socket = tls.connect(tlsOptions(config.bambuPrinterHost, config.bambuMqttPort));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MQTT TLS connect timeout')), config.printTimeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', reject);
  });

  socket.write(connectPacket({
    clientId: `oshida-receiver-${randomUUID()}`,
    username: config.bambuFtpUser,
    password: config.bambuAccessCode,
  }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MQTT CONNACK timeout')), 10000);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      if (chunk.length < 4 || chunk[0] !== 0x20 || chunk[3] !== 0) {
        reject(new Error(`MQTT connect rejected: ${chunk.toString('hex')}`));
        return;
      }
      resolve();
    });
    socket.once('error', reject);
  });
  return socket;
}

function waitForReport(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('MQTT printer report timeout')), timeoutMs);
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = extractPackets(buffered);
      buffered = decoded.rest;
      for (const current of decoded.packets) {
        if ((current[0] >> 4) !== 3) continue;
        try {
          const report = decodePublish(current);
          if (report.print) finish(null, report.print);
        } catch (error) {
          finish(error);
        }
      }
    };
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

export async function publishPrintCommand(config, payload) {
  const socket = await connect(config);
  socket.write(publishPacket(`device/${config.bambuPrinterSerial}/request`, payload));
  socket.write(Buffer.from([0xe0, 0x00]));
  socket.end();
}

export async function getPrinterStatus(config) {
  const socket = await connect(config);
  const report = waitForReport(socket, Math.min(config.printTimeoutMs, 15000));
  socket.write(subscribePacket(`device/${config.bambuPrinterSerial}/report`));
  socket.write(publishPacket(`device/${config.bambuPrinterSerial}/request`, {
    pushing: { command: 'pushall', sequence_id: Date.now().toString() },
  }));
  try {
    return await report;
  } finally {
    socket.write(Buffer.from([0xe0, 0x00]));
    socket.end();
  }
}

export function summarizePrinterStatus(print = {}) {
  return {
    gcodeState: String(print.gcode_state || '').toUpperCase(),
    percent: print.mc_percent ?? null,
    remainingMinutes: print.mc_remaining_time ?? null,
    subtaskName: print.subtask_name || '',
    projectFile: print.project_file || print.gcode_file || '',
    printError: print.print_error || '',
    failReason: print.fail_reason || '',
    trayNow: print.ams?.tray_now ?? '',
  };
}

export function listAmsTrays(print = {}, filamentType = 'PLA') {
  const expected = filamentType.toUpperCase();
  const trays = [];
  for (const ams of print.ams?.ams || []) {
    for (const tray of ams.tray || []) {
      const type = String(tray.tray_type || '').toUpperCase();
      if (!type.includes(expected)) continue;
      const amsId = Number.parseInt(ams.id, 10);
      const slotId = Number.parseInt(tray.id, 10);
      if (!Number.isInteger(amsId) || !Number.isInteger(slotId)) continue;
      trays.push({
        amsId,
        slotId,
        globalTrayId: amsId * 4 + slotId,
        type: tray.tray_type || '',
        name: tray.tray_sub_brands || '',
        color: tray.tray_color || '',
        remain: tray.remain ?? null,
      });
    }
  }
  return trays.sort((a, b) => {
    const aBasic = /basic/i.test(a.name) ? 1 : 0;
    const bBasic = /basic/i.test(b.name) ? 1 : 0;
    return bBasic - aBasic || b.globalTrayId - a.globalTrayId;
  });
}

export function selectAmsTray(print, config, excluded = new Set()) {
  const candidates = listAmsTrays(print, config.bambuAmsFilamentType)
    .filter((tray) => !excluded.has(tray.globalTrayId));
  if (config.bambuAmsSlot !== null) {
    return candidates.find((tray) => tray.globalTrayId === config.bambuAmsSlot) || null;
  }
  return candidates[0] || null;
}

export function isPrinterBusy(print) {
  const state = summarizePrinterStatus(print).gcodeState;
  return !['IDLE', 'FINISH', 'FAILED'].includes(state);
}

export async function waitForPrintOutcome(config, expectedSubtaskName) {
  const deadline = Date.now() + config.bambuPrintConfirmTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getPrinterStatus(config);
    const status = summarizePrinterStatus(last);
    const isExpectedJob = status.subtaskName === expectedSubtaskName;
    if (isExpectedJob && ['RUNNING', 'PAUSE', 'FAILED'].includes(status.gcodeState)) return last;
    await new Promise((resolve) => setTimeout(resolve, config.bambuStatusPollMs));
  }
  return last;
}
