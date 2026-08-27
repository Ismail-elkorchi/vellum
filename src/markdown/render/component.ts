import type { AccessibleNode, AccessibleRole } from '@ismail-elkorchi/terminal-ui/accessibility';
import {
  defineSemanticLeafComponent,
  ignoreMessage,
  type SemanticLeafComponentFactory,
} from '@ismail-elkorchi/terminal-ui/component';
import type { RoutedPointerEvent } from '@ismail-elkorchi/terminal-ui/input';
import {
  measureTextCells,
  textWidthProfileKey,
  type TextWidthProfile,
} from '@ismail-elkorchi/terminal-ui/text';
import { mergeTerminalStyles } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownAccessibleNode, MarkdownAccessibleRole } from './accessibility.js';
import type { MarkdownRenderSpan } from './inline.js';
import type {
  MarkdownPreviewActionFragment,
  MarkdownPreviewActivation,
  MarkdownPreviewLayout,
} from './layout.js';

export interface MarkdownPreviewOptions {
  readonly label: string;
  readonly layout: MarkdownPreviewLayout;
}

export interface MarkdownPreviewAction {
  readonly kind: 'activate';
  readonly target: MarkdownPreviewActivation;
}

interface PreviewTargetFragment {
  readonly target: MarkdownPreviewActionFragment;
  readonly bounds: { readonly row: number; readonly column: number; readonly width: number; readonly height: 1 };
}

interface PreviewTargetGeometry {
  readonly id: string;
  readonly target: MarkdownPreviewActionFragment;
  readonly bounds: { readonly row: number; readonly column: number; readonly width: number; readonly height: number };
  readonly fragments: readonly PreviewTargetFragment[];
}

const previewTargetCache = new WeakMap<MarkdownPreviewLayout, readonly PreviewTargetGeometry[]>();

/** Resolves a rendered preview cell against the exact layout that produced it. */
export function markdownPreviewActivationAt(
  layout: MarkdownPreviewLayout,
  row: number,
  column: number,
): MarkdownPreviewActivation | undefined {
  const normalizedRow = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(row)));
  const line = layout.lines[normalizedRow];
  if (line === undefined) return undefined;
  const normalizedColumn = Math.max(0, Math.floor(column));
  let consumed = 0;
  for (const span of line.inlineSpans) {
    const next = consumed + measureTextCells(span.text, { widthProfile: layout.widthProfile }).cells;
    if (normalizedColumn < next) return previewActivation(layout, normalizedRow, line.sourceOffset, span);
    consumed = next;
  }
  const span = line.inlineSpans.at(-1);
  return span === undefined
    ? undefined
    : previewActivation(layout, normalizedRow, line.sourceOffset, span);
}

export const markdownPreview: SemanticLeafComponentFactory<
  MarkdownPreviewOptions,
  MarkdownPreviewAction
> = defineSemanticLeafComponent<
  MarkdownPreviewOptions,
  MarkdownPreviewOptions,
  MarkdownPreviewAction
>({
  name: 'vellum/components/markdown-preview',
  identity: 'required',
  accessibleRole: 'document',
  measure: ({ model, widthProfile }) => {
    assertActiveWidthProfile(model.layout, widthProfile);
    return {
      minWidth: 0,
      minHeight: 0,
      preferredWidth: model.layout.width,
      preferredHeight: model.layout.lines.length,
    };
  },
  render: ({ model, target, viewport, focusedTargetId, widthProfile }) => {
    assertActiveWidthProfile(model.layout, widthProfile);
    const end = Math.min(model.layout.lines.length, viewport.row + viewport.height);
    for (let row = viewport.row; row < end; row += 1) {
      const line = model.layout.lines[row];
      if (line === undefined) continue;
      const inlineSpans = focusedTargetId === undefined
        ? line.inlineSpans
        : Object.freeze(line.inlineSpans.map((span) => (
            span.activation === undefined
              || previewTargetId(span.activation.nodeId) !== focusedTargetId
              ? span
              : focusedPreviewSpan(span)
          )));
      target.writeLine(row, 0, inlineSpans === line.inlineSpans
        ? line
        : { spans: inlineSpans });
    }
  },
  keys: ({ model, focusedTargetId }) => {
    const focused = focusedTargetId === undefined
      ? undefined
      : previewTargetGeometry(model.layout).find((target) => target.id === focusedTargetId);
    return focused === undefined
      ? {}
      : { enter: () => ({ kind: 'activate', target: focused.target }) };
  },
  focusTargets: ({ model }) => previewTargetGeometry(model.layout).map((target) => ({
    id: target.id,
    bounds: target.bounds,
  })),
  hitTargets(input) {
    if (input.viewport.width === 0 || input.viewport.height === 0) return [];
    const contentTarget = {
      id: `${input.id ?? 'markdown-preview'}:content`,
      bounds: input.viewport,
      accepts: ['click'],
      message(event: RoutedPointerEvent) {
        if (event.button !== 'left') return ignoreMessage();
        const target = markdownPreviewActivationAt(
          input.model.layout,
          input.viewport.row + (event.localRow ?? 0),
          input.viewport.column + (event.localColumn ?? 0),
        );
        return target === undefined ? ignoreMessage() : { kind: 'activate' as const, target };
      },
    } as const;
    const actionTargets = previewTargetGeometry(input.model.layout).flatMap((target) => (
      target.fragments.map((fragment, index) => ({
        id: `${input.id ?? 'markdown-preview'}:${target.id}:${String(index)}`,
        bounds: fragment.bounds,
        accepts: ['click', 'pointerDown'] as const,
        cursor: 'pointer' as const,
        focus: { kind: 'target' as const, targetId: target.id },
        zIndex: 1,
        message(event: RoutedPointerEvent) {
          return event.kind !== 'click' || event.button !== 'left'
            ? ignoreMessage()
            : { kind: 'activate' as const, target: fragment.target };
        },
      }))
    ));
    return [contentTarget, ...actionTargets];
  },
  accessibility: ({ id, model, focusedTargetId }) => accessiblePreviewNode(
    model.layout.accessibility,
    id,
    model.label,
    true,
    focusedTargetId,
  ),
});

