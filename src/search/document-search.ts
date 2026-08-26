import {
  createTextChangeSet,
  type TextChangeSet
} from '@ismail-elkorchi/terminal-ui/text';
import type { SourceSpan } from 'markspan';

export interface DocumentSearchOptions {
  readonly regularExpression?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly selection?: SourceSpan;
}

export interface DocumentSearchMatch extends SourceSpan {
  readonly text: string;
  readonly replacementText?: string;
}

export interface DocumentSearchResult {
  readonly matches: readonly DocumentSearchMatch[];
  readonly error?: string;
}

export function findDocumentMatches(
  source: string,
  query: string,
  options: DocumentSearchOptions = {},
  replacement?: string
): DocumentSearchResult {
  if (query.length === 0) return Object.freeze({ matches: Object.freeze([]) });
  const range = options.selection ?? Object.freeze({ start: 0, end: source.length });
  if (range.start < 0 || range.end < range.start || range.end > source.length) {
    throw new RangeError('The document search selection is outside the source document.');
  }
  let expression: RegExp;
  try {
    expression = new RegExp(
      options.regularExpression === true ? query : escapeRegularExpression(query),
      `gu${options.caseSensitive === true ? '' : 'i'}`
    );
  } catch (error) {
    return Object.freeze({
      matches: Object.freeze([]),
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const selectedSource = source.slice(range.start, range.end);
  const matches: DocumentSearchMatch[] = [];
  for (;;) {
    const match = expression.exec(selectedSource);
    if (match === null) break;
    const start = range.start + match.index;
    const end = start + match[0].length;
    if (options.wholeWord !== true || wholeWord(source, start, end)) {
      matches.push(Object.freeze({
        start,
        end,
        text: match[0],
        ...(replacement === undefined ? {} : {
          replacementText: expandReplacement(replacement, match)
        })
      }));
    }
    if (match[0].length === 0) expression.lastIndex += codePointLengthAt(selectedSource, expression.lastIndex);
  }
  return Object.freeze({ matches: Object.freeze(matches) });
}

export function replacementChangeSet(
  result: DocumentSearchResult,
  currentMatchIndex?: number
): TextChangeSet {
  if (result.error !== undefined) throw new Error(result.error);
  const matches = currentMatchIndex === undefined
    ? result.matches
    : result.matches[currentMatchIndex] === undefined
      ? []
      : [result.matches[currentMatchIndex]];
  return createTextChangeSet(matches.map((match) => ({
    startOffset: match.start,
    endOffsetExclusive: match.end,
    insertedText: match.replacementText ?? ''
  })));
}

export function nextDocumentMatch(
  matches: readonly DocumentSearchMatch[],
  sourceOffset: number,
  direction: 'next' | 'previous'
): DocumentSearchMatch | undefined {
  if (matches.length === 0) return undefined;
  if (direction === 'next') return matches.find((match) => match.start > sourceOffset) ?? matches[0];
  return matches.toReversed().find((match) => match.end < sourceOffset) ?? matches.at(-1);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function wholeWord(source: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : previousCodePoint(source, start);
  const after = end >= source.length ? '' : nextCodePoint(source, end);
  return !/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after);
}

function previousCodePoint(source: string, offset: number): string {
  const last = source.charCodeAt(offset - 1);
  const start = last >= 0xdc00 && last <= 0xdfff ? Math.max(0, offset - 2) : offset - 1;
  return source.slice(start, offset);
}

function nextCodePoint(source: string, offset: number): string {
  const first = source.charCodeAt(offset);
  const length = first >= 0xd800 && first <= 0xdbff ? 2 : 1;
  return source.slice(offset, offset + length);
}

function codePointLengthAt(value: string, offset: number): number {
  if (offset >= value.length) return 1;
  return value.codePointAt(offset) !== undefined && (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
}

function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|`|'|[1-9][0-9]?)/gu, (token, value: string) => {
    if (value === '$') return '$';
    if (value === '&') return match[0];
    if (value === '`') return match.input.slice(0, match.index);
    if (value === "'") return match.input.slice(match.index + match[0].length);
    const group = Number.parseInt(value, 10);
    return Number.isNaN(group) ? token : match[group] ?? '';
  });
}
