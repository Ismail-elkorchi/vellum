import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createTextAreaRowOffsetMap,
  textArea,
} from '@ismail-elkorchi/terminal-ui/components';
import type { TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import { renderElementSnapshot } from '@ismail-elkorchi/terminal-ui/testing';
import {
  defineTextWidthProfile,
  measureTextCells,
  textDocumentText,
} from '@ismail-elkorchi/terminal-ui/text';
import { collectMarkdownNodes, countMarkdownDocumentWords, extractMarkdownOutline, parseMarkdown } from 'markspan';
import { createVellumApplication } from '../app/application.js';
import { createHybridTextDecorations } from '../markdown/hybrid.js';
import {
  markdownPreview,
  markdownPreviewActivationAt,
  type MarkdownPreviewAction,
} from '../markdown/render/component.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';
import { vellumBodyGeometry, vellumPaneGeometry } from '../app/viewport-geometry.js';
import { resolveMarkdownLink } from '../navigation/links.js';

test('incremental document metrics and preview block layout equal a fresh parse while reusing identities', async () => {
  const source = [
    '# Heading',
    '',
    'A paragraph with [a link](./target.md).',
    '',
    '- [ ] task',
    '',
    '| A | B |',
    '| - | - |',
    '| x | y |'
  ].join('\n');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'document' });
  try {
    const id = application.openSource(source);
    const firstLayout = application.previewLayout(id, 32);
    assert.equal(firstLayout?.instrumentation.fullPreviewLayout, true);
    const paragraphOffset = source.indexOf('paragraph') + 4;
    application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: paragraphOffset } });
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: ' edited' } });
    const buffer = application.state().project.buffers[id];
    assert.equal(buffer?.preview.kind, 'ready');
    if (buffer?.preview.kind !== 'ready') return;
    assert.ok(buffer.preview.metricUpdate.reusedNodes > 0);
    assert.ok(buffer.preview.metricUpdate.recomputedNodes > 0);
    assert.equal(buffer.preview.metrics.wordCount, countMarkdownDocumentWords(buffer.preview.snapshot.document.tree));
    assert.equal(buffer.preview.metrics.headingCount, flatten(extractMarkdownOutline(buffer.preview.snapshot.document.tree)).length);
    assert.ok((buffer.preview.update?.instrumentation.parsedCodeUnits ?? source.length) < source.length);
    assert.ok((buffer.preview.update?.instrumentation.sourceIndexCodeUnits ?? source.length) < source.length);
    assert.equal(buffer.preview.update?.instrumentation.fullParse, false);
    assert.ok((buffer.preview.update?.instrumentation.parsedNodes ?? 0) > 0);
    assert.ok((buffer.preview.update?.instrumentation.reusedNodes ?? 0) > 0);
    const nextLayout = application.previewLayout(id, 32);
    assert.ok((nextLayout?.instrumentation.reusedBlockLayouts ?? 0) > 0);
    assert.ok((nextLayout?.instrumentation.rebuiltBlockLayouts ?? 0) > 0);
    assert.equal(nextLayout?.instrumentation.fullPreviewLayout, false);
  } finally {
    await application.dispose();
  }
});

test('incremental metrics preserve words across inline boundaries and release removed syntax nodes', async () => {
  const source = 'hel*lo* [link](./target.md)\n\n- [ ] task\n\n[^one]: hidden words';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'metric-boundaries' });
  try {
    const bufferId = application.openSource(source);
    const taskStart = source.indexOf('- [ ] task');
    const taskEnd = source.indexOf('\n\n[^one]');
    application.applyTextAreaTransition(bufferId, {
      kind: 'applyChanges',
      changeSet: { changes: [{ startOffset: taskStart, endOffsetExclusive: taskEnd, insertedText: '' }] }
    });
    const preview = application.state().project.buffers[bufferId]?.preview;
    assert.equal(preview?.kind, 'ready');
    if (preview?.kind !== 'ready') return;
    const fresh = parseMarkdown(preview.snapshot.source, {
      dialect: 'gfm',
      extensions: ['frontMatter', 'callouts', 'math']
    });
    assert.deepEqual(preview.metrics, {
      wordCount: countMarkdownDocumentWords(fresh.tree),
      headingCount: collectMarkdownNodes(fresh.tree, 'heading').length,
      linkCount: collectMarkdownNodes(fresh.tree, 'link').length,
      taskCount: collectMarkdownNodes(fresh.tree, 'listItem').filter((item) => item.task !== null).length
    });
    assert.equal(preview.metrics.wordCount, 2);
    assert.ok(preview.metricUpdate.reusedNodes > 0);
    assert.ok(preview.metricUpdate.removedNodes > 0);
  } finally {
    await application.dispose();
  }
});

