import { describe, expect, it } from 'vitest';

import { createClaudeSdkFacade } from './sdk-adapter.js';
import { SdkClaudeSessionDriver } from './sdk-driver.js';

const externalDescribe =
  process.env.MESH_RUN_CLAUDE_SMOKE === '1' ? describe : describe.skip;

externalDescribe('Claude Agent SDK external smoke', () => {
  it('starts one subscription-authenticated session and interrupts it', async () => {
    const session = await new SdkClaudeSessionDriver(
      createClaudeSdkFacade(),
    ).create({
      title: 'Mesh external smoke',
      permissionMode: 'interactive',
    });
    const firstAssistantMessage = (async () => {
      for await (const event of session.events()) {
        if (event.kind === 'text_delta' || event.kind === 'text_completed')
          return event.text;
        if (event.kind === 'terminal_error') throw new Error(event.message);
      }
      throw new Error('Claude session ended without an assistant message');
    })();

    try {
      await session.sendPrompt('Reply with the single word ready.');
      await expect(firstAssistantMessage).resolves.toBeTruthy();
      await session.interrupt();
    } finally {
      await session.close();
    }
  }, 60_000);
});
