#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { stdin, stderr, stdout } from 'node:process';
import {
  createVellumApplication,
  restoreVellumApplication,
  type VellumApplication
} from './app/application.js';
import { commandHelp, parseCliArguments, type CliArguments, type OpenCliArguments } from './cli-options.js';
import { builtInExportProfiles, loadUserExportProfiles, type ExportProfile } from './export/profiles.js';
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
    const userProfiles = await loadUserExportProfiles();
    if (userProfiles.diagnostics.length > 0) {
      throw new Error(userProfiles.diagnostics.map((diagnostic) => (
        `Export profile ${diagnostic.profileId}: ${diagnostic.message}`
      )).join('\n'));
    }
    const exportProfiles = Object.freeze([...builtInExportProfiles, ...userProfiles.profiles]);
    if (parsed.kind === 'export') {
      const profile = exportProfiles.find((candidate) => candidate.id === parsed.profileId);
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
    const keymap = await loadUserKeymap();
    if (keymap.diagnostics.length > 0) {
      throw new Error(keymap.diagnostics.map((diagnostic) => `Keymap entry ${String(diagnostic.index + 1)}: ${diagnostic.message}`).join('\n'));
    }
    const application = await prepareApplication(parsed, streams.input, userTheme.theme, userProfiles.profiles);
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
  markdownTheme: MarkdownTheme,
  exportProfiles: readonly ExportProfile[]
): Promise<VellumApplication> {
  const requestedStatus = parsed.path === undefined || parsed.path === '-'
    ? undefined
    : await stat(parsed.path);
  const recoveryStore = createRecoveryStore();
  const application = parsed.path === undefined
    ? await restoreVellumApplication(recoveryStore, { markdownTheme, exportProfiles })
    : createVellumApplication({ recoveryStore, markdownTheme, exportProfiles });
  try {
    if (parsed.path === '-') {
      application.openSource(await readStandardInput(input));
    } else if (parsed.path !== undefined) {
      if (requestedStatus?.isDirectory() === true) await application.openProjectDirectory(parsed.path);
      else if (requestedStatus?.isFile() === true) await application.openFile(parsed.path);
      else throw new Error(`The requested path is neither a file nor a directory: ${parsed.path}`);
    } else if (application.state().project.bufferOrder.length === 0) {
      application.newBuffer();
    }
    if (parsed.editorMode === 'hybrid') application.dispatchCommand('view.editorHybrid');
    else if (parsed.editorMode === 'source') application.dispatchCommand('view.editorSource');
    if (parsed.paneArrangement === 'preview') application.dispatchCommand('view.preview');
    if (parsed.line !== undefined) placeCaretAtLine(application, parsed.line);
    return application;
  } catch (error) {
    await application.dispose();
    throw error;
  }
}

function placeCaretAtLine(application: VellumApplication, line: number): void {
  const state = application.state();
  const id = state.project.activeBufferId;
  const buffer = id === undefined ? undefined : state.project.buffers[id];
  if (id === undefined || buffer === undefined) throw new Error('--line requires an open source document.');
  if (buffer.preview.kind !== 'ready' || line > buffer.preview.snapshot.document.sourceIndex.lineCount) {
    throw new Error(`Source line ${String(line)} does not exist.`);
  }
  const offset = buffer.preview.snapshot.document.sourceIndex.lineSpan(line - 1).start;
  application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset } });
}

async function readStandardInput(input: NodeJS.ReadableStream): Promise<string> {
  input.setEncoding('utf8');
  let source = '';
  for await (const chunk of input) source += String(chunk);
  return source;
}

process.exitCode = await runCli(process.argv.slice(2));