test('editor and preview row-offset maps remain source anchored through wrapping and resizing', async () => {
  const source = [
    '# Wide 👩🏽‍💻 heading',
    '',
    '\tCombining e\u0301 text and a long sentence that wraps repeatedly in a narrow terminal.',
    '',
    '> nested quote',
    '',
    '```ts',
    'const value = "wide 界";',
    '```',
    '',
    '| first | second |',
    '| --- | --- |',
    '| one | two |'
  ].join('\n');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'maps' });
  try {
    const id = application.openSource(source);
    const buffer = application.state().project.buffers[id];
    assert.ok(buffer);
    const narrowEditor = createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: 24,
      terminalRows: 12,
      lineNumbers: { minWidth: 3 },
      wrap: { mode: 'soft' },
      scrollbar: { visible: 'auto' }
    });
    const wideEditor = createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: 60,
      terminalRows: 12,
      lineNumbers: { minWidth: 3 },
      wrap: { mode: 'soft' },
      scrollbar: { visible: 'auto' }
    });
    const narrowPreview = application.previewLayout(id, 24)?.rowOffsetMap;
    const widePreview = application.previewLayout(id, 60)?.rowOffsetMap;
    assert.ok(narrowPreview && widePreview);
    assert.ok(narrowEditor.rowCount > wideEditor.rowCount);
    assert.ok(narrowPreview.rowCount >= widePreview.rowCount);
    for (const offset of [0, source.indexOf('Combining'), source.indexOf('const'), source.indexOf('| first'), source.length]) {
      assert.ok(narrowEditor.sourceOffsetAtRow(narrowEditor.rowAtSourceOffset(offset)) <= offset);
      assert.ok(narrowPreview.sourceOffsetAtRow(narrowPreview.rowAtSourceOffset(offset)) <= offset);
    }
    application.dispatchCommand('view.editorPreview');
    const previousSize = { columns: 80, rows: 24 };
    const nextSize = { columns: 120, rows: 24 };
    const previousBody = vellumBodyGeometry(application.state(), previousSize);
    const previousPanes = vellumPaneGeometry(application.state(), previousBody.bodyWidth, previousBody.contentRows);
    assert.ok(previousPanes.editor && previousPanes.preview);
    const previousEditorMap = createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: previousPanes.editor.width,
      terminalRows: previousPanes.editor.rows,
      lineNumbers: { minWidth: 3 }, wrap: { mode: 'soft' }, scrollbar: { visible: 'auto' }
    });
    const previousPreviewMap = application.previewLayout(id, previousPanes.preview.width)?.rowOffsetMap;
    assert.ok(previousPreviewMap);
    const anchor = source.indexOf('const');
    application.applyTextAreaTransition(id, { kind: 'scroll', request: {
      nextState: { offsetRow: previousEditorMap.rowAtSourceOffset(anchor), offsetColumn: 0, followTail: false },
      source: 'keyboard', target: 'content'
    } });
    application.updatePreviewScroll(id, {
      nextState: { offsetRow: previousPreviewMap.rowAtSourceOffset(anchor), offsetColumn: 0, followTail: false },
      source: 'keyboard', target: 'content'
    });
    const previousEditorAnchor = previousEditorMap.sourceOffsetAtRow(application.state().project.buffers[id]?.editor.scroll.offsetRow ?? 0);
    const previousPreviewAnchor = previousPreviewMap.sourceOffsetAtRow(application.state().project.buffers[id]?.previewScroll.offsetRow ?? 0);
    application.resizeTerminal(previousSize, nextSize, defineTextWidthProfile({ ambiguous: 'narrow', emoji: 'wide' }));
    const nextBody = vellumBodyGeometry(application.state(), nextSize);
    const nextPanes = vellumPaneGeometry(application.state(), nextBody.bodyWidth, nextBody.contentRows);
    assert.ok(nextPanes.editor && nextPanes.preview);
    const resized = application.state().project.buffers[id];
    assert.ok(resized);
    const nextEditorMap = createTextAreaRowOffsetMap({
      document: resized.editor.document,
      terminalWidth: nextPanes.editor.width,
      terminalRows: nextPanes.editor.rows,
      lineNumbers: { minWidth: 3 }, wrap: { mode: 'soft' }, scrollbar: { visible: 'auto' }
    });
    const nextPreviewMap = application.previewLayout(id, nextPanes.preview.width)?.rowOffsetMap;
    assert.ok(nextPreviewMap);
    const nextEditorAnchor = nextEditorMap.sourceOffsetAtRow(resized.editor.scroll.offsetRow);
    const nextPreviewAnchor = nextPreviewMap.sourceOffsetAtRow(resized.previewScroll.offsetRow);
    const tree = resized.preview.kind === 'ready' ? resized.preview.snapshot.document.tree : undefined;
    const blockAt = (offset: number) => tree?.children.find((node) => node.span.start <= offset && offset <= node.span.end)?.id;
    assert.equal(blockAt(nextEditorAnchor), blockAt(previousEditorAnchor));
    assert.equal(blockAt(nextPreviewAnchor), blockAt(previousPreviewAnchor));
  } finally {
    await application.dispose();
  }
});

