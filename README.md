# Vellum

Vellum is a project-aware terminal Markdown editor. A buffer always stores the
exact Markdown source document; preview, hybrid decorations, search, navigation,
document metrics, and export are derived from that source.

Vellum uses
[`@ismail-elkorchi/terminal-ui`](https://github.com/Ismail-elkorchi/terminal-ui)
for text editing, terminal layout, accessibility, graphics, tabs, and the file
tree. It uses [`markspan`](https://github.com/Ismail-elkorchi/markspan) for
source-exact CommonMark/GFM syntax trees and incremental parsing.

## Install and run

Vellum requires Node.js 24 or newer.

```sh
npm install --global vellum-markdown-editor
vellum README.md
```

The command accepts a file, a project directory, the current directory, or
UTF-8 Markdown on standard input:

```sh
vellum
vellum README.md
vellum .
vellum docs/
vellum README.md --line 72
vellum README.md --preview
vellum README.md --source
vellum README.md --hybrid
vellum - --preview
vellum export README.md --profile html
```

Run `vellum --help` for the options generated from the CLI definitions. Opening
a path never changes its extension. A project directory indexes Markdown files
below one root, omits `.git` and configured exclusions, and does not traverse
directory symbolic links.

## Buffers and panes

Each buffer independently retains its source text, caret, selection, undo/redo
history, source and preview scroll, revisions, external file revision, Markspan
session, and preview cache. Opening an already-open file activates its existing
buffer. Tabs show the file label, dirty state, and external conflict state.

Editor mode and pane arrangement are independent:

- Editor mode is `source` or `hybrid`.
- Pane arrangement is `editor`, `preview`, or `editorPreview`.

Hybrid mode styles the source document and conceals inactive Markdown
delimiters. Entering a syntax node reveals its delimiters. Copy, paste, search,
save, undo, redo, and diagnostics continue to use exact source offsets and exact
Markdown source.

The preview supports CommonMark and GFM, footnotes, YAML front matter, GFM
callouts, inline and block math, fenced-code highlighting, local images, and
Mermaid diagram fences. Raw HTML is shown as inert source placeholders. Remote
images are disabled unless explicitly enabled. Unsupported highlighting,
graphics, math, and diagram rendering retain labeled source fallbacks.
Fenced-code languages are loaded lazily from one canonical language registry;
aliases resolve to the same tokenizer, concurrent requests are deduplicated,
large blocks yield cooperatively, and stale or cancelled results cannot update a
newer source revision. Highlight ranges remain code-value offsets and are mapped
to source exclusively through Markspan's code-value source map. Math is parsed
and laid out locally without a network service or text-substitution formatter.

Editor and preview scrolling is synchronized through source offsets. The editor
row-offset map comes from the actual terminal text layout, including wrapping,
tabs, grapheme widths, gutters, concealed ranges, virtual text, scrollbars, and
terminal resizing. The preview uses a centered readable document column whose
gutter collapses in narrow panes. Preview rows retain Markspan source spans.

## Commands

`Ctrl+Alt+P` opens the command palette. The command registry is the source for
palette entries, availability, titles, categories, help labels, and default
bindings. Important defaults include:

| Binding | Command |
| --- | --- |
| `Ctrl+N` | New file |
| `Ctrl+O` | Open file |
| `Ctrl+Alt+D` | Open project directory |
| `Ctrl+S` | Save |
| `Ctrl+Alt+S` | Save as |
| `Ctrl+Alt+A` | Save all |
| `Ctrl+W` | Close active buffer |
| `Ctrl+Alt+R` | Reopen recently closed buffer |
| `Ctrl+P` | Quick open |
| `Ctrl+F` / `Ctrl+H` | Find / replace in the source document |
| `Ctrl+Alt+F` | Search the project directory |
| `Ctrl+Alt+O` | Open the document outline |
| `Alt+Left` / `Alt+Right` | Navigate back / forward |
| `F7` / `F8` | Preview / editor and preview |
| `Ctrl+Q` | Quit |

Default letter shortcuts avoid `Ctrl+Shift`: legacy terminal input cannot
distinguish `Ctrl+Shift+letter` from `Ctrl+letter`, and terminal emulators often
reserve those chords. User keymaps may still assign terminal-specific bindings.

Markdown commands cover strong and emphasis, inline code, links, task state,
heading level, code fences, block movement and duplication, list indentation,
and GFM table navigation and structure. Each operation produces one exact text
change set and one undo entry.

### User keymap

Vellum reads `keymap.json` from the platform configuration directory:

- Linux: `$XDG_CONFIG_HOME/vellum/keymap.json` or `~/.config/vellum/keymap.json`
- macOS: `~/Library/Application Support/Vellum/keymap.json`
- Windows: `%APPDATA%\Vellum\keymap.json`

The file is an array of command bindings:

```json
[
  { "command": "file.quickOpen", "key": "ctrl+p" },
  { "command": "markdown.formatTable", "key": "ctrl+alt+t" }
]
```

Unknown commands, malformed keys, duplicates, and conflicts are reported and do
not start the editor.

## Files, recovery, and conflicts

Saves preserve UTF-8 BOM state, LF/CRLF source text, permissions, and symbolic
links. Vellum writes and flushes a temporary file beside the target, then renames
it atomically. Existing output is not replaced without an explicit action.

Unsaved buffers are written atomically to the platform application-state
directory after a bounded delay and during controlled shutdown. A new
application instance restores the project directory, open-buffer order, active
buffer, exact source, selection, caret, scroll, editor mode, and pane
arrangement. Recovery records are removed after the corresponding buffers are
saved or intentionally discarded.

File watchers and metadata checks detect external replacement, modification,
deletion, and project-directory rename. A dirty conflict offers Compare, Reload
Disk, Keep Buffer, Save As, and Overwrite Disk. A deleted file offers Recreate,
Save As, and Close Buffer. No conflict action overwrites a disk file implicitly.

## Export

Built-in Pandoc profiles target HTML, PDF, DOCX, and EPUB. Export invokes the
configured executable directly with an argument array; it never interpolates a
shell command. User profiles specify an identifier, label, target format,
extension, executable, arguments, and resource paths. Existing outputs require
`--overwrite`. Project-directory export follows stable path order.

Both the interactive application and CLI load `export-profiles.json` from the
platform configuration directory beside `keymap.json` and
`markdown-theme.json`. The file is an array:

```json
[
  {
    "id": "company-html",
    "label": "Company HTML",
    "targetFormat": "html5",
    "outputExtension": ".html",
    "executable": "pandoc",
    "arguments": ["--standalone"],
    "resourcePaths": ["assets"]
  }
]
```

Malformed entries, unknown fields, and identifiers that conflict with built-in
profiles are reported before export or editor startup.

## Markdown theme

Vellum provides dark-terminal and light-terminal Markdown themes. An optional
`markdown-theme.json` beside `keymap.json` may override semantic terminal-style
entries such as `body`, `headings`, `link`, `frontMatter`, `callouts`, `math`,
and diagnostic severity. Unknown keys and invalid color/style values produce a
diagnostic instead of being ignored.

## Verification and benchmarks

```sh
npm ci
npm run verify
```

Verification builds strict declarations, runs integration tests, checks the
deterministic preview snapshot, runs the complete benchmark fixture set, proves
the package archive is reproducible, runs the packed CLI help target, and checks
`npm pack`. CI runs the same package on Node.js 24 across Ubuntu, macOS, and
Windows.
