#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { stdin, stderr, stdout } from 'node:process';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import {
  createVellumApplication,
  restoreVellumApplication,
  type VellumApplication
} from './app/application.js';
import { commandHelp, parseCliArguments, type CliArguments, type OpenCliArguments } from './cli-options.js';
import { builtInExportProfiles } from './export/profiles.js';
import { exportProjectDirectory, exportSourceDocument } from './export/exporter.js';
import { createRecoveryStore } from './recovery/recovery.js';
import { runVellum } from './tui.js';
import { loadUserKeymap } from './commands/keymap.js';
import { loadUserMarkdownTheme, type MarkdownTheme } from './markdown/theme.js';

async function runCli(
  arguments_: readonly string[],
  streams: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream; readonly error: NodeJS.WritableStream } = {
    input: stdin,
    output: stdout,
    error: stderr
  }
): Promise<number> {
  let parsed: CliArguments;
  try {
    parsed = parseCliArguments(arguments_);
  } catch (error) {
    streams.error.write(`${error instanceof Error ? error.message : String(error)}\n\n${commandHelp()}\n`);
    return 2;
  }
  if (parsed.help) {
    streams.output.write(commandHelp() + '\n');
    return 0;
  }
  try {
    if (parsed.kind === 'export') {
      const profile = builtInExportProfiles.find((candidate) => candidate.id === parsed.profileId);
      if (profile === undefined) throw new Error(`Unknown export profile: ${parsed.profileId}`);
      const status = await stat(parsed.path);
      if (status.isDirectory()) {
        if (parsed.outputPath !== undefined) throw new Error('--output cannot name one file when exporting a project directory.');
        await exportProjectDirectory(parsed.path, profile, { overwrite: parsed.overwrite });
      } else if (status.isFile()) {
        await exportSourceDocument(parsed.path, profile, {
          ...(parsed.outputPath === undefined ? {} : { outputPath: parsed.outputPath }),
          overwrite: parsed.overwrite
        });
      } else throw new Error(`Export input is neither a file nor a directory: ${parsed.path}`);
      return 0;
    }
    const userTheme = await loadUserMarkdownTheme();
    if (userTheme.diagnostics.length > 0) {
      throw new Error(userTheme.diagnostics.map((diagnostic) => (
        `${diagnostic.key.length === 0 ? 'Markdown theme' : `Markdown theme ${diagnostic.key}`}: ${diagnostic.message}`
      )).join('\n'));
    }
    const application = await prepareApplication(parsed, streams.input, userTheme.theme);
    const keymap = await loadUserKeymap();
    if (keymap.diagnostics.length > 0) {
      throw new Error(keymap.diagnostics.map((diagnostic) => `Keymap entry ${String(diagnostic.index + 1)}: ${diagnostic.message}`).join('\n'));
    }
    await runVellum(application, keymap);
    return 0;
  } catch (error) {
    streams.error.write((error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}

async function prepareApplication(
  parsed: OpenCliArguments,
  input: NodeJS.ReadableStream,
  markdownTheme: MarkdownTheme
): Promise<VellumApplication> {
  const recoveryStore = createRecoveryStore();
  const application = parsed.path === undefined
    ? await restoreVellumApplication(recoveryStore, { markdownTheme })
    : createVellumApplication({ recoveryStore, markdownTheme });
  if (parsed.path === '-') {
    application.openSource(await readStandardInput(input));
  } else if (parsed.path !== undefined) {
    const status = await stat(parsed.path);
    if (status.isDirectory()) await application.openProjectDirectory(parsed.path);
    else if (status.isFile()) await application.openFile(parsed.path);
    else throw new Error(`The requested path is neither a file nor a directory: ${parsed.path}`);
  } else if (application.state().project.bufferOrder.length === 0) {
    application.newBuffer();
  }
  if (parsed.editorMode === 'hybrid') application.dispatchCommand('view.editorHybrid');
  else application.dispatchCommand('view.editorSource');
  if (parsed.paneArrangement === 'preview') application.dispatchCommand('view.preview');
  if (parsed.line !== undefined) placeCaretAtLine(application, parsed.line);
  return application;
}

function placeCaretAtLine(application: VellumApplication, line: number): void {
  const state = application.state();
  const id = state.project.activeBufferId;
  const buffer = id === undefined ? undefined : state.project.buffers[id];
  if (id === undefined || buffer === undefined) throw new Error('--line requires an open source document.');
  let offset = 0;
  let currentLine = 1;
  const source = textDocumentText(buffer.editor.document);
  while (currentLine < line && offset < source.length) {
    const next = source.indexOf('\n', offset);
    if (next < 0) break;
    offset = next + 1;
    currentLine += 1;
  }
  if (currentLine !== line) throw new Error(`Source line ${String(line)} does not exist.`);
  application.applyTextAreaAction(id, { kind: 'pointer', action: { kind: 'placeCaret', offset } });
}

async function readStandardInput(input: NodeJS.ReadableStream): Promise<string> {
  input.setEncoding('utf8');
  let source = '';
  for await (const chunk of input) source += String(chunk);
  return source;
}

process.exitCode = await runCli(process.argv.slice(2));
