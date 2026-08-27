import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const defaultMaxOutputBytes = 16 * 1024 * 1024;
const defaultTerminationDeadlineMs = 2_000;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunOptions = {
  cwd: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult>;
}

export class ProcessOutputLimitError extends Error {
  readonly code = 'process_output_limit_exceeded';

  constructor(
    readonly stream: 'stderr' | 'stdout',
    readonly limit: number,
  ) {
    super(`Process ${stream} exceeded the ${limit}-byte output limit.`);
    this.name = 'ProcessOutputLimitError';
  }
}

export class ProcessTerminationUnavailableError extends Error {
  readonly code = 'process_termination_unavailable';

  constructor() {
    super('Owned process-tree termination is unavailable.');
    this.name = 'ProcessTerminationUnavailableError';
  }
}

export class ProcessTerminationFailedError extends Error {
  readonly code = 'process_termination_failed';

  constructor() {
    super('The owned process tree could not be terminated safely.');
    this.name = 'ProcessTerminationFailedError';
  }
}

export type NodeProcessRunnerOptions = {
  platform?: NodeJS.Platform;
  resolveWindowsTreeTerminator?: () => Promise<string | undefined>;
  runWindowsTreeTerminator?: (
    executable: string,
    args: readonly string[],
    deadlineMs: number,
  ) => Promise<number>;
  terminationDeadlineMs?: number;
};

const inside = (root: string, candidate: string) => {
  const child = relative(root, candidate);
  return (
    child !== '..' &&
    !child.startsWith('../') &&
    !child.startsWith('..\\') &&
    !isAbsolute(child)
  );
};

const trustedWindowsLauncher = async (
  executable: string,
  args: readonly string[],
): Promise<{ executable: string; args: readonly string[] }> => {
  if (process.platform !== 'win32') return { executable, args };
  const name = executable.replace(/\.cmd$/i, '').toLowerCase();
  const relativeEntry =
    name === 'corepack'
      ? ['node_modules', 'corepack', 'dist', 'corepack.js']
      : name === 'pnpm'
        ? ['node_modules', 'corepack', 'dist', 'pnpm.js']
        : name === 'npm'
          ? ['node_modules', 'npm', 'bin', 'npm-cli.js']
          : undefined;
  if (!relativeEntry) return { executable, args };

  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = dirname(nodeExecutable);
  const entry = await realpath(join(nodeRoot, ...relativeEntry));
  const entryStat = await lstat(entry);
  if (!inside(nodeRoot, entry) || !entryStat.isFile()) {
    throw new Error(`Trusted ${name} launcher is unavailable.`);
  }
  return { executable: nodeExecutable, args: [entry, ...args] };
};

const windowsTaskkillPath = async (): Promise<string | undefined> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return undefined;
  try {
    const canonicalRoot = await realpath(resolve(systemRoot));
    const taskkill = await realpath(
      join(canonicalRoot, 'System32', 'taskkill.exe'),
    );
    const taskkillStat = await lstat(taskkill);
    return inside(canonicalRoot, taskkill) && taskkillStat.isFile()
      ? taskkill
      : undefined;
  } catch {
    return undefined;
  }
};

const spawnWindowsTreeTerminator = async (
  executable: string,
  args: readonly string[],
  deadlineMs: number,
): Promise<number> =>
  new Promise<number>((resolveExit, rejectExit) => {
    const killer = spawn(executable, [...args], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killer.kill();
      rejectExit(new Error('Windows tree terminator timed out.'));
    }, deadlineMs);
    timer.unref?.();
    killer.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectExit(error);
    });
    killer.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(exitCode ?? -1);
    });
  });

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('The operation was aborted.'), {
        code: 'ABORT_ERR',
        name: 'AbortError',
      });

export class NodeProcessRunner implements ProcessRunner {
  private readonly platform: NodeJS.Platform;
  private readonly resolveWindowsTreeTerminator: () => Promise<
    string | undefined
  >;
  private readonly runWindowsTreeTerminator: (
    executable: string,
    args: readonly string[],
    deadlineMs: number,
  ) => Promise<number>;
  private readonly terminationDeadlineMs: number;
  private windowsTerminatorCapability?: Promise<string>;

