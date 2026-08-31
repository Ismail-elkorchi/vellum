import { spawn } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectIndexState } from '../app/types.js';

export interface ProjectLinkChange {
  readonly documentPath: string;
  readonly futureDocumentPath: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface ProjectFileTransaction {
  addRollback(operation: () => Promise<void>): void;
}

export async function executeProjectFileTransaction<T>(
  operation: (transaction: ProjectFileTransaction) => Promise<T>
): Promise<T> {
  const rollbacks: (() => Promise<void>)[] = [];
  const transaction: ProjectFileTransaction = Object.freeze({
    addRollback(rollback: () => Promise<void>) {
      rollbacks.push(rollback);
    }
  });
  try {
    return await operation(transaction);
  } catch (cause) {
    const rollbackFailures: unknown[] = [];
    for (const rollback of rollbacks.toReversed()) {
      try {
        await rollback();
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackFailures],
        'The project file transaction failed and could not be rolled back completely.',
        { cause }
      );
    }
    throw cause;
  }
}

export function resolveProjectPath(rootDirectory: string, requestedPath: string): string {
  if (requestedPath.trim().length === 0) throw new Error('A project path is required.');
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, requestedPath);
  if (!pathWithin(root, resolved) || resolved === root) {
    throw new Error(`The path must remain below the project root: ${requestedPath}`);
  }
  return resolved;
}

export async function assertProjectPathContained(rootDirectory: string, candidatePath: string): Promise<void> {
  const root = await realpath(path.resolve(rootDirectory));
  let existing = path.resolve(candidatePath);
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (!pathWithin(root, resolved)) {
        throw new Error(`The project path resolves outside the project root: ${candidatePath}`);
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

async function assertMutationParent(rootDirectory: string, targetPath: string): Promise<void> {
  await assertProjectPathContained(rootDirectory, path.dirname(targetPath));
}

export async function createProjectFile(rootDirectory: string, requestedPath: string, source = ''): Promise<string> {
  const target = resolveProjectPath(rootDirectory, requestedPath);
  await assertMutationParent(rootDirectory, target);
  const handle = await open(target, 'wx', 0o666);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

export async function createProjectDirectory(rootDirectory: string, requestedPath: string): Promise<string> {
  const target = resolveProjectPath(rootDirectory, requestedPath);
  await assertMutationParent(rootDirectory, target);
  await mkdir(target, { recursive: false });
  return target;
}

export async function moveProjectPath(rootDirectory: string, sourcePath: string, destinationPath: string): Promise<string> {
  const source = resolveProjectPath(rootDirectory, sourcePath);
  const destination = resolveProjectPath(rootDirectory, destinationPath);
  if (pathWithin(source, destination)) throw new Error('A directory cannot be moved inside itself.');
  await Promise.all([
    assertMutationParent(rootDirectory, source),
    assertMutationParent(rootDirectory, destination)
  ]);
  await lstat(source);
  if (await exists(destination)) throw new Error(`The destination already exists: ${destination}`);
  await rename(source, destination);
  return destination;
}

export async function duplicateProjectPath(rootDirectory: string, sourcePath: string, destinationPath: string): Promise<string> {
  const source = resolveProjectPath(rootDirectory, sourcePath);
  const destination = resolveProjectPath(rootDirectory, destinationPath);
  if (pathWithin(source, destination)) throw new Error('A directory cannot be duplicated inside itself.');
  await Promise.all([
    assertMutationParent(rootDirectory, source),
    assertMutationParent(rootDirectory, destination)
  ]);
  if (await exists(destination)) throw new Error(`The destination already exists: ${destination}`);
  const metadata = await lstat(source);
  if (metadata.isDirectory()) await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  else if (metadata.isFile()) await copyFile(source, destination, 0);
  else if (metadata.isSymbolicLink()) throw new Error('Project symlinks cannot be duplicated.');
  else throw new Error(`The project entry cannot be duplicated: ${source}`);
  return destination;
}

export async function trashProjectPath(
  rootDirectory: string,
  requestedPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const target = resolveProjectPath(rootDirectory, requestedPath);
  await assertMutationParent(rootDirectory, target);
  await lstat(target);
  if (platform === 'linux') {
    await runCommand('gio', ['trash', '--', target]);
    return;
  }
  if (platform === 'darwin') {
    await runCommand('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)',
      '-e', 'end run',
      target
    ]);
    return;
  }
  if (platform === 'win32') {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName Microsoft.VisualBasic; $p=$args[0]; if ([IO.Directory]::Exists($p)) {[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,"OnlyErrorDialogs","SendToRecycleBin")} else {[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,"OnlyErrorDialogs","SendToRecycleBin")}',
      target
    ]);
    return;
  }
  throw new Error(`Moving files to trash is not supported on ${platform}.`);
}

