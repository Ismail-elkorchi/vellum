import path from 'node:path';
import type { ProjectIndexState } from '../app/types.js';
import { fuzzyScore } from '../commands/palette.js';
import { compareText } from '../order.js';

export interface QuickOpenEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly score: number;
}

export function quickOpenEntries(
  index: ProjectIndexState,
  query: string,
  recentlyOpenedPaths: readonly string[]
): readonly QuickOpenEntry[] {
  const normalized = query.trim().toLowerCase();
  const recent = new Map(recentlyOpenedPaths.map((filePath, index) => [filePath, index]));
  const entries = index.orderedPaths.map((filePath) => {
    const relativePath = index.documents[filePath]?.relativePath ?? path.basename(filePath);
    const normalizedPath = relativePath.replaceAll('\\', '/').toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
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
    || compareText(left.relativePath, right.relativePath)
  )));
}
