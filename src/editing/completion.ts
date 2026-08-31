import path from 'node:path';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type { BufferState, ProjectIndexState } from '../app/types.js';

export interface MarkdownCompletion {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly replacement: string;
  readonly range: { readonly start: number; readonly end: number };
}

const fenceLanguages = Object.freeze([
  'bash', 'css', 'html', 'javascript', 'json', 'markdown', 'python', 'rust', 'shell', 'typescript', 'yaml'
]);
const calloutTypes = Object.freeze(['note', 'tip', 'important', 'warning', 'caution']);
const snippets = Object.freeze([
  Object.freeze({ label: 'frontmatter', replacement: '---\ntitle: \n---\n', detail: 'YAML front matter' }),
  Object.freeze({ label: 'table', replacement: '| Column | Column |\n| --- | --- |\n| Value | Value |', detail: 'Markdown table' }),
  Object.freeze({ label: 'task', replacement: '- [ ] ', detail: 'Task list item' }),
  Object.freeze({ label: 'callout', replacement: '> [!NOTE]\n> ', detail: 'Note callout' })
]);

export function markdownCompletions(
  buffer: BufferState,
  index: ProjectIndexState
): readonly MarkdownCompletion[] {
  const source = textDocumentText(buffer.editor.document);
  const caret = buffer.editor.caret.position.offset;
  const lineStart = source.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const before = source.slice(lineStart, caret);
  const fence = /^\s*```([\w-]*)$/u.exec(before);
  if (fence !== null) {
    const query = fence[1] ?? '';
    return completions(fenceLanguages, query, caret - query.length, caret, 'Code fence language');
  }
  const callout = /\[!([\w-]*)$/u.exec(before);
  if (callout !== null) {
    const query = callout[1] ?? '';
    return completions(calloutTypes, query, caret - query.length, caret, 'Callout type');
  }
  const destination = /(!?)\[[^\]]*\]\(([^)\s]*)$/u.exec(before);
  if (destination !== null) {
    const image = destination[1] === '!';
    const query = destination[2] ?? '';
    const hash = query.indexOf('#');
    if (hash >= 0) {
      const documentPath = resolveDocumentPath(buffer, query.slice(0, hash), index);
      const headings = documentPath === undefined ? [] : index.documents[documentPath]?.headings ?? [];
      const headingQuery = query.slice(hash + 1);
      return completions(
        headings.map((heading) => heading.text),
        headingQuery,
        caret - headingQuery.length,
        caret,
        'Document heading',
        (value) => slug(value)
      );
    }
    const root = commonRoot(index);
    const base = buffer.path === undefined ? root : path.dirname(buffer.path);
    const candidates = image ? index.assetPaths : index.orderedPaths;
    const files = candidates.map((filePath) => (
      base === undefined ? index.documents[filePath]?.relativePath ?? filePath : path.relative(base, filePath).split(path.sep).join('/')
    ));
    return completions(files, query, caret - query.length, caret, image ? 'Image asset' : 'Markdown document');
  }
  const reference = /\]\[([^\]]*)$/u.exec(before);
  if (reference !== null) {
    const query = reference[1] ?? '';
    const labels = Object.values(index.documents).flatMap((document) => (
      [...document.searchableText.matchAll(/^\[([^\]^]+)\]:/gmu)].map((match) => match[1] ?? '')
    ));
    return completions(labels, query, caret - query.length, caret, 'Reference-link definition');
  }
  const footnote = /\[\^([^\]]*)$/u.exec(before);
  if (footnote !== null) {
    const query = footnote[1] ?? '';
    const labels = [...source.matchAll(/^\[\^([^\]]+)\]:/gmu)].map((match) => match[1] ?? '');
    return completions(labels, query, caret - query.length, caret, 'Footnote definition');
  }
  const frontMatterEnd = Math.max(source.indexOf('\n---', 3), source.indexOf('\n...', 3));
  if (source.startsWith('---') && caret <= (frontMatterEnd < 0 ? source.length : frontMatterEnd)) {
    const key = /^\s*([\w-]*)$/u.exec(before)?.[1];
    if (key !== undefined) {
      const keys = [...new Set(Object.values(index.documents).flatMap((document) => Object.keys(document.properties)))];
      return completions(keys, key, caret - key.length, caret, 'Front-matter property', (value) => `${value}: `);
    }
  }
  const tag = /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u.exec(before);
  if (tag !== null) {
    const query = tag[1] ?? '';
    return completions(
      Object.values(index.documents).flatMap((document) => document.tags),
      query,
      caret - query.length,
      caret,
      'Project tag'
    );
  }
  const citation = /\[@([A-Za-z0-9_:.#$%&+?<>~/\\-]*)$/u.exec(before);
  if (citation !== null) {
    const query = citation[1] ?? '';
    return completions(
      Object.values(index.documents).flatMap((document) => document.citationKeys),
      query,
      caret - query.length,
      caret,
      'Citation key'
    );
  }
  const snippet = /^\s*::([\w-]*)$/u.exec(before);
  if (snippet !== null) {
    const query = snippet[1] ?? '';
    const start = caret - query.length - 2;
    return Object.freeze(snippets.filter((entry) => entry.label.includes(query.toLowerCase())).map((entry, index) => Object.freeze({
      id: `snippet-${String(index)}`,
      label: entry.label,
      detail: entry.detail,
      replacement: entry.replacement,
      range: Object.freeze({ start, end: caret })
    })));
  }
  return Object.freeze([]);
}

function completions(
  values: readonly string[],
  query: string,
  start: number,
  end: number,
  detail: string,
  replacement: (value: string) => string = (value) => value
): readonly MarkdownCompletion[] {
  const normalized = query.toLowerCase();
  return Object.freeze([...new Set(values)]
    .filter((value) => normalized.length === 0 || value.toLowerCase().includes(normalized))
    .toSorted((left, right) => {
      const leftPrefix = left.toLowerCase().startsWith(normalized) ? 0 : 1;
      const rightPrefix = right.toLowerCase().startsWith(normalized) ? 0 : 1;
      return leftPrefix - rightPrefix || left.localeCompare(right);
    })
    .slice(0, 100)
    .map((value, index) => Object.freeze({
      id: `completion-${String(index)}`,
      label: value,
      detail,
      replacement: replacement(value),
      range: Object.freeze({ start, end })
    })));
}

function resolveDocumentPath(
  buffer: BufferState,
  destination: string,
  index: ProjectIndexState
): string | undefined {
  if (destination.length === 0) return buffer.path;
  const base = buffer.path === undefined ? commonRoot(index) : path.dirname(buffer.path);
  if (base === undefined) return undefined;
  const exact = path.resolve(base, destination);
  if (index.documents[exact] !== undefined) return exact;
  return index.orderedPaths.find((candidate) => candidate === `${exact}.md` || candidate === path.join(exact, 'README.md'));
}

function commonRoot(index: ProjectIndexState): string | undefined {
  const first = index.orderedPaths[0];
  if (first === undefined) return undefined;
  const relative = index.documents[first]?.relativePath;
  return relative === undefined ? path.dirname(first) : first.slice(0, Math.max(0, first.length - relative.length)).replace(/[\\/]$/u, '');
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/gu, '-');
}
