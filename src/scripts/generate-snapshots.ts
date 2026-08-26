import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBufferParser } from '../markdown/preview.js';
import { createPreviewLayoutCache, layoutMarkdownPreview } from '../markdown/render/layout.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';

const fixtures = Object.freeze([
  Object.freeze({
    name: 'document',
    source: '---\ntitle: Example\n---\n\n# Heading\n\nParagraph with **strong**, [link](./target.md), $x^2$, and a footnote[^1].\n\n> [!NOTE]\n> A callout.\n\n| A | B |\n| - | - |\n| x | y |\n\n[^1]: Detail.'
  }),
  Object.freeze({ name: 'malformed', source: '---\nunsafe: !tag value\n\n**unclosed\n\n$$\nmath' })
]);

const snapshot = fixtures.map((fixture) => {
  const parser = createBufferParser(fixture.source, 0);
  const preview = parser.preview();
  if (preview.kind === 'failed') return Object.freeze({ name: fixture.name, failure: preview.message });
  const layout = layoutMarkdownPreview(
    preview.snapshot.document.tree,
    preview.snapshot.source,
    44,
    darkTerminalMarkdownTheme,
    createPreviewLayoutCache()
  );
  return Object.freeze({
    name: fixture.name,
    diagnostics: preview.snapshot.document.diagnostics,
    metrics: preview.metrics,
    rows: layout.lines.map((line) => Object.freeze({
      sourceOffset: line.sourceOffset,
      text: line.inlineSpans.map((span) => span.text).join('')
    }))
  });
});

const output = JSON.stringify(snapshot, null, 2) + '\n';
const filePath = path.join(process.cwd(), 'snapshots', 'preview.json');
if (process.argv.includes('--write')) {
  await writeFile(filePath, output, 'utf8');
} else {
  const current = await readFile(filePath, 'utf8');
  if (current !== output) throw new Error('Preview snapshots are stale. Run npm run snapshots:update.');
}
