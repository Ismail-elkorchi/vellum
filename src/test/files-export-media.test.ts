import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTextAreaRowOffsetMap } from '@ismail-elkorchi/terminal-ui/components';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { defaultTextWidthProfile, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { collectMarkdownNodes, parseMarkdown } from 'markspan';
import {
  createCodeHighlighter,
  type CodeHighlightLanguage,
  type CodeTokenizer,
  type CodeTokenizerContext
} from '../markdown/highlight.js';
import { createMathRenderer } from '../markdown/math.js';
import { createMarkdownImageLoader } from '../markdown/image-loader.js';
import { createDiagramRendererRegistry } from '../markdown/diagram.js';
import { readSourceFile, saveSourceFile } from '../files/file-system.js';
import { batchExportDirectory, exportDocument } from '../export/exporter.js';
import { builtInExportProfiles, loadUserExportProfiles, type ExportProfile } from '../export/profiles.js';
import { exportProjectManifest, loadProjectManifest } from '../export/project.js';
import { createVellumApplication } from '../app/application.js';
import {
  vellumBodyGeometry,
  vellumPaneGeometry,
  vellumPreviewDocumentGeometry,
} from '../app/viewport-geometry.js';
import { loadUserMarkdownTheme } from '../markdown/theme.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';
import { renderCodeBlock } from '../markdown/render/code.js';
import { createVellumTui } from '../tui.js';
import { compareSourceLines } from '../files/diff.js';
import sharp from 'sharp';
import { externalMathProvider } from '../markdown/math.js';

test('source file I/O preserves exact path, BOM, CRLF, permissions, and symbolic links', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-files-'));
  const target = path.join(directory, 'target.markdown');
  const link = path.join(directory, 'linked-note');
  try {
    await writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nsecond\r\n')]));
    if (process.platform !== 'win32') await chmod(target, 0o640);
    await symlink(target, link, 'file');
    const opened = await readSourceFile(link);
    assert.equal(opened.path, link);
    assert.equal(opened.source, 'first\r\nsecond\r\n');
    assert.equal(opened.format.bom, true);
    assert.equal(opened.format.lineEnding, 'crlf');
    if (process.platform !== 'win32') await chmod(target, 0o600);
    await saveSourceFile(link, 'changed\r\n', { format: opened.format, expectedFingerprint: opened.fingerprint });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.deepEqual([...await readFile(target)].slice(0, 3), [0xef, 0xbb, 0xbf]);
    assert.equal((await readSourceFile(link)).source, 'changed\r\n');
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomic creation admits one writer and never replaces a concurrently created file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-save-race-'));
  const destination = path.join(directory, 'new.md');
  const format = Object.freeze({ bom: false, lineEnding: 'lf' as const });
  try {
    const results = await Promise.allSettled([
      saveSourceFile(destination, 'first writer\n', { format }),
      saveSourceFile(destination, 'second writer\n', { format })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.match(String(rejected.reason), /already exists/u);
    const source = (await readSourceFile(destination)).source;
    assert.equal(source === 'first writer\n' || source === 'second writer\n', true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saving never replaces a broken symbolic link with a regular file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-broken-link-'));
  const destination = path.join(directory, 'document.md');
  try {
    await symlink(path.join(directory, 'missing.md'), destination, 'file');
    await assert.rejects(
      saveSourceFile(destination, 'replacement\n', {
        format: Object.freeze({ bom: false, lineEnding: 'lf' }),
        overwriteExisting: true
      }),
      /symbolic link whose target does not exist/u
    );
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opening another path to an open file activates and refreshes its existing buffer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-file-alias-'));
  const target = path.join(directory, 'target.md');
  const link = path.join(directory, 'link.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'aliased-buffer' });
  try {
    await writeFile(target, 'original source', 'utf8');
    await symlink(target, link, 'file');
    const firstId = await application.openFile(link);
    await writeFile(target, '# Changed target', 'utf8');
    const secondId = await application.openFile(target);
    assert.equal(secondId, firstId);
    assert.equal(application.state().project.bufferOrder.length, 1);
    assert.equal(textDocumentText(application.state().project.buffers[firstId]?.editor.document as never), '# Changed target');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary and Markdown-aware edits preserve a CRLF source document line-ending contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-crlf-editing-'));
  const sourcePath = path.join(directory, 'document.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'crlf' });
  try {
    await writeFile(sourcePath, 'alpha\r\nbeta', 'utf8');
    const bufferId = await application.openFile(sourcePath);
    application.applyTextAreaTransition(bufferId, {
      kind: 'pointer', transition: { kind: 'placeCaret', offset: 5 }
    });
    application.applyTextAreaTransition(bufferId, { kind: 'edit', operation: { kind: 'insert', text: '\n' } });
    application.applyTextAreaTransition(bufferId, {
      kind: 'pointer', transition: { kind: 'extendSelection', anchor: 9, offset: 13 }
    });
    application.executeMarkdownCommand(bufferId, 'markdown.insertCodeFence', { codeLanguage: 'text' });
    const buffer = application.state().project.buffers[bufferId];
    assert.ok(buffer);
    const source = textDocumentText(buffer.editor.document);
    assert.equal(source.replaceAll('\r\n', '').includes('\n'), false);
    assert.equal(source, 'alpha\r\n\r\n```text\r\nbeta\r\n```');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('user Markdown themes validate semantic keys and terminal colors at the configuration boundary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-theme-'));
  const themePath = path.join(directory, 'markdown-theme.json');
  try {
    await writeFile(themePath, JSON.stringify({
      body: { bold: true, fg: { kind: 'theme', token: 'text.default' } },
      callouts: { warning: { underline: true } }
    }), 'utf8');
    const valid = await loadUserMarkdownTheme(themePath);
    assert.deepEqual(valid.diagnostics, []);
    assert.equal(valid.theme.body.bold, true);
    assert.equal(valid.theme.callouts.warning.underline, true);

    await writeFile(themePath, JSON.stringify({ unknownStyle: {}, body: { fg: { kind: 'rgb', r: 999, g: 0, b: 0 } } }), 'utf8');
    const invalid = await loadUserMarkdownTheme(themePath);
    assert.deepEqual(invalid.diagnostics.map((diagnostic) => diagnostic.key), ['unknownStyle', 'body.fg']);

    await writeFile(themePath, JSON.stringify({
      strong: { fg: { kind: 'rgb', r: -1, g: 0, b: 0 }, unsupportedOne: true, unsupportedTwo: true }
    }), 'utf8');
    const invalidStyle = await loadUserMarkdownTheme(themePath);
    assert.equal(invalidStyle.theme.strong.fg, undefined);
    assert.deepEqual(invalidStyle.diagnostics.map((diagnostic) => diagnostic.key), [
      'strong.unsupportedOne',
      'strong.unsupportedTwo',
      'strong.fg'
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export invokes an executable directly with deterministic Pandoc arguments and protects output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-export-'));
  const script = path.join(directory, 'export-double.mjs');
  const failingScript = path.join(directory, 'failing-export-double.mjs');
  const source = path.join(directory, 'document.md');
  const output = path.join(directory, 'document.html');
  try {
    await writeFile(source, '# Export', 'utf8');
    await writeFile(script, [
      "import { writeFile } from 'node:fs/promises';",
      "const outputIndex = process.argv.indexOf('--output');",
      "await writeFile(process.argv[outputIndex + 1], JSON.stringify(process.argv.slice(2)), 'utf8');"
    ].join('\n'), 'utf8');
    await writeFile(failingScript, [
      "import { writeFile } from 'node:fs/promises';",
      "const outputIndex = process.argv.indexOf('--output');",
      "await writeFile(process.argv[outputIndex + 1], 'partial output', 'utf8');",
      "process.stderr.write('conversion failed');",
      'process.exitCode = 7;'
    ].join('\n'), 'utf8');
    const profile: ExportProfile = Object.freeze({
      ...builtInExportProfiles[0] as ExportProfile,
      id: 'test-html', label: 'Test HTML', executable: process.execPath,
      arguments: Object.freeze([script]), resourcePaths: Object.freeze(['images'])
    });
    const result = await exportDocument({ kind: 'disk', path: source }, profile, { outputPath: output });
    assert.equal(result.executable, process.execPath);
    assert.ok(result.arguments.some((argument) => argument.startsWith('--from=markdown+')));
    assert.ok(result.arguments.includes('--to=html5'));
    assert.ok(result.arguments.includes(output));
    assert.match(await readFile(output, 'utf8'), /document\.md/u);
    await assert.rejects(() => exportDocument({ kind: 'disk', path: source }, profile, { outputPath: output }), /already exists/u);
    await exportDocument({ kind: 'disk', path: source }, profile, { outputPath: output, overwrite: true });
    await writeFile(output, 'preserved output', 'utf8');
    await assert.rejects(
      exportDocument(
        { kind: 'disk', path: source },
        { ...profile, arguments: Object.freeze([failingScript]) },
        { outputPath: output, overwrite: true }
      ),
      /conversion failed/u
    );
    assert.equal(await readFile(output, 'utf8'), 'preserved output');
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.includes('.vellum-')), []);
    await assert.rejects(() => exportDocument({ kind: 'disk', path: source }, profile, { outputPath: source, overwrite: true }), /must not replace/u);
    await assert.rejects(() => exportDocument({ kind: 'disk', path: source }, profile, {
      outputPath: path.join(directory, 'invalid-timeout.html'), timeoutMilliseconds: 0
    }), /positive integer/u);
    const missing = { ...profile, executable: path.join(directory, 'missing-executable') };
    const missingOutput = path.join(directory, 'missing.html');
    await assert.rejects(() => exportDocument({ kind: 'disk', path: source }, missing, { outputPath: missingOutput }), /not found/u);
    await assert.rejects(() => readFile(missingOutput), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('user export profiles load through one validated CLI and application contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-export-configuration-'));
  const filePath = path.join(directory, 'export-profiles.json');
  try {
    await writeFile(filePath, JSON.stringify([{
      id: 'custom-html',
      label: 'Custom HTML',
      reader: { name: 'gfm', extensions: [] },
      writer: { name: 'html5', extensions: [] },
      outputExtension: '.html',
      executable: '/opt/tools/pandoc',
      standalone: true,
      arguments: [],
      stylesheets: [], filters: [], bibliography: [], metadata: {},
      resourcePaths: ['assets'], environment: {}, outputName: '{name}', postExport: 'none'
    }]), 'utf8');
    const loaded = await loadUserExportProfiles(filePath);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.profiles[0]?.writer.name, 'html5');
    assert.equal(loaded.profiles[0]?.standalone, true);
    const application = createVellumApplication({ watchFiles: false, exportProfiles: loaded.profiles });
    try {
      const id = application.openSource('# Export');
      application.dispatchCommand('export.activeBuffer');
      assert.equal(application.state().project.activeBufferId, id);
      assert.equal(application.state().dialogState?.kind, 'exportProfile');
    } finally {
      await application.dispose();
    }

    const configurationRoot = path.join(directory, 'configuration');
    const cliConfigurationDirectory = process.platform === 'win32'
      ? path.join(configurationRoot, 'Vellum')
      : process.platform === 'darwin'
        ? path.join(configurationRoot, 'Library', 'Application Support', 'Vellum')
        : path.join(configurationRoot, 'vellum');
    const cliProfiles = path.join(cliConfigurationDirectory, 'export-profiles.json');
    const sourcePath = path.join(directory, 'source.md');
    const outputPath = path.join(directory, 'source.custom');
    const executable = path.join(directory, 'profile-double.mjs');
    await mkdir(path.dirname(cliProfiles), { recursive: true });
    await writeFile(sourcePath, '# CLI export', 'utf8');
    await writeFile(executable, [
      "import { writeFile } from 'node:fs/promises';",
      "const output = process.argv[process.argv.indexOf('--output') + 1];",
      "await writeFile(output, 'custom profile', 'utf8');"
    ].join('\n'), 'utf8');
    await writeFile(cliProfiles, JSON.stringify([{
      id: 'custom-cli', label: 'Custom CLI', reader: { name: 'gfm', extensions: [] }, writer: { name: 'html5', extensions: [] }, outputExtension: '.custom',
      executable: process.execPath, standalone: true, arguments: [executable], stylesheets: [], filters: [], bibliography: [], metadata: {}, resourcePaths: [], environment: {}, outputName: '{name}', postExport: 'none'
    }]), 'utf8');
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../cli.js', import.meta.url)),
      'export', sourcePath, '--profile', 'custom-cli', '--output', outputPath
    ], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configurationRoot,
        APPDATA: configurationRoot,
        HOME: configurationRoot
      }
    });
    assert.equal(await readFile(outputPath, 'utf8'), 'custom profile');

    await writeFile(filePath, JSON.stringify([{
      id: 'html', label: '', reader: { name: '', extensions: [] }, writer: { name: '', extensions: [] }, outputExtension: 'html', executable: '', standalone: true,
      arguments: [], stylesheets: [], filters: [], bibliography: [], metadata: {}, resourcePaths: [], environment: {}, outputName: '{name}', postExport: 'none', extra: true
    }]), 'utf8');
    const invalid = await loadUserExportProfiles(filePath);
    assert.equal(invalid.profiles.length, 0);
    assert.match(invalid.diagnostics[0]?.message ?? '', /Unknown export profile fields/u);

    await writeFile(filePath, JSON.stringify([{
      id: 'unsafe', label: 'Unsafe', reader: { name: 'gfm', extensions: [] }, writer: { name: 'html5', extensions: [] }, outputExtension: '.html',
      executable: `pandoc\0extra`, standalone: true, arguments: ['--standalone\0'], stylesheets: [], filters: [], bibliography: [], metadata: {}, resourcePaths: ['assets\0'], environment: {}, outputName: '{name}', postExport: 'none'
    }]), 'utf8');
    const unsafe = await loadUserExportProfiles(filePath);
    assert.equal(unsafe.profiles.length, 1);
    assert.equal(unsafe.diagnostics.some((diagnostic) => /null character/u.test(diagnostic.message)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all built-in export profiles preserve arguments, stable project order, failures, timeouts, and cancellation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-export-profiles-'));
  const script = path.join(directory, 'pandoc-double.mjs');
  try {
    await writeFile(script, [
      "import { writeFile } from 'node:fs/promises';",
      "const mode = process.argv[2];",
      "if (mode === 'fail') { process.stderr.write('profile failure'); process.exit(7); }",
      "if (mode === 'delay') await new Promise((resolve) => setTimeout(resolve, 30000));",
      "const args = process.argv.slice(3);",
      "const output = args[args.indexOf('--output') + 1];",
      "await writeFile(output, JSON.stringify(args), 'utf8');"
    ].join('\n'), 'utf8');
    const source = path.join(directory, 'source.md');
    await writeFile(source, '# Source', 'utf8');
    for (const builtIn of builtInExportProfiles) {
      const profile = { ...builtIn, executable: process.execPath, arguments: Object.freeze([script, 'success']) };
      const outputPath = path.join(directory, `built-in-${builtIn.id}${builtIn.outputExtension}`);
      const result = await exportDocument({ kind: 'disk', path: source }, profile, { outputPath });
      assert.ok(result.arguments.includes(`--to=${builtIn.writer.name}`));
      assert.equal(result.outputPath, outputPath);
    }

    const project = path.join(directory, 'project');
    await mkdir(path.join(project, 'nested'), { recursive: true });
    await writeFile(path.join(project, 'z.md'), '# Z', 'utf8');
    await writeFile(path.join(project, 'a.markdown'), '# A', 'utf8');
    await writeFile(path.join(project, 'nested', 'b.md'), '# B', 'utf8');
    const projectProfile: ExportProfile = {
      ...builtInExportProfiles[0] as ExportProfile,
      id: 'project-html', label: 'Project HTML', executable: process.execPath,
      arguments: Object.freeze([script, 'success'])
    };
    const projectResults = await batchExportDirectory(project, projectProfile);
    assert.deepEqual(projectResults.map((result) => path.relative(project, result.inputLabels[0] ?? '').split(path.sep).join('/')), ['a.markdown', 'nested/b.md', 'z.md']);

    const failedProfile = { ...projectProfile, id: 'failure', arguments: Object.freeze([script, 'fail']) };
    await assert.rejects(
      () => exportDocument({ kind: 'disk', path: source }, failedProfile, { outputPath: path.join(directory, 'failure.html') }),
      /profile failure/u
    );
    const timeoutProfile = { ...projectProfile, id: 'timeout', arguments: Object.freeze([script, 'delay']) };
    await assert.rejects(
      () => exportDocument({ kind: 'disk', path: source }, timeoutProfile, { outputPath: path.join(directory, 'timeout.html'), timeoutMilliseconds: 10 }),
      /timeout/u
    );
    const controller = new AbortController();
    const cancelled = exportDocument({ kind: 'disk', path: source }, timeoutProfile, {
      outputPath: path.join(directory, 'cancelled.html'), signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('export cancelled')), 10);
    await assert.rejects(cancelled, /abort|cancel/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project manifests preserve declared order and live source while repeat export replaces its own prior output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-export-'));
  const manifestDirectory = path.join(directory, '.vellum');
  const outputDirectory = path.join(directory, 'output');
  const firstPath = path.join(directory, 'first.md');
  const secondPath = path.join(directory, 'second.md');
  const script = path.join(directory, 'project-export.mjs');
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(firstPath, '# First on disk\n', 'utf8');
  await writeFile(secondPath, '# Second on disk\n', 'utf8');
  await writeFile(script, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "const outputIndex = process.argv.indexOf('--output');",
    "const output = process.argv[outputIndex + 1];",
    "const inputs = process.argv.slice(outputIndex + 2);",
    "await writeFile(output, JSON.stringify(await Promise.all(inputs.map(async (input) => ({ input, source: await readFile(input, 'utf8') })))), 'utf8');"
  ].join('\n'), 'utf8');
  const profile: ExportProfile = Object.freeze({
    ...(builtInExportProfiles[0] as ExportProfile),
    id: 'manifest-test', label: 'Manifest test', executable: process.execPath,
    arguments: Object.freeze([script]), outputExtension: '.manifest'
  });
  await writeFile(path.join(manifestDirectory, 'project.json'), JSON.stringify({
    version: 1,
    title: 'Ordered Book',
    files: ['second.md', 'first.md'],
    profiles: [{ profileId: profile.id }],
    metadata: { author: 'Vellum' },
    bibliography: [],
    resourcePaths: [],
    outputDirectory: 'output'
  }), 'utf8');
  try {
    const manifest = await loadProjectManifest(directory);
    const progress: string[] = [];
    const results = await exportProjectManifest(
      directory,
      manifest,
      [profile],
      new Map([[firstPath, { source: '# First live\n', unsaved: true }]]),
      {},
      (entry) => progress.push(`${entry.profileId}:${String(entry.completed)}/${String(entry.total)}`)
    );
    assert.deepEqual(results[0]?.inputLabels, [secondPath, firstPath]);
    assert.equal(results[0]?.usedUnsavedSource, true);
    assert.deepEqual(progress, ['manifest-test:0/1', 'manifest-test:1/1']);
    const generated = JSON.parse(await readFile(path.join(outputDirectory, 'Ordered Book.manifest'), 'utf8')) as Array<{ source: string }>;
    assert.deepEqual(generated.map((entry) => entry.source), ['# Second on disk\n', '# First live\n']);

    await writeFile(path.join(manifestDirectory, 'project.json'), JSON.stringify({
      ...manifest,
      profiles: [{ profileId: profile.id, unknown: true }]
    }), 'utf8');
    await assert.rejects(loadProjectManifest(directory), /Unknown project profile fields/u);

    await rm(outputDirectory, { recursive: true, force: true });
    const application = createVellumApplication({ watchFiles: false, exportProfiles: [profile] });
    try {
      await application.openProjectDirectory(directory);
      const id = await application.openFile(firstPath);
      application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'draft ' } });
      application.dispatchCommand('export.activeBuffer');
      await application.submitExportProfile(profile.id);
      const outputPath = path.join(directory, 'first.manifest');
      let exported = JSON.parse(await readFile(outputPath, 'utf8')) as Array<{ source: string }>;
      assert.deepEqual(exported.map((entry) => entry.source), ['draft # First on disk\n']);
      assert.equal(application.state().exports.history[0]?.usedUnsavedSource, true);
      application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'new ' } });
      await application.repeatLastExport();
      exported = JSON.parse(await readFile(outputPath, 'utf8')) as Array<{ source: string }>;
      assert.deepEqual(exported.map((entry) => entry.source), ['draft new # First on disk\n']);
      assert.equal(application.state().exports.history[0]?.status, 'succeeded');
      assert.equal(application.state().exports.history.length, 2);
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('code highlighting uses exact value offsets, canonical aliases, lazy loading, deduplication, and bounded cancellation', async () => {
  const highlighter = createCodeHighlighter();
  const source = 'const value: number = 4;';
  const first = await highlighter.highlight('ts', source);
  const second = await highlighter.highlight('typescript', source);
  assert.equal(first, second);
  const keyword = first?.tokens.find((token) => source.slice(token.span.start, token.span.end) === 'const');
  assert.deepEqual(keyword, {
    span: { start: 0, end: 5 },
    style: { fg: themeColor('accent.primary'), bold: true }
  });
  assert.equal(await highlighter.highlight('unsupported', 'text'), undefined);

  let loads = 0;
  let tokenizations = 0;
  const tokenizer: CodeTokenizer = Object.freeze({
    async tokenize(value: string) {
      tokenizations += 1;
      return Object.freeze([{ span: Object.freeze({ start: 0, end: value.length }), style: Object.freeze({ underline: true }) }]);
    }
  });
  const custom: CodeHighlightLanguage = Object.freeze({
    id: ' Custom-Language ',
    aliases: Object.freeze(['custom', 'CUSTOM-ALIAS']),
    async load() {
      loads += 1;
      return tokenizer;
    }
  });
  const customHighlighter = createCodeHighlighter([custom]);
  assert.equal(loads, 0);
  const [aliasResult, canonicalResult] = await Promise.all([
    customHighlighter.highlight('custom-alias', 'value'),
    customHighlighter.highlight('custom-language', 'value')
  ]);
  assert.equal(aliasResult, canonicalResult);
  assert.equal(aliasResult?.language, 'custom-language');
  assert.equal(loads, 1);
  assert.equal(tokenizations, 1);

  let loadAttempts = 0;
  const loadRetry = createCodeHighlighter([{
    id: 'load-retry', aliases: [], async load() {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new Error('language load failed');
      return tokenizer;
    }
  }]);
  await assert.rejects(() => loadRetry.highlight('load-retry', 'value'), /language load failed/u);
  assert.equal((await loadRetry.highlight('load-retry', 'value'))?.language, 'load-retry');
  assert.equal(loadAttempts, 2);

  const cancelled = new AbortController();
  const retryHighlighter = createCodeHighlighter([{
    id: 'retry', aliases: [], async load() {
      return {
        async tokenize(value, context) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          context.signal.throwIfAborted();
          return [Object.freeze({ span: Object.freeze({ start: 0, end: value.length }), style: Object.freeze({ italic: true }) })];
        }
      };
    }
  }]);
  const cancelledRequest = retryHighlighter.highlight('retry', 'value', cancelled.signal);
  cancelled.abort(new DOMException('First waiter cancelled.', 'AbortError'));
  await assert.rejects(cancelledRequest, /cancel|abort/iu);
  assert.equal((await retryHighlighter.highlight('retry', 'value'))?.language, 'retry');

  const largeSource = `${'const value = 1;\n'.repeat(20_000)}tail`;
  let timerObserved = false;
  const largeHighlight = highlighter.highlight('js', largeSource).then((result) => {
    assert.equal(timerObserved, true);
    return result;
  });
  setTimeout(() => { timerObserved = true; }, 0);
  await largeHighlight;
  for (const language of ['md', 'yaml']) {
    let yielded = false;
    const block = highlighter.highlight(language, '['.repeat(250_000)).then((result) => {
      assert.equal(yielded, true);
      return result;
    });
    setTimeout(() => { yielded = true; }, 0);
    await block;
  }
  const controller = new AbortController();
  const cancellation = highlighter.highlight('js', `${'identifier'.repeat(100_000)};`, controller.signal);
  setImmediate(() => controller.abort(new DOMException('Highlight cancelled.', 'AbortError')));
  await assert.rejects(cancellation, /cancel|abort/iu);
});

test('code rendering maps highlighted value ranges through Markspan for CRLF and indented fences', async () => {
  const source = '  ```ts\r\n  const value: number = 4;\r\n  ```';
  const node = collectMarkdownNodes(parseMarkdown(source).tree, 'codeBlock')[0];
  assert.ok(node);
  const before = renderCodeBlock(node, darkTerminalMarkdownTheme);
  const unhighlighted = before.find((span) => span.text.includes('const'));
  assert.equal(unhighlighted?.style, darkTerminalMarkdownTheme.codeBlock);
  const highlighted = await createCodeHighlighter().highlight('ts', node.value);
  const after = renderCodeBlock(node, darkTerminalMarkdownTheme, highlighted);
  const keyword = after.find((span) => span.text === 'const');
  assert.deepEqual(keyword?.style, {
    fg: themeColor('accent.primary'),
    bg: themeColor('surface.inset.background'),
    bold: true
  });
  assert.deepEqual(keyword?.sourceSpan, {
    start: source.indexOf('const'),
    end: source.indexOf('const') + 'const'.length
  });
  assert.equal(source.slice(keyword?.sourceSpan.start, keyword?.sourceSpan.end), 'const');
});

test('the local math renderer lays out structures deterministically and remains cached and cancellable', async () => {
  const math = createMathRenderer();
  const renderedMath = await math.render('\\frac{1}{2} \\leq x^2');
  assert.equal(renderedMath.text, '1\n─ ≤ x²\n2');
  assert.equal(await math.render('\\frac{1}{2} \\leq x^2'), renderedMath);
  await assert.rejects(() => math.render('\\frac{1}'), /denominator/u);
  const controller = new AbortController();
  const rendering = math.render('x+'.repeat(40_000), controller.signal);
  setImmediate(() => controller.abort(new DOMException('Math cancelled.', 'AbortError')));
  await assert.rejects(rendering, /cancel|abort/iu);
});

test('an optional full math provider is preferred while the local renderer remains the failure fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-math-provider-'));
  const providerScript = path.join(directory, 'math-provider.mjs');
  const failingScript = path.join(directory, 'math-provider-failure.mjs');
  try {
    await writeFile(providerScript, [
      "let source = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { source += chunk; });",
      "process.stdin.on('end', () => process.stdout.write(`FULL(${source})`));"
    ].join('\n'), 'utf8');
    await writeFile(failingScript, "process.stdin.resume(); process.stdin.on('end', () => process.exit(7));", 'utf8');
    const supplied = createMathRenderer({}, [externalMathProvider({
      id: 'full-test', version: '1', executable: process.execPath, arguments: [providerScript],
      timeoutMilliseconds: 1_000, maximumOutputBytes: 1_024
    })]);
    assert.equal((await supplied.render('x^2')).text, 'FULL(x^2)');

    const fallback = createMathRenderer({}, [externalMathProvider({
      id: 'failing-test', version: '1', executable: process.execPath, arguments: [failingScript],
      timeoutMilliseconds: 1_000, maximumOutputBytes: 1_024
    })]);
    assert.equal((await fallback.render('x^2')).text, 'x²');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('common image formats use bounded decoding and reject active SVG resources', async () => {
  const pixels = { create: { width: 2, height: 1, channels: 4 as const, background: { r: 20, g: 40, b: 60, alpha: 1 } } };
  const encoded = await Promise.all([
    sharp(pixels).jpeg().toBuffer().then((bytes) => ['image/jpeg', bytes] as const),
    sharp(pixels).webp().toBuffer().then((bytes) => ['image/webp', bytes] as const),
    sharp(pixels).gif().toBuffer().then((bytes) => ['image/gif', bytes] as const),
    Promise.resolve(['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>')] as const)
  ]);
  const images = createMarkdownImageLoader({ maximumDecodedCacheEntries: 2 });
  for (const [contentType, bytes] of encoded) {
    const decoded = await images.decode(bytes, contentType, contentType);
    assert.equal(decoded.kind, 'ready');
    if (decoded.kind === 'ready') assert.deepEqual([decoded.image.width, decoded.image.height], [2, 1]);
  }
  assert.equal(images.stats().decodedCacheEntries, 2);
  for (const source of [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="https://example.invalid/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect onclick="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><style>@import "https://example.invalid/x.css";</style></svg>'
  ]) {
    const decoded = await images.decode(Buffer.from(source), 'unsafe.svg', 'image/svg+xml');
    assert.equal(decoded.kind, 'failed');
    if (decoded.kind === 'failed') assert.match(decoded.message, /active|external/u);
  }
});

test('diagrams and local terminal images are asynchronous, cached, and cancellable', async () => {

  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-media-'));
  try {
    const ppm = path.join(directory, 'pixel.ppm');
    await writeFile(ppm, Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([1, 2, 3])]));
    const images = createMarkdownImageLoader();
    const image = await images.load('./pixel.ppm', path.join(directory, 'document.md'));
    assert.equal(image.kind, 'ready');
    if (image.kind === 'ready') {
      assert.equal(image.image.width, 1);
      assert.equal(image.image.height, 1);
    }
    const remote = await images.load('https://example.invalid/image.png', undefined);
    assert.deepEqual(remote, { kind: 'failed', message: 'Remote image loading is disabled.', source: 'https://example.invalid/image.png' });
    const oversized = await images.decode(
      Buffer.from('P6\n5000 1\n255\n'),
      'oversized.ppm',
      'image/x-portable-pixmap'
    );
    assert.equal(oversized.kind, 'failed');
    if (oversized.kind === 'failed') assert.match(oversized.message, /dimensions/u);
    const invalidChecksum = await images.decode(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]),
      'corrupt.png',
      'image/png'
    );
    assert.equal(invalidChecksum.kind, 'failed');
    if (invalidChecksum.kind === 'failed') assert.match(invalidChecksum.message, /checksum/u);

    const diagramScript = path.join(directory, 'diagram.mjs');
    const diagramBytes = [...Buffer.from('P6\n1 1\n255\n'), 4, 5, 6];
    await writeFile(diagramScript, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.from(${JSON.stringify(diagramBytes)})));`, 'utf8');
    const diagrams = createDiagramRendererRegistry([{
      language: 'mermaid', executable: process.execPath, arguments: Object.freeze([diagramScript]), version: 'test-1',
      outputContentType: 'image/x-portable-pixmap', transport: 'stdio'
    }]);
    const diagram = await diagrams.render('mermaid', 'graph TD; A-->B');
    assert.deepEqual([...diagram?.bytes ?? []], diagramBytes);
    assert.equal(await diagrams.render('mermaid', 'graph TD; A-->B'), diagram);
    assert.equal(await diagrams.render('python', 'print(1)'), undefined);
    assert.throws(() => createDiagramRendererRegistry([], { timeoutMilliseconds: 0, maximumOutputBytes: 1 }), /positive integer/u);
    assert.throws(() => createDiagramRendererRegistry([
      { language: 'MERMAID', executable: 'one', arguments: [], version: 'one', outputContentType: 'image/png', transport: 'stdio' },
      { language: 'mermaid', executable: 'two', arguments: [], version: 'two', outputContentType: 'image/png', transport: 'stdio' }
    ]), /Duplicate diagram renderer language/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('line comparison preserves repeated unchanged lines and remains source ordered', async () => {
  const identical = await compareSourceLines('same\nsame\nsame\n', 'same\nsame\nsame\n');
  assert.equal(identical.every((line) => line.kind === 'unchanged'), true);
  const changed = await compareSourceLines(
    'heading\nrepeat\nrepeat\nold\ntail\ntail\n',
    'heading\nrepeat\nrepeat\nnew\ntail\ntail\n'
  );
  assert.deepEqual(changed.filter((line) => line.kind !== 'unchanged'), [
    { kind: 'removed', text: 'old', bufferLine: 4 },
    { kind: 'added', text: 'new', diskLine: 4 }
  ]);
});

test('each buffer runtime publishes asynchronous highlighting, math, image, and diagram resources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-preview-resources-'));
  const documentPath = path.join(directory, 'document.md');
  const pixelPath = path.join(directory, 'pixel.ppm');
  const diagramScript = path.join(directory, 'diagram.mjs');
  const ppmBytes = [...Buffer.from('P6\n1 1\n255\n'), 20, 40, 60];
  try {
    await writeFile(pixelPath, Buffer.from(ppmBytes));
    await writeFile(diagramScript, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.from(${JSON.stringify(ppmBytes)})));`, 'utf8');
    await writeFile(documentPath, [
      '```ts', 'const value: number = 4;', '```', '',
      '$$', 'x^2 \\leq 4', '$$', '',
      '![pixel](./pixel.ppm)', '',
      '- ![nested](./pixel.ppm)', '',
      '| Kind | Visual |', '| --- | --- |', '| table | ![tabular](./pixel.ppm) |', '',
      '```mermaid', 'graph TD; A-->B', '```'
    ].join('\n'), 'utf8');
    const application = createVellumApplication({
      watchFiles: false,
      createBufferId: () => 'resources',
      diagramRenderers: [{
        language: 'mermaid', executable: process.execPath, arguments: Object.freeze([diagramScript]),
        version: 'test-1', outputContentType: 'image/x-portable-pixmap', transport: 'stdio'
      }]
    });
    try {
      const id = await application.openFile(documentPath);
      const updates: Array<{ readonly revision: number; readonly reason: string; readonly bufferId?: string }> = [];
      const unsubscribe = application.subscribe((update) => updates.push(update));
      await application.refreshPreviewResources(id);
      const layout = application.previewLayout(id, 60);
      const rendered = layout?.rows.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n') ?? '';
      assert.match(rendered, /x² ≤ 4/u);
      const codeKeyword = layout?.rows.flatMap((line) => line.inlineSpans).find((span) => span.text === 'const');
      assert.equal(codeKeyword?.style?.bold, true);
      assert.equal((await readFile(documentPath, 'utf8')).slice(codeKeyword?.sourceSpan.start, codeKeyword?.sourceSpan.end), 'const');
      assert.equal(layout?.media.length, 4);
      assert.deepEqual(layout?.media.map((entry) => entry.media.label), ['pixel', 'nested', 'tabular', 'Mermaid diagram']);
      assert.ok((layout?.media[0]?.width ?? 0) >= '[Image: pixel]'.length);
      assert.ok((layout?.media[1]?.column ?? 0) > 0);
      assert.ok((layout?.media[2]?.column ?? 0) > (layout?.media[1]?.column ?? 0));
      assert.deepEqual(
        layout?.media.map((entry) => entry.media.sourceSpan.start),
        layout?.media.map((entry) => entry.media.sourceSpan.start).toSorted((left, right) => left - right),
      );
      assert.doesNotMatch(rendered, /\[Image: pixel\]|Mermaid diagram/u);
      for (const media of layout?.media ?? []) {
        const mappedRow = layout?.rowOffsetMap.rowAtSourceOffset(media.media.sourceSpan.start) ?? -1;
        assert.ok(mappedRow >= media.row && mappedRow < media.row + media.height);
      }
      const previewUpdates = updates.filter((update) => update.reason === 'previewResource');
      assert.equal(previewUpdates.every((update) => update.bufferId === id), true);
      assert.equal(updates.every((update, index) => index === 0 || update.revision > (updates[index - 1]?.revision ?? 0)), true);
      assert.equal(application.state().project.buffers[id]?.previewResourceRevision, previewUpdates.length);
      unsubscribe();
      assert.equal(application.runtimeBufferInfo(id)?.pendingEffects, 0);
      application.dispatchCommand('view.preview');
      const host = createMemoryTerminalHost({ terminalSize: { columns: 60, rows: 10 } });
      const runtime = createTuiRuntime({ app: createVellumTui(application), host });
      try {
        await runtime.start();
        assert.equal(runtime.frame()?.hitTargets?.some((target) => (
          target.id === `vellum-preview-${id}:scrollbar:horizontal:track`
        )), false);
      } finally {
        await runtime.dispose();
      }
      assert.equal(application.requestCloseBuffer(id), true);
      assert.equal(application.runtimeBufferInfo(id), undefined);
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed preview resource cancels and drains sibling work before the refresh rejects', async () => {
  const application = createVellumApplication({
    watchFiles: false,
    createBufferId: () => 'resource-failure',
    highlightLanguages: [{
      id: 'fail', aliases: [], async load() {
        return { async tokenize() { throw new Error('tokenizer failed'); } };
      }
    }, {
      id: 'slow', aliases: [], async load() {
        return {
          async tokenize(source, context) {
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            context.signal.throwIfAborted();
            return [{ span: { start: 0, end: source.length }, style: { italic: true } }];
          }
        };
      }
    }]
  });
  try {
    const bufferId = application.openSource('```fail\nfirst\n```\n\n```slow\nsecond\n```');
    await assert.rejects(() => application.refreshPreviewResources(bufferId), /tokenizer failed/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(application.state().project.buffers[bufferId]?.previewResourceRevision, 0);
    assert.equal(application.runtimeBufferInfo(bufferId)?.pendingEffects, 0);
  } finally {
    await application.dispose();
  }
});

test('preview viewport centers one readable document column and collapses its gutter safely', async () => {
  assert.deepEqual(vellumPreviewDocumentGeometry(1), {
    contentWidth: 1,
    contentColumn: 0,
  });
  assert.deepEqual(vellumPreviewDocumentGeometry(2), {
    contentWidth: 1,
    contentColumn: 1,
  });
  assert.deepEqual(vellumPreviewDocumentGeometry(140), {
    contentWidth: 88,
    contentColumn: 26,
  });

  const terminalSize = Object.freeze({ columns: 140, rows: 16 });
  const application = createVellumApplication({
    watchFiles: false,
    createBufferId: () => 'centered-preview',
  });
  const bufferId = application.openSource([
    '# Centered document',
    '',
    'Read [the guide](./guide.md).',
    '',
    ...Array.from({ length: 30 }, (_, index) => `Paragraph ${String(index)} keeps the preview vertically scrollable.`),
  ].join('\n'));
  application.dispatchCommand('view.preview');
  const layout = application.previewViewportLayout(bufferId, terminalSize.columns, 13);
  assert.equal(layout?.width, 88);
  const host = createMemoryTerminalHost({ terminalSize });
  const runtime = createTuiRuntime({ app: createVellumTui(application), host });
  try {
    await runtime.start();
    const frame = runtime.frame();
    assert.ok(frame);
    const heading = renderFramePlain(frame).split('\n').find((line) => line.includes('Centered document'));
    assert.ok(heading);
    assert.equal(heading.indexOf('Centered document'), 25);
    const link = layout?.activations.find((target) => target.activation.kind === 'link');
    assert.ok(link);
    const linkHitTarget = frame.hitTargets?.find((target) => target.id.includes(`:${link.id}:`));
    assert.equal(linkHitTarget?.bounds.column, 26 + link.column);
    const verticalScrollbar = frame.hitTargets?.find((target) => (
      target.id === `vellum-preview-${bufferId}:scrollbar:vertical:track`
    ));
    assert.equal(verticalScrollbar?.bounds.column, terminalSize.columns);
    assert.equal(frame.hitTargets?.some((target) => (
      target.id === `vellum-preview-${bufferId}:scrollbar:horizontal:track`
    )), false);
    await runtime.dispose();
    const bottom = Math.max(0, (layout?.rows.length ?? 0) - 13);
    application.updatePreviewScroll(bufferId, {
      nextState: { offsetRow: bottom, offsetColumn: 0, followTail: false },
      source: 'keyboard',
      target: 'content',
    });
    const bottomRuntime = createTuiRuntime({
      app: createVellumTui(application),
      host: createMemoryTerminalHost({ terminalSize }),
    });
    try {
      await bottomRuntime.start();
      const bottomFrame = bottomRuntime.frame();
      assert.ok(bottomFrame);
      assert.match(renderFramePlain(bottomFrame), /Paragraph 29 keeps the preview vertically scrollable\./u);
    } finally {
      await bottomRuntime.dispose();
    }
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
});

test('terminal-ui runtime resizing preserves Vellum source anchors before committing each frame', async () => {
  const initialSize = Object.freeze({ columns: 80, rows: 24 });
  const directResize = Object.freeze({ columns: 120, rows: 24 });
  const hostResize = Object.freeze({ columns: 72, rows: 20 });
  const source = Array.from(
    { length: 40 },
    (_, index) => `Paragraph ${String(index)} contains enough text to wrap across several terminal rows at narrow pane widths.`
  ).join('\n\n');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'runtime-resize' });
  const bufferId = application.openSource(source);
  application.dispatchCommand('view.editorPreview');
  const host = createMemoryTerminalHost({ terminalSize: initialSize });
  const runtime = createTuiRuntime({ app: createVellumTui(application), host });

  const rowMapsAt = (terminalSize: { readonly columns: number; readonly rows: number }) => {
    const state = application.state();
    const buffer = state.project.buffers[bufferId];
    assert.ok(buffer);
    const body = vellumBodyGeometry(state, terminalSize);
    const panes = vellumPaneGeometry(state, body.bodyWidth, body.contentRows);
    assert.ok(panes.editor && panes.preview);
    const editor = createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: panes.editor.width,
      terminalRows: panes.editor.rows,
      lineNumbers: { minWidth: 3 },
      wrap: { mode: 'soft' },
      scrollbar: { visible: 'auto' }
    });
    const preview = application.previewViewportLayout(
      bufferId,
      panes.preview.width,
      panes.preview.rows,
    )?.rowOffsetMap;
    assert.ok(preview);
    return Object.freeze({ editor, preview });
  };

  const sourceAnchorsAt = (terminalSize: { readonly columns: number; readonly rows: number }) => {
    const buffer = application.state().project.buffers[bufferId];
    assert.ok(buffer);
    const maps = rowMapsAt(terminalSize);
    return Object.freeze({
      editor: maps.editor.sourceOffsetAtRow(buffer.editor.scroll.offsetRow),
      preview: maps.preview.sourceOffsetAtRow(buffer.previewScroll.offsetRow)
    });
  };

  try {
    const initialMaps = rowMapsAt(initialSize);
    const targetOffset = source.indexOf('Paragraph 24');
    application.applyTextAreaTransition(bufferId, {
      kind: 'scroll',
      request: {
        nextState: {
          offsetRow: initialMaps.editor.rowAtSourceOffset(targetOffset),
          offsetColumn: 0,
          followTail: false
        },
        source: 'keyboard',
        target: 'content'
      }
    });
    application.updatePreviewScroll(bufferId, {
      nextState: {
        offsetRow: initialMaps.preview.rowAtSourceOffset(targetOffset),
        offsetColumn: 0,
        followTail: false
      },
      source: 'keyboard',
      target: 'content'
    });
    const initialAnchors = sourceAnchorsAt(initialSize);
    const syntaxTree = application.state().project.buffers[bufferId]?.preview;
    assert.equal(syntaxTree?.kind, 'ready');
    if (syntaxTree?.kind !== 'ready') return;
    const syntaxNodeAt = (offset: number) => syntaxTree.snapshot.document.tree.children.find((node) => (
      node.span.start <= offset && offset <= node.span.end
    ))?.id;
    const anchorNodeId = syntaxNodeAt(initialAnchors.editor);
    assert.ok(anchorNodeId !== undefined);
    assert.equal(syntaxNodeAt(initialAnchors.preview), anchorNodeId);

    await runtime.start();
    const stateBeforeResize = application.state();
    await runtime.resize(directResize);
    const directAnchors = sourceAnchorsAt(directResize);
    const directFrame = runtime.frame();
    assert.ok(directFrame);
    assert.equal(directFrame.width, directResize.columns);
    assert.equal(runtime.state(), application.state());
    assert.notEqual(application.state(), stateBeforeResize);
    assert.equal(syntaxNodeAt(directAnchors.editor), anchorNodeId);
    assert.equal(syntaxNodeAt(directAnchors.preview), anchorNodeId);

    const terminalSizeControl = host.terminalSizeControl;
    assert.ok(terminalSizeControl);
    await terminalSizeControl.setTerminalSize(hostResize);
    await runtime.redraw();
    const hostAnchors = sourceAnchorsAt(hostResize);
    const hostFrame = runtime.frame();
    assert.ok(hostFrame);
    assert.equal(hostFrame.width, hostResize.columns);
    assert.equal(runtime.state(), application.state());
    assert.equal(syntaxNodeAt(hostAnchors.editor), anchorNodeId);
    assert.equal(syntaxNodeAt(hostAnchors.preview), anchorNodeId);
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
});

test('split preview preserves scroll edges, reveals keyboard carets, and needs no horizontal scrollbar', async () => {
  const terminalSize = Object.freeze({ columns: 140, rows: 40 });
  const source = Array.from(
    { length: 80 },
    (_, index) => `## Section ${String(index)}\n\nParagraph ${String(index)} contains enough text to wrap differently in source and preview panes.`,
  ).join('\n\n');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'split-scroll-contracts' });
  const bufferId = application.openSource(source);
  application.dispatchCommand('view.editorPreview');
  const body = vellumBodyGeometry(application.state(), terminalSize);
  const panes = vellumPaneGeometry(application.state(), body.bodyWidth, body.contentRows);
  assert.ok(panes.editor && panes.preview);
  const synchronization = Object.freeze({
    editor: panes.editor,
    preview: panes.preview,
    widthProfile: defaultTextWidthProfile,
  });
  const buffer = application.state().project.buffers[bufferId];
  assert.ok(buffer);
  const editorMap = createTextAreaRowOffsetMap({
    document: buffer.editor.document,
    terminalWidth: panes.editor.width,
    terminalRows: panes.editor.rows,
    lineNumbers: { minWidth: 3 },
    wrap: { mode: 'soft' },
    scrollbar: { visible: 'auto' },
  });
  const previewMap = application.previewViewportLayout(
    bufferId,
    panes.preview.width,
    panes.preview.rows,
  )?.rowOffsetMap;
  assert.ok(previewMap);
  const editorBottom = Math.max(0, editorMap.rowCount - panes.editor.rows);
  const previewBottom = Math.max(0, previewMap.rowCount - panes.preview.rows);

  try {
    application.updatePreviewScroll(bufferId, {
      nextState: { offsetRow: previewBottom, offsetColumn: 0, followTail: false },
      source: 'keyboard',
      target: 'content',
    }, synchronization);
    let current = application.state().project.buffers[bufferId];
    assert.equal(current?.previewScroll.offsetRow, previewBottom);
    assert.equal(current?.editor.scroll.offsetRow, editorBottom);

    application.applyTextAreaTransition(bufferId, {
      kind: 'scroll',
      request: {
        nextState: { offsetRow: editorBottom, offsetColumn: 0, followTail: false },
        source: 'keyboard',
        target: 'content',
      },
    }, synchronization);
    current = application.state().project.buffers[bufferId];
    assert.equal(current?.editor.scroll.offsetRow, editorBottom);
    assert.equal(current?.previewScroll.offsetRow, previewBottom);

    application.applyTextAreaTransition(bufferId, {
      kind: 'scroll',
      request: {
        nextState: { offsetRow: 0, offsetColumn: 0, followTail: false },
        source: 'keyboard',
        target: 'content',
      },
    }, synchronization);
    for (let index = 0; index < 40; index += 1) {
      application.applyTextAreaTransition(bufferId, {
        kind: 'edit',
        operation: { kind: 'moveLineDown' },
      }, synchronization);
    }
    current = application.state().project.buffers[bufferId];
    assert.ok((current?.editor.scroll.offsetRow ?? 0) > 0);
    assert.ok((current?.previewScroll.offsetRow ?? 0) > 0);
    assert.equal(current?.editor.revealCaret, false);

    const host = createMemoryTerminalHost({ terminalSize });
    const runtime = createTuiRuntime({ app: createVellumTui(application), host });
    try {
      await runtime.start();
      assert.ok(runtime.frame()?.cursor);
      assert.equal(runtime.frame()?.hitTargets?.some((target) => (
        target.id === `vellum-preview-${bufferId}:scrollbar:horizontal:track`
      )), false);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await application.dispose();
  }
});

