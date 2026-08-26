import {
  defineTui,
  runTui,
  type TuiApp,
  type TuiEffect,
  type TuiInputBinding,
  type TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import { tabsReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import type { AppState } from './app/types.js';
import type { VellumApplication } from './app/application.js';
import { allCommands, type VellumEffect } from './commands/registry.js';
import { defaultKeymap, type ValidatedKeymap } from './commands/keymap.js';
import { viewVellum, VELLUM_IDS, type AppMessage } from './view.js';

const editorFocus = { kind: 'element', elementId: VELLUM_IDS.tabs } as const;

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
    update: (_state, message) => updateVellum(application, message),
    view: (state, context) => viewVellum(application, state, context),
    nonTty: {
      mode: 'last_frame',
      diagnosticHint: 'Run Vellum in an interactive terminal to edit source documents.'
    }
  });
}

export async function runVellum(application: VellumApplication, keymap: ValidatedKeymap = defaultKeymap()) {
  try {
    return await runTui(createVellumTui(application, keymap), { initialFocus: editorFocus });
  } finally {
    await application.dispose();
  }
}

function updateVellum(
  application: VellumApplication,
  message: AppMessage
): TuiUpdateResult<AppState, AppMessage> {
  switch (message.kind) {
    case 'editor':
      application.applyTextAreaAction(message.bufferId, message.action);
      if (message.action.kind === 'scroll' && message.editorMap !== undefined && message.previewMap !== undefined) {
        application.synchronizeFromEditor(message.bufferId, message.editorMap, message.previewMap);
      }
      return { state: application.state() };
    case 'previewScroll':
      application.updatePreviewScroll(message.bufferId, message.event, message.editorMap, message.previewMap);
      return { state: application.state() };
    case 'tabs': {
      const state = application.state();
      const ids = state.project.bufferOrder;
      const presentation = tabsReducer({
        ...(state.project.activeBufferId === undefined ? {} : {
          activeId: state.project.activeBufferId,
          selectedId: state.project.activeBufferId
        })
      }, message.transition, { tabs: ids.map((id) => ({ id })), activation: 'automatic' });
      const selected = presentation.selectedId ?? presentation.activeId;
      if (selected !== undefined) application.activateBuffer(selected);
      return { state: application.state() };
    }
    case 'closeTab':
      application.requestCloseBuffer(message.bufferId);
      return { state: application.state() };
    case 'fileTree':
      return effectUpdate(application, async () => application.applyFileTreeTransition(message.transition));
    case 'activateFileTree':
      return effectUpdate(application, async () => application.activateFileTreeNode(message.nodeId));
    case 'split':
      application.resizeSplitPane(message.action);
      return { state: application.state() };
    case 'command': {
      const update = application.dispatchCommand(message.commandId);
      const quit = update.effects.some((effect) => effect.kind === 'quit');
      if (quit) {
        return application.requestCloseApplication()
          ? { state: application.state(), exit: { reason: 'quit' } }
          : { state: application.state() };
      }
      const asynchronous = update.effects.filter(requiresEffect);
      return asynchronous.length === 0
        ? { state: application.state() }
        : effectsUpdate(application, asynchronous);
    }
    case 'filePath':
      application.updateFilePathDialog(message.transition);
      return { state: application.state() };
    case 'submitFilePath':
      return {
        state: application.state(),
        effects: [{
          id: 'vellum-file-path-effect',
          concurrency: 'replace',
          async run() {
            const closeApplication = await application.submitFilePathDialog(message.value);
            return { kind: 'message', message: closeApplication ? { kind: 'exit' } : { kind: 'refresh' } };
          }
        }]
      };
    case 'selection':
      application.updateSelectionDialog(message.transition);
      return { state: application.state() };
    case 'submitSelection':
      return effectUpdate(application, async () => application.submitSelectionDialog(message.value));
    case 'documentSearch':
      application.updateDocumentSearch(message.field, message.transition);
      return { state: application.state() };
    case 'configureDocumentSearch':
      application.configureDocumentSearch(message.option);
      return { state: application.state() };
    case 'navigateDocumentSearch':
      application.navigateDocumentSearch(message.direction);
      return { state: application.state() };
    case 'replaceDocumentSearch':
      application.replaceDocumentSearch(message.scope);
      return { state: application.state() };
    case 'projectDirectorySearch':
      application.updateProjectDirectorySearch(message.transition);
      return { state: application.state() };
    case 'submitProjectDirectorySearch':
      return effectUpdate(application, async (signal) => application.submitProjectDirectorySearch(message.value, signal));
    case 'outline':
      application.updateOutline(message.transition);
      return { state: application.state() };
    case 'submitOutline':
      application.submitOutline(message.value);
      return { state: application.state() };
    case 'goToLine':
      application.updateGoToLine(message.transition);
      return { state: application.state() };
    case 'submitGoToLine':
      application.submitGoToLine(message.value);
      return { state: application.state() };
    case 'previewActivate':
      return effectUpdate(application, async (signal) => application.activatePreview(message.bufferId, message.row, message.column, signal));
    case 'exportProfile':
      application.updateExportProfile(message.transition);
      return { state: application.state() };
    case 'submitExportProfile':
      return effectUpdate(application, async (signal) => application.submitExportProfile(message.value, signal));
    case 'dismissDialog':
      application.dismissDialog();
      return { state: application.state() };
    case 'externalFile':
      return effectUpdate(application, async (signal) => application.resolveExternalFileAction(message.action, signal));
    case 'checkExternalFiles':
      return effectUpdate(application, async () => {
        const state = application.state();
        for (const id of state.project.bufferOrder) {
          if (state.project.buffers[id]?.path !== undefined) await application.checkExternalFile(id);
        }
      });
    case 'resolveDirty': {
      const dialog = application.state().dialogState;
      if (dialog?.kind !== 'dirtyBuffer') return { state: application.state() };
      if (dialog.closeApplication) {
        if (message.action === 'cancel') {
          void application.resolveCloseApplication('cancel');
          return { state: application.state() };
        }
        return {
          state: application.state(),
          effects: [{
            id: 'vellum-close-application',
            concurrency: 'replace',
            async run() {
              const closed = await application.resolveCloseApplication(message.action === 'save' ? 'saveAll' : 'discardAll');
              return { kind: 'message', message: closed ? { kind: 'exit' } : { kind: 'refresh' } };
            }
          }]
        };
      }
      return effectUpdate(application, async () => {
        await application.resolveDirtyBuffer(message.action);
      });
    }
    case 'refresh':
      return { state: application.state() };
    case 'exit':
      return { state: application.state(), exit: { reason: 'quit' } };
  }
}

