import { createHash } from 'node:crypto';
import type { TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import { themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import type { HighlightedCode, HighlightToken } from './render/code.js';
import { BoundedLruMap } from '../cache/lru.js';

export interface CodeHighlightSettings {
  readonly rendererVersion: string;
  readonly cooperativeChunkCodeUnits: number;
  readonly maximumSourceCodeUnits: number;
  readonly maximumCacheEntries: number;
}

export interface CodeTokenizerContext {
  readonly signal: AbortSignal;
  checkpoint(offset: number): Promise<void>;
}

export interface CodeTokenizer {
  tokenize(source: string, context: CodeTokenizerContext): Promise<readonly HighlightToken[]>;
}

export interface CodeHighlightLanguage {
  readonly id: string;
  readonly aliases: readonly string[];
  load(): Promise<CodeTokenizer>;
}

export interface CodeHighlighter {
  highlight(language: string, source: string, signal?: AbortSignal): Promise<HighlightedCode | undefined>;
  stats(): { readonly cacheEntries: number; readonly loadedLanguages: number; readonly pending: number };
  clear(): void;
}

interface SharedHighlight {
  readonly controller: AbortController;
  readonly promise: Promise<HighlightedCode>;
  waiters: number;
  settled: boolean;
}

const defaultSettings: CodeHighlightSettings = Object.freeze({
  rendererVersion: 'vellum-lexer-1',
  cooperativeChunkCodeUnits: 4_096,
  maximumSourceCodeUnits: 2_000_000,
  maximumCacheEntries: 256
});

export function createCodeHighlighter(
  languages: readonly CodeHighlightLanguage[] = builtInCodeHighlightLanguages(),
  settings: Partial<CodeHighlightSettings> = {}
): CodeHighlighter {
  const resolvedSettings = resolveSettings(settings);
  const definitions = languageRegistry(languages);
  const loaded = new Map<string, Promise<CodeTokenizer>>();
  const cache = new BoundedLruMap<string, HighlightedCode>(resolvedSettings.maximumCacheEntries);
  const pending = new Map<string, SharedHighlight>();
  const settingsHash = createHash('sha256').update(JSON.stringify(resolvedSettings)).digest('hex');

  return Object.freeze({
    async highlight(language: string, source: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const definition = definitions.get(normalizeLanguageName(language));
      if (definition === undefined) return undefined;
      if (source.length > resolvedSettings.maximumSourceCodeUnits) {
        throw new RangeError(`Code block exceeds ${String(resolvedSettings.maximumSourceCodeUnits)} UTF-16 code units.`);
      }
      const sourceHash = await hashSource(source, signal, resolvedSettings.cooperativeChunkCodeUnits);
      const key = `${definition.id}\0${sourceHash}\0${resolvedSettings.rendererVersion}\0${settingsHash}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let shared = pending.get(key);
      if (shared?.controller.signal.aborted === true) {
        pending.delete(key);
        shared = undefined;
      }
      if (shared === undefined) {
        const controller = new AbortController();
        shared = {
          controller,
          waiters: 0,
          settled: false,
          promise: startHighlight(definition, source, sourceHash, controller.signal)
        };
        pending.set(key, shared);
        const active = shared;
        void active.promise.then((result) => {
          if (!controller.signal.aborted) cache.set(key, result);
        }).finally(() => {
          active.settled = true;
          if (pending.get(key) === active) pending.delete(key);
        }).catch(() => undefined);
      }
      shared.waiters += 1;
      try {
        return await waitForShared(shared.promise, signal);
      } finally {
        shared.waiters -= 1;
        if (shared.waiters === 0 && !shared.settled) shared.controller.abort();
      }
    },
    stats() {
      return Object.freeze({ cacheEntries: cache.size, loadedLanguages: loaded.size, pending: pending.size });
    },
    clear() {
      for (const request of pending.values()) request.controller.abort();
      pending.clear();
      cache.clear();
      loaded.clear();
    }
  });

  async function startHighlight(
    definition: CodeHighlightLanguage,
    source: string,
    sourceHash: string,
    signal: AbortSignal
  ): Promise<HighlightedCode> {
    let tokenizerPromise = loaded.get(definition.id);
    if (tokenizerPromise === undefined) {
      tokenizerPromise = definition.load();
      loaded.set(definition.id, tokenizerPromise);
      void tokenizerPromise.catch(() => {
        if (loaded.get(definition.id) === tokenizerPromise) loaded.delete(definition.id);
      });
    }
    const tokenizer = await tokenizerPromise;
    signal.throwIfAborted();
    const checkpoint = cooperativeCheckpoint(signal, resolvedSettings.cooperativeChunkCodeUnits);
    const tokens = await tokenizer.tokenize(source, { signal, checkpoint });
    signal.throwIfAborted();
    validateTokens(tokens, source.length, definition.id);
    return Object.freeze({
      language: definition.id,
      sourceHash,
      tokens: Object.freeze([...tokens])
    });
  }
}

export function builtInCodeHighlightLanguages(): readonly CodeHighlightLanguage[] {
  return Object.freeze([
    language('javascript', ['js', 'jsx', 'mjs', 'cjs'], () => cLikeTokenizer(javascriptKeywords, ['//'], ['/*', '*/'])),
    language('typescript', ['ts', 'tsx', 'mts', 'cts'], () => cLikeTokenizer(typescriptKeywords, ['//'], ['/*', '*/'])),
    language('json', ['jsonc'], () => jsonTokenizer()),
    language('shell', ['sh', 'bash', 'zsh'], () => shellTokenizer()),
    language('markdown', ['md', 'mdown'], () => markdownTokenizer()),
    language('python', ['py', 'pyw'], () => pythonTokenizer()),
    language('rust', ['rs'], () => cLikeTokenizer(rustKeywords, ['//'], ['/*', '*/'])),
    language('css', [], () => cssTokenizer()),
    language('html', ['htm'], () => htmlTokenizer()),
    language('yaml', ['yml'], () => yamlTokenizer())
  ]);
}

function language(
  id: string,
  aliases: readonly string[],
  create: () => CodeTokenizer
): CodeHighlightLanguage {
  return Object.freeze({
    id,
    aliases: Object.freeze([...aliases]),
    async load() {
      return create();
    }
  });
}

function languageRegistry(languages: readonly CodeHighlightLanguage[]): ReadonlyMap<string, CodeHighlightLanguage> {
  const registry = new Map<string, CodeHighlightLanguage>();
  for (const definition of languages) {
    const id = normalizeLanguageName(definition.id);
    if (id.length === 0) throw new TypeError('A code highlight language id cannot be empty.');
    const aliases = definition.aliases.map(normalizeLanguageName);
    const canonical: CodeHighlightLanguage = Object.freeze({
      id,
      aliases: Object.freeze(aliases),
      load: () => definition.load()
    });
    for (const name of [id, ...aliases]) {
      if (name.length === 0) throw new TypeError(`Code highlight language ${id} contains an empty alias.`);
      const existing = registry.get(name);
      if (existing !== undefined) {
        throw new Error(`Code highlight language name ${name} is claimed by both ${existing.id} and ${id}.`);
      }
      registry.set(name, canonical);
    }
  }
  return registry;
}

function normalizeLanguageName(value: string): string {
  return value.trim().toLowerCase();
}

function resolveSettings(settings: Partial<CodeHighlightSettings>): CodeHighlightSettings {
  const rendererVersion = settings.rendererVersion ?? defaultSettings.rendererVersion;
  const cooperativeChunkCodeUnits = settings.cooperativeChunkCodeUnits ?? defaultSettings.cooperativeChunkCodeUnits;
  const maximumSourceCodeUnits = settings.maximumSourceCodeUnits ?? defaultSettings.maximumSourceCodeUnits;
  const maximumCacheEntries = settings.maximumCacheEntries ?? defaultSettings.maximumCacheEntries;
  if (rendererVersion.trim().length === 0) throw new TypeError('Code highlighter rendererVersion cannot be empty.');
  if (!Number.isSafeInteger(cooperativeChunkCodeUnits) || cooperativeChunkCodeUnits < 256) {
    throw new RangeError('Code highlighter cooperativeChunkCodeUnits must be an integer of at least 256.');
  }
  if (!Number.isSafeInteger(maximumSourceCodeUnits) || maximumSourceCodeUnits < cooperativeChunkCodeUnits) {
    throw new RangeError('Code highlighter maximumSourceCodeUnits must be an integer no smaller than cooperativeChunkCodeUnits.');
  }
  if (!Number.isSafeInteger(maximumCacheEntries) || maximumCacheEntries < 1) {
    throw new RangeError('Code highlighter maximumCacheEntries must be a positive integer.');
  }
  return Object.freeze({ rendererVersion, cooperativeChunkCodeUnits, maximumSourceCodeUnits, maximumCacheEntries });
}

async function hashSource(source: string, signal: AbortSignal | undefined, chunkCodeUnits: number): Promise<string> {
  const hash = createHash('sha256');
  for (let start = 0; start < source.length; start += chunkCodeUnits) {
    signal?.throwIfAborted();
    const end = Math.min(source.length, start + chunkCodeUnits);
    hash.update(Buffer.from(source.slice(start, end), 'utf16le'));
    if (end < source.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}

function cooperativeCheckpoint(
  signal: AbortSignal,
  chunkCodeUnits: number
): (offset: number) => Promise<void> {
  let previousOffset = 0;
  let workSinceYield = 0;
  return async (offset) => {
    signal.throwIfAborted();
    workSinceYield += Math.max(1, offset >= previousOffset ? offset - previousOffset : 1);
    previousOffset = offset;
    if (workSinceYield < chunkCodeUnits) return;
    workSinceYield = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  };
}

async function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function validateTokens(tokens: readonly HighlightToken[], sourceLength: number, language: string): void {
  let previousEnd = 0;
  for (const entry of tokens) {
    if (!Number.isSafeInteger(entry.span.start)
      || !Number.isSafeInteger(entry.span.end)
      || entry.span.start < previousEnd
      || entry.span.end <= entry.span.start
      || entry.span.end > sourceLength) {
      throw new RangeError(`Code tokenizer ${language} returned invalid or overlapping token ranges.`);
    }
    previousEnd = entry.span.end;
  }
}

const keywordStyle: TerminalStyle = Object.freeze({ fg: themeColor('accent.primary'), bold: true });
const typeStyle: TerminalStyle = Object.freeze({ fg: themeColor('link.foreground') });
const stringStyle: TerminalStyle = Object.freeze({ fg: themeColor('status.success') });
const commentStyle: TerminalStyle = Object.freeze({ fg: themeColor('text.muted'), italic: true });
const numberStyle: TerminalStyle = Object.freeze({ fg: themeColor('status.warning') });
const propertyStyle: TerminalStyle = Object.freeze({ fg: themeColor('table.header') });
const operatorStyle: TerminalStyle = Object.freeze({ fg: themeColor('text.muted') });
const tagStyle: TerminalStyle = Object.freeze({ fg: themeColor('accent.primary'), bold: true });

function highlightToken(start: number, end: number, style: TerminalStyle): HighlightToken {
  return Object.freeze({ span: Object.freeze({ start, end }), style });
}

function cLikeTokenizer(
  keywords: ReadonlySet<string>,
  lineComments: readonly string[],
  blockComment: readonly [string, string]
): CodeTokenizer {
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      while (offset < source.length) {
        await context.checkpoint(offset);
        const lineComment = lineComments.find((marker) => source.startsWith(marker, offset));
        if (lineComment !== undefined) {
          const end = await lineEndCooperative(source, offset + lineComment.length, context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
          continue;
        }
        if (source.startsWith(blockComment[0], offset)) {
          const end = await delimitedEnd(source, offset, blockComment[1], context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
          continue;
        }
        const character = source[offset];
        if (character === "'" || character === '"' || character === '`') {
          const end = await quotedEnd(source, offset, character, context);
          tokens.push(highlightToken(offset, end, stringStyle));
          offset = end;
          continue;
        }
        if (isIdentifierStart(character)) {
          const end = await identifierEndCooperative(source, offset + 1, context);
          const value = source.slice(offset, end);
          if (keywords.has(value)) tokens.push(highlightToken(offset, end, keywordStyle));
          else if (/^[A-Z]/u.test(value)) tokens.push(highlightToken(offset, end, typeStyle));
          offset = end;
          continue;
        }
        if (isNumberStart(source, offset)) {
          const end = await numberEndCooperative(source, offset, context);
          tokens.push(highlightToken(offset, end, numberStyle));
          offset = end;
          continue;
        }
        if (/[{}()[\].,;:+\-*/%=&|!<>?~^]/u.test(character ?? '')) {
          tokens.push(highlightToken(offset, offset + 1, operatorStyle));
        }
        offset += 1;
      }
      return Object.freeze(tokens);
    }
  });
}