test('Markdown preview geometry follows the active terminal text-width profile', async () => {
  const source = '·· [target](./target.md)';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'width-profile' });
  try {
    const id = application.openSource(source);
    const narrowProfile = defineTextWidthProfile({ ambiguous: 'narrow', emoji: 'wide' });
    const wideProfile = defineTextWidthProfile({ ambiguous: 'wide', emoji: 'wide' });
    const narrow = application.previewLayout(id, 24, darkTerminalMarkdownTheme, narrowProfile);
    const wide = application.previewLayout(id, 24, darkTerminalMarkdownTheme, wideProfile);
    assert.ok(narrow && wide);
    const narrowLink = narrow.activations.find((entry) => entry.activation.kind === 'link');
    const wideLink = wide.activations.find((entry) => entry.activation.kind === 'link');
    assert.ok(narrowLink && wideLink);
    assert.equal(narrowLink.column, 3);
    assert.equal(wideLink.column, 5);
    assert.ok(wide.instrumentation.rebuiltBlockLayouts > 0);

    const preview = markdownPreview({
      id: 'wide-profile-preview',
      label: 'Wide profile preview',
      layout: wide,
      onAction: (action: MarkdownPreviewAction) => action,
    });
    assert.doesNotThrow(() => renderElementSnapshot({
      element: preview,
      terminalSize: { columns: 24, rows: 1 },
      widthProfile: wideProfile,
    }));
    assert.throws(() => renderElementSnapshot({
      element: preview,
      terminalSize: { columns: 24, rows: 1 },
      widthProfile: narrowProfile,
    }), /must use the active terminal text-width profile/u);
  } finally {
    await application.dispose();
  }
});

