import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * The suite runs against the fixture-replaying stub by default, so a browser
 * run spends no subscription quota and the assertions stay deterministic.
 * Set MESH_E2E_REAL=1 to run the opt-in real-CLI spec against the actual
 * `claude` binary instead.
 */
const real = process.env.MESH_E2E_REAL === '1';

const stub = resolve('tests/stubs/fake-claude.mjs');
const fixture = resolve('tests/fixtures/streams/subagent-conversation.ndjson');

// A throwaway repo root, so the run writes its .mesh/config.json here instead
// of clobbering the developer's own session id.
const e2eRoot = resolve('.e2e-tmp');

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node src/index.ts ${e2eRoot}`,
      port: 4317,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: real
        ? {}
        : {
            MESH_CLAUDE_BIN: process.execPath,
            MESH_CLAUDE_ARGS: JSON.stringify([stub]),
            FAKE_CLAUDE_FIXTURE: fixture,
          },
    },
    {
      command: 'npm run dev:web',
      port: 5173,
      reuseExistingServer: false,
    },
  ],
});