function jsonTokenizer(): CodeTokenizer {
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      while (offset < source.length) {
        await context.checkpoint(offset);
        const character = source[offset];
        if (source.startsWith('//', offset)) {
          const end = await lineEndCooperative(source, offset + 2, context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
        } else if (source.startsWith('/*', offset)) {
          const end = await delimitedEnd(source, offset, '*/', context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
        } else if (character === '"') {
          const end = await quotedEnd(source, offset, '"', context);
          let cursor = end;
          while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
          tokens.push(highlightToken(offset, end, source[cursor] === ':' ? propertyStyle : stringStyle));
          offset = end;
        } else if (isNumberStart(source, offset)) {
          const end = await numberEndCooperative(source, offset, context);
          tokens.push(highlightToken(offset, end, numberStyle));
          offset = end;
        } else {
          const literal = jsonLiteralAt(source, offset);
          if (literal !== undefined) {
            tokens.push(highlightToken(offset, offset + literal.length, keywordStyle));
            offset += literal.length;
          } else {
            if (/[{}[\],:]/u.test(character ?? '')) tokens.push(highlightToken(offset, offset + 1, operatorStyle));
            offset += 1;
          }
        }
      }
      return Object.freeze(tokens);
    }
  });
}

function shellTokenizer(): CodeTokenizer {
  const keywords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'in', 'do', 'done', 'case', 'esac', 'function', 'select', 'time']);
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      while (offset < source.length) {
        await context.checkpoint(offset);
        const character = source[offset];
        if (character === '#' && (offset === 0 || /[\s;]/u.test(source[offset - 1] ?? ''))) {
          const end = await lineEndCooperative(source, offset + 1, context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
        } else if (character === "'" || character === '"') {
          const end = await quotedEnd(source, offset, character, context);
          tokens.push(highlightToken(offset, end, stringStyle));
          offset = end;
        } else if (character === '$') {
          const closing = source[offset + 1] === '{'
            ? await closingCharacter(source, offset + 2, source.length, '}', context)
            : -1;
          const end = source[offset + 1] === '{'
            ? closing >= 0 ? closing + 1 : source.length
            : await identifierEndCooperative(source, offset + 1, context);
          tokens.push(highlightToken(offset, Math.max(offset + 1, end), propertyStyle));
          offset = Math.max(offset + 1, end);
        } else if (isIdentifierStart(character)) {
          const end = await identifierEndCooperative(source, offset + 1, context);
          if (keywords.has(source.slice(offset, end))) tokens.push(highlightToken(offset, end, keywordStyle));
          offset = end;
        } else {
          if (/[|&;()<>]/u.test(character ?? '')) tokens.push(highlightToken(offset, offset + 1, operatorStyle));
          offset += 1;
        }
      }
      return Object.freeze(tokens);
    }
  });
}

