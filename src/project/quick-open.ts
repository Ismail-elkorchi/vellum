import path from 'node:path';
import type { FileTreeState } from '../app/types.js';
import { fuzzyScore } from '../commands/palette.js';
import { indexedFilePaths } from './file-tree.js';

export interface QuickOpenEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly score: number;
}

export function quickOpenEntries(
  fileTree: FileTreeState,
  query: string,
  recentlyOpenedPaths: readonly string[]
): readonly QuickOpenEntry[] {
  const root = fileTree.rootIds[0];
  const normalized = query.trim().toLocaleLowerCase();
  const recent = new Map(recentlyOpenedPaths.map((filePath, index) => [filePath, index]));
  const entries = indexedFilePaths(fileTree).map((filePath) => {
    const relativePath = root === undefined ? filePath : path.relative(root, filePath);
    const normalizedPath = relativePath.replaceAll('\\', '/').toLocaleLowerCase();
    const basename = path.basename(filePath).toLocaleLowerCase();
    let score = normalized.length === 0 ? 0 : fuzzyScore(normalizedPath, normalized);
    if (basename === normalized) score += 10_000;
    else if (basename.startsWith(normalized)) score += 5_000;
    if (normalizedPath.split('/').some((component) => component === normalized)) score += 2_000;
    const recentIndex = recent.get(filePath);
    if (recentIndex !== undefined) score += Math.max(1, 500 - recentIndex);
    return Object.freeze({ path: filePath, relativePath, score });
  }).filter((entry) => normalized.length === 0 || entry.score > Number.NEGATIVE_INFINITY);
  return Object.freeze(entries.toSorted((left, right) => (
    right.score - left.score
    || left.relativePath.localeCompare(right.relativePath)
  )));
}