test('fenced code blank lines retain monotonic preview source geometry', async () => {
  const source = [
    '```ts',
    'const first = 1;',
    '',
    'const second = 2;',
    '```',
  ].join('\n');
  const application = createVellumApplication({
    watchFiles: false,
    createBufferId: () => 'fenced-code-geometry',
  });
  try {
    const id = application.openSource(source);
    const layout = application.previewLayout(id, 40);
    assert.ok(layout);
    const offsets = layout.lines.map((line) => line.sourceOffset);
    assert.deepEqual(offsets, [0, 6, 23, 24]);
    assert.ok(offsets.every((offset, index) => index === 0 || offset >= (offsets[index - 1] ?? 0)));
  } finally {
    await application.dispose();
  }
});

test('preview code layout preserves leading, repeated, and blank-line whitespace', async () => {
  const source = '```text\n  alpha  beta\n\n    gamma\n```';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'preformatted-code' });
  try {
    const bufferId = application.openSource(source);
    await application.refreshPreviewResources(bufferId);
    const lines = application.previewLayout(bufferId, 80)?.lines.map((line) => (
      line.inlineSpans.map((span) => span.text).join('')
    ));
    assert.deepEqual(lines, ['text', '  alpha  beta', '', '    gamma']);
  } finally {
    await application.dispose();
  }
});

test('list and blockquote prefixes follow container semantics across child blocks', async () => {
  const source = '- first\n\n  second paragraph\n\n> quoted first\n>\n> quoted second';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'container-prefixes' });
  try {
    const bufferId = application.openSource(source);
    const lines = application.previewLayout(bufferId, 80)?.lines.map((line) => (
      line.inlineSpans.map((span) => span.text).join('')
    )) ?? [];
    assert.equal(lines.filter((line) => line.startsWith('- ')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('│ ')).length, 2);
  } finally {
    await application.dispose();
  }
});

test('table preview wraps cells within grid width and uses a narrow-terminal fallback', async () => {
  const source = '| First | Second |\n| --- | --- |\n| alphabet soup | another long value |';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'table-width' });
  try {
    const bufferId = application.openSource(source);
    for (const width of [18, 8]) {
      const layout = application.previewLayout(bufferId, width);
      assert.ok(layout);
      assert.equal(layout.lines.every((line) => (
        measureTextCells(line.inlineSpans.map((span) => span.text).join('')).cells <= width
      )), true);
      const offsets = layout.lines.map((line) => line.sourceOffset);
      assert.deepEqual(offsets, offsets.toSorted((left, right) => left - right));
    }
  } finally {
    await application.dispose();
  }
});

test('extension preview and accessibility retain front matter, callout, math, task, table, link, image, and footnote semantics', async () => {
  const source = [
    '---', 'title: Example', 'owner: Editor', '---', '',
    '# Heading', '',
    '> [!WARNING]', '> Read [the guide](./guide.md) and note[^one].', '',
    '- [x] complete', '',
    '| Name | Value |', '| --- | --- |', '| image | ![pixel](pixel.png) |', '',
    '$x^2$', '', '$$', '\\frac{1}{2}', '$$', '',
    '[^one]: Footnote text.'
  ].join('\n');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'semantics' });
  try {
    const id = application.openSource(source);
    await application.refreshPreviewResources(id);
    const layout = application.previewLayout(id, 50);
    assert.ok(layout);
    const roles = accessibleRoles(layout.accessibility);
    for (const role of ['frontMatter', 'heading', 'note', 'link', 'checkbox', 'table', 'image', 'math', 'footnote']) {
      assert.ok(roles.has(role), `Missing accessible Markdown role: ${role}`);
    }
    const snapshot = renderElementSnapshot({
      element: markdownPreview({
        id: 'semantic-preview',
        label: 'Rendered Markdown',
        layout,
        onAction: (action: MarkdownPreviewAction) => action,
      }),
      terminalSize: { columns: 50, rows: layout.lines.length },
    });
    assert.equal(snapshot.frame.accessibility.root.role, 'document');
    assert.equal(snapshot.frame.accessibility.root.label, 'Rendered Markdown');
    assert.ok(accessibleTerminalRoles(snapshot.frame.accessibility.root).has('link'));
    assert.ok(accessibleTerminalRoles(snapshot.frame.accessibility.root).has('checkbox'));
    assert.equal(snapshot.frame.hitTargets?.length, 1 + layout.activations.length);
    const rendered = layout.lines.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n');
    assert.match(rendered, /title: Example/u);
    assert.match(rendered, /WARNING:/u);
    assert.match(rendered, /x²/u);
  } finally {
    await application.dispose();
  }
});

