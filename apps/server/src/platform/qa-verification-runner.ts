import { createHash } from 'node:crypto';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
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

export class QaVerificationTerminationFailedError extends Error {
  readonly code = 'qa_verification_termination_failed';

  constructor() {
    super('QA verification process ownership could not be enforced.');
    this.name = 'QaVerificationTerminationFailedError';
  }
}

export class QaVerificationExecutableUnavailableError extends Error {
  readonly code = 'qa_verification_executable_unavailable';

  constructor() {
    super(
      'A trusted Git executable is unavailable. Configure an absolute operator-approved MESH_GIT_EXECUTABLE and restart Mesh.',
    );
    this.name = 'QaVerificationExecutableUnavailableError';
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

type TrackedFileHandle = {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(options: { bigint: true }): Promise<TrackedFileStat>;
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

const pathStatIdentity = (stat: TrackedFileStat) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  );

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
  const lexicalWorkspace = resolve(workspacePath);
  const lexicalCandidate = resolve(
    lexicalWorkspace,
    candidate.replace(/\\/g, '/'),
  );
  let pending = relative(lexicalWorkspace, lexicalCandidate)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = canonicalWorkspace;
  let followedLinks = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    if (!component) continue;
    const next = resolve(current, component);
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(next, { bigint: true });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return escapesWorkspace(canonicalWorkspace, resolve(next, ...pending));
    }
    if (before.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(next);
      } catch {
        return true;
      }
      let after: Awaited<ReturnType<typeof lstat>>;
      try {
        after = await lstat(next, { bigint: true });
      } catch (error) {
        if (isMissingFile(error)) return true;
        throw error;
      }
      if (
        !after.isSymbolicLink() ||
        pathStatIdentity(before) !== pathStatIdentity(after) ||
        (await readlink(next).catch(() => undefined)) !== target
      ) {
        return true;
      }
      const targetPath = resolve(dirname(next), target.replace(/\\/g, '/'));
      if (escapesWorkspace(canonicalWorkspace, targetPath)) return true;
      followedLinks += 1;
      if (followedLinks > 32) return true;
      pending = [
        ...relative(canonicalWorkspace, targetPath)
          .split(/[\\/]+/)
          .filter(Boolean),
        ...pending,
      ];
      current = canonicalWorkspace;
    } else {
      try {
        current = await realpath(next);
      } catch {
        return true;
      }
    }
    if (escapesWorkspace(canonicalWorkspace, current)) return true;
  }
  return false;
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
  private readonly openTrackedFile: (
    path: string,
  ) => Promise<TrackedFileHandle>;
  private readonly readTrackedLink: (path: string) => Promise<string>;
  private readonly resolveRealPath: (path: string) => Promise<string>;
  private readonly verificationTimeoutMs: number;

  constructor(
    private readonly processes: ProcessRunner,
    openTrackedFile: (path: string) => Promise<TrackedFileHandle> = async (
      path,
    ) => open(path, 'r'),
    private readonly statTrackedFile: (
      path: string,
    ) => Promise<TrackedFileStat> = async (path) =>
      lstat(path, { bigint: true }),
    options: {
      openTrackedFile?: (path: string) => Promise<TrackedFileHandle>;
      readTrackedLink?: (path: string) => Promise<string>;
      resolveRealPath?: (path: string) => Promise<string>;
      verificationTimeoutMs?: number;
    } = {},
  ) {
    this.openTrackedFile = options.openTrackedFile ?? openTrackedFile;
    this.readTrackedLink = options.readTrackedLink ?? readlink;
    this.resolveRealPath = options.resolveRealPath ?? realpath;
    this.verificationTimeoutMs =
      options.verificationTimeoutMs ?? defaultVerificationTimeoutMs;
  }

  private throwIfCaptureCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new QaVerificationCancelledError();
  }

  async captureTrackedSource(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const assignedWorkspace = resolve(workspacePath);
    this.throwIfCaptureCancelled(signal);
    for (let attempt = 0; attempt < stableSnapshotAttempts; attempt += 1) {
      const forward = await this.captureObservation(
        assignedWorkspace,
        'forward',
        signal,
      );
      this.throwIfCaptureCancelled(signal);
      const reverse = await this.captureObservation(
        assignedWorkspace,
        'reverse',
        signal,
      );
      this.throwIfCaptureCancelled(signal);
      if (forward !== undefined && forward === reverse) {
        this.throwIfCaptureCancelled(signal);
        return forward;
      }
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
    this.throwIfCaptureCancelled(signal);
    const canonicalWorkspace = await this.tryRealPath(workspacePath);
    this.throwIfCaptureCancelled(signal);
    const rootBefore = canonicalWorkspace
      ? await this.readCanonicalIdentity(canonicalWorkspace)
      : undefined;
    this.throwIfCaptureCancelled(signal);
    if (rootBefore === 'missing') return undefined;
    const trackedPaths = await this.listTrackedPaths(workspacePath, signal);
    this.throwIfCaptureCancelled(signal);
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
      this.throwIfCaptureCancelled(signal);
      if (parentBefore === 'missing') return undefined;
      const before = await this.readFileIdentity(absolutePath);
      this.throwIfCaptureCancelled(signal);
      const parentStillMatches =
        parentBefore && canonicalWorkspace
          ? await this.trackedParentMatches(
              canonicalWorkspace,
              absolutePath,
              parentBefore,
            )
          : true;
      this.throwIfCaptureCancelled(signal);
      if (!parentStillMatches) return undefined;
      if (before === 'missing') {
        const confirmedMissing = await this.readFileIdentity(absolutePath);
        this.throwIfCaptureCancelled(signal);
        if (confirmedMissing !== 'missing') {
          return undefined;
        }
        records.set(trackedPath, 'missing');
        continue;
      }
      if (before.symbolicLink) {
        const target = await this.tryReadTrackedLink(absolutePath);
        this.throwIfCaptureCancelled(signal);
        if (target === undefined) return undefined;
        const after = await this.readFileIdentity(absolutePath);
        this.throwIfCaptureCancelled(signal);
        const confirmedTarget = await this.tryReadTrackedLink(absolutePath);
        this.throwIfCaptureCancelled(signal);
        const linkParentStillMatches =
          parentBefore && canonicalWorkspace
            ? await this.trackedParentMatches(
                canonicalWorkspace,
                absolutePath,
                parentBefore,
              )
            : true;
        this.throwIfCaptureCancelled(signal);
        if (
          !linkParentStillMatches ||
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
      this.throwIfCaptureCancelled(signal);
      if (
        canonicalWorkspace &&
        (!canonicalPath || escapesWorkspace(canonicalWorkspace, canonicalPath))
      ) {
        throw new Error('Tracked source path escaped the verified workspace.');
      }
      const contentHash = await this.hashOpenedTrackedFile(
        canonicalPath ?? absolutePath,
        before,
        signal,
      );
      this.throwIfCaptureCancelled(signal);
      if (!contentHash) return undefined;
      const after = await this.readFileIdentity(absolutePath);
      this.throwIfCaptureCancelled(signal);
      const boundaryMatches = canonicalWorkspace
        ? await this.regularFileBoundaryMatches(
            workspacePath,
            canonicalWorkspace,
            absolutePath,
            canonicalPath,
            parentBefore,
            rootBefore,
            signal,
          )
        : true;
      this.throwIfCaptureCancelled(signal);
      if (
        after === 'missing' ||
        after.symbolicLink ||
        before.key !== after.key ||
        !boundaryMatches ||
        (canonicalWorkspace &&
          escapesWorkspace(canonicalWorkspace, canonicalPath ?? ''))
      ) {
        return undefined;
      }
      records.set(trackedPath, `${before.key}\0${contentHash}`);
    }
    const pathsAfterRead = await this.listTrackedPaths(workspacePath, signal);
    this.throwIfCaptureCancelled(signal);
    const rootStillMatches =
      canonicalWorkspace && rootBefore
        ? await this.canonicalIdentityMatches(workspacePath, rootBefore)
        : true;
    this.throwIfCaptureCancelled(signal);
    if (
      trackedPaths.join('\0') !== pathsAfterRead.join('\0') ||
      !rootStillMatches
    ) {
      return undefined;
    }

    const hash = createHash('sha256');
    for (const trackedPath of trackedPaths) {
      hash.update(trackedPath);
      hash.update('\0');
      hash.update(records.get(trackedPath) ?? 'missing');
      hash.update('\0');
    }
    this.throwIfCaptureCancelled(signal);
    return `sha256:${hash.digest('hex')}`;
  }

  private async hashOpenedTrackedFile(
    path: string,
    expected: TrackedFileIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let handle: TrackedFileHandle;
    try {
      handle = await this.openTrackedFile(path);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    try {
      const opened = this.fileIdentity(await handle.stat({ bigint: true }));
      if (opened.symbolicLink || opened.key !== expected.key) return undefined;
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        if (signal?.aborted) throw new QaVerificationCancelledError();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = this.fileIdentity(await handle.stat({ bigint: true }));
      this.throwIfCaptureCancelled(signal);
      return after.symbolicLink || after.key !== opened.key
        ? undefined
        : hash.digest('hex');
    } finally {
      await handle.close();
    }
  }

  private async regularFileBoundaryMatches(
    workspacePath: string,
    canonicalWorkspace: string,
    absolutePath: string,
    expectedPath: string | undefined,
    expectedParent: TrackedParentIdentity | undefined,
    expectedRoot: TrackedParentIdentity | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!expectedPath || escapesWorkspace(canonicalWorkspace, expectedPath)) {
      return false;
    }
    const currentPath = await this.tryRealPath(absolutePath);
    this.throwIfCaptureCancelled(signal);
    if (
      !currentPath ||
      relative(expectedPath, currentPath) !== '' ||
      escapesWorkspace(canonicalWorkspace, currentPath)
    ) {
      return false;
    }
    if (expectedParent) {
      const parentMatches = await this.trackedParentMatches(
        canonicalWorkspace,
        absolutePath,
        expectedParent,
      );
      this.throwIfCaptureCancelled(signal);
      if (!parentMatches) return false;
    }
    if (expectedRoot) {
      const rootMatches = await this.canonicalIdentityMatches(
        workspacePath,
        expectedRoot,
      );
      this.throwIfCaptureCancelled(signal);
      if (!rootMatches) return false;
    }
    return true;
  }

  private fileIdentity(current: TrackedFileStat): TrackedFileIdentity {
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
  }

  private async readFileIdentity(
    path: string,
  ): Promise<TrackedFileIdentity | 'missing'> {
    try {
      return this.fileIdentity(await this.statTrackedFile(path));
    } catch (error) {
      if (isMissingFile(error)) return 'missing';
      throw error;
    }
  }

  private async readCanonicalIdentity(
    path: string,
  ): Promise<TrackedParentIdentity | 'missing'> {
    try {
      const canonicalPath = await this.resolveRealPath(path);
      const current = await lstat(canonicalPath, { bigint: true });
      return {
        path: canonicalPath,
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

  private async canonicalIdentityMatches(
    path: string,
    expected: TrackedParentIdentity,
  ): Promise<boolean> {
    const current = await this.readCanonicalIdentity(path);
    return (
      current !== 'missing' &&
      relative(expected.path, current.path) === '' &&
      expected.key === current.key
    );
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
    const abortWith = (
      reason: QaVerificationCancelledError | QaVerificationTimedOutError,
    ) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const cancel = () => {
      abortWith(new QaVerificationCancelledError());
    };
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      abortWith(new QaVerificationTimedOutError());
    }, this.verificationTimeoutMs);
    timeout.unref?.();
    try {
      const result = await this.processes.run(executable, args, {
        cwd,
        ...(maxOutputBytes ? { maxOutputBytes } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new QaVerificationCancelledError();
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new QaVerificationCancelledError();
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'process_output_limit_exceeded'
      ) {
        throw new QaVerificationOutputLimitError();
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'process_termination_unavailable' ||
          error.code === 'process_termination_failed')
      ) {
        throw new QaVerificationTerminationFailedError();
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'process_trusted_executable_unavailable'
      ) {
        throw new QaVerificationExecutableUnavailableError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancel);
    }
  }
}