function markdownTokenizer(): CodeTokenizer {
  return lineOrientedTokenizer(async (source, start, end, tokens, context) => {
    await markdownLineTokens(source, start, end, tokens, context);
  });
}

function pythonTokenizer(): CodeTokenizer {
  const keywords = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield']);
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      while (offset < source.length) {
        await context.checkpoint(offset);
        const character = source[offset];
        if (character === '#') {
          const end = await lineEndCooperative(source, offset + 1, context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
        } else if ((character === "'" || character === '"') && source.slice(offset, offset + 3) === character.repeat(3)) {
          const end = await delimitedEnd(source, offset, character.repeat(3), context, 3);
          tokens.push(highlightToken(offset, end, stringStyle));
          offset = end;
        } else if (character === "'" || character === '"') {
          const end = await quotedEnd(source, offset, character, context);
          tokens.push(highlightToken(offset, end, stringStyle));
          offset = end;
        } else if (isIdentifierStart(character)) {
          const end = await identifierEndCooperative(source, offset + 1, context);
          const value = source.slice(offset, end);
          if (keywords.has(value)) tokens.push(highlightToken(offset, end, keywordStyle));
          else if (/^[A-Z]/u.test(value)) tokens.push(highlightToken(offset, end, typeStyle));
          offset = end;
        } else if (isNumberStart(source, offset)) {
          const end = await numberEndCooperative(source, offset, context);
          tokens.push(highlightToken(offset, end, numberStyle));
          offset = end;
        } else {
          if (/[{}()[\].,:;+\-*/%=&|!<>@]/u.test(character ?? '')) tokens.push(highlightToken(offset, offset + 1, operatorStyle));
          offset += 1;
        }
      }
      return Object.freeze(tokens);
    }
  });
}

