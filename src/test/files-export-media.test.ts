import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodeHighlighter } from '../markdown/highlight.js';
import { createMathRenderer } from '../markdown/math.js';
import { createMarkdownImageLoader } from '../markdown/image-loader.js';
import { createDiagramRendererRegistry } from '../markdown/diagram.js';
import { readSourceFile, saveSourceFile } from '../files/file-system.js';
import { exportProjectDirectory, exportSourceDocument } from '../export/exporter.js';
import { builtInExportProfiles, type ExportProfile } from '../export/profiles.js';
import { createVellumApplication } from '../app/application.js';
import { loadUserMarkdownTheme } from '../markdown/theme.js';

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
    await saveSourceFile(link, 'changed\r\n', { format: opened.format, expectedFingerprint: opened.fingerprint });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.deepEqual([...await readFile(target)].slice(0, 3), [0xef, 0xbb, 0xbf]);
    assert.equal((await readSourceFile(link)).source, 'changed\r\n');
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o640);
  } finally {
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('export invokes an executable directly with deterministic Pandoc arguments and protects output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-export-'));
  const script = path.join(directory, 'export-double.mjs');
  const source = path.join(directory, 'document.md');
  const output = path.join(directory, 'document.html');
  try {
    await writeFile(source, '# Export', 'utf8');
    await writeFile(script, [
      "import { writeFile } from 'node:fs/promises';",
      "const outputIndex = process.argv.indexOf('--output');",
      "await writeFile(process.argv[outputIndex + 1], JSON.stringify(process.argv.slice(2)), 'utf8');"
    ].join('\n'), 'utf8');
    const profile: ExportProfile = Object.freeze({
      id: 'test-html', label: 'Test HTML', targetFormat: 'html5', outputExtension: '.html',
      executable: process.execPath, arguments: Object.freeze([script]), resourcePaths: Object.freeze(['images'])
    });
    const result = await exportSourceDocument(source, profile, { outputPath: output });
    assert.equal(result.executable, process.execPath);
    assert.ok(result.arguments.includes('--from=gfm'));
    assert.ok(result.arguments.includes('--to=html5'));
    assert.ok(result.arguments.includes(output));
    assert.match(await readFile(output, 'utf8'), /document\.md/u);
    await assert.rejects(() => exportSourceDocument(source, profile, { outputPath: output }), /already exists/u);
    await exportSourceDocument(source, profile, { outputPath: output, overwrite: true });
    const missing = { ...profile, executable: path.join(directory, 'missing-executable') };
    await assert.rejects(() => exportSourceDocument(source, missing, { outputPath: path.join(directory, 'missing.html') }), /not found/u);
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
      const result = await exportSourceDocument(source, profile, { outputPath });
      assert.ok(result.arguments.includes(`--to=${builtIn.targetFormat}`));
      assert.equal(result.outputPath, outputPath);
    }

    const project = path.join(directory, 'project');
    await mkdir(path.join(project, 'nested'), { recursive: true });
    await writeFile(path.join(project, 'z.md'), '# Z', 'utf8');
    await writeFile(path.join(project, 'a.markdown'), '# A', 'utf8');
    await writeFile(path.join(project, 'nested', 'b.md'), '# B', 'utf8');
    const projectProfile: ExportProfile = {
      id: 'project-html', label: 'Project HTML', targetFormat: 'html5', outputExtension: '.html',
      executable: process.execPath, arguments: Object.freeze([script, 'success']), resourcePaths: Object.freeze([])
    };
    const projectResults = await exportProjectDirectory(project, projectProfile);
    assert.deepEqual(projectResults.map((result) => path.relative(project, result.inputPath).split(path.sep).join('/')), ['a.markdown', 'nested/b.md', 'z.md']);

    const failedProfile = { ...projectProfile, id: 'failure', arguments: Object.freeze([script, 'fail']) };
    await assert.rejects(
      () => exportSourceDocument(source, failedProfile, { outputPath: path.join(directory, 'failure.html') }),
      /profile failure/u
    );
    const timeoutProfile = { ...projectProfile, id: 'timeout', arguments: Object.freeze([script, 'delay']) };
    await assert.rejects(
      () => exportSourceDocument(source, timeoutProfile, { outputPath: path.join(directory, 'timeout.html'), timeoutMilliseconds: 10 }),
      /timeout/u
    );
    const controller = new AbortController();
    const cancelled = exportSourceDocument(source, timeoutProfile, {
      outputPath: path.join(directory, 'cancelled.html'), signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('export cancelled')), 10);
    await assert.rejects(cancelled, /abort|cancel/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('highlighting, math, diagrams, and local terminal images are asynchronous, cached, and cancellable', async () => {
  const highlighter = createCodeHighlighter();
  const first = await highlighter.highlight('ts', 'const value: number = 4;');
  const second = await highlighter.highlight('typescript', 'const value: number = 4;');
  assert.equal(first, second);
  assert.ok((first?.tokens.length ?? 0) > 0);
  assert.equal(await highlighter.highlight('unsupported', 'text'), undefined);

  const math = createMathRenderer();
  const renderedMath = await math.render('\\frac{1}{2} \\leq x^2');
  assert.match(renderedMath.text, /\(1\)\/\(2\).*≤.*²/u);
  assert.equal(await math.render('\\frac{1}{2} \\leq x^2'), renderedMath);

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

    const diagramScript = path.join(directory, 'diagram.mjs');
    await writeFile(diagramScript, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('<svg/>'));", 'utf8');
    const diagrams = createDiagramRendererRegistry([{
      language: 'mermaid', executable: process.execPath, arguments: Object.freeze([diagramScript]), version: 'test-1',
      outputContentType: 'image/svg+xml'
    }]);
    const diagram = await diagrams.render('mermaid', 'graph TD; A-->B');
    assert.equal(new TextDecoder().decode(diagram?.bytes), '<svg/>');
    assert.equal(await diagrams.render('mermaid', 'graph TD; A-->B'), diagram);
    assert.equal(await diagrams.render('python', 'print(1)'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      '```mermaid', 'graph TD; A-->B', '```'
    ].join('\n'), 'utf8');
    const application = createVellumApplication({
      watchFiles: false,
      createBufferId: () => 'resources',
      diagramRenderers: [{
        language: 'mermaid', executable: process.execPath, arguments: Object.freeze([diagramScript]),
        version: 'test-1', outputContentType: 'image/x-portable-pixmap'
      }]
    });
    try {
      const id = await application.openFile(documentPath);
      await application.refreshPreviewResources(id);
      const layout = application.previewLayout(id, 60);
      const rendered = layout?.lines.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n') ?? '';
      assert.match(rendered, /x² ≤ 4/u);
      assert.ok(layout?.lines.some((line) => line.inlineSpans.some((span) => span.style?.bold === true)));
      assert.equal([...application.previewImages(id).values()].filter((image) => image.kind === 'ready').length, 2);
      assert.equal(application.runtimeBufferInfo(id)?.pendingEffects, 0);
      assert.equal(application.requestCloseBuffer(id), true);
      assert.equal(application.runtimeBufferInfo(id), undefined);
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
