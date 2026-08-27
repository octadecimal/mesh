import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ProcessResult, ProcessRunner } from './process-runner.js';

export type QaVerificationCommand = {
  executable: string;
  args: string[];
};

export type QaVerificationResult = ProcessResult & {
  command: string;
};

export class QaVerificationCommandRejectedError extends Error {
  readonly code = 'qa_verification_command_rejected';

  constructor(message: string) {
    super(message);
    this.name = 'QaVerificationCommandRejectedError';
  }
}

export class QaTrackedSourceUnstableError extends Error {
  readonly code = 'qa_source_snapshot_unstable';

  constructor() {
    super('Tracked source did not remain stable during verification capture.');
    this.name = 'QaTrackedSourceUnstableError';
  }
}

export class QaVerificationCancelledError extends Error {
  readonly code = 'qa_verification_cancelled';

  constructor() {
    super('QA verification was cancelled with its owning runtime.');
    this.name = 'QaVerificationCancelledError';
  }
}

export class QaVerificationTimedOutError extends Error {
  readonly code = 'qa_verification_timed_out';

  constructor() {
    super('QA verification exceeded its bounded execution time.');
    this.name = 'QaVerificationTimedOutError';
  }
}

export class QaVerificationOutputLimitError extends Error {
  readonly code = 'qa_verification_output_limit_exceeded';

  constructor() {
    super('QA verification exceeded its bounded output limit.');
    this.name = 'QaVerificationOutputLimitError';
  }
}

type TrackedFileStat = {
  dev: bigint | number;
  ino: bigint | number;
  mode: bigint | number;
  size: bigint | number;
  mtimeNs: bigint | number;
  ctimeNs: bigint | number;
  isSymbolicLink?(): boolean;
};

type TrackedFileIdentity = {
  key: string;
  symbolicLink: boolean;
};

type TrackedParentIdentity = {
  key: string;
  path: string;
};

const stableSnapshotAttempts = 3;
const defaultVerificationTimeoutMs = 300_000;
const verificationOutputLimitBytes = 64_000;

