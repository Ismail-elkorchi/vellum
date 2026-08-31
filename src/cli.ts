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
import { batchExportDirectory, exportDocument } from './export/exporter.js';
import { exportProjectManifest, loadProjectManifest } from './export/project.js';
import { createRecoveryStore } from './recovery/recovery.js';
import { createSessionStore } from './session/session.js';
import { runVellum } from './tui.js';
import { loadUserKeymap } from './commands/keymap.js';
import { loadUserMarkdownTheme, type MarkdownTheme } from './markdown/theme.js';
import { runKeyboardReport } from './keyboard-report.js';
import type { ConfigurationDiagnostic } from './app/types.js';
import { detectedDiagramRenderers } from './markdown/diagram.js';

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
    if (parsed.kind === 'keyboardReport') {
      await runKeyboardReport();
      return 0;
    }
    if (parsed.kind === 'checkKeymap') {
      const keymap = await loadUserKeymap();
      for (const diagnostic of keymap.diagnostics) {
        streams.output.write(`${diagnostic.severity}: keymap entry ${String(diagnostic.index + 1)}: ${diagnostic.message}\n`);
      }
      streams.output.write(`${String(keymap.entries.length)} active key bindings.\n`);
      return keymap.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
    }
    const userProfiles = await loadUserExportProfiles();
    if (parsed.strictConfig === true && userProfiles.diagnostics.length > 0) {
      throw new Error(userProfiles.diagnostics.map((diagnostic) => (
        `Export profile ${diagnostic.profileId}: ${diagnostic.message}`
      )).join('\n'));
    }
    const exportProfiles = Object.freeze([...builtInExportProfiles, ...userProfiles.profiles]);
    if (parsed.kind === 'export') {
      reportConfigurationDiagnostics(streams.error, userProfiles.diagnostics.map((diagnostic) => (
        `Export profile ${diagnostic.profileId}: ${diagnostic.message}`
      )));
      const status = await stat(parsed.path);
      if (parsed.scope === 'projectManifest') {
        if (!status.isDirectory()) throw new Error('Project manifest export requires a project directory.');
        await exportProjectManifest(
          parsed.path,
          await loadProjectManifest(parsed.path),
          exportProfiles,
          new Map(),
          { overwrite: parsed.overwrite }
        );
      } else {
        const profile = exportProfiles.find((candidate) => candidate.id === parsed.profileId);
        if (profile === undefined) throw new Error(`Unknown export profile: ${parsed.profileId}`);
        if (parsed.scope === 'batchDirectory') {
          if (!status.isDirectory()) throw new Error('Batch export requires a project directory.');
          await batchExportDirectory(parsed.path, profile, new Map(), { overwrite: parsed.overwrite });
        } else if (status.isFile()) {
          await exportDocument({ kind: 'disk', path: parsed.path }, profile, {
          ...(parsed.outputPath === undefined ? {} : { outputPath: parsed.outputPath }),
          overwrite: parsed.overwrite
          });
        } else throw new Error('Document export requires one source file; use --batch or --project-manifest for a directory.');
      }
      return 0;
    }
    const userTheme = await loadUserMarkdownTheme();
    if (parsed.strictConfig === true && userTheme.diagnostics.length > 0) {
      throw new Error(userTheme.diagnostics.map((diagnostic) => (
        `${diagnostic.key.length === 0 ? 'Markdown theme' : `Markdown theme ${diagnostic.key}`}: ${diagnostic.message}`
      )).join('\n'));
    }
    const keymap = await loadUserKeymap();
    if (parsed.strictConfig === true && keymap.diagnostics.length > 0) {
      throw new Error(keymap.diagnostics.map((diagnostic) => `Keymap entry ${String(diagnostic.index + 1)}: ${diagnostic.message}`).join('\n'));
    }
    const startupDiagnostics: ConfigurationDiagnostic[] = [
      ...userProfiles.diagnostics.map((diagnostic) => Object.freeze({
        source: 'exportProfiles' as const,
        severity: 'error' as const,
        message: `${diagnostic.profileId}: ${diagnostic.message}`
      })),
      ...userTheme.diagnostics.map((diagnostic) => Object.freeze({
        source: 'theme' as const,
        severity: 'error' as const,
        message: `${diagnostic.key.length === 0 ? 'Markdown theme' : diagnostic.key}: ${diagnostic.message}`
      })),
      ...keymap.diagnostics.map((diagnostic) => Object.freeze({
        source: 'keymap' as const,
        severity: diagnostic.severity,
        message: `Entry ${String(diagnostic.index + 1)}: ${diagnostic.message}`
      }))
    ];
    if (parsed.kind !== 'open') throw new Error(`Unsupported CLI mode: ${String(parsed.kind)}`);
    const application = await prepareApplication(
      parsed,
      streams.input,
      userTheme.theme,
      userProfiles.profiles,
      startupDiagnostics
    );
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
  exportProfiles: readonly ExportProfile[],
  startupDiagnostics: readonly ConfigurationDiagnostic[]
): Promise<VellumApplication> {
  const requestedStatus = parsed.path === undefined || parsed.path === '-'
    ? undefined
    : await stat(parsed.path);
  const recoveryStore = createRecoveryStore();
  const sessionStore = createSessionStore();
  const diagramRenderers = detectedDiagramRenderers();
  const application = parsed.path === undefined
    ? await restoreVellumApplication(sessionStore, recoveryStore, {
        markdownTheme,
        exportProfiles,
        startupDiagnostics,
        diagramRenderers
      })
    : createVellumApplication({
        sessionStore,
        recoveryStore,
        markdownTheme,
        exportProfiles,
        startupDiagnostics,
        diagramRenderers
      });
  try {
    if (parsed.path === '-') {
      application.openSource(await readStandardInput(input));
    } else if (parsed.path !== undefined) {
      if (requestedStatus?.isDirectory() === true) await application.openProjectDirectory(parsed.path);
      else if (requestedStatus?.isFile() === true) await application.openFile(parsed.path);
      else throw new Error(`The requested path is neither a file nor a directory: ${parsed.path}`);
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

function reportConfigurationDiagnostics(stream: NodeJS.WritableStream, diagnostics: readonly string[]): void {
  for (const diagnostic of diagnostics) stream.write(`warning: ${diagnostic}\n`);
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
