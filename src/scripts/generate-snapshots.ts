import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderElementSnapshot } from '@ismail-elkorchi/terminal-ui/testing';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import {
  activatePane,
  editDocument,
  initialState,
  openDocument,
  setFileDialogError,
  setMode,
  showHelpDialog,
  showQuitConfirmation,
  startFileDialog,
  type AppState
} from '../editor-state.js';
import { view } from '../view.js';

const SAMPLE_MARKDOWN = [
  '# Vellum',
  '',
  'A **terminal-first** Markdown editor with *live preview*, `inline code`, and [clickable links](https://example.com).',
  '',
  '## Editorial rendering',
  '',
  '> Blockquotes use a guide and preserve **nested formatting** while wrapping at word boundaries.',
  '',
  '- [x] Block-aware rendering',
  '- [ ] Final polish',
  '  - Nested list with *emphasis*',
  '',
  '```ts',
  'export const answer = 42;',
  '```',
  '',
  '| Feature | Status |',
  '| :--- | ---: |',
  '| Unicode width | 東京 ✅ |',
  '| Terminal links | [Open](https://example.com) |',
  '',
  '---',
  '',
  '![Architecture](https://example.com/architecture.png)',
  '',
  '<section>HTML is intentionally not executed.</section>'
].join('\n');

interface SnapshotSpec {
  readonly name: string;
  readonly state: AppState;
  readonly columns: number;
  readonly rows: number;
}

function context(columns: number, rows: number): TuiContext {
  return { terminalSize: { columns, rows } } as TuiContext;
}

function documentState(): AppState {
  return openDocument(initialState(), '/workspace/README.md', 'README.md', SAMPLE_MARKDOWN);
}

function inMode(mode: 'edit' | 'split' | 'preview', pane: 'editor' | 'preview' = 'editor'): AppState {
  return activatePane(setMode(documentState(), mode), pane);
}

let modified = editDocument(inMode('edit'), {
  kind: 'edit',
  operation: { kind: 'insert', text: '\n' }
});
modified = showQuitConfirmation(modified);

const specs: readonly SnapshotSpec[] = [
  { name: 'empty-edit-80x24', state: initialState(), columns: 80, rows: 24 },
  { name: 'split-narrow-60x18', state: inMode('split', 'editor'), columns: 60, rows: 18 },
  { name: 'split-stacked-80x24', state: inMode('split', 'preview'), columns: 80, rows: 24 },
  { name: 'split-wide-120x34', state: inMode('split', 'preview'), columns: 120, rows: 34 },
  { name: 'preview-reading-160x40', state: inMode('preview', 'preview'), columns: 160, rows: 40 },
  { name: 'open-dialog-80x24', state: startFileDialog(inMode('edit'), 'open'), columns: 80, rows: 24 },
  {
    name: 'save-as-error-80x24',
    state: setFileDialogError(startFileDialog(inMode('edit'), 'saveAs'), 'Destination is not writable.'),
    columns: 80,
    rows: 24
  },
  { name: 'unsaved-confirm-80x24', state: modified, columns: 80, rows: 24 },
  { name: 'help-dialog-80x24', state: showHelpDialog(inMode('edit')), columns: 80, rows: 24 }
];

const outputDirectory = path.resolve(process.cwd(), 'snapshots');
await mkdir(outputDirectory, { recursive: true });

for (const spec of specs) {
  const terminalSize = { columns: spec.columns, rows: spec.rows };
  const result = renderElementSnapshot({
    element: view(spec.state, context(spec.columns, spec.rows)),
    terminalSize
  });
  const artifact = [
    `# ${spec.name}`,
    '',
    '## Frame',
    '',
    result.plainTextFrame,
    '',
    '## Accessibility',
    '',
    result.accessibleText,
    '',
    '## Focus targets',
    '',
    result.focusTargetJson,
    ''
  ].join('\n');
  await writeFile(path.join(outputDirectory, `${spec.name}.txt`), artifact, 'utf8');
}

console.log(`Wrote ${String(specs.length)} Vellum visual snapshots to ${outputDirectory}`);