function cssTokenizer(): CodeTokenizer {
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      let inBlock = false;
      while (offset < source.length) {
        await context.checkpoint(offset);
        if (source.startsWith('/*', offset)) {
          const end = await delimitedEnd(source, offset, '*/', context);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
          continue;
        }
        const character = source[offset];
        if (character === "'" || character === '"') {
          const end = await quotedEnd(source, offset, character, context);
          tokens.push(highlightToken(offset, end, stringStyle));
          offset = end;
        } else if (character === '{' || character === '}') {
          inBlock = character === '{';
          tokens.push(highlightToken(offset, offset + 1, operatorStyle));
          offset += 1;
        } else if (isIdentifierStart(character) || character === '-' || character === '#') {
          const end = await cssWordEndCooperative(source, offset + 1, context);
          let next = end;
          while (/\s/u.test(source[next] ?? '')) {
            next += 1;
            await context.checkpoint(next);
          }
          tokens.push(highlightToken(offset, end, inBlock && source[next] === ':' ? propertyStyle : tagStyle));
          offset = end;
        } else if (isNumberStart(source, offset)) {
          const end = await numberEndCooperative(source, offset, context);
          tokens.push(highlightToken(offset, end, numberStyle));
          offset = end;
        } else offset += 1;
      }
      return Object.freeze(tokens);
    }
  });
}

