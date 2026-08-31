import {
  defineTui,
  replaceableSourceMessage,
  runTui,
  type TuiApp,
  type TuiEffect,
  type TuiInputBinding,
  type TuiEventSource,
  type TuiSourceSink,
  type TuiSubscriptionContext,
  type TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import { tabsReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import type { AppState } from './app/types.js';
import type { VellumApplication } from './app/application.js';
import { allCommands, type VellumEffect } from './commands/registry.js';
import { defaultKeymap, type ValidatedKeymap } from './commands/keymap.js';
import { viewVellum, VELLUM_IDS, type AppMessage } from './view.js';

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
      previousTerminalSize: context.previousTerminalSize,
      terminalSize: context.terminalSize,
      widthProfile: context.capabilities.unicode.widthProfile
    }),
    update: (_state, message) => updateVellum(application, message),
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

function updateVellum(
  application: VellumApplication,
  message: AppMessage
): TuiUpdateResult<AppState, AppMessage> {
  switch (message.kind) {
    case 'editor':
      application.applyTextAreaTransition(message.bufferId, message.transition, message.synchronization);
      return { state: application.state() };
    case 'previewScroll':
      application.updatePreviewScroll(message.bufferId, message.request, message.synchronization);
      return { state: application.state() };
    case 'tabs': {
      const state = application.state();
      const ids = state.project.bufferOrder;
      const tabs = tabsReducer({
        ...(state.project.activeBufferId === undefined ? {} : {
          activeId: state.project.activeBufferId,
          selectedId: state.project.activeBufferId
        })
      }, message.transition, { tabs: ids.map((id) => ({ id })), activation: 'automatic' });
      const selected = tabs.selectedId ?? tabs.activeId;
      if (selected !== undefined) application.activateBuffer(selected);
      return { state: application.state() };
    }
    case 'closeTab':
      application.requestCloseBuffer(message.bufferId);
      return { state: application.state() };
    case 'fileTree':
      return effectUpdate(
        application,
        `tree:${'id' in message.transition ? message.transition.id : 'viewport'}`,
        'replace',
        async () => application.applyFileTreeTransition(message.transition)
      );
    case 'activateFileTree':
      return effectUpdate(application, `tree:${message.nodeId}`, 'keep-first', async () => application.activateFileTreeNode(message.nodeId));
    case 'split':
      application.resizeSplitPane(message.transition);
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
    case 'submitFilePath': {
      const dialog = application.state().dialogState;
      return {
        state: application.state(),
        effects: [{
          id: `file-path:${dialog?.kind === 'filePath' ? dialog.operation : 'unknown'}`,
          concurrency: 'replace',
          async run({ signal }) {
            const closeApplication = await application.submitFilePathDialog(message.value, signal);
            return { kind: 'message', message: closeApplication ? { kind: 'exit' } : { kind: 'refresh' } };
          }
        }]
      };
    }
    case 'selection':
      application.updateSelectionDialog(message.transition);
      return { state: application.state() };
    case 'submitSelection':
      return effectUpdate(application, 'selection:submit', 'replace', async (signal) => application.submitSelectionDialog(message.value, signal));
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
      return effectUpdate(application, 'search:project', 'replace', async (signal) => application.submitProjectDirectorySearch(message.value, signal));
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
      return effectUpdate(application, `preview-activate:${message.bufferId}`, 'replace', async (signal) => application.activatePreview(message.bufferId, message.target, signal));
    case 'exportProfile':
      application.updateExportProfile(message.transition);
      return { state: application.state() };
    case 'submitExportProfile': {
      const dialog = application.state().dialogState;
      return effectUpdate(application, `export:${dialog?.kind === 'exportProfile' ? dialog.scope : 'unknown'}`, 'keep-first', async (signal) => application.submitExportProfile(message.value, signal));
    }
    case 'dismissDialog':
      application.dismissDialog();
      return { state: application.state() };
    case 'externalFile': {
      const dialog = application.state().dialogState;
      return effectUpdate(application, `conflict:${dialog?.kind === 'externalConflict' ? dialog.bufferId : 'unknown'}`, 'keep-first', async (signal) => application.resolveExternalFileAction(message.action, signal));
    }
    case 'checkExternalFiles':
      return effectUpdate(application, 'external-check:workspace', 'keep-first', async () => {
        const state = application.state();
        for (const id of state.project.bufferOrder) {
          if (state.project.buffers[id]?.path !== undefined) await application.checkExternalFile(id);
        }
      });
    case 'applicationUpdate':
      return { state: application.state() };
    case 'terminalResize':
      application.resizeTerminal(message.previousTerminalSize, message.terminalSize, message.widthProfile);
      return { state: application.state() };
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
      return effectUpdate(application, `close:${dialog.bufferIds[0] ?? 'unknown'}`, 'keep-first', async () => {
        await application.resolveDirtyBuffer(message.action);
      });
    }
    case 'refresh':
      return { state: application.state() };
    case 'exit':
      return { state: application.state(), exit: { reason: 'quit' } };
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
            update.bufferId ?? update.reason,
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

type AsynchronousVellumEffect = Extract<VellumEffect, {
  readonly kind: 'save' | 'saveAll' | 'trashProjectEntry' | 'copyProjectPath' | 'importClipboardAsset' | 'findUnusedAssets' | 'exportProjectManifest' | 'repeatLastExport' | 'refreshProjectEntry' | 'revealProjectEntry' | 'refreshDiagnostics' | 'addDiagnosticWord'
}>;

function requiresEffect(effect: VellumEffect): effect is AsynchronousVellumEffect {
  return effect.kind === 'save'
    || effect.kind === 'saveAll'
    || effect.kind === 'trashProjectEntry'
    || effect.kind === 'copyProjectPath'
    || effect.kind === 'importClipboardAsset'
    || effect.kind === 'findUnusedAssets'
    || effect.kind === 'exportProjectManifest'
    || effect.kind === 'repeatLastExport'
    || effect.kind === 'refreshProjectEntry'
    || effect.kind === 'revealProjectEntry'
    || effect.kind === 'refreshDiagnostics'
    || effect.kind === 'addDiagnosticWord';
}

function effectsUpdate(
  application: VellumApplication,
  effects: readonly AsynchronousVellumEffect[]
): TuiUpdateResult<AppState, AppMessage> {
  return {
    state: application.state(),
    effects: effects.map((effect): TuiEffect<AppMessage> => {
      const bufferId = effect.kind === 'save' ? application.state().project.activeBufferId : undefined;
      return {
      id: effect.kind === 'save'
        ? `save:${bufferId ?? 'none'}`
        : effect.kind === 'saveAll'
          ? 'save-all'
          : effect.kind === 'trashProjectEntry'
            ? `trash:${effect.path}`
            : effect.kind === 'copyProjectPath'
              ? `clipboard:${effect.path}`
              : effect.kind === 'importClipboardAsset'
                ? 'asset:clipboard'
                : effect.kind === 'findUnusedAssets'
                  ? 'asset:unused-scan'
                  : effect.kind === 'refreshProjectEntry'
                    ? `tree:${effect.path}`
                    : effect.kind === 'revealProjectEntry'
                      ? `reveal:${effect.path}`
                      : effect.kind === 'refreshDiagnostics'
                        ? `diagnostics:${effect.scope}`
                        : effect.kind === 'addDiagnosticWord'
                          ? 'diagnostics:dictionary'
                          : 'export:active',
      concurrency: effect.kind === 'save' ? 'enqueue' : 'keep-first',
      async run({ signal }) {
        if (effect.kind === 'save') {
          if (bufferId !== undefined) await application.saveBuffer(bufferId, undefined, false, signal);
        } else if (effect.kind === 'saveAll') {
          await application.saveAll(signal);
        } else if (effect.kind === 'trashProjectEntry') {
          signal.throwIfAborted();
          await application.trashProjectEntry(effect.path);
        } else if (effect.kind === 'copyProjectPath') {
          signal.throwIfAborted();
          await application.copyProjectPath(effect.path, effect.relative);
        } else if (effect.kind === 'importClipboardAsset') {
          signal.throwIfAborted();
          await application.importClipboardAsset();
        } else if (effect.kind === 'findUnusedAssets') {
          signal.throwIfAborted();
          await application.refreshUnusedAssets();
        } else if (effect.kind === 'exportProjectManifest') {
          await application.runProjectManifestExport(signal);
        } else if (effect.kind === 'repeatLastExport') {
          await application.repeatLastExport(signal);
        } else if (effect.kind === 'refreshProjectEntry') {
          signal.throwIfAborted();
          await application.refreshProjectEntry(effect.path);
        } else if (effect.kind === 'revealProjectEntry') {
          signal.throwIfAborted();
          await application.revealProjectEntry(effect.path);
        } else if (effect.kind === 'refreshDiagnostics') {
          signal.throwIfAborted();
          if (effect.scope === 'project') await application.refreshProjectDiagnostics();
          else {
            const bufferId = application.state().project.activeBufferId;
            if (bufferId !== undefined) await application.refreshDiagnostics(bufferId);
          }
        } else if (effect.kind === 'addDiagnosticWord') {
          signal.throwIfAborted();
          await application.addCurrentWordToDictionary();
        }
        return { kind: 'message', message: { kind: 'refresh' } };
      }
    }})
  };
}

function effectUpdate(
  application: VellumApplication,
  id: string,
  concurrency: TuiEffect<AppMessage>['concurrency'],
  operation: (signal: AbortSignal) => Promise<void>
): TuiUpdateResult<AppState, AppMessage> {
  return {
    state: application.state(),
    effects: [{
      id,
      concurrency,
      async run({ signal }) {
        await operation(signal);
        return { kind: 'message', message: { kind: 'refresh' } };
      }
    }]
  };
}
