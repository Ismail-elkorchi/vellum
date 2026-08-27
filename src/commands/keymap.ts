import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BindableKeyName } from '@ismail-elkorchi/terminal-ui/input';
import type { CommandId } from '../app/types.js';
import {
  allCommands,
  commandById,
  type KeyBinding
} from './registry.js';
import { defaultVellumConfigurationDirectory } from '../config/paths.js';

export interface KeymapEntry {
  readonly command: CommandId;
  readonly binding: KeyBinding;
}

export interface KeymapDiagnostic {
  readonly index: number;
  readonly message: string;
}

export interface ValidatedKeymap {
  readonly entries: readonly KeymapEntry[];
  readonly diagnostics: readonly KeymapDiagnostic[];
}

const keyPattern = /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|f(?:[1-9]|[12][0-9]|3[0-5])|tab|enter|escape|backspace|delete|arrow(?:up|down|left|right)|home|end|page(?:up|down)|insert|space|add|subtract|multiply|divide|decimal|equal)$/u;

export function parseKeyBinding(value: string): KeyBinding {
  if (typeof value !== 'string') throw new TypeError('A key binding must be a string.');
  const normalized = value.trim().toLowerCase();
  if (!keyPattern.test(normalized)) throw new Error(`Malformed key binding: ${value}`);
  const parts = normalized.split('+');
  const key = parts.at(-1);
  if (key === undefined) throw new Error(`Malformed key binding: ${value}`);
  const modifiers = new Set(parts.slice(0, -1));
  if (modifiers.size !== parts.length - 1) throw new Error(`Malformed key binding: ${value}`);
  return Object.freeze({
    key: canonicalKey(key),
    ...(modifiers.has('ctrl') ? { ctrl: true } : {}),
    ...(modifiers.has('alt') ? { alt: true } : {}),
    ...(modifiers.has('shift') ? { shift: true } : {}),
    ...(modifiers.has('meta') ? { meta: true } : {})
  });
}

function canonicalKey(value: string): BindableKeyName {
  const special: Readonly<Record<string, BindableKeyName>> = Object.freeze({
    arrowup: 'arrowUp',
    arrowdown: 'arrowDown',
    arrowleft: 'arrowLeft',
    arrowright: 'arrowRight',
    pageup: 'pageUp',
    pagedown: 'pageDown'
  });
  return special[value] ?? value as BindableKeyName;
}

export function keyBindingText(binding: KeyBinding): string {
  return [
    ...(binding.ctrl === true ? ['ctrl'] : []),
    ...(binding.alt === true ? ['alt'] : []),
    ...(binding.shift === true ? ['shift'] : []),
    ...(binding.meta === true ? ['meta'] : []),
    binding.key.toLowerCase()
  ].join('+');
}

export function validateKeymap(value: unknown): ValidatedKeymap {
  if (!Array.isArray(value)) {
    return Object.freeze({
      entries: Object.freeze([]),
      diagnostics: Object.freeze([{ index: 0, message: 'The keymap must be an array.' }])
    });
  }
  const entries: KeymapEntry[] = [];
  const diagnostics: KeymapDiagnostic[] = [];
  const bindings = new Map<string, CommandId>();
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      diagnostics.push({ index, message: 'A keymap entry must be an object.' });
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const unknownFields = Object.keys(record).filter((key) => key !== 'command' && key !== 'key');
    if (unknownFields.length > 0) {
      diagnostics.push({ index, message: `Unknown keymap fields: ${unknownFields.join(', ')}.` });
      continue;
    }
    if (typeof record['command'] !== 'string' || commandById(record['command']) === undefined) {
      diagnostics.push({ index, message: `Unknown command identifier: ${String(record['command'])}` });
      continue;
    }
    if (typeof record['key'] !== 'string') {
      diagnostics.push({ index, message: 'A keymap entry requires a key string.' });
      continue;
    }
    try {
      const binding = parseKeyBinding(record['key']);
      const text = keyBindingText(binding);
      const previous = bindings.get(text);
      if (previous !== undefined) {
        diagnostics.push({
          index,
          message: previous === record['command']
            ? `Duplicate key binding ${text} for ${previous}.`
            : `Conflicting key binding ${text}: ${previous} and ${record['command']}.`
        });
        continue;
      }
      const command = record['command'] as CommandId;
      bindings.set(text, command);
      entries.push(Object.freeze({ command, binding }));
    } catch (error) {
      diagnostics.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic)))
  });
}

export async function readUserKeymap(filePath: string): Promise<ValidatedKeymap> {
  const source = await readFile(filePath, 'utf8');
  try {
    return validateKeymap(JSON.parse(source));
  } catch (error) {
    return Object.freeze({
      entries: Object.freeze([]),
      diagnostics: Object.freeze([{
        index: 0,
        message: `Invalid keymap JSON: ${error instanceof Error ? error.message : String(error)}`
      }])
    });
  }
}

export function defaultUserKeymapPath(platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultVellumConfigurationDirectory(platform), 'keymap.json');
}

export async function loadUserKeymap(filePath = defaultUserKeymapPath()): Promise<ValidatedKeymap> {
  try {
    return await readUserKeymap(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return defaultKeymap();
    throw error;
  }
}

export function defaultKeymap(): ValidatedKeymap {
  return validateKeymap(allCommands().flatMap((command) => command.defaultBindings.map((binding) => ({
    command: command.id,
    key: keyBindingText(binding)
  }))));
}