function htmlTokenizer(): CodeTokenizer {
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let offset = 0;
      while (offset < source.length) {
        await context.checkpoint(offset);
        if (source.startsWith('<!--', offset)) {
          const end = await delimitedEnd(source, offset, '-->', context, 4);
          tokens.push(highlightToken(offset, end, commentStyle));
          offset = end;
          continue;
        }
        if (source[offset] !== '<') {
          offset += 1;
          continue;
        }
        const end = await delimitedEnd(source, offset, '>', context, 1);
        let cursor = offset + (source[offset + 1] === '/' ? 2 : 1);
        const nameEnd = await identifierEndCooperative(source, cursor, context);
        if (nameEnd > cursor) tokens.push(highlightToken(cursor, nameEnd, tagStyle));
        cursor = nameEnd;
        while (cursor < end - 1) {
          if (/\s/u.test(source[cursor] ?? '')) {
            cursor += 1;
            continue;
          }
          const attributeEnd = await identifierEndCooperative(source, cursor, context);
          if (attributeEnd > cursor) tokens.push(highlightToken(cursor, attributeEnd, propertyStyle));
          cursor = Math.max(cursor + 1, attributeEnd);
          while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
          if (source[cursor] === '=') cursor += 1;
          while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
          if (source[cursor] === '"' || source[cursor] === "'") {
            const stringEnd = await quotedEnd(source, cursor, source[cursor] as '"' | "'", context);
            tokens.push(highlightToken(cursor, Math.min(stringEnd, end), stringStyle));
            cursor = stringEnd;
          }
        }
        offset = end;
      }
      return Object.freeze(tokens.sort((left, right) => left.span.start - right.span.start));
    }
  });
}

