import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLineSplitter, parseLine, classify } from './stream.ts';
import { PM } from './types.ts';
import type { MeshConfig, MeshEvent } from './types.ts';

/** Environment variables that must never reach the child process. */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
];

export interface SupervisorOptions {
  config: MeshConfig;
  /** Overridden in tests to point at the stub. */
  command?: string;
  /** Prepended to the generated flags. Used by tests to pass the stub path. */
  baseArgs?: string[];
  /** Extra environment for the child. Used by tests to configure the stub. */
  env?: Record<string, string>;
}

export class Supervisor {
  #child: ChildProcessWithoutNullStreams | null = null;
  #listeners: ((event: MeshEvent) => void)[] = [];
  #options: SupervisorOptions;
  #env: NodeJS.ProcessEnv = {};
  sessionId: string | null;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.sessionId = options.config.pm.sessionId;
  }

  onEvent(listener: (event: MeshEvent) => void): void {
    this.#listeners.push(listener);
  }

  /** Exposed so a test can assert the environment is scrubbed. */
  spawnEnvForTest(): NodeJS.ProcessEnv {
    return this.#env;
  }

  #buildArgs(): string[] {
    const args = [
      ...(this.#options.baseArgs ?? []),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      this.#options.config.pm.model,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  #buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.#options.env ?? {}) };
    for (const key of STRIPPED_ENV) delete env[key];
    return env;
  }

  #emit(event: MeshEvent): void {
    if (event.kind === 'init' && event.agent === PM && event.sessionId) {
      this.sessionId = event.sessionId;
    }
    for (const listener of this.#listeners) listener(event);
  }

  async start(): Promise<void> {
    this.#env = this.#buildEnv();
    const child = spawn(this.#options.command ?? 'claude', this.#buildArgs(), {
      cwd: this.#options.config.targetRepo,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    const split = createLineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of split(chunk)) {
        const raw = parseLine(line);
        if (!raw) continue;
        for (const event of classify(raw)) this.#emit(event);
      }
    });

    let stderrBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      process.stderr.write(`[claude] ${chunk}`);
    });

    // Resolve once the child has produced its first output, so the caller
    // knows the process is genuinely running. If the child terminates first
    // — auth failure, bad --model, broken MCP config — reject instead of
    // reporting a false success. 'close' (not 'exit') so stdio has fully
    // drained by the time we decide which branch this was.
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('close', (code) => {
        const detail = stderrBuf.trim();
        reject(
          new Error(
            `claude exited with code ${code} before producing output${detail ? `: ${detail}` : ''}`,
          ),
        );
      });
      child.once('error', reject);
    });
  }

  send(text: string): void {
    if (!this.#child) throw new Error('supervisor not started');
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    // The child never echoes stdin back on stdout, so the human's own words
    // would otherwise be missing from every transcript. Emitting here puts
    // them on the bus like any other event: in history, replayed on
    // reconnect, and visible in every open tab rather than only the sender's.
    this.#emit({ kind: 'text', agent: PM, role: 'user', text });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 2000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
