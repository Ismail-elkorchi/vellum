import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TextAreaLayoutSnapshot } from '@ismail-elkorchi/terminal-ui/components';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import type { MarkdownPreviewLayoutSnapshot } from '../markdown/render/component.js';
import type { VellumApplication } from '../app/application.js';
import { createVellumTui } from '../tui.js';

/** Observe accepted public layout messages instead of reproducing the allocator. */
export function observedVellum(application: VellumApplication, host: TerminalHost) {
  let editor: TextAreaLayoutSnapshot | undefined;
  let preview: MarkdownPreviewLayoutSnapshot | undefined;
  const layoutWaiters = new Set<() => void>();
  const observed: VellumApplication = { ...application, update(message) {
    if (message.kind === 'editorLayout') editor = message.snapshot;
    if (message.kind === 'previewLayout') preview = message.snapshot;
    const result = application.update(message);
    for (const notify of layoutWaiters) notify();
    return result;
  } };
  const runtime = createTuiRuntime({ app: createVellumTui(observed), host });
  return {
    runtime,
    async settle() {
      const signal = AbortSignal.timeout(10_000);
      await runtime.dispatch({ kind: 'applicationUpdate', update: application.snapshot() });
      while (true) {
        const state = application.state();
        const bufferId = state.project.activeBufferId;
        const presentation = bufferId === undefined ? undefined : application.previewPresentation(bufferId);
        if (state.paneArrangement === 'editor' || bufferId === undefined
          || (presentation?.kind === 'ready' && preview?.layout === presentation.layout
            && runtime.state().revision === state.revision)) return;
        if (presentation?.kind === 'failed') throw new Error(presentation.message);
        await new Promise<void>((resolve, reject) => {
          const notify = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(new Error('Preview layout did not settle.')); };
          const cleanup = () => { layoutWaiters.delete(notify); signal.removeEventListener('abort', abort); };
          if (signal.aborted) { abort(); return; }
          layoutWaiters.add(notify);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    },
    editor: () => {
      if (editor === undefined) throw new Error('No editor layout committed.');
      return editor;
    },
    preview: () => {
      if (preview === undefined) throw new Error('No preview layout committed.');
      return preview;
    }
  };
}
