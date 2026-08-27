import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
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
    super('The external file revision changed before the save could commit.');
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

function fingerprint(
  realFilePath: string,
  metadata: BigIntStats,
  content: Uint8Array
): ExternalFileFingerprint {
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
    const realFilePath = await realpath(target);
    const revision = await readStableFile(realFilePath);
    return fingerprint(realFilePath, revision.metadata, revision.bytes);
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
  const revision = await readStableFile(realFilePath, signal);
  const { bytes, metadata } = revision;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  const format: FileFormat = Object.freeze({
    bom,
    lineEnding: source.includes('\r\n') ? 'crlf' : 'lf',
    permissionMode: Number(metadata.mode & 0o777n)
  });
  return Object.freeze({
    path: exactPath,
    realPath: realFilePath,
    label: path.basename(exactPath),
    source,
    format,
    fingerprint: fingerprint(realFilePath, metadata, bytes)
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
  let permissionMode = options.format.permissionMode ?? 0o666;
  let requestedMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    requestedMetadata = await lstat(exactPath);
    exists = true;
  } catch (error) {
    if (!hasFileCode(error, 'ENOENT')) throw error;
  }
  if (requestedMetadata !== undefined) {
    if (requestedMetadata.isSymbolicLink()) {
      try {
        targetPath = await realpath(exactPath);
      } catch (error) {
        if (hasFileCode(error, 'ENOENT')) {
          throw new Error(`The save target is a symbolic link whose target does not exist: ${exactPath}`);
        }
        throw error;
      }
    }
    const targetMetadata = await stat(targetPath);
    if (!targetMetadata.isFile()) throw new Error(`The save target is not a file: ${exactPath}`);
    permissionMode = targetMetadata.mode & 0o777;
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
  const reservation = !exists && options.overwriteExisting !== true
    ? await reserveNewFile(exactPath, permissionMode)
    : undefined;
  try {
    const handle = await open(temporaryPath, 'wx', permissionMode);
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(permissionMode);
    } finally {
      await handle.close();
    }
    options.signal?.throwIfAborted();
    if (options.expectedFingerprint !== undefined) {
      const current = await externalFileFingerprint(exactPath);
      if (current === undefined) throw new Error(`The external file was deleted before saving: ${exactPath}`);
      if (!sameExternalFileRevision(current, options.expectedFingerprint)) {
        throw new ExternalFileChangedError(current);
      }
    }
    if (reservation !== undefined && !await ownsReservation(exactPath, reservation)) {
      throw new ExistingFileError(exactPath);
    }
    await rename(temporaryPath, targetPath);
    temporaryCreated = false;
    await flushDirectoryMetadata(directory);
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true });
    if (reservation !== undefined) await removeOwnedReservation(exactPath, reservation);
  }
  return readSourceFile(exactPath);
}

interface FileReservation {
  readonly device: bigint;
  readonly inode: bigint;
}

async function reserveNewFile(filePath: string, permissionMode: number): Promise<FileReservation> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, 'wx', permissionMode);
  } catch (error) {
    if (hasFileCode(error, 'EEXIST')) throw new ExistingFileError(filePath);
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } finally {
    await handle.close();
  }
}

async function ownsReservation(filePath: string, reservation: FileReservation): Promise<boolean> {
  try {
    const metadata = await lstat(filePath, { bigint: true });
    return metadata.dev === reservation.device && metadata.ino === reservation.inode;
  } catch (error) {
    if (hasFileCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function removeOwnedReservation(filePath: string, reservation: FileReservation): Promise<void> {
  if (await ownsReservation(filePath, reservation)) await rm(filePath);
}

interface StableFileRevision {
  readonly metadata: BigIntStats;
  readonly bytes: Uint8Array;
}

async function readStableFile(realFilePath: string, signal?: AbortSignal): Promise<StableFileRevision> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    const before = await stat(realFilePath, { bigint: true });
    if (!before.isFile()) throw new Error(`The requested path is not a file: ${realFilePath}`);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The requested file is too large: ${realFilePath}`);
    const bytes = await readFile(realFilePath, { signal });
    const after = await stat(realFilePath, { bigint: true });
    if (sameReadRevision(before, after) && BigInt(bytes.length) === after.size) {
      return Object.freeze({ metadata: after, bytes });
    }
  }
  throw new Error(`The file changed repeatedly while it was being read: ${realFilePath}`);
}

function sameReadRevision(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function hasFileCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