test('malformed front matter renders Markspan diagnostics without changing the source document', async () => {
  const source = '---\nroot:\n    valid: true\n  invalid: indentation\n---';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'invalid-front-matter' });
  try {
    const id = application.openSource(source);
    const layout = application.previewLayout(id, 60);
    assert.ok(layout);
    const rendered = layout.lines.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n');
    assert.match(rendered, /Front matter error: Unexpected YAML indentation/u);
    assert.equal(accessibleRoles(layout.accessibility).has('diagnostic'), true);
    assert.equal(sourceText(application, id), source);
  } finally {
    await application.dispose();
  }
});

test('Markdown-aware editing makes one exact undo entry and round-trips nested operations', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'editing' });
  try {
    const id = application.openSource('- parent');
    application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 8 } });
    const sources = ['- parent'];
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: '\n' } });
    sources.push('- parent\n- ');
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'child' } });
    sources.push('- parent\n- child');
    application.indentList(id, false);
    sources.push('- parent\n    - child');
    application.executeMarkdownCommand(id, 'markdown.toggleTask');
    sources.push('- parent\n    - [ ] child');
    for (let index = sources.length - 2; index >= 0; index -= 1) {
      application.executeMarkdownCommand(id, 'edit.undo');
      assert.equal(sourceText(application, id), sources[index]);
    }
    for (let index = 1; index < sources.length; index += 1) {
      application.executeMarkdownCommand(id, 'edit.redo');
      assert.equal(sourceText(application, id), sources[index]);
    }
  } finally {
    await application.dispose();
  }
});

