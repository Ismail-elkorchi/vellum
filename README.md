# Vellum

Vellum is a terminal-first Markdown editor whose interface is built with [`@ismail-elkorchi/terminal-ui`](https://github.com/Ismail-elkorchi/terminal-ui) and whose source-aware syntax tree comes from [`markspan`](https://github.com/Ismail-elkorchi/markspan). It combines a controlled source editor with an incremental, block-aware, width-aware terminal preview.

## Requirements

- Node.js 24 or newer
- A terminal with UTF-8 support
- OSC 8 support for clickable preview links, when available

## Run

```sh
npm install
npm run build
npm start
```

Vellum starts with a new document. Use `Ctrl+O` to open an existing `.md` file or `Ctrl+Shift+S` to choose a destination for a new document.

## Interface

Vellum has three modes:

- **Edit** — the source editor fills the workspace.
- **Split** — source and preview are shown side by side on wide terminals, stacked on medium terminals, or one active pane at a time on compact terminals.
- **Preview** — a centered reading column renders the document without Markdown source delimiters.

The source editor provides line numbers, active-line emphasis, selection, soft wrapping, scrolling, undo/redo through the `terminal-ui` text behavior, and a compact status bar.

The preview preserves block and inline structure. It supports headings, paragraphs, strong and emphasized text, strikethrough, inline code, links, blockquotes, ordered and unordered lists, tasks, nested lists, code blocks, tables, horizontal rules, images, hard breaks, footnotes, and safe HTML placeholders. Tables measure terminal-cell width and switch to a stacked record layout when a terminal is too narrow.

Preview parsing is incremental. Unchanged Markspan nodes retain stable identities, their terminal layouts are reused, and Split-mode scrolling maps source positions to rendered blocks instead of estimating positions from document percentages.

Raw HTML is never executed. Images are represented by labeled terminal placeholders with their destinations.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a Markdown file |
| `Ctrl+S` | Save |
| `F2` / `Ctrl+Shift+S` | Save As |
| `Ctrl+P` | Cycle Edit → Split → Preview |
| `Tab` / `Shift+Tab` | Switch the active Split pane |
| Arrow keys | Scroll the focused Preview pane |
| `Page Up` / `Page Down` | Scroll Preview by a page |
| `Home` / `End` | Move Preview to the beginning or end |
| `Alt+Arrow` | Resize a visible split |
| `F1` | Open keyboard help |
| `Ctrl+Q` | Quit |

Vellum asks before discarding unsaved work when opening another file or quitting.

`F2` provides a Save As binding in terminals whose input protocol cannot distinguish `Ctrl+Shift+S` from `Ctrl+S`.

## Architecture

- `src/editor-state.ts` owns immutable document, preview, dialog, scroll, and split-pane state.
- `src/markdown/preview.ts` owns the active Markspan session and publishes immutable source-aware preview snapshots.
- `src/markdown/render.ts` renders Markspan nodes directly, applies terminal-safety policy, and reuses layouts by stable node identity.
- `src/view.ts` composes the responsive workspace, status bar, and modal dialogs.
- `src/main.ts` defines shortcuts, effects, focus transitions, unsaved-change handling, and the TUI runtime.
- `src/file-io.ts` implements `.md` path handling and UTF-8 file operations.

## Verification

```sh
npm test
npm run snapshots
```

The suite covers incremental Markdown parsing and rendering, stable source identities, nested inline styles, loose and nested lists, CRLF input, Unicode tables, source-aware scrolling, responsive layouts, modal focus, unsaved-change behavior, exact save snapshots, file I/O, preview keyboard navigation, and terminal restoration.

Generated visual artifacts are stored in `snapshots/` for these layouts and states:

- `60×18`, `80×24`, `120×34`, and `160×40`
- empty editor
- compact, stacked, and wide Split layouts
- full Preview reading layout
- Open, Save As error, unsaved-change, and Help dialogs
