import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MarkdownFileRecord {
  readonly path: string;
  readonly label: string;
  readonly text: string;
}

function expandHome(rawPath: string): string {
  if (rawPath.startsWith('~/') || rawPath === '~') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    return path.join(home, rawPath.slice(2));
  }
  return rawPath;
}

export function ensureMarkdownExtension(rawPath: string): string {
  const normalized = rawPath.trim();
  if (normalized.length === 0) {
    return normalized;
  }
  if (/\.md$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}.md`;
}

export function resolveMarkdownPath(rawPath: string): string {
  const expanded = expandHome(rawPath.trim());
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(process.cwd(), expanded);
  return path.resolve(absolute);
}

export function loadMarkdownPath(rawPath: string): string {
  return resolveMarkdownPath(ensureMarkdownExtension(rawPath));
}

export async function openMarkdownFile(rawPath: string, signal: AbortSignal): Promise<MarkdownFileRecord> {
  const filePath = loadMarkdownPath(rawPath);
  const label = path.basename(filePath);
  try {
    const text = await readFile(filePath, { encoding: 'utf8', signal });
    return { path: filePath, label, text };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}

export async function saveMarkdownFile(
  rawPath: string,
  text: string,
  signal: AbortSignal
): Promise<MarkdownFileRecord> {
  const filePath = loadMarkdownPath(rawPath);
  const directory = path.dirname(filePath);
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true });
  signal.throwIfAborted();

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', signal });
    signal.throwIfAborted();
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: filePath,
    label: path.basename(filePath),
    text
  };
}