function yamlTokenizer(): CodeTokenizer {
  return lineOrientedTokenizer(async (source, start, end, tokens, context) => {
    await yamlLineTokens(source, start, end, tokens, context);
  });
}

function jsonLiteralAt(source: string, offset: number): string | undefined {
  for (const value of ['true', 'false', 'null']) {
    if (source.startsWith(value, offset) && !/[$_\p{L}\p{N}\p{M}]/u.test(source[offset + value.length] ?? '')) {
      return value;
    }
  }
  return undefined;
}

async function markdownLineTokens(
  source: string,
  start: number,
  end: number,
  tokens: HighlightToken[],
  context: CodeTokenizerContext
): Promise<void> {
  let content = start;
  while (content < end && content - start < 3 && source[content] === ' ') content += 1;
  const markerEnd = markdownBlockMarkerEnd(source, content, end);
  if (markerEnd > content) pushNonOverlapping(tokens, highlightToken(content, markerEnd, keywordStyle));
  let offset = start;
  while (offset < end) {
    await context.checkpoint(offset);
    const character = source[offset];
    if (character === '`') {
      const marker = await repeatedCharacterEnd(source, offset, end, '`', context);
      pushNonOverlapping(tokens, highlightToken(offset, marker, stringStyle));
      offset = marker;
      continue;
    }
    if (character === '*' || character === '_') {
      const marker = Math.min(end, source[offset + 1] === character ? offset + 2 : offset + 1);
      pushNonOverlapping(tokens, highlightToken(offset, marker, keywordStyle));
      offset = marker;
      continue;
    }
    if (character === '~' && source[offset + 1] === '~') {
      pushNonOverlapping(tokens, highlightToken(offset, offset + 2, keywordStyle));
      offset += 2;
      continue;
    }
    const bracket = character === '[' ? offset : character === '!' && source[offset + 1] === '[' ? offset + 1 : -1;
    if (bracket >= 0) {
      const labelEnd = await closingCharacter(source, bracket + 1, end, ']', context);
      if (labelEnd >= 0 && (source[labelEnd + 1] === '(' || source[labelEnd + 1] === '[')) {
        const closing = source[labelEnd + 1] === '(' ? ')' : ']';
        const destinationEnd = await closingCharacter(source, labelEnd + 2, end, closing, context);
        if (destinationEnd >= 0) {
          pushNonOverlapping(tokens, highlightToken(offset, destinationEnd + 1, keywordStyle));
          offset = destinationEnd + 1;
          continue;
        }
        offset = end;
        continue;
      }
      offset = labelEnd >= 0 ? labelEnd + 1 : end;
      continue;
    }
    offset += 1;
  }
}

function markdownBlockMarkerEnd(source: string, start: number, end: number): number {
  const character = source[start];
  if (character === '>') return start + 1;
  if ((character === '-' || character === '+' || character === '*') && /\s/u.test(source[start + 1] ?? '')) return start + 1;
  if (character === '#') {
    let offset = start;
    while (offset < end && offset - start < 6 && source[offset] === '#') offset += 1;
    return /\s/u.test(source[offset] ?? '') ? offset : start;
  }
  if (/\d/u.test(character ?? '')) {
    let offset = start + 1;
    while (offset < end && offset - start < 9 && /\d/u.test(source[offset] ?? '')) offset += 1;
    if (/\d/u.test(source[offset] ?? '')) return start;
    if ((source[offset] === '.' || source[offset] === ')') && /\s/u.test(source[offset + 1] ?? '')) return offset + 1;
  }
  return start;
}

async function repeatedCharacterEnd(
  source: string,
  start: number,
  end: number,
  character: string,
  context: CodeTokenizerContext
): Promise<number> {
  let offset = start + 1;
  while (offset < end && source[offset] === character) {
    offset += 1;
    await context.checkpoint(offset);
  }
  return offset;
}

