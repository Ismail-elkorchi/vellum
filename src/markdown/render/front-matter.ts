import type {
  MarkdownFrontMatterMappingEntry,
  MarkdownFrontMatterValue,
  SourceSpan
} from 'markspan';

export interface FrontMatterPreviewRow {
  readonly text: string;
  readonly sourceSpan: SourceSpan;
}

/** Produces a readable, structurally indented view of parsed YAML front matter. */
export function frontMatterPreviewRows(
  value: MarkdownFrontMatterValue | null
): readonly FrontMatterPreviewRow[] {
  if (value === null) return Object.freeze([]);
  const rows: FrontMatterPreviewRow[] = [];
  if (value.kind === 'mapping') {
    appendMapping(rows, value.entries, 0);
  } else {
    appendValue(rows, value, 0, 'value:');
  }
  return Object.freeze(rows);
}

function appendMapping(
  rows: FrontMatterPreviewRow[],
  entries: readonly MarkdownFrontMatterMappingEntry[],
  depth: number,
): void {
  for (const entry of entries) {
    if (entry.value.kind === 'scalar') {
      rows.push(row(`${indent(depth)}${entry.key}: ${scalarText(entry.value.value)}`, {
        start: entry.keySpan.start,
        end: entry.valueSpan.end,
      }));
    } else {
      rows.push(row(`${indent(depth)}${entry.key}:`, entry.keySpan));
      appendValue(rows, entry.value, depth + 1);
    }
  }
}

function appendValue(
  rows: FrontMatterPreviewRow[],
  value: MarkdownFrontMatterValue,
  depth: number,
  prefix?: string,
): void {
  if (value.kind === 'scalar') {
    rows.push(row(`${indent(depth)}${prefix === undefined ? '' : `${prefix} `}${scalarText(value.value)}`, value.span));
    return;
  }
  if (prefix !== undefined) rows.push(row(`${indent(depth)}${prefix}`, value.span));
  if (value.kind === 'mapping') {
    appendMapping(rows, value.entries, prefix === undefined ? depth : depth + 1);
    return;
  }
  const itemDepth = prefix === undefined ? depth : depth + 1;
  for (const item of value.items) {
    if (item.kind === 'scalar') {
      rows.push(row(`${indent(itemDepth)}- ${scalarText(item.value)}`, item.span));
    } else {
      rows.push(row(`${indent(itemDepth)}-`, item.span));
      appendValue(rows, item, itemDepth + 1);
    }
  }
}

function row(text: string, sourceSpan: SourceSpan): FrontMatterPreviewRow {
  return Object.freeze({ text, sourceSpan: Object.freeze(sourceSpan) });
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? 'null' : String(value);
}

function indent(depth: number): string {
  return '  '.repeat(Math.max(0, depth));
}