export async function copyTextToClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'darwin') return runCommandWithInput('pbcopy', [], text);
  if (platform === 'win32') return runCommandWithInput('clip.exe', [], text);
  if (platform === 'linux') {
    try {
      await runCommandWithInput('wl-copy', [], text);
    } catch (first) {
      try {
        await runCommandWithInput('xclip', ['-selection', 'clipboard'], text);
      } catch {
        throw first;
      }
    }
    return;
  }
  throw new Error(`Clipboard integration is not supported on ${platform}.`);
}

export async function revealProjectPath(
  rootDirectory: string,
  requestedPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const target = resolveProjectPath(rootDirectory, requestedPath);
  await lstat(target);
  if (platform === 'darwin') return runCommand('open', ['-R', target]);
  if (platform === 'win32') return runCommand('explorer.exe', [`/select,${target}`]);
  if (platform === 'linux') return runCommand('xdg-open', [path.dirname(target)]);
  throw new Error(`Revealing files externally is not supported on ${platform}.`);
}

export function planProjectMoveLinkChanges(
  rootDirectory: string,
  index: ProjectIndexState,
  requestedSource: string,
  requestedDestination: string
): readonly ProjectLinkChange[] {
  const source = resolveProjectPath(rootDirectory, requestedSource);
  const destination = resolveProjectPath(rootDirectory, requestedDestination);
  const changes: ProjectLinkChange[] = [];
  for (const document of Object.values(index.documents)) {
    const futureDocumentPath = remapPath(document.path, source, destination);
    for (const link of document.links) {
      const parsed = localLink(link.destination);
      if (parsed === undefined) continue;
      const currentTarget = path.resolve(path.dirname(document.path), parsed.path);
      const futureTarget = remapPath(currentTarget, source, destination);
      if (futureTarget === currentTarget && futureDocumentPath === document.path) continue;
      let relative = path.relative(path.dirname(futureDocumentPath), futureTarget).split(path.sep).join('/');
      if (relative.length === 0) relative = path.basename(futureTarget);
      if (!relative.startsWith('.') && parsed.path.startsWith('./')) relative = `./${relative}`;
      const replacement = `${relative}${parsed.fragment}`;
      if (replacement === link.destination) continue;
      changes.push(Object.freeze({
        documentPath: document.path,
        futureDocumentPath,
        start: link.sourceSpan.start,
        end: link.sourceSpan.end,
        replacement
      }));
    }
  }
  return Object.freeze(changes.toSorted((left, right) => (
    left.documentPath.localeCompare(right.documentPath) || right.start - left.start
  )));
}

function remapPath(candidate: string, source: string, destination: string): string {
  if (candidate === source) return destination;
  return pathWithin(source, candidate) ? path.join(destination, path.relative(source, candidate)) : candidate;
}

function localLink(destination: string): { readonly path: string; readonly fragment: string } | undefined {
  if (destination.length === 0 || destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) return undefined;
  const hash = destination.indexOf('#');
  const rawPath = hash < 0 ? destination : destination.slice(0, hash);
  try {
    return Object.freeze({
      path: decodeURIComponent(rawPath),
      fragment: hash < 0 ? '' : destination.slice(hash)
    });
  } catch {
    return undefined;
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runCommand(executable: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorText += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} failed${signal === null ? ` with exit code ${String(code)}` : ` from ${signal}`}${errorText.trim().length === 0 ? '.' : `: ${errorText.trim()}`}`));
    });
  });
}

async function runCommandWithInput(executable: string, arguments_: readonly string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorText += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} failed${signal === null ? ` with exit code ${String(code)}` : ` from ${signal}`}${errorText.trim().length === 0 ? '.' : `: ${errorText.trim()}`}`));
    });
    child.stdin.end(input);
  });
}