async function closingCharacter(
  source: string,
  start: number,
  end: number,
  character: string,
  context: CodeTokenizerContext
): Promise<number> {
  let offset = start;
  while (offset < end) {
    if (source[offset] === '\\') offset += 2;
    else if (source[offset] === character) return offset;
    else offset += 1;
    await context.checkpoint(offset);
  }
  return -1;
}

async function yamlLineTokens(
  source: string,
  start: number,
  end: number,
  tokens: HighlightToken[],
  context: CodeTokenizerContext
): Promise<void> {
  const comment = await yamlCommentCooperative(source, start, end, context);
  const contentEnd = comment < 0 ? end : comment;
  const colon = await yamlMappingColon(source, start, contentEnd, context);
  if (colon >= 0) {
    let keyStart = start;
    while (keyStart < colon && /\s/u.test(source[keyStart] ?? '')) keyStart += 1;
    if (source[keyStart] === '-') {
      keyStart += 1;
      while (keyStart < colon && /\s/u.test(source[keyStart] ?? '')) keyStart += 1;
    }
    if (keyStart < colon) pushNonOverlapping(tokens, highlightToken(keyStart, colon, propertyStyle));
  }
  let offset = start;
  while (offset < contentEnd) {
    await context.checkpoint(offset);
    const character = source[offset];
    if (character === '"' || character === "'") {
      const tokenEnd = Math.min(contentEnd, await quotedEnd(source, offset, character, context));
      pushNonOverlapping(tokens, highlightToken(offset, tokenEnd, stringStyle));
      offset = Math.max(offset + 1, tokenEnd);
    } else if (isNumberStart(source, offset)) {
      const tokenEnd = Math.min(contentEnd, await numberEndCooperative(source, offset, context));
      pushNonOverlapping(tokens, highlightToken(offset, tokenEnd, numberStyle));
      offset = tokenEnd;
    } else if (character === '~') {
      pushNonOverlapping(tokens, highlightToken(offset, offset + 1, keywordStyle));
      offset += 1;
    } else if (isIdentifierStart(character)) {
      const tokenEnd = Math.min(contentEnd, await identifierEndCooperative(source, offset + 1, context));
      const value = source.slice(offset, tokenEnd).toLowerCase();
      if (value === 'true' || value === 'false' || value === 'null') {
        pushNonOverlapping(tokens, highlightToken(offset, tokenEnd, keywordStyle));
      }
      offset = tokenEnd;
    } else offset += 1;
  }
  if (comment >= 0) pushNonOverlapping(tokens, highlightToken(comment, end, commentStyle));
}

async function yamlMappingColon(
  source: string,
  start: number,
  end: number,
  context: CodeTokenizerContext
): Promise<number> {
  let quote: '"' | "'" | undefined;
  for (let offset = start; offset < end; offset += 1) {
    await context.checkpoint(offset);
    const character = source[offset];
    if (quote === '"' && character === '\\') offset += 1;
    else if (character === '"' || character === "'") quote = quote === character ? undefined : quote ?? character;
    else if (quote === undefined && character === ':') return offset;
  }
  return -1;
}

async function yamlCommentCooperative(
  source: string,
  start: number,
  end: number,
  context: CodeTokenizerContext
): Promise<number> {
  let quote: '"' | "'" | undefined;
  for (let offset = start; offset < end; offset += 1) {
    await context.checkpoint(offset);
    const character = source[offset];
    if (quote === '"' && character === '\\') offset += 1;
    else if (character === '"' || character === "'") quote = quote === character ? undefined : quote ?? character;
    else if (quote === undefined && character === '#' && (offset === start || /\s/u.test(source[offset - 1] ?? ''))) return offset;
  }
  return -1;
}

function pushNonOverlapping(tokens: HighlightToken[], token: HighlightToken): void {
  const previous = tokens.at(-1);
  if (previous !== undefined && previous.span.start < token.span.end && token.span.start < previous.span.end) return;
  if (previous !== undefined && previous.span.end === token.span.start && previous.style === token.style) {
    tokens[tokens.length - 1] = highlightToken(previous.span.start, token.span.end, token.style);
    return;
  }
  tokens.push(token);
}

