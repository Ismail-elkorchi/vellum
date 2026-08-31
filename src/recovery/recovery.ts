import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type {
  AppState,
  BufferId,
  ExternalFileFingerprint,
  ExternalFileState,
  FileFormat
} from '../app/types.js';
import { defaultVellumStateDirectory } from '../config/paths.js';
import { flushDirectoryMetadata } from '../files/durability.js';

const recoverySchemaVersion = 1;
const maximumSnapshots = 5;

export interface RecoveryBufferRecord {
  readonly id: BufferId;
  readonly path?: string;
  readonly label: string;
  readonly source: string;
  readonly checksum: string;
  readonly savedSourceRevision: number;
  readonly currentSourceRevision: number;
  readonly externalFileState: ExternalFileState;
  readonly format: FileFormat;
}

export interface RecoverySnapshot {
  readonly generation: number;
  readonly timestamp: string;
  readonly buffers: readonly RecoveryBufferRecord[];
}

export interface RecoveryJournal {
  readonly schemaVersion: 1;
  readonly snapshots: readonly RecoverySnapshot[];
}

export interface RecoveryStore {
  readonly filePath: string;
  read(): Promise<RecoveryJournal | undefined>;
  write(state: AppState): Promise<void>;
  delete(): Promise<void>;
  diagnostics(): readonly string[];
}

