import type { AppMessage } from './app/messages.js';
import {
  defineTui,
  replaceableSourceMessage,
  runTui,
  type TuiApp,
  type TuiInputBinding,
  type TuiEventSource,
  type TuiSourceSink,
  type TuiSubscriptionContext,
} from '@ismail-elkorchi/terminal-ui/tui';
import type { AppState } from './app/types.js';
import type { VellumApplication } from './app/application.js';
import { allCommands } from './commands/registry.js';
import { defaultKeymap, type ValidatedKeymap } from './commands/keymap.js';
import { viewVellum, VELLUM_IDS } from './view.js';

function inputBindings(keymap: ValidatedKeymap): readonly TuiInputBinding<AppState, AppMessage>[] {
  const commandBindings = keymap.entries.flatMap((entry, index) => {
    const command = allCommands().find((candidate) => candidate.id === entry.command);
    if (command === undefined) return [];
    const binding = entry.binding;
    return [{
    id: `vellum-command-${command.id}-${String(index)}`,
    label: command.title,
    triggers: [Object.freeze({
      kind: 'key' as const,
      key: binding.key,
      ...((binding.ctrl ?? binding.alt ?? binding.shift ?? binding.meta) ? {
        modifiers: Object.freeze({
          ...(binding.ctrl === undefined ? {} : { ctrl: binding.ctrl }),
          ...(binding.alt === undefined ? {} : { alt: binding.alt }),
          ...(binding.shift === undefined ? {} : { shift: binding.shift }),
          ...(binding.meta === undefined ? {} : { meta: binding.meta })
        })
      } : {})
    })],
    enabled: ({ state }: { readonly state: AppState }) => state.dialogState === undefined && command.enabled(state),
    message: Object.freeze({ kind: 'command' as const, commandId: command.id })
    }];
  });
  return Object.freeze([
    ...commandBindings,
    Object.freeze({
      id: 'vellum-check-external-files',
      label: 'Check external file revisions',
      triggers: Object.freeze([Object.freeze({ kind: 'focus' as const, focused: true })]),
      message: Object.freeze({ kind: 'checkExternalFiles' as const })
    })
  ]);
}

export function createVellumTui(
  application: VellumApplication,
  keymap: ValidatedKeymap = defaultKeymap()
): TuiApp<AppState, AppMessage> {
  return defineTui<AppState, AppMessage>({
    id: 'vellum-markdown-editor',
    init: () => ({ state: application.state() }),
    inputBindings: inputBindings(keymap),
    subscriptions: () => applicationUpdateSources(application),
    resizeMessage: (_state, context) => Object.freeze({
      kind: 'terminalResize' as const,
      widthProfile: context.capabilities.unicode.widthProfile
    }),
    update: (state, message) => message.kind === 'applicationUpdate'
      ? { state: message.update.revision > state.revision ? message.update.state : state }
      : application.update(message),
    view: (state, context) => viewVellum(application, state, context),
    nonTty: {
      mode: 'last_frame',
      diagnosticHint: 'Run Vellum in an interactive terminal to edit source documents.'
    }
  });
}

export async function runVellum(application: VellumApplication, keymap: ValidatedKeymap = defaultKeymap()) {
  const activeBufferId = application.state().project.activeBufferId;
  try {
    return await runTui(createVellumTui(application, keymap), activeBufferId === undefined
      ? {}
      : { initialFocus: { kind: 'element', elementId: `${VELLUM_IDS.editor}-${activeBufferId}` } });
  } finally {
    await application.dispose();
  }
}


function applicationUpdateSources(
  application: VellumApplication
): readonly TuiEventSource<AppMessage>[] {
  return Object.freeze([Object.freeze({
    id: 'vellum-application-updates',
    generation: 0,
    source: 'external' as const,
    channel: Object.freeze({ capacity: 64, cadenceMs: 8 }),
    async run(context: TuiSubscriptionContext, sink: TuiSourceSink<AppMessage>) {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = application.subscribe((update) => {
          void sink.emit(replaceableSourceMessage(
            'snapshot',
            Object.freeze({ kind: 'applicationUpdate' as const, update })
          )).catch((error: unknown) => {
            if (!context.signal.aborted) reject(error);
          });
        });
        context.signal.addEventListener('abort', () => {
          unsubscribe();
          resolve();
        }, { once: true });
      });
    }
  })]);
}
