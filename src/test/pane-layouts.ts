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
  const observed: VellumApplication = { ...application, update(message) {
    if (message.kind === 'editorLayout') editor = message.snapshot;
    if (message.kind === 'previewLayout') preview = message.snapshot;
    return application.update(message);
  } };
  return {
    runtime: createTuiRuntime({ app: createVellumTui(observed), host }),
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