function previewTargetGeometry(layout: MarkdownPreviewLayout): readonly PreviewTargetGeometry[] {
  const cached = previewTargetCache.get(layout);
  if (cached !== undefined) return cached;
  const grouped = new Map<string, PreviewTargetFragment[]>();
  for (const target of layout.activations) {
    const fragments = grouped.get(target.id) ?? [];
    fragments.push(Object.freeze({
      target,
      bounds: Object.freeze({
        row: target.row,
        column: target.column,
        width: target.width,
        height: 1 as const,
      }),
    }));
    grouped.set(target.id, fragments);
  }
  const created = Object.freeze([...grouped.entries()].map(([id, fragments]) => {
    const first = fragments[0];
    if (first === undefined) throw new TypeError('Markdown preview target geometry requires a fragment.');
    return Object.freeze({
      id,
      target: first.target,
      bounds: unionFragments(fragments),
      fragments: Object.freeze(fragments),
    });
  }));
  previewTargetCache.set(layout, created);
  return created;
}

function unionFragments(
  fragments: readonly PreviewTargetFragment[],
): PreviewTargetGeometry['bounds'] {
  const first = fragments[0];
  if (first === undefined) return Object.freeze({ row: 0, column: 0, width: 0, height: 0 });
  let top = first.bounds.row;
  let left = first.bounds.column;
  let bottom = first.bounds.row + first.bounds.height;
  let right = first.bounds.column + first.bounds.width;
  for (const fragment of fragments.slice(1)) {
    top = Math.min(top, fragment.bounds.row);
    left = Math.min(left, fragment.bounds.column);
    bottom = Math.max(bottom, fragment.bounds.row + fragment.bounds.height);
    right = Math.max(right, fragment.bounds.column + fragment.bounds.width);
  }
  return Object.freeze({ row: top, column: left, width: right - left, height: bottom - top });
}

function previewTargetId(nodeId: number): string {
  return `markdown-${String(nodeId)}`;
}

function assertActiveWidthProfile(
  layout: MarkdownPreviewLayout,
  widthProfile: TextWidthProfile,
): void {
  if (textWidthProfileKey(layout.widthProfile) !== textWidthProfileKey(widthProfile)) {
    throw new TypeError('Markdown preview layout must use the active terminal text-width profile.');
  }
}

function focusedPreviewSpan(span: MarkdownRenderSpan): MarkdownRenderSpan {
  const style = mergeTerminalStyles(span.style, { inverse: true, bold: true });
  return Object.freeze({
    ...span,
    ...(style === undefined ? {} : { style }),
  });
}

function previewActivation(
  layout: MarkdownPreviewLayout,
  row: number,
  sourceOffset: number,
  span: MarkdownPreviewLayout['lines'][number]['inlineSpans'][number],
): MarkdownPreviewActivation {
  const sourceSpan = span.activation === undefined
    ? blockSourceSpanAt(layout, sourceOffset) ?? span.sourceSpan
    : span.sourceSpan;
  return Object.freeze({
    row,
    sourceSpan,
    ...(span.activation === undefined ? {} : { activation: span.activation }),
  });
}

function blockSourceSpanAt(
  layout: MarkdownPreviewLayout,
  sourceOffset: number
): MarkdownPreviewLayout['blocks'][number]['sourceSpan'] | undefined {
  let low = 0;
  let high = layout.blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((layout.blocks[middle]?.sourceSpan.start ?? Number.POSITIVE_INFINITY) <= sourceOffset) low = middle + 1;
    else high = middle;
  }
  const candidate = layout.blocks[Math.max(0, low - 1)];
  return candidate !== undefined && sourceOffset <= candidate.sourceSpan.end
    ? candidate.sourceSpan
    : undefined;
}

function accessiblePreviewNode(
  node: MarkdownAccessibleNode,
  rootId: string,
  rootLabel: string,
  root: boolean,
  focusedTargetId?: string,
): AccessibleNode {
  const role = accessibleRole(node.role);
  const id = root ? rootId : `${rootId}:${node.id}`;
  const children = node.children.map((child) => accessiblePreviewNode(
    child,
    rootId,
    rootLabel,
    false,
    focusedTargetId,
  ));
  const label = root ? rootLabel : node.label;
  return Object.freeze({
    id,
    role,
    ...(role === 'text' ? { value: label } : { label }),
    ...(!root && node.id === focusedTargetId ? { focused: true } : {}),
    ...(node.headingLevel === undefined ? {} : { position: { level: node.headingLevel } }),
    ...(node.checked === undefined ? {} : { checked: node.checked }),
    ...(children.length === 0 ? {} : { children: Object.freeze(children) }),
  });
}

function accessibleRole(role: MarkdownAccessibleRole): AccessibleRole {
  switch (role) {
    case 'document': return 'document';
    case 'heading': return 'heading';
    case 'link': return 'link';
    case 'image':
    case 'diagram': return 'image';
    case 'list': return 'list';
    case 'listItem': return 'listitem';
    case 'checkbox': return 'checkbox';
    case 'table': return 'table';
    case 'row': return 'row';
    case 'cell': return 'cell';
    case 'separator': return 'separator';
    case 'diagnostic': return 'status';
    case 'paragraph':
    case 'code':
    case 'math': return 'text';
    case 'blockquote':
    case 'note':
    case 'frontMatter':
    case 'footnote': return 'group';
  }
}
