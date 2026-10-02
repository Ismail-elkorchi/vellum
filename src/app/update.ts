import type { TuiCancellation, TuiEffect, TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import { tabsReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import type { AppState, DialogState } from './types.js';
import type { VellumApplication } from './application.js';
import type { AppMessage, VellumMessage } from './messages.js';

/** Routes domain messages once; state and async completion snapshots share one owner. */
export function updateVellumApplication(application: VellumApplication, message: VellumMessage): TuiUpdateResult<AppState, AppMessage> {
  const result = routeVellumMessage(application, message);
  return { ...result, state: application.state() };
}

function routeVellumMessage(
  application: VellumApplication,
  message: VellumMessage
): Omit<TuiUpdateResult<AppState, AppMessage>, 'state'> {
  switch (message.kind) {
    case 'editorLayout':
      application.commitEditorLayout(message.bufferId, message.snapshot);
      return {};
    case 'previewAllocation': {
      const operation = application.acceptPreviewAllocation(message.bufferId, message.document, message.resourceRevision, message.allocation);
      return operation === undefined ? {} : { effects: [{
        id: operation.id, concurrency: operation.concurrency,
        async run({ signal }) {
          await operation.run(signal);
          return signal.aborted ? { kind: 'none' } : {
            kind: 'message', message: { kind: 'applicationUpdate', update: application.snapshot() },
          };
        },
      }] };
    }
    case 'previewLayout':
      application.commitPreviewLayout(message.bufferId, message.document, message.resourceRevision, message.snapshot);
      return {};
    case 'editor':
      application.applyTextAreaTransition(message.bufferId, message.transition);
      return {};
    case 'previewScroll':
      application.updatePreviewScroll(message.bufferId, message.request);
      return {};
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
      return {};
    }
    case 'closeTab':
      application.requestCloseBuffer(message.bufferId);
      return {};
    case 'fileTree':
      return effectUpdate(
        `tree:${'id' in message.transition ? message.transition.id : 'viewport'}`,
        'replace',
        async (signal) => application.applyFileTreeTransition(message.transition, signal, message.treeRevision)
      );
    case 'activateFileTree':
      return effectUpdate(`tree:${message.nodeId}`, 'keep-first', async (signal) => application.activateFileTreeNode(message.nodeId, signal, message.treeRevision));
    case 'split':
      application.resizeSplitPane(message.transition);
      return {};
    case 'command': {
      const update = application.dispatchCommand(message.commandId);
      return {
        ...(update.quit ? { exit: { reason: 'quit' as const } } : {}),
        effects: update.operations.map((operation) => ({
          id: operation.id,
          concurrency: operation.concurrency,
          async run({ signal }) {
            await operation.run(signal);
            return { kind: 'none' as const };
          }
        }))
      };
    }
    case 'filePath':
      application.updateFilePathDialog(message.transition);
      return {};
    case 'submitFilePath': {
      const dialog = application.state().dialogState;
      return {
        effects: [{
          id: `file-path:${dialog?.kind === 'filePath' ? dialog.operation : 'unknown'}`,
          concurrency: 'replace',
          async run({ signal }) {
            if (application.state().dialogState !== dialog) return { kind: 'none' };
            const closeApplication = await application.submitFilePathDialog(message.value, signal);
            return closeApplication ? { kind: 'message', message: { kind: 'exit', project: application.state().project } } : { kind: 'none' };
          }
        }]
      };
    }
    case 'selection':
      application.updateSelectionDialog(message.transition);
      return {};
    case 'submitSelection': {
      const dialog = application.state().dialogState;
      return { effects: [{ id: 'selection:submit', concurrency: 'replace', async run({ signal }) {
        if (application.state().dialogState !== dialog) return { kind: 'none' };
        const update = await application.submitSelectionDialog(message.value, signal);
        return update?.quit === true ? { kind: 'message', message: { kind: 'exit', project: application.state().project } } : { kind: 'none' };
      } }] };
    }
    case 'documentSearch':
      application.updateDocumentSearch(message.field, message.transition);
      return {};
    case 'configureDocumentSearch':
      application.configureDocumentSearch(message.option);
      return {};
    case 'navigateDocumentSearch':
      application.navigateDocumentSearch(message.direction);
      return {};
    case 'replaceDocumentSearch':
      application.replaceDocumentSearch(message.scope);
      return {};
    case 'projectDirectorySearch':
      application.updateProjectDirectorySearch(message.transition);
      return {};
    case 'submitProjectDirectorySearch':
      return effectUpdate('search:project', 'replace', async (signal) => application.submitProjectDirectorySearch(message.value, signal));
    case 'outline':
      application.updateOutline(message.transition);
      return {};
    case 'submitOutline':
      application.submitOutline(message.value);
      return {};
    case 'goToLine':
      application.updateGoToLine(message.transition);
      return {};
    case 'submitGoToLine':
      application.submitGoToLine(message.value);
      return {};
    case 'previewActivate':
      return effectUpdate(`preview-activate:${message.bufferId}`, 'replace', async (signal) => application.activatePreview(message.bufferId, message.target, signal));
    case 'exportProfile':
      application.updateExportProfile(message.transition);
      return {};
    case 'submitExportProfile': {
      const dialog = application.state().dialogState;
      return effectUpdate(`export:${dialog?.kind === 'exportProfile' ? dialog.scope : 'unknown'}`, 'keep-first', async (signal) => application.submitExportProfile(message.value, signal));
    }
    case 'dismissDialog': {
      const cancel = dialogCancellation(application.state().dialogState);
      application.dismissDialog();
      return { cancel };
    }
    case 'externalFile': {
      const dialog = application.state().dialogState;
      return effectUpdate(`conflict:${dialog?.kind === 'externalConflict' ? dialog.bufferId : 'unknown'}`, 'keep-first', async (signal) => application.resolveExternalFileAction(message.action, signal));
    }
    case 'checkExternalFiles':
      return effectUpdate('external-check:workspace', 'keep-first', async () => {
        const state = application.state();
        for (const id of state.project.bufferOrder) {
          if (state.project.buffers[id]?.path !== undefined) await application.checkExternalFile(id);
        }
      });
    case 'terminalResize':
      application.updateTextWidthProfile(message.widthProfile);
      return {};
    case 'resolveDirty': {
      const dialog = application.state().dialogState;
      if (dialog?.kind !== 'dirtyBuffer') return {};
      if (message.action === 'cancel') {
        application.dismissDialog();
        return { cancel: dialogCancellation(dialog) };
      }
      if (dialog.closeApplication) {
        return {
          effects: [{
            id: 'vellum-close-application',
            concurrency: 'replace',
            async run({ signal }) {
              if (application.state().dialogState !== dialog) return { kind: 'none' };
              const closed = await application.resolveCloseApplication(message.action === 'save' ? 'saveAll' : 'discardAll', signal);
              return closed ? { kind: 'message', message: { kind: 'exit', project: application.state().project } } : { kind: 'none' };
            }
          }]
        };
      }
      return effectUpdate(`close:${dialog.bufferIds[0] ?? 'unknown'}`, 'keep-first', async (signal) => {
        if (application.state().dialogState === dialog) await application.resolveDirtyBuffer(message.action, undefined, signal);
      });
    }
    case 'exit':
      return application.canExit(message.project) ? { exit: { reason: 'quit' } } : {};
  }
}

function effectUpdate(
  id: string,
  concurrency: TuiEffect<AppMessage>['concurrency'],
  operation: (signal: AbortSignal) => Promise<void>
): Omit<TuiUpdateResult<AppState, AppMessage>, 'state'> {
  return {
    effects: [{
      id,
      concurrency,
      async run({ signal }) {
        await operation(signal);
        return { kind: 'none' };
      }
    }]
  };
}

function dialogCancellation(dialog: DialogState | undefined): readonly TuiCancellation[] {
  if (dialog?.kind === 'filePath') return [{ kind: 'effect', id: `file-path:${dialog.operation}` }];
  if (dialog?.kind === 'dirtyBuffer') return [{ kind: 'effect', id: dialog.closeApplication ? 'vellum-close-application' : `close:${dialog.bufferIds[0] ?? 'unknown'}` }];
  if (dialog?.kind === 'commandPalette' || dialog?.kind === 'quickOpen' || dialog?.kind === 'completion'
    || dialog?.kind === 'recentProject' || dialog?.kind === 'recoverySelection') return [{ kind: 'effect', id: 'selection:submit' }];
  return [];
}