test('hybrid editing preserves exact source through concealed ranges, selection, paste, undo, redo, wide graphemes, and resizing', async () => {
  const source = '**bold 👩🏽‍💻** and [link](target.md) with `code 界`\n- [x] task';
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'hybrid' });
  try {
    const id = application.openSource(source);
    application.applyTextAreaTransition(id, {
      kind: 'pointer',
      transition: { kind: 'placeCaret', offset: source.indexOf(' and ') + 2 },
    });
    const buffer = application.state().project.buffers[id];
    assert.ok(buffer);
    const inactive = createHybridTextDecorations(buffer, darkTerminalMarkdownTheme);
    const rendered = renderElementSnapshot({
      element: textArea({
        id: 'hybrid-source',
        state: {
          document: buffer.editor.document,
          caret: buffer.editor.caret,
          scroll: buffer.editor.scroll,
        },
        decorations: inactive,
        meta: { accessibleName: 'Hybrid source' },
        onTransition: (transition: TextAreaTransition) => transition,
      }),
      terminalSize: { columns: 36, rows: 3 },
    });
    assert.match(rendered.plainTextFrame, /link with code/u);
    assert.doesNotMatch(rendered.plainTextFrame, /\*\*bold\*\*/u);
    assert.match(rendered.plainTextFrame, /☑ task/u);
    const strongEnd = source.indexOf(' and ');
    application.applyTextAreaTransition(id, {
      kind: 'pointer', transition: { kind: 'extendSelection', anchor: 0, offset: strongEnd }
    });
    const enclosingSelection = application.state().project.buffers[id];
    assert.ok(enclosingSelection);
    const selectedStrong = renderElementSnapshot({
      element: textArea({
        id: 'selected-strong-source',
        state: enclosingSelection.editor,
        decorations: createHybridTextDecorations(enclosingSelection, darkTerminalMarkdownTheme),
        meta: { accessibleName: 'Selected strong source' },
        onTransition: (transition: TextAreaTransition) => transition
      }),
      terminalSize: { columns: 72, rows: 2 }
    });
    assert.match(selectedStrong.plainTextFrame, /\*\*bold 👩🏽‍💻\*\*/u);
    application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 3 } });
    const activeBuffer = application.state().project.buffers[id];
    assert.ok(activeBuffer);
    const active = renderElementSnapshot({
      element: textArea({
        id: 'active-hybrid-source',
        state: activeBuffer.editor,
        decorations: createHybridTextDecorations(activeBuffer, darkTerminalMarkdownTheme),
        meta: { accessibleName: 'Active hybrid source' },
        onTransition: (transition: TextAreaTransition) => transition,
      }),
      terminalSize: { columns: 72, rows: 2 },
    });
    assert.match(active.plainTextFrame, /\*\*bold 👩🏽‍💻\*\*/u);
    application.applyTextAreaTransition(id, {
      kind: 'pointer', transition: { kind: 'placeCaret', offset: source.indexOf('target.md') + 2 }
    });
    const linkBuffer = application.state().project.buffers[id];
    assert.ok(linkBuffer);
    const activeLink = renderElementSnapshot({
      element: textArea({
        id: 'active-hybrid-link', state: linkBuffer.editor,
        decorations: createHybridTextDecorations(linkBuffer, darkTerminalMarkdownTheme),
        meta: { accessibleName: 'Active hybrid link source' },
        onTransition: (transition: TextAreaTransition) => transition
      }),
      terminalSize: { columns: 72, rows: 2 }
    });
    assert.match(activeLink.plainTextFrame, /\[link\]\(target\.md\)/u);
    assert.equal(sourceText(application, id), source);
    const selectionStart = source.indexOf('bold');
    const selectionEnd = source.indexOf('code') + 'code 界'.length;
    application.applyTextAreaTransition(id, {
      kind: 'pointer', transition: { kind: 'extendSelection', anchor: selectionStart, offset: selectionEnd }
    });
    const selected = application.state().project.buffers[id]?.editor.selection;
    assert.ok(selected);
    const copyStart = Math.min(selected.anchor.offset, selected.focus.offset);
    const copyEnd = Math.max(selected.anchor.offset, selected.focus.offset);
    assert.equal(source.slice(copyStart, copyEnd), 'bold 👩🏽‍💻** and [link](target.md) with `code 界');
    application.applyTextAreaTransition(id, {
      kind: 'edit', operation: { kind: 'replaceSelection', text: 'pasted 👩🏽‍💻 source' }
    });
    const pasted = sourceText(application, id);
    application.executeMarkdownCommand(id, 'edit.undo');
    assert.equal(sourceText(application, id), source);
    application.executeMarkdownCommand(id, 'edit.redo');
    assert.equal(sourceText(application, id), pasted);
    const resizedBuffer = application.state().project.buffers[id];
    assert.ok(resizedBuffer);
    for (const columns of [22, 72]) {
      assert.doesNotThrow(() => renderElementSnapshot({
        element: textArea({
          id: `resized-hybrid-${String(columns)}`,
          state: resizedBuffer.editor,
          decorations: createHybridTextDecorations(resizedBuffer, darkTerminalMarkdownTheme),
          meta: { accessibleName: 'Resized hybrid source' },
          onTransition: (transition: TextAreaTransition) => transition
        }),
        terminalSize: { columns, rows: 4 }
      }));
    }
  } finally {
    await application.dispose();
  }
});

