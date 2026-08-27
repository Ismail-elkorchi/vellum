import type {
  MarkdownFrontMatterMappingEntry,
  MarkdownFrontMatterValue,
  SourceSpan
} from 'markspan';

export interface FrontMatterPreviewRow {
  readonly key: string;
  readonly value: string;
  readonly keySpan: SourceSpan;
  readonly valueSpan: SourceSpan;
}

export function frontMatterPreviewRows(
  value: MarkdownFrontMatterValue | null
): readonly FrontMatterPreviewRow[] {
  if (value === null) return Object.freeze([]);
  if (value.kind !== 'mapping') {
    return Object.freeze([Object.freeze({
      key: 'value',
      value: frontMatterValueText(value),
      keySpan: value.span,
      valueSpan: value.span
    })]);
  }
  return Object.freeze(value.entries.map(previewRow));
}

function previewRow(entry: MarkdownFrontMatterMappingEntry): FrontMatterPreviewRow {
  return Object.freeze({
    key: entry.key,
    value: frontMatterValueText(entry.value),
    keySpan: entry.keySpan,
    valueSpan: entry.valueSpan
  });
}

function frontMatterValueText(value: MarkdownFrontMatterValue): string {
  switch (value.kind) {
    case 'scalar':
      return value.value === null ? 'null' : String(value.value);
    case 'sequence':
      return `[${value.items.map(frontMatterValueText).join(', ')}]`;
    case 'mapping':
      return `{${value.entries.map((entry) => `${entry.key}: ${frontMatterValueText(entry.value)}`).join(', ')}}`;
  }
}
