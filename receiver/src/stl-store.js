import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function safeBaseName(value) {
  const fallback = 'upload.stl';
  const name = basename(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  const withExt = extname(name).toLowerCase() === '.stl' ? name : `${name}.stl`;
  return withExt.slice(0, 120) || fallback;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

export function assertLooksLikeStl(buffer) {
  if (buffer.length < 15) {
    throw new Error('Upload is too small to be an STL file');
  }

  if (buffer.subarray(0, 5).toString('ascii').toLowerCase() === 'solid') {
    return;
  }

  if (buffer.length >= 84) {
    return;
  }

  throw new Error('Upload does not look like an STL file');
}

export async function saveStl({ uploadDir, body, originalName }) {
  assertLooksLikeStl(body);
  await mkdir(uploadDir, { recursive: true });

  const id = randomUUID();
  const safeName = safeBaseName(originalName);
  const filename = `${timestampForFile()}-${id}-${safeName}`;
  const path = join(uploadDir, filename);

  await writeFile(path, body, { flag: 'wx' });

  return {
    id,
    filename,
    path,
    bytes: body.length,
  };
}