const allowedExecutables = new Set(['corepack', 'pnpm', 'npm', 'git']);
const readOnlyGitCommands = new Set([
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);
const packageManagerMutations = new Set([
  'add',
  'config',
  'dlx',
  'env',
  'exec',
  'import',
  'init',
  'install',
  'link',
  'pack',
  'publish',
  'rebuild',
  'remove',
  'setup',
  'shell',
  'uninstall',
  'unlink',
  'update',
  'upgrade',
]);
const verificationScripts =
  /^(build|check|e2e|lint|test|typecheck|verify)(:|$)/;
const unsafeArgument = /[\0\r\n]/;
const gitWriteArguments = [
  '--ext-diff',
  '--open-files-in-pager',
  '--output',
  '--textconv',
];
const workspaceRedirectArguments = new Set([
  '-c',
  '--config-env',
  '--cwd',
  '--dir',
  '--exec-path',
  '--git-dir',
  '--prefix',
  '--work-tree',
]);
const sourceUpdatingArguments = new Set([
  '-o',
  '-u',
  '--fix',
  '--fix-dry-run',
  '--json-output',
  '--json-output-file',
  '--out-dir',
  '--outdir',
  '--output',
  '--output-file',
  '--output-path',
  '--outputfile',
  '--outputpath',
  '--reporter-output',
  '--reporter-output-file',
  '--snapshot-output',
  '--update',
  '--update-snapshot',
  '--update-snapshots',
  '--updatesnapshot',
  '--write',
]);
const pathValueArguments = new Set([
  '--config',
  '--config-file',
  '--configfile',
  '--globalsetup',
  '--globalteardown',
  '--import',
  '--project',
  '--require',
  '--resolver',
  '--setupfiles',
  '--setupfilesafterenv',
  '--snapshotresolver',
  '--testenvironment',
  '--testresultsprocessor',
  '--testrunner',
  '--tsconfig',
]);
const safeNonPathValueArguments = new Set([
  '--test-name-pattern',
  '--testnamepattern',
]);
const interactiveArguments = new Set([
  '--browser',
  '--interactive',
  '--open',
  '--serve',
  '--ui',
  '--watch',
  '--watch-all',
  '--watchall',
]);
const interactiveScript =
  /(^|[:._-])(dev|interactive|serve|server|start|ui|watch)([:._-]|$)/;

const executableName = (value: string) =>
  value
    .trim()
    .replace(/\.cmd$/i, '')
    .toLowerCase();

const packageCommand = (args: readonly string[]) => {
  let index = 0;
  while (args[index]?.startsWith('-')) index += 1;
  return { command: args[index]?.toLowerCase(), index };
};

const assertPackageManagerCommand = (args: readonly string[]) => {
  const { command, index } = packageCommand(args);
  if (!command || packageManagerMutations.has(command)) {
    throw new QaVerificationCommandRejectedError(
      'The requested package-manager operation is not a verification command.',
    );
  }
  if (
    interactiveScript.test(command) ||
    args.some((argument) => {
      const name = optionName(argument);
      return (
        interactiveArguments.has(name) ||
        (argument.startsWith('-') &&
          !argument.startsWith('--') &&
          argument[1]?.toLowerCase() === 'w')
      );
    })
  ) {
    throw new QaVerificationCommandRejectedError(
      'Interactive, watch, and server modes are unavailable to QA.',
    );
  }
  if (command === 'run' && !verificationScripts.test(args[index + 1] ?? '')) {
    throw new QaVerificationCommandRejectedError(
      'Only named verification scripts may be run.',
    );
  }
  if (command === 'run' && interactiveScript.test(args[index + 1] ?? '')) {
    throw new QaVerificationCommandRejectedError(
      'Interactive, watch, and server scripts are unavailable to QA.',
    );
  }
  if (command === 'run') return;
  if (verificationScripts.test(command)) return;
  if (command !== 'nx') {
    throw new QaVerificationCommandRejectedError(
      'Only named verification scripts and targets may be run.',
    );
  }

  const nxArgs = args.slice(index + 1);
  const nxCommand = nxArgs[0]?.toLowerCase();
  const target =
    nxCommand === 'run'
      ? nxArgs[1]?.split(':').at(-1)
      : nxCommand === 'run-many'
        ? (nxArgs
            .find(
              (argument) =>
                argument.startsWith('--target=') ||
                argument.startsWith('--targets='),
            )
            ?.split('=', 2)[1] ??
          nxArgs[
            nxArgs.findIndex((argument) =>
              ['-t', '--target', '--targets'].includes(argument),
            ) + 1
          ])
        : nxCommand;
  if (
    !target ||
    target.split(',').some((candidate) => !verificationScripts.test(candidate))
  ) {
    throw new QaVerificationCommandRejectedError(
      'Only named Nx verification targets may be run.',
    );
  }
};

const quote = (value: string) =>
  /\s/.test(value) ? JSON.stringify(value) : value;

const optionName = (argument: string) =>
  argument.split('=', 1)[0]?.toLowerCase() ?? '';

const looksLikePathOperand = (argument: string) => {
  if (!argument || argument === '--' || argument.startsWith('-')) return false;
  const normalized = argument.replace(/\\/g, '/');
  return (
    isAbsolute(normalized) ||
    /^[a-z]:/i.test(normalized) ||
    normalized.includes('/') ||
    /\.[a-z0-9][a-z0-9._-]*$/i.test(normalized)
  );
};

const escapesWorkspace = (workspacePath: string, candidate: string) => {
  if (!candidate) return false;
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const withinWorkspace = relative(
    workspacePath,
    resolve(workspacePath, normalizedCandidate),
  );
  return (
    isAbsolute(withinWorkspace) ||
    withinWorkspace === '..' ||
    withinWorkspace.startsWith('../') ||
    withinWorkspace.startsWith('..\\')
  );
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

const canonicalEscapesWorkspace = async (
  workspacePath: string,
  candidate: string,
): Promise<boolean> => {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspacePath);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  let current = resolve(workspacePath, candidate.replace(/\\/g, '/'));
  while (true) {
    try {
      return escapesWorkspace(canonicalWorkspace, await realpath(current));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  }
};

const assertWorkspaceBoundValue = async (
  workspacePath: string,
  value: string,
): Promise<void> => {
  if (
    escapesWorkspace(workspacePath, value) ||
    (await canonicalEscapesWorkspace(workspacePath, value))
  ) {
    throw new QaVerificationCommandRejectedError(
      'Verification command paths must remain inside the assigned workspace.',
    );
  }
};

const assertWorkspaceBoundArguments = async (
  workspacePath: string,
  args: readonly string[],
): Promise<void> => {
  let followingValue: 'path' | 'safe_non_path' | undefined;
  for (const argument of args) {
    if (followingValue) {
      const valueKind = followingValue;
      followingValue = undefined;
      if (valueKind === 'path') {
        await assertWorkspaceBoundValue(workspacePath, argument);
      }
      continue;
    }
    const name = optionName(argument);
    const shortOption =
      argument.startsWith('-') && !argument.startsWith('--')
        ? (argument[1] ?? '')
        : '';
    if (
      workspaceRedirectArguments.has(name) ||
      ['c', 'C'].includes(shortOption)
    ) {
      throw new QaVerificationCommandRejectedError(
        'Verification commands may not redirect their assigned workspace.',
      );
    }
    if (sourceUpdatingArguments.has(name) || ['o', 'u'].includes(shortOption)) {
      throw new QaVerificationCommandRejectedError(
        'Verification commands may not update source or select output destinations.',
      );
    }
    if (argument.startsWith('--') && argument.includes('=')) {
      if (!safeNonPathValueArguments.has(name)) {
        await assertWorkspaceBoundValue(
          workspacePath,
          argument.slice(argument.indexOf('=') + 1),
        );
      }
      continue;
    }
    if (pathValueArguments.has(name)) {
      followingValue = 'path';
      continue;
    }
    if (safeNonPathValueArguments.has(name)) {
      followingValue = 'safe_non_path';
      continue;
    }
    if (looksLikePathOperand(argument)) {
      await assertWorkspaceBoundValue(workspacePath, argument);
    }
  }
};

export class QaVerificationRunner {
  private readonly readTrackedLink: (path: string) => Promise<string>;
  private readonly resolveRealPath: (path: string) => Promise<string>;
  private readonly verificationTimeoutMs: number;

  constructor(
    private readonly processes: ProcessRunner,
    private readonly readTrackedFile: (
      path: string,
    ) => Promise<Uint8Array> = readFile,
    private readonly statTrackedFile: (
      path: string,
    ) => Promise<TrackedFileStat> = async (path) =>
      lstat(path, { bigint: true }),
    options: {
      readTrackedLink?: (path: string) => Promise<string>;
      resolveRealPath?: (path: string) => Promise<string>;
      verificationTimeoutMs?: number;
    } = {},
  ) {
    this.readTrackedLink = options.readTrackedLink ?? readlink;
    this.resolveRealPath = options.resolveRealPath ?? realpath;
    this.verificationTimeoutMs =
      options.verificationTimeoutMs ?? defaultVerificationTimeoutMs;
  }

  async captureTrackedSource(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const assignedWorkspace = resolve(workspacePath);
    for (let attempt = 0; attempt < stableSnapshotAttempts; attempt += 1) {
      const forward = await this.captureObservation(
        assignedWorkspace,
        'forward',
        signal,
      );
      const reverse = await this.captureObservation(
        assignedWorkspace,
        'reverse',
        signal,
      );
      if (forward !== undefined && forward === reverse) return forward;
    }
    throw new QaTrackedSourceUnstableError();
  }

  private async listTrackedPaths(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.runOwnedProcess(
      'git',
      ['-C', workspacePath, 'ls-files', '-z'],
      workspacePath,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Tracked source state could not be read: ${result.stderr}`,
      );
    }
    return result.stdout.split('\0').filter(Boolean).sort();
  }

  private async captureObservation(
    workspacePath: string,
    direction: 'forward' | 'reverse',
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const canonicalWorkspace = await this.tryRealPath(workspacePath);
    const trackedPaths = await this.listTrackedPaths(workspacePath, signal);
    const pathsToRead =
      direction === 'forward' ? trackedPaths : [...trackedPaths].reverse();
    const records = new Map<string, string>();
    for (const trackedPath of pathsToRead) {
      const absolutePath = resolve(workspacePath, trackedPath);
      const withinWorkspace = relative(workspacePath, absolutePath);
      if (
        isAbsolute(withinWorkspace) ||
        withinWorkspace === '..' ||
        withinWorkspace.startsWith(`..\\`) ||
        withinWorkspace.startsWith('../')
      ) {
        throw new Error('Tracked source path escaped the verified workspace.');
      }
      const parentBefore = canonicalWorkspace
        ? await this.readTrackedParentIdentity(canonicalWorkspace, absolutePath)
        : undefined;
      if (parentBefore === 'missing') return undefined;
      const before = await this.readFileIdentity(absolutePath);
      if (
        parentBefore &&
        canonicalWorkspace &&
        !(await this.trackedParentMatches(
          canonicalWorkspace,
          absolutePath,
          parentBefore,
        ))
      ) {
        return undefined;
      }
      if (before === 'missing') {
        if ((await this.readFileIdentity(absolutePath)) !== 'missing') {
          return undefined;
        }
        records.set(trackedPath, 'missing');
        continue;
      }
      if (before.symbolicLink) {
        const target = await this.tryReadTrackedLink(absolutePath);
        if (target === undefined) return undefined;
        const after = await this.readFileIdentity(absolutePath);
        const confirmedTarget = await this.tryReadTrackedLink(absolutePath);
        if (
          (parentBefore &&
            canonicalWorkspace &&
            !(await this.trackedParentMatches(
              canonicalWorkspace,
              absolutePath,
              parentBefore,
            ))) ||
          after === 'missing' ||
          !after.symbolicLink ||
          before.key !== after.key ||
          target !== confirmedTarget
        ) {
          return undefined;
        }
        records.set(
          trackedPath,
          `${before.key}\0link\0${createHash('sha256').update(target).digest('hex')}`,
        );
        continue;
      }
      const canonicalPath = await this.tryRealPath(absolutePath);
      if (
        canonicalWorkspace &&
        canonicalPath &&
        escapesWorkspace(canonicalWorkspace, canonicalPath)
      ) {
        throw new Error('Tracked source path escaped the verified workspace.');
      }
      let content: Uint8Array;
      try {
        content = await this.readTrackedFile(canonicalPath ?? absolutePath);
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }
      const after = await this.readFileIdentity(absolutePath);
      if (
        after === 'missing' ||
        after.symbolicLink ||
        before.key !== after.key
      ) {
        return undefined;
      }
      records.set(
        trackedPath,
        `${before.key}\0${createHash('sha256').update(content).digest('hex')}`,
      );
    }
    const pathsAfterRead = await this.listTrackedPaths(workspacePath, signal);
    if (trackedPaths.join('\0') !== pathsAfterRead.join('\0')) return undefined;

    const hash = createHash('sha256');
    for (const trackedPath of trackedPaths) {
      hash.update(trackedPath);
      hash.update('\0');
      hash.update(records.get(trackedPath) ?? 'missing');
      hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  }

  private async readFileIdentity(
    path: string,
  ): Promise<TrackedFileIdentity | 'missing'> {
    try {
      const current = await this.statTrackedFile(path);
      return {
        key: [
          current.dev,
          current.ino,
          current.mode,
          current.size,
          current.mtimeNs,
          current.ctimeNs,
        ].join(':'),
        symbolicLink: current.isSymbolicLink?.() === true,
      };
    } catch (error) {
      if (isMissingFile(error)) return 'missing';
      throw error;
    }
  }

  private async readTrackedParentIdentity(
    canonicalWorkspace: string,
    path: string,
  ): Promise<TrackedParentIdentity | 'missing'> {
    const canonicalParent = await this.tryRealPath(dirname(path));
    if (!canonicalParent) return 'missing';
    if (escapesWorkspace(canonicalWorkspace, canonicalParent)) {
      throw new Error('Tracked source path escaped the verified workspace.');
    }
    try {
      const current = await lstat(canonicalParent, { bigint: true });
      return {
        path: canonicalParent,
        key: [
          current.dev,
          current.ino,
          current.mode,
          current.mtimeNs,
          current.ctimeNs,
        ].join(':'),
      };
    } catch (error) {
      if (isMissingFile(error)) return 'missing';
      throw error;
    }
  }

  private async trackedParentMatches(
    canonicalWorkspace: string,
    path: string,
    expected: TrackedParentIdentity,
  ): Promise<boolean> {
    const current = await this.readTrackedParentIdentity(
      canonicalWorkspace,
      path,
    );
    return (
      current !== 'missing' &&
      current.path === expected.path &&
      current.key === expected.key
    );
  }

  private async tryRealPath(path: string): Promise<string | undefined> {
    try {
      return await this.resolveRealPath(path);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async tryReadTrackedLink(path: string): Promise<string | undefined> {
    try {
      return await this.readTrackedLink(path);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async run(
    workspacePath: string,
    input: QaVerificationCommand,
    options: { signal?: AbortSignal } = {},
  ): Promise<QaVerificationResult> {
    const assignedWorkspace = resolve(workspacePath);
    const executable = executableName(input.executable);
    if (!allowedExecutables.has(executable)) {
      throw new QaVerificationCommandRejectedError(
        `Executable '${input.executable}' is outside QA verification authority.`,
      );
    }
    if (
      input.args.length === 0 ||
      input.args.some((argument) => unsafeArgument.test(argument))
    ) {
      throw new QaVerificationCommandRejectedError(
        'Verification arguments are empty or malformed.',
      );
    }
    await assertWorkspaceBoundArguments(assignedWorkspace, input.args);

    if (executable === 'git') {
      const command = input.args.find((argument) => !argument.startsWith('-'));
      if (
        !command ||
        !readOnlyGitCommands.has(command.toLowerCase()) ||
        input.args.some((argument) =>
          gitWriteArguments.some(
            (unsafe) =>
              argument === unsafe || argument.startsWith(`${unsafe}=`),
          ),
        )
      ) {
        throw new QaVerificationCommandRejectedError(
          'Only read-only Git inspection is available to QA.',
        );
      }
    } else {
      const args =
        executable === 'corepack' &&
        ['pnpm', 'npm'].includes(input.args[0] ?? '')
          ? input.args.slice(1)
          : input.args;
      if (executable === 'corepack' && args.length === input.args.length) {
        throw new QaVerificationCommandRejectedError(
          'Corepack may invoke only pnpm or npm verification commands.',
        );
      }
      assertPackageManagerCommand(args);
    }

    const result = await this.runOwnedProcess(
      executable,
      input.args,
      assignedWorkspace,
      options.signal,
      verificationOutputLimitBytes,
    );
    return {
      ...result,
      command: [executable, ...input.args].map(quote).join(' '),
      stdout: result.stdout.slice(0, 32_000),
      stderr: result.stderr.slice(0, 32_000),
    };
  }

  private async runOwnedProcess(
    executable: string,
    args: readonly string[],
    cwd: string,
    parentSignal?: AbortSignal,
    maxOutputBytes?: number,
  ): Promise<ProcessResult> {
    if (parentSignal?.aborted) throw new QaVerificationCancelledError();
    const controller = new AbortController();
    let abortReason: QaVerificationCancelledError | QaVerificationTimedOutError;
    const cancel = () => {
      abortReason = new QaVerificationCancelledError();
      controller.abort(abortReason);
    };
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      abortReason = new QaVerificationTimedOutError();
      controller.abort(abortReason);
    }, this.verificationTimeoutMs);
    timeout.unref?.();
    try {
      const result = await this.processes.run(executable, args, {
        cwd,
        ...(maxOutputBytes ? { maxOutputBytes } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw abortReason ?? new QaVerificationCancelledError();
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw abortReason ?? new QaVerificationCancelledError();
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'process_output_limit_exceeded'
      ) {
        throw new QaVerificationOutputLimitError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancel);
    }
  }
}
