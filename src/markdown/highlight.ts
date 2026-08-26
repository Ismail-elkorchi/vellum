import { createHash } from 'node:crypto';
import type { TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import { themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import type { HighlightedCode, HighlightToken } from './render/code.js';

export interface CodeHighlightLanguage {
  readonly id: string;
  readonly aliases: readonly string[];
  highlight(source: string, signal: AbortSignal): readonly HighlightToken[];
}

export interface CodeHighlighter {
  highlight(language: string, source: string, signal?: AbortSignal): Promise<HighlightedCode | undefined>;
  clear(): void;
}

type LanguageLoader = () => Promise<CodeHighlightLanguage>;

export function createCodeHighlighter(
  loaders: Readonly<Record<string, LanguageLoader>> = builtInLanguageLoaders()
): CodeHighlighter {
  const aliases = new Map<string, string>();
  const loaded = new Map<string, Promise<CodeHighlightLanguage>>();
  const cache = new Map<string, HighlightedCode>();
  for (const id of Object.keys(loaders)) aliases.set(id.toLowerCase(), id);
  for (const [alias, id] of Object.entries({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'shell', bash: 'shell', md: 'markdown' })) {
    aliases.set(alias, id);
  }
  return Object.freeze({
    async highlight(language: string, source: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const id = aliases.get(language.trim().toLowerCase());
      const loader = id === undefined ? undefined : loaders[id];
      if (id === undefined || loader === undefined) return undefined;
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const key = `${id}:${sourceHash}`;
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const pending = loaded.get(id) ?? loader();
      loaded.set(id, pending);
      const definition = await pending;
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      const result = Object.freeze({
        language: definition.id,
        sourceHash,
        tokens: Object.freeze(definition.highlight(source, signal ?? new AbortController().signal))
      });
      cache.set(key, result);
      return result;
    },
    clear() {
      cache.clear();
      loaded.clear();
    }
  });
}

function builtInLanguageLoaders(): Readonly<Record<string, LanguageLoader>> {
  return Object.freeze({
    javascript: async () => language('javascript', ['js', 'jsx'], jsTokens),
    typescript: async () => language('typescript', ['ts', 'tsx'], jsTokens),
    json: async () => language('json', [], jsonTokens),
    shell: async () => language('shell', ['sh', 'bash'], shellTokens),
    markdown: async () => language('markdown', ['md'], markdownTokens)
  });
}

function language(
  id: string,
  aliases: readonly string[],
  highlighter: (source: string, signal: AbortSignal) => readonly HighlightToken[]
): CodeHighlightLanguage {
  return Object.freeze({ id, aliases: Object.freeze(aliases), highlight: highlighter });
}

const keywordStyle: TerminalStyle = Object.freeze({ fg: themeColor('accent.primary'), bold: true });
const stringStyle: TerminalStyle = Object.freeze({ fg: themeColor('status.success') });
const commentStyle: TerminalStyle = Object.freeze({ fg: themeColor('text.muted'), italic: true });
const numberStyle: TerminalStyle = Object.freeze({ fg: themeColor('status.warning') });

function jsTokens(source: string, signal: AbortSignal): readonly HighlightToken[] {
  return tokenize(source, /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|async|await|new|throw|try|catch|finally|extends|implements|readonly|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b/gu, (value) => (
    value.startsWith('//') || value.startsWith('/*') ? commentStyle
      : /^['"`]/u.test(value) ? stringStyle
        : /^\d/u.test(value) ? numberStyle
          : keywordStyle
  ), signal);
}

function jsonTokens(source: string, signal: AbortSignal): readonly HighlightToken[] {
  return tokenize(source, /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/giu, (value) => (
    value.startsWith('"') ? stringStyle : /^-?\d/u.test(value) ? numberStyle : keywordStyle
  ), signal);
}

function shellTokens(source: string, signal: AbortSignal): readonly HighlightToken[] {
  return tokenize(source, /#[^\r\n]*|'[^']*'|"(?:\\.|[^"\\])*"|\b(?:if|then|else|fi|for|in|do|done|case|esac|function)\b/gu, (value) => (
    value.startsWith('#') ? commentStyle : /^['"]/u.test(value) ? stringStyle : keywordStyle
  ), signal);
}

function markdownTokens(source: string, signal: AbortSignal): readonly HighlightToken[] {
  return tokenize(source, /^(?:#{1,6}|>|[-+*]|\d+[.)])(?=\s)|`+|\*{1,2}|_{1,2}|\[[^\]]*\]\([^)]*\)/gmu, () => keywordStyle, signal);
}

function tokenize(
  source: string,
  pattern: RegExp,
  style: (value: string) => TerminalStyle,
  signal: AbortSignal
): readonly HighlightToken[] {
  const tokens: HighlightToken[] = [];
  for (const match of source.matchAll(pattern)) {
    signal.throwIfAborted();
    const start = match.index;
    const value = match[0];
    tokens.push(Object.freeze({ span: Object.freeze({ start, end: start + value.length }), style: style(value) }));
  }
  return Object.freeze(tokens);
}
