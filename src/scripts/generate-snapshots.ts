import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryTerminalHost, type TerminalSize } from '@ismail-elkorchi/terminal-ui/host';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createVellumApplication, type VellumApplication } from '../app/application.js';
import type { AppState, ExternalFileFingerprint, ProjectDocumentIndexEntry } from '../app/types.js';
import { initialAppState } from '../commands/registry.js';
import { createVellumTui } from '../tui.js';

const documentSource = [
  '---', 'title: Snapshot', 'status: draft', '---', '',
  '# Heading', '',
  'Paragraph with **strong text**, [a link](./target.md), العربية, עברית, 日本語, and 😀.', '',
  '> [!NOTE]', '> A source-exact callout.', '',
  '| Name | Value |', '| :--- | ---: |', '| alpha | 42 |', '',
  '- [ ] open task', '- [x] complete task', '',
  '$$', '\\frac{x^2}{2}', '$$', '',
  '[TOC]', '',
  '## Details', '', 'Final paragraph.'
].join('\n');

const scenarios: Array<{ readonly name: string; readonly size: TerminalSize; readonly create: () => Promise<VellumApplication> }> = [
  { name: 'empty-60x18', size: { columns: 60, rows: 18 }, create: async () => createVellumApplication({ watchFiles: false }) },
  { name: 'source-80x24', size: { columns: 80, rows: 24 }, create: () => documentApplication('source', 'editor') },
  { name: 'hybrid-120x34', size: { columns: 120, rows: 34 }, create: () => documentApplication('hybrid', 'editor') },
  { name: 'preview-160x40', size: { columns: 160, rows: 40 }, create: () => documentApplication('source', 'preview') },
  { name: 'split-120x34', size: { columns: 120, rows: 34 }, create: () => documentApplication('hybrid', 'editorPreview') },
  { name: 'project-tree', size: { columns: 100, rows: 28 }, create: () => applicationWithState(projectState()) },
  { name: 'dirty-tabs', size: { columns: 100, rows: 26 }, create: dirtyTabs },
  { name: 'quick-open', size: { columns: 100, rows: 28 }, create: () => dialogApplication('file.quickOpen') },
  { name: 'outline', size: { columns: 100, rows: 28 }, create: () => dialogApplication('navigate.outline') },
  { name: 'project-search', size: { columns: 100, rows: 28 }, create: () => dialogApplication('file.searchProjectDirectory') },
  { name: 'document-replace', size: { columns: 100, rows: 28 }, create: () => dialogApplication('edit.replace') },
  { name: 'diagnostics', size: { columns: 100, rows: 28 }, create: diagnosticsApplication },
  { name: 'external-conflict', size: { columns: 100, rows: 28 }, create: () => externalState('conflict') },
  { name: 'deleted-file', size: { columns: 100, rows: 28 }, create: () => externalState('deleted') },
  { name: 'dirty-close', size: { columns: 80, rows: 24 }, create: dirtyClose },
  { name: 'recovery-selection', size: { columns: 100, rows: 28 }, create: recoverySelection },
  { name: 'export-progress', size: { columns: 100, rows: 28 }, create: exportProgress },
  { name: 'narrow-fallback', size: { columns: 42, rows: 14 }, create: () => documentApplication('hybrid', 'editorPreview') }
];

const snapshots = [];
for (const scenario of scenarios) {
  const application = await scenario.create();
  const host = createMemoryTerminalHost({ terminalSize: scenario.size });
  const runtime = createTuiRuntime({ app: createVellumTui(application), host });
  try {
    const frame = await runtime.start();
    snapshots.push(Object.freeze({
      name: scenario.name,
      size: scenario.size,
      frame: renderFramePlain(frame),
      accessibility: frame.accessibility
    }));
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
}

const output = JSON.stringify(snapshots, null, 2) + '\n';
const filePath = path.join(process.cwd(), 'snapshots', 'application.json');
if (process.argv.includes('--write')) await writeFile(filePath, output, 'utf8');
else {
  const current = await readFile(filePath, 'utf8');
  if (current !== output) throw new Error('Application snapshots are stale. Run npm run snapshots:update.');
}

async function documentApplication(editorMode: AppState['editorMode'], paneArrangement: AppState['paneArrangement']): Promise<VellumApplication> {
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'document' });
  const id = application.openSource(documentSource, 'document.md');
  if (editorMode === 'hybrid') application.dispatchCommand('view.editorHybrid');
  if (paneArrangement === 'preview') application.dispatchCommand('view.preview');
  else if (paneArrangement === 'editorPreview') application.dispatchCommand('view.editorPreview');
  await application.refreshPreviewResources(id);
  return application;
}

async function dirtyTabs(): Promise<VellumApplication> {
  let next = 0;
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => `buffer-${String(++next)}` });
  application.openSource('# First\n\nUnsaved first.', 'first.md');
  application.openSource('# Second\n\nUnsaved second.', 'second.md');
  return application;
}

async function dialogApplication(command: Parameters<VellumApplication['dispatchCommand']>[0]): Promise<VellumApplication> {
  const base = await documentApplication('source', 'editor');
  const state = projectState(base.state());
  await base.dispose();
  const application = await applicationWithState(state);
  application.dispatchCommand(command);
  return application;
}

