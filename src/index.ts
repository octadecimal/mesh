import { resolve } from 'node:path';
import { loadConfig, saveConfig } from './config.ts';
import { Supervisor } from './supervisor.ts';
import { EventBus } from './bus.ts';
import { createServer } from './api.ts';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const config = await loadConfig(repoRoot);

const bus = new EventBus();

// End-to-end tests point the child at the fixture-replaying stub so a browser
// run costs no quota. Both are unset in normal use, giving the real CLI.
const claudeBin = process.env.MESH_CLAUDE_BIN;
const claudeArgs = process.env.MESH_CLAUDE_ARGS;

const supervisor = new Supervisor({
  config,
  ...(claudeBin ? { command: claudeBin } : {}),
  ...(claudeArgs ? { baseArgs: JSON.parse(claudeArgs) as string[] } : {}),
});

supervisor.onEvent((event) => {
  bus.publish(event);
  // Persist the session id the first time we learn it, so a restart resumes.
  if (event.kind === 'init' && config.pm.sessionId !== event.sessionId) {
    config.pm.sessionId = event.sessionId;
    void saveConfig(repoRoot, config);
  }
});

await supervisor.start();

const server = createServer({ bus, onMessage: (text) => supervisor.send(text) });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`mesh: watching ${repoRoot}`);
  console.log(`mesh: api on http://127.0.0.1:${config.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await supervisor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