test('preview resource completion redraws the TUI without input and rejects stale highlights after edits', async () => {
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  const tokenizer: CodeTokenizer = Object.freeze({
    async tokenize(source: string, context: CodeTokenizerContext) {
      if (source.includes('old')) {
        firstStarted.resolve();
        await firstGate.promise;
      }
      context.signal.throwIfAborted();
      return Object.freeze([{
        span: Object.freeze({ start: 0, end: source.length }),
        style: Object.freeze({ underline: true })
      }]);
    }
  });
  const language: CodeHighlightLanguage = Object.freeze({
    id: 'controlled', aliases: Object.freeze(['ctl']), async load() { return tokenizer; }
  });
  const application = createVellumApplication({
    watchFiles: false,
    createBufferId: () => 'asynchronous-preview',
    highlightLanguages: [language]
  });
  const id = application.openSource('```ctl\nold value\n```');
  application.dispatchCommand('view.preview');
  await firstStarted.promise;
  const host = createMemoryTerminalHost({ terminalSize: { columns: 60, rows: 18 } });
  const runtime = createTuiRuntime({ app: createVellumTui(application), host });
  try {
    await runtime.start();
    const initialCommits = runtime.metrics().frameCommits;
    const previewUpdates: number[] = [];
    const unsubscribe = application.subscribe((update) => {
      if (update.reason === 'previewResource') previewUpdates.push(update.revision);
    });
    application.applyTextAreaTransition(id, {
      kind: 'edit',
      operation: { kind: 'replaceRange', range: { startOffset: 7, endOffsetExclusive: 10 }, text: 'new' }
    });
    await application.refreshPreviewResources(id);
    await waitUntil(() => {
      host.clock.advance(1);
      return runtime.metrics().frameCommits > initialCommits;
    });
    assert.equal(application.state().project.buffers[id]?.previewResourceRevision, 1);
    assert.equal(previewUpdates.length, 1);
    const committedFrame = runtime.frame();
    assert.ok(committedFrame);
    assert.match(renderFramePlain(committedFrame), /new value/u);
    assert.equal(committedFrame.cells.some((cell) => cell.style?.underline === true), true);
    firstGate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(application.state().project.buffers[id]?.previewResourceRevision, 1);
    assert.equal(previewUpdates.length, 1);
    unsubscribe();
  } finally {
    firstGate.resolve();
    await runtime.dispose();
    await application.dispose();
  }
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete as (value?: T) => void;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out while waiting for an asynchronous preview update.');
}