async function diagnosticsApplication(): Promise<VellumApplication> {
  const base = await documentApplication('source', 'editor');
  const id = base.state().project.activeBufferId as string;
  const state: AppState = Object.freeze({
    ...base.state(),
    navigator: Object.freeze({ ...base.state().navigator, mode: 'diagnostics', visible: true }),
    diagnostics: Object.freeze({
      [id]: Object.freeze([Object.freeze({
        id: 'snapshot-diagnostic', source: 'links', severity: 'error', rule: 'links.missing',
        span: Object.freeze({ start: 40, end: 44 }), message: 'Linked document does not exist: target.md',
        providerRevision: 0, fixes: Object.freeze([])
      })])
    })
  });
  await base.dispose();
  return applicationWithState(state);
}

async function externalState(kind: 'conflict' | 'deleted'): Promise<VellumApplication> {
  const base = await documentApplication('source', 'editor');
  const id = base.state().project.activeBufferId as string;
  const buffer = base.state().project.buffers[id] as NonNullable<AppState['project']['buffers'][string]>;
  const fingerprint = fakeFingerprint();
  const changed = Object.freeze({
    ...buffer,
    path: '/workspace/project/document.md',
    externalFileState: kind === 'conflict'
      ? Object.freeze({ kind: 'conflict' as const, disk: fingerprint })
      : Object.freeze({ kind: 'deleted' as const, previous: fingerprint })
  });
  const state = Object.freeze({
    ...base.state(),
    project: Object.freeze({ ...base.state().project, buffers: Object.freeze({ [id]: changed }) })
  });
  await base.dispose();
  return applicationWithState(state);
}

async function dirtyClose(): Promise<VellumApplication> {
  const application = await documentApplication('source', 'editor');
  application.requestCloseBuffer(application.state().project.activeBufferId as string);
  return application;
}

async function recoverySelection(): Promise<VellumApplication> {
  const state = initialAppState();
  return createVellumApplication({
    watchFiles: false,
    initialState: state,
    recoveryJournal: Object.freeze({
      schemaVersion: 1,
      snapshots: Object.freeze([1, 2].map((generation) => Object.freeze({
        generation,
        timestamp: `2026-08-31T0${String(generation)}:00:00.000Z`,
        buffers: Object.freeze([Object.freeze({
          id: 'draft', label: 'draft.md', source: `draft ${String(generation)}`, checksum: 'unused-in-view',
          savedSourceRevision: 0, currentSourceRevision: generation,
          externalFileState: Object.freeze({ kind: 'untracked' as const }),
          format: Object.freeze({ bom: false, lineEnding: 'lf' as const })
        })])
      })))
    })
  });
}

async function exportProgress(): Promise<VellumApplication> {
  const base = await documentApplication('source', 'editor');
  const state: AppState = Object.freeze({
    ...base.state(),
    navigator: Object.freeze({ ...base.state().navigator, mode: 'export', visible: true }),
    exports: Object.freeze({
      activeId: 'export-1',
      lastRequest: Object.freeze({ scope: 'activeBuffer', profileId: 'html' }),
      history: Object.freeze([Object.freeze({
        id: 'export-1', scope: 'activeBuffer', profileId: 'html', status: 'running',
        startedAt: '2026-08-31T12:00:00.000Z', outputPaths: Object.freeze([]), standardError: '', usedUnsavedSource: true
      })])
    })
  });
  await base.dispose();
  return applicationWithState(state);
}

function projectState(seed: AppState = initialAppState()): AppState {
  const root = '/workspace/project';
  const document = '/workspace/project/document.md';
  const asset = '/workspace/project/assets';
  const indexed: ProjectDocumentIndexEntry = Object.freeze({
    path: document, relativePath: 'document.md', size: documentSource.length, modifiedMilliseconds: 1,
    contentHash: 'snapshot', headings: Object.freeze([{ text: 'Heading', depth: 1, sourceOffset: 0 }]),
    links: Object.freeze([]), properties: Object.freeze({ status: 'draft' }), taskStates: Object.freeze([false]),
    tags: Object.freeze(['snapshot']), citationKeys: Object.freeze([]), searchableText: documentSource
  });
  return Object.freeze({
    ...seed,
    project: Object.freeze({
      ...seed.project,
      rootDirectory: root,
      recentProjects: Object.freeze([root]),
      fileTree: Object.freeze({
        ...seed.project.fileTree,
        nodes: Object.freeze({
          [root]: Object.freeze({ id: root, path: root, label: 'project', kind: 'directory', loaded: true, loading: false, children: Object.freeze([document, asset]) }),
          [document]: Object.freeze({ id: document, path: document, label: 'document.md', kind: 'file', parentId: root, loaded: true, loading: false, children: Object.freeze([]) }),
          [asset]: Object.freeze({ id: asset, path: asset, label: 'assets', kind: 'directory', parentId: root, loaded: false, loading: false, children: Object.freeze([]) })
        }),
        rootIds: Object.freeze([root]), expandedIds: Object.freeze([root]), pendingExpansionIds: Object.freeze([]),
        activeId: document, exclusionPatterns: Object.freeze(['.git', 'node_modules']), filter: '', sort: 'foldersFirst', revision: 1
      }),
      index: Object.freeze({ documents: Object.freeze({ [document]: indexed }), orderedPaths: Object.freeze([document]), assetPaths: Object.freeze([]), indexing: false, revision: 1 })
    })
  });
}

async function applicationWithState(state: AppState): Promise<VellumApplication> {
  return createVellumApplication({ watchFiles: false, initialState: state });
}

function fakeFingerprint(): ExternalFileFingerprint {
  return Object.freeze({
    realPath: '/workspace/project/document.md', device: '1', inode: '2', size: 10,
    modifiedNanoseconds: '3', contentHash: '0'.repeat(64)
  });
}