export function createRecoveryStore(directory = defaultVellumStateDirectory()): RecoveryStore {
  const filePath = path.join(directory, 'recovery.json');
  const diagnostics: string[] = [];
  let loaded = false;
  let journal: RecoveryJournal | undefined;

  const load = async (): Promise<RecoveryJournal | undefined> => {
    if (loaded) return journal;
    let source: string;
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      loaded = true;
      if (!isMissingFile(error)) diagnostics.push(`Recovery data could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    try {
      journal = decodeRecoveryJournal(JSON.parse(source));
    } catch (error) {
      const quarantine = path.join(directory, `recovery.corrupt-${randomUUID()}.json`);
      try {
        await rename(filePath, quarantine);
        diagnostics.push(`Invalid recovery data was quarantined at ${quarantine}: ${errorMessage(error)}`);
      } catch (quarantineError) {
        diagnostics.push(`Invalid recovery data could not be quarantined: ${errorMessage(error)}; ${errorMessage(quarantineError)}`);
      }
      journal = undefined;
    }
    loaded = true;
    return journal;
  };

  const remove = async (): Promise<void> => {
    try {
      await rm(filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return;
    }
    await flushDirectoryMetadata(directory);
  };

  return Object.freeze({
    filePath,
    read: load,
    async write(state: AppState) {
      const buffers = unsafeBufferRecords(state);
      if (buffers.length === 0) {
        await remove();
        journal = undefined;
        loaded = true;
        return;
      }
      const previous = await load();
      const latest = previous?.snapshots.at(-1);
      if (latest !== undefined && JSON.stringify(latest.buffers) === JSON.stringify(buffers)) return;
      const generation = (previous?.snapshots.at(-1)?.generation ?? 0) + 1;
      const snapshot: RecoverySnapshot = Object.freeze({
        generation,
        timestamp: new Date().toISOString(),
        buffers
      });
      const nextJournal: RecoveryJournal = Object.freeze({
        schemaVersion: recoverySchemaVersion,
        snapshots: Object.freeze([...(previous?.snapshots ?? []), snapshot].slice(-maximumSnapshots))
      });
      await writeAtomicJson(directory, filePath, nextJournal);
      journal = nextJournal;
      loaded = true;
    },
    async delete() {
      await remove();
      journal = undefined;
      loaded = true;
    },
    diagnostics() {
      return Object.freeze([...diagnostics]);
    }
  });
}

export function latestRecoverySnapshot(journal: RecoveryJournal | undefined): RecoverySnapshot | undefined {
  return journal?.snapshots.at(-1);
}

function unsafeBufferRecords(state: AppState): readonly RecoveryBufferRecord[] {
  return Object.freeze(state.project.bufferOrder.flatMap((id) => {
    const buffer = state.project.buffers[id];
    if (buffer === undefined || (buffer.path !== undefined && buffer.sourceRevision === buffer.savedRevision)) return [];
    const source = textDocumentText(buffer.editor.document);
    return [Object.freeze({
      id,
      ...(buffer.path === undefined ? {} : { path: buffer.path }),
      label: buffer.label,
      source,
      checksum: sourceChecksum(source),
      savedSourceRevision: buffer.savedRevision,
      currentSourceRevision: buffer.sourceRevision,
      externalFileState: buffer.externalFileState,
      format: buffer.format
    })];
  }));
}

function decodeRecoveryJournal(value: unknown): RecoveryJournal {
  const journal = objectValue(value, 'Recovery journal');
  exactFields(journal, ['schemaVersion', 'snapshots'], 'Recovery journal');
  if (journal['schemaVersion'] !== recoverySchemaVersion) {
    throw new TypeError(`Unsupported recovery schema version: ${String(journal['schemaVersion'])}.`);
  }
  if (!Array.isArray(journal['snapshots']) || journal['snapshots'].length === 0 || journal['snapshots'].length > maximumSnapshots) {
    throw new TypeError(`Recovery journal must contain from one through ${String(maximumSnapshots)} snapshots.`);
  }
  const snapshots = Object.freeze(journal['snapshots'].map(decodeRecoverySnapshot));
  for (let index = 1; index < snapshots.length; index += 1) {
    if ((snapshots[index]?.generation ?? 0) <= (snapshots[index - 1]?.generation ?? 0)) {
      throw new TypeError('Recovery generations must be strictly increasing.');
    }
  }
  return Object.freeze({ schemaVersion: recoverySchemaVersion, snapshots });
}

function decodeRecoverySnapshot(value: unknown): RecoverySnapshot {
  const snapshot = objectValue(value, 'Recovery snapshot');
  exactFields(snapshot, ['generation', 'timestamp', 'buffers'], 'Recovery snapshot');
  const generation = positiveInteger(snapshot['generation'], 'Recovery generation');
  if (typeof snapshot['timestamp'] !== 'string' || !Number.isFinite(Date.parse(snapshot['timestamp']))) {
    throw new TypeError('Recovery timestamp is invalid.');
  }
  if (!Array.isArray(snapshot['buffers']) || snapshot['buffers'].length === 0) {
    throw new TypeError('Recovery snapshot buffers must be a nonempty array.');
  }
  const buffers = Object.freeze(snapshot['buffers'].map(decodeRecoveryBuffer));
  if (new Set(buffers.map((buffer) => buffer.id)).size !== buffers.length) {
    throw new TypeError('Recovery buffer identifiers must be unique within a snapshot.');
  }
  return Object.freeze({ generation, timestamp: snapshot['timestamp'], buffers });
}

function decodeRecoveryBuffer(value: unknown): RecoveryBufferRecord {
  const buffer = objectValue(value, 'Recovery buffer');
  exactFields(buffer, [
    'id', 'path', 'label', 'source', 'checksum', 'savedSourceRevision',
    'currentSourceRevision', 'externalFileState', 'format'
  ], 'Recovery buffer');
  const id = nonemptyString(buffer['id'], 'Recovery buffer id');
  const pathValue = optionalAbsolutePath(buffer['path'], `Recovery buffer ${id} path`);
  if (typeof buffer['label'] !== 'string' || typeof buffer['source'] !== 'string') {
    throw new TypeError(`Recovery buffer ${id} label and source must be strings.`);
  }
  if (buffer['checksum'] !== sourceChecksum(buffer['source'])) {
    throw new TypeError(`Recovery buffer ${id} checksum does not match its source.`);
  }
  const savedSourceRevision = nonnegativeInteger(buffer['savedSourceRevision'], `Recovery buffer ${id} saved revision`);
  const currentSourceRevision = nonnegativeInteger(buffer['currentSourceRevision'], `Recovery buffer ${id} current revision`);
  if (savedSourceRevision > currentSourceRevision) throw new TypeError(`Recovery buffer ${id} revisions are invalid.`);
  const externalFileState = decodeExternalFileState(buffer['externalFileState'], id);
  if ((pathValue === undefined) !== (externalFileState.kind === 'untracked')) {
    throw new TypeError(`Recovery buffer ${id} path and external-file state are inconsistent.`);
  }
  return Object.freeze({
    id,
    ...(pathValue === undefined ? {} : { path: pathValue }),
    label: buffer['label'],
    source: buffer['source'],
    checksum: buffer['checksum'],
    savedSourceRevision,
    currentSourceRevision,
    externalFileState,
    format: decodeFileFormat(buffer['format'], id)
  });
}

function decodeExternalFileState(value: unknown, id: string): ExternalFileState {
  const state = objectValue(value, `Recovery buffer ${id} external-file state`);
  if (state['kind'] === 'untracked') {
    exactFields(state, ['kind'], `Recovery buffer ${id} external-file state`);
    return Object.freeze({ kind: 'untracked' });
  }
  if (state['kind'] === 'current') {
    exactFields(state, ['kind', 'fingerprint'], `Recovery buffer ${id} external-file state`);
    return Object.freeze({ kind: 'current', fingerprint: decodeFingerprint(state['fingerprint'], id) });
  }
  if (state['kind'] === 'conflict') {
    exactFields(state, ['kind', 'disk'], `Recovery buffer ${id} external-file state`);
    return Object.freeze({ kind: 'conflict', disk: decodeFingerprint(state['disk'], id) });
  }
  if (state['kind'] === 'deleted') {
    exactFields(state, ['kind', 'previous'], `Recovery buffer ${id} external-file state`);
    return Object.freeze({ kind: 'deleted', previous: decodeFingerprint(state['previous'], id) });
  }
  throw new TypeError(`Recovery buffer ${id} external-file state is invalid.`);
}

function decodeFingerprint(value: unknown, id: string): ExternalFileFingerprint {
  const fingerprint = objectValue(value, `Recovery buffer ${id} fingerprint`);
  exactFields(fingerprint, ['realPath', 'device', 'inode', 'size', 'modifiedNanoseconds', 'contentHash'], `Recovery buffer ${id} fingerprint`);
  const realPath = optionalAbsolutePath(fingerprint['realPath'], `Recovery buffer ${id} real path`);
  if (realPath === undefined
    || typeof fingerprint['device'] !== 'string'
    || typeof fingerprint['inode'] !== 'string'
    || typeof fingerprint['modifiedNanoseconds'] !== 'string'
    || typeof fingerprint['contentHash'] !== 'string'
    || !/^\d+$/u.test(fingerprint['device'])
    || !/^\d+$/u.test(fingerprint['inode'])
    || !/^-?\d+$/u.test(fingerprint['modifiedNanoseconds'])
    || !/^[a-f0-9]{64}$/u.test(fingerprint['contentHash'])) {
    throw new TypeError(`Recovery buffer ${id} fingerprint is invalid.`);
  }
  return Object.freeze({
    realPath,
    device: fingerprint['device'],
    inode: fingerprint['inode'],
    size: nonnegativeInteger(fingerprint['size'], `Recovery buffer ${id} file size`),
    modifiedNanoseconds: fingerprint['modifiedNanoseconds'],
    contentHash: fingerprint['contentHash']
  });
}

function decodeFileFormat(value: unknown, id: string): FileFormat {
  const format = objectValue(value, `Recovery buffer ${id} format`);
  exactFields(format, ['bom', 'lineEnding', 'permissionMode'], `Recovery buffer ${id} format`);
  if (typeof format['bom'] !== 'boolean' || (format['lineEnding'] !== 'lf' && format['lineEnding'] !== 'crlf')) {
    throw new TypeError(`Recovery buffer ${id} format is invalid.`);
  }
  const permissionMode = format['permissionMode'];
  if (permissionMode !== undefined && (!Number.isSafeInteger(permissionMode) || Number(permissionMode) < 0 || Number(permissionMode) > 0o777)) {
    throw new TypeError(`Recovery buffer ${id} permission mode is invalid.`);
  }
  return Object.freeze({
    bom: format['bom'],
    lineEnding: format['lineEnding'],
    ...(permissionMode === undefined ? {} : { permissionMode: Number(permissionMode) })
  });
}

async function writeAtomicJson(directory: string, filePath: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.recovery-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await flushDirectoryMetadata(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

function sourceChecksum(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function optionalAbsolutePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a nonnegative integer.`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result === 0) throw new TypeError(`${label} must be positive.`);
  return result;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
