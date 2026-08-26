import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractMarkdownOutline, type MarkdownDocumentNode } from 'markspan';

export type ResolvedMarkdownLink =
  | { readonly kind: 'external'; readonly url: URL }
  | { readonly kind: 'source'; readonly path?: string; readonly sourceOffset?: number };

export function resolveMarkdownLink(
  destination: string,
  sourceDocumentPath: string | undefined,
  targetTree?: MarkdownDocumentNode
): ResolvedMarkdownLink {
  const external = URL.parse(destination);
  if (external !== null && !isWindowsDrivePath(destination) && ['http:', 'https:', 'mailto:'].includes(external.protocol)) {
    return Object.freeze({ kind: 'external', url: external });
  }
  const hashIndex = destination.indexOf('#');
  const rawPath = hashIndex < 0 ? destination : destination.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : decodeURIComponent(destination.slice(hashIndex + 1));
  if (sourceDocumentPath === undefined && rawPath.length > 0 && !path.isAbsolute(rawPath)) {
    throw new Error('A relative link requires a saved source document.');
  }
  const targetPath = rawPath.length === 0
    ? sourceDocumentPath
    : path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(path.dirname(sourceDocumentPath as string), rawPath);
  const sourceOffset = fragment.length === 0 || targetTree === undefined
    ? undefined
    : headingOffset(targetTree, fragment);
  return Object.freeze({
    kind: 'source',
    ...(targetPath === undefined ? {} : { path: targetPath }),
    ...(sourceOffset === undefined ? {} : { sourceOffset })
  });
}

export function openExternalMarkdownLink(url: URL, signal?: AbortSignal): Promise<void> {
  const invocation = process.platform === 'darwin'
    ? { executable: '/usr/bin/open', arguments: [url.href] }
    : process.platform === 'win32'
      ? { executable: 'rundll32.exe', arguments: ['url.dll,FileProtocolHandler', url.href] }
      : { executable: '/usr/bin/xdg-open', arguments: [url.href] };
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      stdio: 'ignore', windowsHide: true,
      ...(signal === undefined ? {} : { signal })
    });
    child.once('error', reject);
    child.once('close', (status) => status === 0
      ? resolve()
      : reject(new Error(`External link opener exited with status ${String(status)}.`)));
  });
}

function headingOffset(tree: MarkdownDocumentNode, fragment: string): number | undefined {
  const wanted = normalizeFragment(fragment);
  for (const entry of flatten(extractMarkdownOutline(tree))) {
    if (normalizeFragment(entry.text) === wanted) return entry.span.start;
  }
  return undefined;
}

function flatten(entries: ReturnType<typeof extractMarkdownOutline>): ReturnType<typeof extractMarkdownOutline> {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}

function normalizeFragment(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/[^\p{Letter}\p{Number}\s-]/gu, '').replaceAll(/\s+/gu, '-');
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value);
}