function lineOrientedTokenizer(
  visit: (
    source: string,
    start: number,
    end: number,
    tokens: HighlightToken[],
    context: CodeTokenizerContext
  ) => Promise<void>
): CodeTokenizer {
  return Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      const tokens: HighlightToken[] = [];
      let start = 0;
      while (start < source.length) {
        await context.checkpoint(start);
        const end = await lineEndCooperative(source, start, context);
        await visit(source, start, end, tokens, context);
        start = end;
        if (source[start] === '\r' && source[start + 1] === '\n') start += 2;
        else if (source[start] === '\r' || source[start] === '\n') start += 1;
      }
      return Object.freeze(tokens.sort((left, right) => left.span.start - right.span.start));
    }
  });
}

async function quotedEnd(
  source: string,
  start: number,
  quote: string,
  context: CodeTokenizerContext
): Promise<number> {
  let offset = start + 1;
  while (offset < source.length) {
    await context.checkpoint(offset);
    if (source[offset] === '\\') offset += 2;
    else if (source[offset] === quote) return offset + 1;
    else if (quote !== '`' && (source[offset] === '\r' || source[offset] === '\n')) return offset;
    else offset += 1;
  }
  return source.length;
}

async function delimitedEnd(
  source: string,
  start: number,
  closing: string,
  context: CodeTokenizerContext,
  openingLength = 2
): Promise<number> {
  let offset = start + openingLength;
  while (offset < source.length) {
    await context.checkpoint(offset);
    if (source.startsWith(closing, offset)) return offset + closing.length;
    offset += 1;
  }
  return source.length;
}

async function lineEndCooperative(source: string, start: number, context: CodeTokenizerContext): Promise<number> {
  let offset = start;
  while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') {
    offset += 1;
    if ((offset - start & 0x3ff) === 0) await context.checkpoint(offset);
  }
  return offset;
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[$_\p{L}]/u.test(value);
}

async function identifierEndCooperative(source: string, start: number, context: CodeTokenizerContext): Promise<number> {
  let offset = start;
  while (/[$_\p{L}\p{N}\p{M}]/u.test(source[offset] ?? '')) {
    offset += 1;
    if ((offset - start & 0x3ff) === 0) await context.checkpoint(offset);
  }
  return offset;
}

async function cssWordEndCooperative(source: string, start: number, context: CodeTokenizerContext): Promise<number> {
  let offset = start;
  while (/[-_\p{L}\p{N}]/u.test(source[offset] ?? '')) {
    offset += 1;
    if ((offset - start & 0x3ff) === 0) await context.checkpoint(offset);
  }
  return offset;
}

function isNumberStart(source: string, offset: number): boolean {
  const character = source[offset];
  return /\d/u.test(character ?? '')
    || ((character === '-' || character === '+') && /\d/u.test(source[offset + 1] ?? ''));
}

async function numberEndCooperative(source: string, start: number, context: CodeTokenizerContext): Promise<number> {
  let offset = start;
  if (source[offset] === '+' || source[offset] === '-') offset += 1;
  const radixPrefix = source[offset] === '0' && /[xXbBoO]/u.test(source[offset + 1] ?? '');
  if (radixPrefix) offset += 2;
  while (offset < source.length) {
    const character = source[offset] ?? '';
    const allowed = radixPrefix
      ? /[\dA-Fa-f_]/u.test(character)
      : /[\d_eEn.]/u.test(character) || ((character === '+' || character === '-') && /[eE]/u.test(source[offset - 1] ?? ''));
    if (!allowed) break;
    offset += 1;
    if ((offset - start & 0x3ff) === 0) await context.checkpoint(offset);
  }
  return Math.max(start + 1, offset);
}

const javascriptKeywords = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
]);

const typescriptKeywords = new Set([
  ...javascriptKeywords,
  'abstract', 'any', 'asserts', 'bigint', 'boolean', 'declare', 'enum', 'implements', 'infer', 'interface', 'is',
  'keyof', 'module', 'namespace', 'never', 'number', 'object', 'override', 'private', 'protected', 'public', 'readonly',
  'require', 'satisfies', 'string', 'symbol', 'type', 'unique', 'unknown'
]);

const rustKeywords = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn',
  'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'
]);
