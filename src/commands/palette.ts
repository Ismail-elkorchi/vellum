import type { AppState, CommandId } from '../app/types.js';
import { allCommands } from './registry.js';
import { defaultKeymap, keyBindingText, type ValidatedKeymap } from './keymap.js';

export interface CommandPaletteEntry {
  readonly commandId: CommandId;
  readonly title: string;
  readonly category: string;
  readonly binding?: string;
  readonly enabled: boolean;
  readonly score: number;
}

export function commandPaletteEntries(
  state: AppState,
  query: string,
  keymap: ValidatedKeymap = defaultKeymap()
): readonly CommandPaletteEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  const entries = allCommands().map((command) => {
    const score = fuzzyScore(command.title.toLocaleLowerCase(), normalized);
    const binding = keymap.entries.find((entry) => entry.command === command.id)?.binding;
    return Object.freeze({
      commandId: command.id,
      title: command.title,
      category: command.category,
      ...(binding === undefined ? {} : { binding: keyBindingText(binding) }),
      enabled: command.enabled(state),
      score
    });
  }).filter((entry) => normalized.length === 0 || entry.score > Number.NEGATIVE_INFINITY);
  return Object.freeze(entries.toSorted((left, right) => (
    right.score - left.score
    || left.category.localeCompare(right.category)
    || left.title.localeCompare(right.title)
  )));
}

export function fuzzyScore(candidate: string, query: string): number {
  if (query.length === 0) return 0;
  if (candidate === query) return 10_000;
  if (candidate.startsWith(query)) return 5_000 - candidate.length;
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return Number.NEGATIVE_INFINITY;
    score += found === previous + 1 ? 8 : 2;
    if (found === 0 || /[ /._-]/u.test(candidate[found - 1] ?? '')) score += 5;
    previous = found;
    cursor = found + 1;
  }
  return score - candidate.length * 0.01;
}