  constructor(options: NodeProcessRunnerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveWindowsTreeTerminator =
      options.resolveWindowsTreeTerminator ?? windowsTaskkillPath;
    this.runWindowsTreeTerminator =
      options.runWindowsTreeTerminator ?? spawnWindowsTreeTerminator;
    this.terminationDeadlineMs =
      options.terminationDeadlineMs ?? defaultTerminationDeadlineMs;
  }

  private async runTerminatorBounded(
    executable: string,
    args: readonly string[],
  ): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runWindowsTreeTerminator(
          executable,
          args,
          this.terminationDeadlineMs,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Windows tree terminator timed out.')),
            this.terminationDeadlineMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private requireWindowsTerminator(): Promise<string> {
    this.windowsTerminatorCapability ??= (async () => {
      const executable = await this.resolveWindowsTreeTerminator();
      if (!executable) throw new ProcessTerminationUnavailableError();
      try {
        if ((await this.runTerminatorBounded(executable, ['/?'])) !== 0) {
          throw new ProcessTerminationUnavailableError();
        }
      } catch (error) {
        if (error instanceof ProcessTerminationUnavailableError) throw error;
        throw new ProcessTerminationUnavailableError();
      }
      return executable;
    })();
    return this.windowsTerminatorCapability;
  }

  private async terminateOwnedTree(
    child: ChildProcessWithoutNullStreams,
    windowsTerminator: string | undefined,
  ): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    if (this.platform === 'win32') {
      try {
        if (
          !windowsTerminator ||
          (await this.runTerminatorBounded(windowsTerminator, [
            '/PID',
            String(pid),
            '/T',
            '/F',
          ])) !== 0
        ) {
          throw new ProcessTerminationFailedError();
        }
      } catch {
        const closed = this.waitForOwnedChildClose(child);
        try {
          child.kill();
        } catch {
          // The exact owned child already exited.
        }
        await closed;
        throw new ProcessTerminationFailedError();
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise((done) => setTimeout(done, 250));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The owned group already exited.
    }
  }

  private waitForOwnedChildClose(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolveClose) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('close', done);
        resolveClose();
      };
      const timer = setTimeout(done, this.terminationDeadlineMs);
      timer.unref?.();
      child.once('close', done);
    });
  }

  async run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    if (options.signal?.aborted) throw abortError(options.signal);
    const windowsTerminator =
      this.platform === 'win32'
        ? await this.requireWindowsTerminator()
        : undefined;
    if (options.signal?.aborted) throw abortError(options.signal);
    const launch = await trustedWindowsLauncher(executable, args);
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error('Process output limit must be a positive safe integer.');
    }

    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(launch.executable, [...launch.args], {
        cwd: options.cwd,
        detached: this.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
      const output: Record<'stderr' | 'stdout', Buffer[]> = {
        stderr: [],
        stdout: [],
      };
      const outputBytes = { stderr: 0, stdout: 0 };
      let settled = false;
      let spawnError: Error | undefined;
      let terminalError: Error | undefined;
      let termination: Promise<void> | undefined;

      const terminate = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        child.stdout.pause();
        child.stderr.pause();
        termination = this.terminateOwnedTree(child, windowsTerminator).catch(
          (terminationError: unknown) => {
            terminalError =
              terminationError instanceof Error
                ? terminationError
                : new ProcessTerminationFailedError();
          },
        );
        void termination.then(() => settle(null));
      };
      const collect = (stream: 'stderr' | 'stdout', chunk: Buffer) => {
        if (terminalError) return;
        if (outputBytes[stream] + chunk.byteLength > maxOutputBytes) {
          terminate(new ProcessOutputLimitError(stream, maxOutputBytes));
          return;
        }
        outputBytes[stream] += chunk.byteLength;
        output[stream].push(chunk);
      };
      const abort = () => {
        if (options.signal) terminate(abortError(options.signal));
      };
      const settle = async (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        await termination;
        if (terminalError) {
          rejectResult(terminalError);
          return;
        }
        if (spawnError) {
          rejectResult(spawnError);
          return;
        }
        resolveResult({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(output.stdout, outputBytes.stdout).toString(
            'utf8',
          ),
          stderr: Buffer.concat(output.stderr, outputBytes.stderr).toString(
            'utf8',
          ),
        });
      };

      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.once('error', (error) => {
        spawnError = error;
        if (!child.pid) void settle(null);
      });
      child.once('close', (exitCode) => void settle(exitCode));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
