import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectIndexState } from '../app/types.js';
import { assertProjectPathContained, resolveProjectPath } from './project-operations.js';

export interface ImportedAsset {
  readonly path: string;
  readonly mediaType: string;
}

const extensions = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ppm', 'image/x-portable-pixmap']
]);

export async function importAssetFile(
  rootDirectory: string,
  sourcePath: string,
  assetDirectory = 'assets'
): Promise<ImportedAsset> {
  const source = await realpath(path.resolve(sourcePath));
  const metadata = await lstat(source);
  if (!metadata.isFile()) throw new Error(`Asset source is not a file: ${sourcePath}`);
  const mediaType = mediaTypeForPath(source);
  const directory = resolveProjectPath(rootDirectory, assetDirectory);
  await assertProjectPathContained(rootDirectory, directory);
  await mkdir(directory, { recursive: true });
  await assertProjectPathContained(rootDirectory, directory);
  const destination = await availableAssetPath(directory, path.basename(source));
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  return Object.freeze({ path: destination, mediaType });
}

export async function importClipboardImage(
  rootDirectory: string,
  assetDirectory = 'assets',
  platform: NodeJS.Platform = process.platform
): Promise<ImportedAsset> {
  const clipboard = await readClipboardImage(platform);
  const directory = resolveProjectPath(rootDirectory, assetDirectory);
  await assertProjectPathContained(rootDirectory, directory);
  await mkdir(directory, { recursive: true });
  await assertProjectPathContained(rootDirectory, directory);
  const basename = `clipboard-${timestampName(new Date())}${extensionForMediaType(clipboard.mediaType)}`;
  const destination = await availableAssetPath(directory, basename);
  const handle = await open(destination, 'wx', 0o666);
  try {
    await handle.writeFile(clipboard.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({ path: destination, mediaType: clipboard.mediaType });
}

export async function findUnusedAssets(rootDirectory: string, index: ProjectIndexState): Promise<readonly string[]> {
  const referenced = new Set<string>();
  for (const document of Object.values(index.documents)) {
    for (const link of document.links) {
      const destination = localAssetDestination(link.destination);
      if (destination === undefined) continue;
      referenced.add(path.resolve(path.dirname(document.path), destination));
    }
  }
  const unused: string[] = [];
  await collectAssets(path.resolve(rootDirectory), referenced, unused);
  return Object.freeze(unused.toSorted((left, right) => left.localeCompare(right)));
}

export function markdownAssetReference(documentPath: string, assetPath: string, label?: string): string {
  const relative = path.relative(path.dirname(documentPath), assetPath).split(path.sep).join('/');
  const destination = relative.startsWith('.') ? relative : `./${relative}`;
  const escapedDestination = destination.includes(' ') ? `<${destination}>` : destination;
  const alt = (label ?? path.basename(assetPath, path.extname(assetPath))).replaceAll('[', '\\[').replaceAll(']', '\\]');
  return `![${alt}](${escapedDestination})`;
}

function mediaTypeForPath(filePath: string): string {
  const mediaType = extensions.get(path.extname(filePath).toLowerCase());
  if (mediaType === undefined) throw new Error(`Unsupported asset image format: ${filePath}`);
  return mediaType;
}

function extensionForMediaType(mediaType: string): string {
  for (const [extension, candidate] of extensions) if (candidate === mediaType) return extension;
  throw new Error(`Unsupported clipboard image type: ${mediaType}`);
}

async function availableAssetPath(directory: string, basename: string): Promise<string> {
  const extension = path.extname(basename);
  const stem = path.basename(basename, extension);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = path.join(directory, suffix === 1 ? basename : `${stem}-${String(suffix)}${extension}`);
    try {
      await lstat(candidate);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error(`Could not choose a unique asset path below ${directory}.`);
}

async function collectAssets(directory: string, referenced: ReadonlySet<string>, unused: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EACCES') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectAssets(candidate, referenced, unused);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) && !referenced.has(candidate)) unused.push(candidate);
  }
}

function localAssetDestination(destination: string): string | undefined {
  if (destination.length === 0 || destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) return undefined;
  const raw = destination.split('#', 1)[0] ?? '';
  try {
    const decoded = decodeURIComponent(raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw);
    return extensions.has(path.extname(decoded).toLowerCase()) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function readClipboardImage(platform: NodeJS.Platform): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  if (platform === 'darwin') {
    return Object.freeze({ bytes: await runBinaryCommand('pngpaste', ['-']), mediaType: 'image/png' });
  }
  if (platform === 'linux') {
    try {
      return Object.freeze({ bytes: await runBinaryCommand('wl-paste', ['--no-newline', '--type', 'image/png']), mediaType: 'image/png' });
    } catch (first) {
      try {
        return Object.freeze({ bytes: await runBinaryCommand('xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']), mediaType: 'image/png' });
      } catch {
        throw first;
      }
    }
  }
  if (platform === 'win32') {
    const encoded = await runBinaryCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Sta', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); if($null -eq $i){exit 4}; $m=New-Object IO.MemoryStream; $i.Save($m,[Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())'
    ]);
    return Object.freeze({ bytes: new Uint8Array(Buffer.from(Buffer.from(encoded).toString('utf8').trim(), 'base64')), mediaType: 'image/png' });
  }
  throw new Error(`Clipboard image import is not supported on ${platform}.`);
}

function runBinaryCommand(executable: string, arguments_: readonly string[], maximumBytes = 20_000_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let length = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maximumBytes) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.subarray(0, Math.max(0, 16_384 - errors.reduce((sum, value) => sum + value.length, 0)))));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (length > maximumBytes) reject(new Error('Clipboard image exceeds the configured size limit.'));
      else if (code !== 0) reject(new Error(`${executable} could not read an image from the clipboard${signal === null ? '' : ` (${signal})`}: ${Buffer.concat(errors).toString('utf8').trim()}`));
      else if (length === 0) reject(new Error('The clipboard does not contain an image.'));
      else resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

function timestampName(value: Date): string {
  return value.toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/u, 'Z');
}
