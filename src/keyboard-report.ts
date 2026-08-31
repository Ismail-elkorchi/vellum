import { createTerminalHost, type TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createInputPipeline, type InputEvent } from '@ismail-elkorchi/terminal-ui/input';
import {
  KITTY_KEYBOARD_FLAGS,
  kittyKeyboardProfile
} from '@ismail-elkorchi/terminal-ui/protocol';

export async function runKeyboardReport(host: TerminalHost = createTerminalHost()): Promise<void> {
  const controller = new AbortController();
  const unsubscribe = host.signals.subscribe((signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') controller.abort(signal);
  });
  let reason: 'success' | 'interrupted' | 'error' = 'success';
  try {
    if (!host.stdin.isTty() || !host.stdout.isTty()) throw new Error('--keyboard-report requires an interactive terminal.');
    const capabilities = await host.getCapabilities({
      activeProbes: ['keyboardProtocol'],
      signal: controller.signal
    });
    const session = await host.beginSession({ id: 'vellum-keyboard-report' });
    await session.enableRawInput({ signal: controller.signal });
    if (capabilities.keyboardProtocol.support === 'supported') {
      const flags = KITTY_KEYBOARD_FLAGS.disambiguateEscapeCodes
        | KITTY_KEYBOARD_FLAGS.reportEventTypes
        | KITTY_KEYBOARD_FLAGS.reportAlternateKeys
        | KITTY_KEYBOARD_FLAGS.reportAllKeysAsEscapeCodes
        | KITTY_KEYBOARD_FLAGS.reportAssociatedText;
      await session.enableKeyboardProfile(kittyKeyboardProfile(flags), { signal: controller.signal });
    }
    const terminalState = await session.currentState();
    const pipeline = createInputPipeline({
      capabilities,
      keyboard: terminalState.keyboardProfile
    });
    await host.stdout.write(`${JSON.stringify({
      kind: 'keyboardProfile',
      profile: terminalState.keyboardProfile,
      support: capabilities.keyboardProtocol.support,
      availability: capabilities.keyboardProtocol.availability
    })}\r\nPress keys to inspect normalized events. Press Ctrl+C to finish.\r\n`);
    report: for await (const chunk of host.stdin.read({ signal: controller.signal })) {
      const batch = pipeline.decode(chunk);
      for (const event of batch.events) {
        await host.stdout.write(`${JSON.stringify(event)}\r\n`);
        if (isInterrupt(event)) break report;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      reason = 'error';
      throw error;
    }
    reason = 'interrupted';
  } finally {
    unsubscribe();
    await host.restoreTerminalState(reason).catch(() => undefined);
    await host.dispose().catch(() => undefined);
  }
}

function isInterrupt(event: InputEvent): boolean {
  return event.kind === 'key'
    && event.key === 'c'
    && event.modifiers.ctrl
    && event.eventType !== 'release';
}
