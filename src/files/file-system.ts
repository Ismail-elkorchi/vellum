import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import { flushDirectoryMetadata } from './durability.js';
import type {
  ExternalFileFingerprint,
  FileFormat
} from '../app/types.js';

export interface SourceFileRecord {
  readonly path: string;
  readonly realPath: string;
  readonly label: string;
  readonly source: string;
  readonly format: FileFormat;
  readonly fingerprint: ExternalFileFingerprint;
}

export interface SaveSourceFileOptions {
  readonly expectedFingerprint?: ExternalFileFingerprint;
  readonly overwriteExisting?: boolean;
  readonly format: FileFormat;
  readonly signal?: AbortSignal;
}

export class ExternalFileChangedError extends Error {
  readonly current: ExternalFileFingerprint;

  constructor(current: ExternalFileFingerprint) {
    super('The external file revision changed before the save could begin.');
    this.name = 'ExternalFileChangedError';
    this.current = current;
  }
}

export class ExistingFileError extends Error {
  constructor(filePath: string) {
    super(`The output file already exists: ${filePath}`);
    this.name = 'ExistingFileError';
  }
}

function absolutePath(requestedPath: string): string {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new TypeError('A file path is required.');
  }
  return path.resolve(requestedPath);
}

function bytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceBytes(source: string, format: FileFormat): Uint8Array {
  const prefix = format.bom ? '\ufeff' : '';
  return new TextEncoder().encode(prefix + source);
}

async function fingerprint(realFilePath: string, bytes?: Uint8Array): Promise<ExternalFileFingerprint> {
  const metadata = await stat(realFilePath, { bigint: true });
  const content = bytes ?? await readFile(realFilePath);
  return Object.freeze({
    realPath: realFilePath,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: Number(metadata.size),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
    contentHash: bytesHash(content)
  });
}

export function sameExternalFileRevision(
  left: ExternalFileFingerprint,
  right: ExternalFileFingerprint
): boolean {
  return left.realPath === right.realPath
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.contentHash === right.contentHash;
}

export async function externalFileFingerprint(
  requestedPath: string
): Promise<ExternalFileFingerprint | undefined> {
  const target = absolutePath(requestedPath);
  try {
    return await fingerprint(await realpath(target));
  } catch (error) {
    if (hasFileCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function readSourceFile(
  requestedPath: string,
  signal?: AbortSignal
): Promise<SourceFileRecord> {
  signal?.throwIfAborted();
  const exactPath = absolutePath(requestedPath);
  const realFilePath = await realpath(exactPath);
  const metadata = await stat(realFilePath);
  if (!metadata.isFile()) throw new Error(`The requested path is not a file: ${exactPath}`);
  const bytes = await readFile(realFilePath, { signal });
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  const format: FileFormat = Object.freeze({
    bom,
    lineEnding: source.includes('\r\n') ? 'crlf' : 'lf',
    permissionMode: metadata.mode & 0o777
  });
  return Object.freeze({
    path: exactPath,
    realPath: realFilePath,
    label: path.basename(exactPath),
    source,
    format,
    fingerprint: await fingerprint(realFilePath, bytes)
  });
}

export async function saveSourceFile(
  requestedPath: string,
  source: string,
  options: SaveSourceFileOptions
): Promise<SourceFileRecord> {
  options.signal?.throwIfAborted();
  const exactPath = absolutePath(requestedPath);
  let targetPath = exactPath;
  let exists = false;
  try {
    const requestedMetadata = await lstat(exactPath);
    exists = true;
    targetPath = requestedMetadata.isSymbolicLink() ? await realpath(exactPath) : exactPath;
  } catch (error) {
    if (!hasFileCode(error, 'ENOENT')) throw error;
  }

  if (exists && options.expectedFingerprint === undefined && options.overwriteExisting !== true) {
    throw new ExistingFileError(exactPath);
  }
  if (options.expectedFingerprint !== undefined) {
    const current = await externalFileFingerprint(exactPath);
    if (current === undefined || !sameExternalFileRevision(current, options.expectedFingerprint)) {
      if (current !== undefined) throw new ExternalFileChangedError(current);
      throw new Error(`The external file was deleted before saving: ${exactPath}`);
    }
  }

  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`
  );
  const bytes = sourceBytes(source, options.format);
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, 'wx', options.format.permissionMode ?? 0o666);
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      if (options.format.permissionMode !== undefined) await handle.chmod(options.format.permissionMode);
    } finally {
      await handle.close();
    }
    options.signal?.throwIfAborted();
    await rename(temporaryPath, targetPath);
    temporaryCreated = false;
    if (options.format.permissionMode !== undefined) await chmod(targetPath, options.format.permissionMode);
    await flushDirectoryMetadata(directory);
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true });
  }
  return readSourceFile(exactPath, options.signal);
}

function hasFileCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
