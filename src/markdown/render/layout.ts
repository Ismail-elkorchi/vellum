import {
  createRowOffsetMap,
  measureTextCells,
  type RowOffsetMap,
  type TextWidthProfile,
} from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownDocumentNode, SourceSpan } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { renderMarkdownBlock, type MarkdownRenderedBlock } from './block.js';
import type { MarkdownBlockResources } from './resources.js';
import {
  createMarkdownBlockLayoutCache,
  type MarkdownBlockLayoutCache,
  type MarkdownLayoutCacheUpdate
} from './cache.js';
import type { MarkdownActivation } from './inline.js';
import {
  blankMarkdownRow,
  type MarkdownLayoutMedia,
  type MarkdownLayoutRow,
} from './wrap.js';
import { accessibleMarkdownDocument, type MarkdownAccessibleNode } from './accessibility.js';

export interface MarkdownPreviewActivation {
  readonly row: number;
  readonly sourceSpan: SourceSpan;
  readonly activation?: MarkdownActivation;
}

export interface MarkdownPreviewActionFragment extends MarkdownPreviewActivation {
  readonly id: string;
  readonly column: number;
  readonly width: number;
  readonly activation: MarkdownActivation;
}

export interface MarkdownPreviewMediaPlacement extends MarkdownLayoutMedia {
  readonly row: number;
}

export interface MarkdownPreviewLayout {
  readonly width: number;
  readonly widthProfile: TextWidthProfile;
  readonly rows: readonly MarkdownLayoutRow[];
  readonly blocks: readonly MarkdownRenderedBlock[];
  readonly media: readonly MarkdownPreviewMediaPlacement[];
  readonly rowOffsetMap: RowOffsetMap;
  readonly activations: readonly MarkdownPreviewActionFragment[];
  readonly accessibility: MarkdownAccessibleNode;
  readonly instrumentation: MarkdownLayoutCacheUpdate;
}

export function createPreviewLayoutCache(): MarkdownBlockLayoutCache<MarkdownRenderedBlock> {
  return createMarkdownBlockLayoutCache();
}

export function layoutMarkdownPreview(
  tree: MarkdownDocumentNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  cache: MarkdownBlockLayoutCache<MarkdownRenderedBlock>,
  resources: MarkdownBlockResources = {}
): MarkdownPreviewLayout {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const blocks: MarkdownRenderedBlock[] = [];
  const rows: MarkdownLayoutRow[] = [];
  const activeIds = new Set<number>();
  let reusedBlockLayouts = 0;
  let rebuiltBlockLayouts = 0;
  let previousVisible: MarkdownRenderedBlock | undefined;
  for (const node of tree.children) {
    activeIds.add(node.id);
    const existing = cache.get(node.id, normalizedWidth, theme, widthProfile);
    const block = existing === undefined
      ? renderMarkdownBlock(node, normalizedWidth, theme, widthProfile, resources)
      : translateBlock(existing.value, node.span.start - existing.sourceStart);
    if (existing === undefined) {
      rebuiltBlockLayouts += 1;
      cache.set(node.id, {
        width: normalizedWidth,
        theme,
        widthProfile,
        sourceStart: node.span.start,
        value: block,
      });
    } else {
      reusedBlockLayouts += 1;
    }
    blocks.push(block);
    if (block.rows.length === 0) continue;
    if (previousVisible !== undefined) {
      rows.push(blankMarkdownRow(previousVisible.sourceSpan.end, previousVisible.nodeId));
    }
    rows.push(...block.rows);
    previousVisible = block;
  }
  cache.retain(activeIds);
  const rowOffsetMap = createRowOffsetMap(rows.map((row) => row.sourceOffset));
  const activations: MarkdownPreviewActionFragment[] = [];
  const media: MarkdownPreviewMediaPlacement[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    let column = 0;
    for (const span of rows[row]?.inlineSpans ?? []) {
      const width = measureTextCells(span.text, { widthProfile }).cells;
      if (span.activation !== undefined && width > 0) {
        activations.push(Object.freeze({
          id: `markdown-${String(span.activation.nodeId)}`,
          row,
          column,
          width,
          sourceSpan: span.sourceSpan,
          activation: span.activation,
        }));
      }
      column += width;
    }
    for (const entry of rows[row]?.media ?? []) {
      media.push(Object.freeze({ ...entry, row }));
    }
  }
  return Object.freeze({
    width: normalizedWidth,
    widthProfile,
    rows: Object.freeze(rows),
    blocks: Object.freeze(blocks),
    media: Object.freeze(media),
    rowOffsetMap,
    activations: Object.freeze(activations),
    accessibility: accessibleMarkdownDocument(tree, resources.diagnostics),
    instrumentation: Object.freeze({
      reusedBlockLayouts,
      rebuiltBlockLayouts,
      fullPreviewLayout: tree.children.length > 0 && reusedBlockLayouts === 0
    })
  });
}

function translateBlock(block: MarkdownRenderedBlock, delta: number): MarkdownRenderedBlock {
  if (delta === 0) return block;
  const move = (span: SourceSpan): SourceSpan => Object.freeze({ start: span.start + delta, end: span.end + delta });
  const rows = block.rows.map((row) => {
    const inlineSpans = row.inlineSpans.map((span) => Object.freeze({ ...span, sourceSpan: move(span.sourceSpan) }));
    const media = row.media?.map((entry) => Object.freeze({
      ...entry,
      media: Object.freeze({ ...entry.media, sourceSpan: move(entry.media.sourceSpan) }),
    }));
    return Object.freeze({
      ...row,
      sourceOffset: row.sourceOffset + delta,
      spans: Object.freeze(inlineSpans),
      inlineSpans: Object.freeze(inlineSpans),
      ...(media === undefined ? {} : { media: Object.freeze(media) }),
    });
  });
  return Object.freeze({
    ...block,
    sourceSpan: move(block.sourceSpan),
    rows: Object.freeze(rows)
  });
}
