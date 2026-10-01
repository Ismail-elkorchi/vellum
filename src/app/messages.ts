import type { CommandInputTransition, ScrollRequest, SplitPaneTransition, TextAreaTransition, TreeTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import type { TabsTransition } from '@ismail-elkorchi/terminal-ui/components';
import type { TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { BufferId, CommandId } from './types.js';
import type { VellumApplicationUpdate } from './application.js';
import type { MarkdownPreviewLayoutSnapshot } from '../markdown/render/component.js';
import type { MarkdownPreviewActivation } from '../markdown/render/layout.js';
import type { TextAreaLayoutSnapshot } from '@ismail-elkorchi/terminal-ui/components';
import type { TextDocument } from '@ismail-elkorchi/terminal-ui/text';

export type AppMessage =
  | { readonly kind: 'editorLayout'; readonly bufferId: BufferId; readonly snapshot: TextAreaLayoutSnapshot }
  | { readonly kind: 'previewLayout'; readonly bufferId: BufferId; readonly document: TextDocument; readonly resourceRevision: number; readonly snapshot: MarkdownPreviewLayoutSnapshot }
  | { readonly kind: 'editor'; readonly bufferId: BufferId; readonly transition: TextAreaTransition }
  | { readonly kind: 'previewScroll'; readonly bufferId: BufferId; readonly request: ScrollRequest }
  | { readonly kind: 'tabs'; readonly transition: TabsTransition<BufferId> }
  | { readonly kind: 'closeTab'; readonly bufferId: BufferId }
  | { readonly kind: 'fileTree'; readonly transition: TreeTransition }
  | { readonly kind: 'activateFileTree'; readonly nodeId: string }
  | { readonly kind: 'split'; readonly transition: SplitPaneTransition }
  | { readonly kind: 'command'; readonly commandId: CommandId }
  | { readonly kind: 'filePath'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitFilePath'; readonly value?: string }
  | { readonly kind: 'selection'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitSelection'; readonly value?: string }
  | { readonly kind: 'documentSearch'; readonly field: 'query' | 'replacement'; readonly transition: CommandInputTransition }
  | { readonly kind: 'configureDocumentSearch'; readonly option: 'regularExpression' | 'caseSensitive' | 'wholeWord' | 'selectionOnly' }
  | { readonly kind: 'navigateDocumentSearch'; readonly direction: 'next' | 'previous' }
  | { readonly kind: 'replaceDocumentSearch'; readonly scope: 'current' | 'all' }
  | { readonly kind: 'projectDirectorySearch'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitProjectDirectorySearch'; readonly value?: string }
  | { readonly kind: 'outline'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitOutline'; readonly value?: string }
  | { readonly kind: 'goToLine'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitGoToLine'; readonly value?: string }
  | { readonly kind: 'previewActivate'; readonly bufferId: BufferId; readonly target: MarkdownPreviewActivation }
  | { readonly kind: 'exportProfile'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitExportProfile'; readonly value?: string }
  | { readonly kind: 'dismissDialog' }
  | { readonly kind: 'resolveDirty'; readonly action: 'save' | 'discard' | 'cancel' }
  | { readonly kind: 'externalFile'; readonly action: 'compare' | 'reloadDisk' | 'keepBuffer' | 'saveAs' | 'overwriteDisk' | 'recreate' | 'closeBuffer' }
  | { readonly kind: 'checkExternalFiles' }
  | { readonly kind: 'applicationUpdate'; readonly update: VellumApplicationUpdate }
  | { readonly kind: 'terminalResize'; readonly widthProfile: TextWidthProfile }
  | { readonly kind: 'exit' };

export type VellumMessage = Exclude<AppMessage, { readonly kind: 'applicationUpdate' }>;

