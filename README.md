# Vellum

Vellum is a project-aware terminal Markdown editor. The Markdown source is the
only authoritative document; hybrid presentation, preview, search, navigation,
diagnostics, recovery, and export are derived from exact source offsets.

Vellum uses
[`@ismail-elkorchi/terminal-ui`](https://github.com/Ismail-elkorchi/terminal-ui)
for terminal interaction and [`markspan`](https://github.com/Ismail-elkorchi/markspan)
for source-exact CommonMark/GFM parsing and incremental syntax trees.

## Build and run

Vellum requires Node.js 24 or newer. From a checkout:

```sh
npm ci
npm run build
node dist/cli.js README.md
```

The package exposes a `vellum` executable, so `npm link` may be used during
local development. The command accepts a file, a project directory, or UTF-8
Markdown on standard input:

```sh
vellum
vellum README.md
vellum docs/
vellum README.md --line 72 --hybrid
vellum README.md --preview
vellum - --preview
vellum export README.md --profile html
vellum export docs/ --batch --profile html
vellum export book/ --project-manifest
```

Run `vellum --help` for the complete generated command reference. Starting
without a path restores the previous session or opens the empty-workspace
screen.

## Editing and preview

Each buffer independently retains source, caret, selection, undo/redo history,
source and preview scroll, disk fingerprint, parser session, and layout state.
Opening an already-open file activates that buffer instead of creating another
copy.

Editor mode and pane arrangement are independent:

- Source mode presents literal Markdown.
- Hybrid mode styles the same source and conceals inactive delimiters.
- Pane arrangement is editor, preview, or editor and preview.

Hybrid mode reveals exact syntax around the caret. It also provides source-exact
visual presentations for inactive tables, typed YAML front matter, standalone
images, equations, Mermaid fences, callouts, and table-of-contents blocks.
Table commands navigate and modify cells, rows, and columns without creating a
second document model. Focus, typewriter, and distraction-free writing modes
are independent.

Preview supports CommonMark/GFM, front matter, callouts, footnotes, math, local
images, diagrams, highlighted fenced code, links, tasks, and accessible
structure. Raw HTML remains inert. Preview and source scrolling use Markspan
source mappings and terminal row-offset maps, including wraps, tabs, grapheme
widths, decorations, gutters, and terminal resizing.

Code tokenizers are lazy and shared across buffers. The workspace also shares
bounded caches for math, diagrams, and decoded images. PNG, JPEG, WebP, GIF,
SVG, and binary PPM are accepted under encoded, decoded, and dimension limits;
animation is reduced to its first frame and unsafe or externally-referencing SVG
is rejected. Remote images are disabled by default. A local math renderer is
always available, and applications embedding Vellum may provide a fuller math
renderer. The CLI automatically uses `mmdc` for Mermaid when a working
executable is available and otherwise shows an explicit source fallback.

## Workspace

A project indexes `.md`, `.markdown`, `.mdown`, and `.mkd` files beneath one
root. The maintained index records headings, links, front-matter properties,
tags, citations, task states, searchable source, and image assets. It honors
`.gitignore`, `.ignore`, configured include/exclude patterns, file-size limits,
binary detection, and the configured file-symlink policy. Directory symlinks are
not traversed.

File-watch events update only affected index paths. Directory topology or
ignore-rule changes trigger a fresh traversal. Unsaved open buffers overlay the
disk index for search, links, diagnostics, and exports.

The Files navigator and command palette support creating files and directories,
renaming or moving entries with source-exact link updates, duplication, moving
to the operating-system trash, copying paths, external reveal, filtering,
sorting, refresh, recent and pinned projects, image import, clipboard image
import, and unused-asset detection. File moves are committed as transactions;
open buffers and project links are changed only after filesystem work succeeds.

The persistent navigator switches between Files, Outline, Search, Diagnostics,
Backlinks, Properties, and Export. Its visibility, mode, width, tree expansion,
split ratio, and writing layout are part of the clean session.

Project search streams bounded result batches, cancels stale queries, searches
unsaved buffers, retains recent queries, and supports literal, word, case,
regular-expression, include/exclude, and result-order options. Query fields
include:

```text
"exact phrase"
/regular expression/
path:docs/**
file:README
heading:architecture
property:status=draft
task:open
link:target.md
-link:target.md
```

## Completion and diagnostics

Press `F12` for contextual completion. Completion uses exact replacement ranges
for document links, target headings, image paths, reference and footnote
definitions, code-fence languages, front-matter keys, tags, citations, callout
types, and built-in snippets.

One diagnostics model combines parser, Markdown style, spelling, grammar,
broken-link, missing-asset, and export checks. The built-in providers cover
parser errors, repeated words, whitespace, local links/assets, and preview versus
export dialect differences. A Hunspell-compatible word list enables spelling,
including a personal dictionary. `languageToolProvider()` supports an explicit
local or remote LanguageTool endpoint; it is not enabled by default. Diagnostic
navigation, filtering, fixes, ignored rules, dictionary additions, and document
or project refresh all use exact source spans.

## Keyboard

`F1` opens the command palette. Important portable defaults are:

| Binding | Command |
| --- | --- |
| `F1` | Command palette |
| `Ctrl+N` | New file |
| `Ctrl+O` | Open file |
| `Alt+D` | Open project directory |
| `Ctrl+S` | Save |
| `Alt+S` | Save as |
| `Alt+A` | Save all |
| `Ctrl+W` | Close active buffer |
| `Alt+R` | Reopen recently closed buffer |
| `Ctrl+P` | Quick open |
| `Ctrl+F` / `Ctrl+R` | Find / replace |
| `F3` | Project search |
| `Alt+O` | Document outline |
| `F4` / `Shift+F4` | Next / previous diagnostic |
| `F6` / `Shift+F6` | Next / previous heading |
| `F7` / `F8` | Preview / split view |
| `F11` | Distraction-free mode |
| `F12` | Contextual completion |
| `Alt+Left` / `Alt+Right` | Navigate back / forward |
| `Ctrl+Q` | Quit |

Defaults avoid `Ctrl+Shift+letter`, `Ctrl+H`, `Ctrl+I`, and `Ctrl+Alt+letter`.
Legacy terminals cannot distinguish some of those chords from ordinary control
characters, while `Ctrl+Alt` may collide with AltGr input on international
layouts.

Vellum reads `keymap.json` from its platform configuration directory:

- Linux: `$XDG_CONFIG_HOME/vellum/keymap.json` or `~/.config/vellum/keymap.json`
- macOS: `~/Library/Application Support/Vellum/keymap.json`
- Windows: `%APPDATA%\Vellum\keymap.json`

```json
[
  { "command": "file.quickOpen", "key": "ctrl+p" },
  { "command": "markdown.formatTable", "key": "f5" }
]
```

Malformed, duplicate, unknown, protocol-dependent, text-control, AltGr-prone,
and commonly intercepted bindings are diagnosed. Valid entries still load, and
interactive startup falls back to portable built-ins for invalid entries. Use
`vellum --check-keymap` to validate the active keymap and
`vellum --keyboard-report` to see the normalized events received from the
current terminal. `--strict-config` makes configuration diagnostics fatal for
CI or scripted use.

## Saving, sessions, and recovery

Saves preserve UTF-8 BOM state, LF/CRLF line endings, permissions, and symbolic
links. Vellum writes and flushes a temporary file beside the target before an
atomic rename. Existing output is not replaced without an explicit action.

Clean session continuity and unsaved-source recovery are separate:

- `session.json` stores project, clean tab paths, active buffer, caret,
  selection, scroll anchors, tree expansion, split layout, navigator, writing
  modes, recent searches/projects, diagnostics preferences, and export history.
  It does not duplicate saved file contents.
- The bounded recovery journal stores only untitled or dirty source with disk
  fingerprints, generations, timestamps, and checksums. Multiple generations
  can be selected after startup.

Corrupt or unknown session/recovery data is quarantined and reported instead of
preventing startup. File watchers detect replacement, modification, rename, and
deletion. Conflicts require an explicit Compare, Reload, Keep Buffer, Save As,
Overwrite, Recreate, or Close action; no implicit operation overwrites the disk.

## Export

Built-in Pandoc profiles target HTML, PDF, DOCX, and EPUB. An export profile
defines reader and writer extensions, standalone mode, templates, stylesheets,
filters, bibliography, CSL, metadata, resource paths, environment, output name,
and post-export action. Vellum executes an argument array directly without a
shell.

Interactive document export uses current in-memory source, including unsaved
changes. Batch Export Directory exports each Markdown document independently.
A true multi-file project export reads `.vellum/project.json`, combines files in
declared order, and runs its selected profiles. Export history records progress,
warnings, stderr, output paths, elapsed time, and unsaved-source use; an export
can be cancelled or repeated with the same output.

Example `.vellum/project.json`:

```json
{
  "version": 1,
  "title": "Example Book",
  "files": ["intro.md", "chapters/one.md"],
  "profiles": [{ "profileId": "html" }, { "profileId": "pdf" }],
  "metadata": { "author": "Example Author" },
  "bibliography": [],
  "resourcePaths": ["assets"],
  "outputDirectory": "build"
}
```

`export-profiles.json` and `markdown-theme.json` live beside `keymap.json`.
Configuration is schema-checked: unknown fields are errors, valid entries still
load in interactive mode, and built-ins remain available. Export diagnostics
identify syntax whose configured Pandoc reader or filters do not match preview
meaning.

## Verification

```sh
npm test
npm run snapshots
npm run benchmark
npm run verify:package
```

The suite covers source/file safety, concurrent operation domains, full
application visual and accessibility frames at multiple terminal sizes, real
PTY keyboard/mouse/paste/resize/focus behavior, Unicode and multilingual text,
preview resources, project transactions, session/recovery, and publishing.
Benchmark checks emit machine-readable measurements with regression gates for a
1 MiB document, a 10,000-file Quick Open index, warm project search, and
cancellation acknowledgement.