test('preview activation maps terminal cells to exact inline spans and navigates files, headings, and footnotes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-preview-navigation-'));
  const sourcePath = path.join(directory, 'source.md');
  const targetPath = path.join(directory, 'target.md');
  const openedUrls: string[] = [];
  try {
    const source = '# Source\n\n界 [target](./target.md#destination) and [web](https://example.test). Note[^one].\n\n[^one]: Detail.';
    await writeFile(sourcePath, source, 'utf8');
    await writeFile(targetPath, '# Top\n\n## Destination\n', 'utf8');
    const application = createVellumApplication({
      watchFiles: false,
      createBufferId: (() => { let next = 0; return () => `navigation-${String(next++)}`; })(),
      openExternalLink: async (url) => { openedUrls.push(url.href); }
    });
    try {
      const sourceId = await application.openFile(sourcePath);
      const layout = application.previewLayout(sourceId, 72);
      assert.ok(layout);
      const focusedLink = layout.activations.find((entry) => (
        entry.activation.kind === 'link'
        && entry.activation.destination === 'https://example.test'
      ));
      assert.ok(focusedLink);
      const focusedPreview = renderElementSnapshot({
        element: markdownPreview({
          id: 'keyboard-preview',
          label: 'Keyboard preview',
          layout,
          onAction: (action: MarkdownPreviewAction) => action,
        }),
        terminalSize: { columns: 72, rows: layout.lines.length },
        focusPath: ['keyboard-preview', focusedLink.id],
      });
      assert.equal(focusedPreview.frame.accessibility.focusPath[0], 'keyboard-preview');
      assert.equal(
        focusedPreview.frame.accessibility.focusPath.at(-1),
        `keyboard-preview:${focusedLink.id}`,
      );
      assert.ok(focusedPreview.frame.cells.some((cell) => cell.style?.inverse === true));
      assert.match(focusedPreview.hitTargetJson, new RegExp(focusedLink.id, 'u'));

      const documentTarget = markdownPreviewActivationAt(layout, 0, 0);
      assert.ok(documentTarget);
      await application.activatePreview(sourceId, documentTarget);
      assert.equal(application.state().project.buffers[sourceId]?.editor.caret.position.offset, 0);

      await application.activatePreview(sourceId, activationTarget(layout, 'link', './target.md#destination'));
      const target = application.state().project.buffers[application.state().project.activeBufferId as string];
      assert.equal(target?.path, targetPath);
      assert.equal(target?.editor.caret.position.offset, 7);

      application.activateBuffer(sourceId);
      await application.activatePreview(sourceId, activationTarget(layout, 'footnote'));
      assert.equal(application.state().project.buffers[sourceId]?.editor.caret.position.offset, source.indexOf('[^one]:'));

      await application.activatePreview(sourceId, activationTarget(layout, 'link', 'https://example.test'));
      assert.deepEqual(openedUrls, ['https://example.test/']);
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local link resolution decodes paths and resolves unique duplicate heading fragments', () => {
  const sourcePath = path.join('/project', 'notes', 'source.md');
  const tree = parseMarkdown('# Repeat\n\n# Repeat-1\n\n# Repeat\n').tree;
  const duplicate = resolveMarkdownLink('#repeat-2', sourcePath, tree);
  assert.equal(duplicate.kind, 'source');
  if (duplicate.kind === 'source') assert.equal(duplicate.sourceOffset, tree.children[2]?.span.start);
  const encoded = resolveMarkdownLink('../target%20file.md#section_name', sourcePath, tree);
  assert.deepEqual(encoded, {
    kind: 'source',
    path: path.resolve(path.dirname(sourcePath), '..', 'target file.md')
  });
  assert.throws(() => resolveMarkdownLink('target%ZZ.md', sourcePath), /invalid percent encoding/u);
});