function requiresEffect(effect: VellumEffect): boolean {
  return effect.kind === 'save' || effect.kind === 'saveAll';
}

function effectsUpdate(
  application: VellumApplication,
  effects: readonly VellumEffect[]
): TuiUpdateResult<AppState, AppMessage> {
  return {
    state: application.state(),
    effects: effects.map((effect, index): TuiEffect<AppMessage> => ({
      id: `vellum-${effect.kind}-${String(index)}`,
      concurrency: 'enqueue',
      async run({ signal }) {
        if (effect.kind === 'save') {
          const id = application.state().project.activeBufferId;
          if (id !== undefined) await application.saveBuffer(id, undefined, false, signal);
        } else if (effect.kind === 'saveAll') {
          await application.saveAll(signal);
        }
        return { kind: 'message', message: { kind: 'refresh' } };
      }
    }))
  };
}

function effectUpdate(
  application: VellumApplication,
  operation: (signal: AbortSignal) => Promise<void>
): TuiUpdateResult<AppState, AppMessage> {
  return {
    state: application.state(),
    effects: [{
      id: 'vellum-application-effect',
      concurrency: 'replace',
      async run({ signal }) {
        await operation(signal);
        return { kind: 'message', message: { kind: 'refresh' } };
      }
    }]
  };
}
