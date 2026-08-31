import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type {
  BufferState,
  ProjectIndexState,
  VellumDiagnostic,
  VellumDiagnosticFix
} from '../app/types.js';
import { walkMarkdown } from 'markspan';
import type { ExportProfile } from '../export/profiles.js';

export interface DiagnosticProvider {
  readonly id: VellumDiagnostic['source'];
  diagnose(buffer: BufferState, index: ProjectIndexState, revision: number, signal?: AbortSignal): Promise<readonly VellumDiagnostic[]>;
}

export interface LanguageToolProviderOptions {
  readonly endpoint: URL;
  readonly language: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class WordDictionary {
  readonly #words: Set<string>;

  private constructor(words: ReadonlySet<string>) {
    this.#words = new Set(words);
  }

  static fromWords(words: readonly string[]): WordDictionary {
    return new WordDictionary(new Set(words.map(normalizeWord)));
  }

  static async read(dictionaryPath: string, personalWords: readonly string[] = []): Promise<WordDictionary> {
    const source = await readFile(dictionaryPath, 'utf8');
    const lines = source.split(/\r?\n/u);
    const start = /^\d+$/u.test(lines[0] ?? '') ? 1 : 0;
    const words = new Set(personalWords.map(normalizeWord));
    for (const line of lines.slice(start)) {
      const word = line.trim().split('/')[0];
      if (word !== undefined && word.length > 0) words.add(normalizeWord(word));
    }
    return new WordDictionary(words);
  }

  contains(word: string): boolean {
    return this.#words.has(normalizeWord(word));
  }

  add(word: string): boolean {
    const normalized = normalizeWord(word.trim());
    if (normalized.length === 0 || this.#words.has(normalized)) return false;
    this.#words.add(normalized);
    return true;
  }
}

export async function addPersonalDictionaryWord(filePath: string, dictionary: WordDictionary, word: string): Promise<boolean> {
  const candidate = word.trim();
  if (candidate.length === 0 || dictionary.contains(candidate)) return false;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${candidate}\n`, { encoding: 'utf8', mode: 0o600 });
  return dictionary.add(candidate);
}

export function builtInDiagnosticProviders(dictionary?: WordDictionary): readonly DiagnosticProvider[] {
  return Object.freeze([
    markdownProvider,
    linkProvider,
    ...(dictionary === undefined ? [] : [spellingProvider(dictionary)])
  ]);
}

export function exportDiagnosticProvider(profiles: readonly ExportProfile[]): DiagnosticProvider {
  return Object.freeze({
    id: 'export' as const,
    async diagnose(buffer: BufferState, _index: ProjectIndexState, revision: number) {
      if (buffer.preview.kind !== 'ready') return Object.freeze([]);
      const diagnostics: VellumDiagnostic[] = [];
      for (const { node } of walkMarkdown(buffer.preview.snapshot.document.tree)) {
        let required: string | undefined;
        let label: string | undefined;
        if (node.kind === 'frontMatter') {
          required = 'yaml_metadata_block';
          label = 'front matter';
        } else if (node.kind === 'table') {
          required = 'pipe_tables';
          label = 'pipe table';
        } else if (node.kind === 'footnoteDefinition' || node.kind === 'footnoteReference') {
          required = 'footnotes';
          label = 'footnote';
        } else if (node.kind === 'mathBlock' || node.kind === 'mathInline') {
          required = 'tex_math_dollars';
          label = 'math';
        }
        if (required !== undefined && profiles.some((profile) => !profile.reader.extensions.includes(required))) {
          diagnostics.push(diagnostic(
            `export-${required}-${String(node.span.start)}`,
            'export',
            'warning',
            node.span.start,
            node.span.end,
            `At least one export profile does not enable ${required}; ${label ?? 'syntax'} may differ from preview.`,
            revision,
            Object.freeze([]),
            `export.reader.${required}`
          ));
        }
        if ((node.kind === 'callout' || node.kind === 'codeBlock' && node.language?.trim().toLowerCase() === 'mermaid')
          && profiles.some((profile) => profile.filters.length === 0)) {
          const syntax = node.kind === 'callout' ? 'callout' : 'Mermaid diagram';
          diagnostics.push(diagnostic(
            `export-filter-${String(node.span.start)}`,
            'export',
            'info',
            node.span.start,
            node.span.end,
            `${syntax} export requires a profile filter for presentation equivalent to preview.`,
            revision,
            Object.freeze([]),
            `export.filter.${node.kind === 'callout' ? 'callout' : 'mermaid'}`
          ));
        }
      }
      return Object.freeze(diagnostics);
    }
  });
}

export function languageToolProvider(options: LanguageToolProviderOptions): DiagnosticProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (fetchImplementation === undefined) throw new Error('LanguageTool requires a fetch implementation.');
  return Object.freeze({
    id: 'grammar' as const,
    async diagnose(
      buffer: BufferState,
      _index: ProjectIndexState,
      revision: number,
      signal?: AbortSignal
    ) {
      const source = textDocumentText(buffer.editor.document);
      const body = new URLSearchParams({
        language: options.language,
        text: source
      });
      const response = await fetchImplementation(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        ...(signal === undefined ? {} : { signal })
      });
      if (!response.ok) throw new Error(`LanguageTool returned HTTP ${String(response.status)}.`);
      const value = await response.json() as { matches?: unknown };
      if (!Array.isArray(value.matches)) throw new Error('LanguageTool returned an invalid response.');
      return Object.freeze(value.matches.flatMap((candidate, index) => {
        if (candidate === null || typeof candidate !== 'object') return [];
        const match = candidate as Record<string, unknown>;
        if (!Number.isSafeInteger(match['offset']) || !Number.isSafeInteger(match['length']) || typeof match['message'] !== 'string') return [];
        const start = Number(match['offset']);
        const end = start + Number(match['length']);
        if (start < 0 || end < start || end > source.length) return [];
        const replacements = Array.isArray(match['replacements']) ? match['replacements'] : [];
        const fixes: VellumDiagnosticFix[] = replacements.slice(0, 5).flatMap((replacement) => (
          replacement !== null && typeof replacement === 'object' && typeof (replacement as Record<string, unknown>)['value'] === 'string'
            ? [Object.freeze({
                label: `Replace with ${(replacement as Record<string, unknown>)['value'] as string}`,
                replacement: (replacement as Record<string, unknown>)['value'] as string,
                span: Object.freeze({ start, end })
              })]
            : []
        ));
        const rule = match['rule'] !== null && typeof match['rule'] === 'object' && typeof (match['rule'] as Record<string, unknown>)['id'] === 'string'
          ? `grammar.${(match['rule'] as Record<string, unknown>)['id'] as string}`
          : 'grammar.languageTool';
        return [diagnostic(`grammar-${String(index)}-${String(start)}`, 'grammar', 'warning', start, end, match['message'], revision, fixes, rule)];
      }));
    }
  });
}

export async function collectDiagnostics(
  buffer: BufferState,
  index: ProjectIndexState,
  providers: readonly DiagnosticProvider[],
  signal?: AbortSignal
): Promise<readonly VellumDiagnostic[]> {
  const revision = buffer.sourceRevision;
  const parserDiagnostics = buffer.preview.kind === 'ready'
    ? buffer.preview.snapshot.document.diagnostics.map((value, itemIndex) => diagnostic(
        `parser-${value.code}-${String(itemIndex)}-${String(value.span.start)}`,
        'parser',
        value.severity,
        value.span.start,
        value.span.end,
        value.message,
        revision,
        Object.freeze([]),
        `parser.${value.code}`
      ))
    : [];
  const supplied = await Promise.all(providers.map((provider) => provider.diagnose(buffer, index, revision, signal)));
  signal?.throwIfAborted();
  return Object.freeze([...parserDiagnostics, ...supplied.flat()].toSorted((left, right) => (
    left.span.start - right.span.start || left.span.end - right.span.end || left.id.localeCompare(right.id)
  )));
}

const markdownProvider: DiagnosticProvider = Object.freeze({
  id: 'markdown' as const,
  async diagnose(buffer: BufferState, _index: ProjectIndexState, revision: number) {
    const source = textDocumentText(buffer.editor.document);
    const diagnostics: VellumDiagnostic[] = [];
    for (const match of source.matchAll(/[\t ]+$/gmu)) {
      const start = match.index;
      const end = start + match[0].length;
      diagnostics.push(diagnostic(
        `markdown-trailing-${String(start)}`,
        'markdown',
        'info',
        start,
        end,
        'Trailing whitespace.',
        revision,
        [Object.freeze({ label: 'Remove trailing whitespace', replacement: '', span: Object.freeze({ start, end }) })],
        'markdown.trailingWhitespace'
      ));
    }
    for (const match of source.matchAll(/\b([\p{L}\p{N}_]+)(\s+)\1\b/gimu)) {
      const repeated = match[1] ?? '';
      const start = match.index + repeated.length;
      const end = match.index + match[0].length;
      diagnostics.push(diagnostic(
        `markdown-repeated-${String(start)}`,
        'markdown',
        'warning',
        start,
        end,
        `Repeated word “${repeated}”.`,
        revision,
        [Object.freeze({ label: 'Remove repeated word', replacement: '', span: Object.freeze({ start, end }) })],
        'markdown.repeatedWord'
      ));
    }
    return Object.freeze(diagnostics);
  }
});

const linkProvider: DiagnosticProvider = Object.freeze({
  id: 'links' as const,
  async diagnose(
    buffer: BufferState,
    index: ProjectIndexState,
    revision: number,
    signal?: AbortSignal
  ) {
    if (buffer.path === undefined) return Object.freeze([]);
    const document = index.documents[buffer.path];
    if (document === undefined) return Object.freeze([]);
    const diagnostics: VellumDiagnostic[] = [];
    for (const link of document.links) {
      signal?.throwIfAborted();
      const parsed = localDestination(link.destination);
      if (parsed === undefined) continue;
      const target = path.resolve(path.dirname(buffer.path), parsed.path);
      const resolved = await resolveLocalTarget(target, index);
      if (resolved === undefined) {
        const source = markdownExtension(parsed.path) ? 'links' : 'assets';
        diagnostics.push(diagnostic(
          `${source}-missing-${String(link.sourceSpan.start)}`,
          source,
          'error',
          link.sourceSpan.start,
          link.sourceSpan.end,
          `${source === 'links' ? 'Linked document' : 'Local asset'} does not exist: ${parsed.path}`,
          revision,
          Object.freeze([]),
          `${source}.missing`
        ));
      } else if (parsed.fragment.length > 0 && markdownExtension(resolved)) {
        const heading = parsed.fragment.slice(1).replaceAll('-', ' ').toLowerCase();
        const targetDocument = index.documents[resolved];
        if (targetDocument !== undefined && !targetDocument.headings.some((entry: ProjectIndexState['documents'][string]['headings'][number]) => (
          entry.text.toLowerCase() === heading || slug(entry.text) === parsed.fragment.slice(1).toLowerCase()
        ))) {
          diagnostics.push(diagnostic(
            `links-heading-${String(link.sourceSpan.start)}`,
            'links',
            'warning',
            link.sourceSpan.start,
            link.sourceSpan.end,
            `Linked heading does not exist: ${parsed.fragment}`,
            revision,
            Object.freeze([]),
            'links.missingHeading'
          ));
        }
      }
    }
    return Object.freeze(diagnostics);
  }
});

function spellingProvider(dictionary: WordDictionary): DiagnosticProvider {
  return Object.freeze({
    id: 'spelling' as const,
    async diagnose(buffer: BufferState, _index: ProjectIndexState, revision: number) {
      const source = textDocumentText(buffer.editor.document);
      if (buffer.preview.kind !== 'ready') return Object.freeze([]);
      const diagnostics: VellumDiagnostic[] = [];
      let index = 0;
      for (const { node } of walkMarkdown(buffer.preview.snapshot.document.tree)) {
        if (node.kind !== 'text') continue;
        const text = source.slice(node.span.start, node.span.end);
        for (const match of text.matchAll(/[\p{L}][\p{L}\p{M}'’-]*/gu)) {
          const word = match[0];
          if (word.length <= 1 || dictionary.contains(word)) continue;
          const start = node.span.start + match.index;
          diagnostics.push(diagnostic(
            `spelling-${String(index++)}-${String(start)}`,
            'spelling',
            'info',
            start,
            start + word.length,
            `Unknown word: ${word}`,
            revision,
            Object.freeze([]),
            'spelling.unknownWord'
          ));
        }
      }
      return Object.freeze(diagnostics);
    }
  });
}

function diagnostic(
  id: string,
  source: VellumDiagnostic['source'],
  severity: VellumDiagnostic['severity'],
  start: number,
  end: number,
  message: string,
  providerRevision: number,
  fixes: readonly VellumDiagnosticFix[] = Object.freeze([]),
  rule = `${source}.general`
): VellumDiagnostic {
  return Object.freeze({
    id,
    source,
    severity,
    span: Object.freeze({ start, end }),
    message,
    providerRevision,
    rule,
    fixes: Object.freeze([...fixes])
  });
}

function localDestination(destination: string): { readonly path: string; readonly fragment: string } | undefined {
  if (destination.length === 0 || destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) return undefined;
  const hash = destination.indexOf('#');
  try {
    return Object.freeze({
      path: decodeURIComponent(hash < 0 ? destination : destination.slice(0, hash)),
      fragment: hash < 0 ? '' : `#${decodeURIComponent(destination.slice(hash + 1))}`
    });
  } catch {
    return undefined;
  }
}

async function resolveLocalTarget(target: string, index: ProjectIndexState): Promise<string | undefined> {
  const candidates = markdownExtension(target)
    ? [target]
    : [target, `${target}.md`, `${target}.markdown`, path.join(target, 'README.md')];
  for (const candidate of candidates) {
    if (index.documents[candidate] !== undefined) return candidate;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
  }
  return undefined;
}

function markdownExtension(filePath: string): boolean {
  return ['.md', '.markdown', '.mdown', '.mkd'].includes(path.extname(filePath).toLowerCase());
}

function normalizeWord(word: string): string {
  return word.normalize('NFC').toLocaleLowerCase();
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/gu, '-');
}