test('automatic marker pairing handles strong markers, closing markers, code fences, and literal code context', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: (() => {
    let next = 0;
    return () => `pairs-${String(next++)}`;
  })() });
  try {
    const strong = application.openSource('');
    application.applyTextAreaTransition(strong, { kind: 'edit', operation: { kind: 'insert', text: '**' } });
    assert.equal(sourceText(application, strong), '****');
    assert.equal(application.state().project.buffers[strong]?.editor.caret.position.offset, 2);
    application.applyTextAreaTransition(strong, { kind: 'edit', operation: { kind: 'deleteBackward' } });
    assert.equal(sourceText(application, strong), '');

    const bracket = application.openSource('');
    application.applyTextAreaTransition(bracket, { kind: 'edit', operation: { kind: 'insert', text: '[' } });
    application.applyTextAreaTransition(bracket, { kind: 'edit', operation: { kind: 'insert', text: ']' } });
    assert.equal(sourceText(application, bracket), '[]');
    assert.equal(application.state().project.buffers[bracket]?.editor.caret.position.offset, 2);

    const fence = application.openSource('');
    application.applyTextAreaTransition(fence, { kind: 'edit', operation: { kind: 'insert', text: '```' } });
    assert.equal(sourceText(application, fence), '```\n\n```');
    assert.equal(application.state().project.buffers[fence]?.editor.caret.position.offset, 4);
    application.applyTextAreaTransition(fence, { kind: 'edit', operation: { kind: 'insert', text: '*' } });
    assert.equal(sourceText(application, fence), '```\n*\n```');
  } finally {
    await application.dispose();
  }
});

test('inline toggles preserve crossed syntax and GFM table formatting aligns Unicode by terminal cells', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: (() => {
    let next = 0;
    return () => `format-${String(next++)}`;
  })() });
  try {
    const inline = application.openSource('**bold** and plain');
    application.applyTextAreaTransition(inline, {
      kind: 'pointer', transition: { kind: 'endSelection', anchor: 12, offset: 4 }
    });
    application.executeMarkdownCommand(inline, 'markdown.toggleEmphasis');
    assert.equal(sourceText(application, inline), '**bo*ld** and* plain');
    application.executeMarkdownCommand(inline, 'edit.undo');
    assert.equal(sourceText(application, inline), '**bold** and plain');

    const table = application.openSource('| Name | Value |\n| --- | --- |\n| 界 | é |');
    application.applyTextAreaTransition(table, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 38 } });
    application.executeMarkdownCommand(table, 'markdown.formatTable');
    const lines = sourceText(application, table).split('\n');
    const widths = lines.map((line) => line.split('|').slice(1, -1).map((cell) => measureTextCells(cell).cells));
    assert.deepEqual(widths[0], widths[1]);
    assert.deepEqual(widths[1], widths[2]);
  } finally {
    await application.dispose();
  }
});

function sourceText(application: ReturnType<typeof createVellumApplication>, id: string): string {
  const buffer = application.state().project.buffers[id];
  assert.ok(buffer);
  return textDocumentText(buffer.editor.document);
}

function flatten(entries: ReturnType<typeof extractMarkdownOutline>): ReturnType<typeof extractMarkdownOutline> {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}

function activationTarget(
  layout: NonNullable<ReturnType<ReturnType<typeof createVellumApplication>['previewLayout']>>,
  kind: 'link' | 'footnote',
  destination?: string
): NonNullable<ReturnType<typeof markdownPreviewActivationAt>> {
  for (let row = 0; row < layout.lines.length; row += 1) {
    let column = 0;
    for (const span of layout.lines[row]?.inlineSpans ?? []) {
      if (span.activation?.kind === kind && (destination === undefined || ('destination' in span.activation && span.activation.destination === destination))) {
        const target = markdownPreviewActivationAt(layout, row, column);
        if (target !== undefined) return target;
      }
      column += measureTextCells(span.text).cells;
    }
  }
  throw new Error(`Missing ${kind} activation.`);
}

function accessibleRoles(
  node: NonNullable<ReturnType<ReturnType<typeof createVellumApplication>['previewLayout']>>['accessibility']
): ReadonlySet<string> {
  const roles = new Set<string>([node.role]);
  for (const child of node.children) for (const role of accessibleRoles(child)) roles.add(role);
  return roles;
}

function accessibleTerminalRoles(
  node: ReturnType<typeof renderElementSnapshot>['frame']['accessibility']['root']
): ReadonlySet<string> {
  const roles = new Set<string>([node.role]);
  for (const child of node.children ?? []) {
    for (const role of accessibleTerminalRoles(child)) roles.add(role);
  }
  return roles;
}
