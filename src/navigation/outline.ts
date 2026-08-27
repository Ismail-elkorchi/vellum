import { extractMarkdownOutline, type MarkdownOutlineEntry } from 'markspan';
import type { ReadyMarkdownPreview } from '../app/types.js';

export interface OutlineItem {
  readonly nodeId: number;
  readonly depth: number;
  readonly title: string;
  readonly sourceOffset: number;
  readonly active: boolean;
  readonly children: readonly OutlineItem[];
}

export function documentOutline(
  preview: ReadyMarkdownPreview,
  sourceOffset: number,
  query = ''
): readonly OutlineItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const entries = extractMarkdownOutline(preview.snapshot.document.tree);
  const flat = flatten(entries);
  let activeNodeId: number | undefined;
  for (const entry of flat) if (entry.span.start <= sourceOffset) activeNodeId = entry.nodeId;
  const map = (entry: MarkdownOutlineEntry): OutlineItem | undefined => {
    const children = entry.children.flatMap((child) => {
      const mapped = map(child);
      return mapped === undefined ? [] : [mapped];
    });
    if (normalizedQuery.length > 0 && !entry.text.toLowerCase().includes(normalizedQuery) && children.length === 0) {
      return undefined;
    }
    return Object.freeze({
      nodeId: entry.nodeId,
      depth: entry.depth,
      title: entry.text.length === 0 ? 'Untitled heading' : entry.text,
      sourceOffset: entry.span.start,
      active: entry.nodeId === activeNodeId,
      children: Object.freeze(children)
    });
  };
  return Object.freeze(entries.flatMap((entry) => {
    const mapped = map(entry);
    return mapped === undefined ? [] : [mapped];
  }));
}

function flatten(entries: readonly MarkdownOutlineEntry[]): readonly MarkdownOutlineEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}
