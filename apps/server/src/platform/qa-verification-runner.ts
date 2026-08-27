import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

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
  if (command === 'run' && !verificationScripts.test(args[index + 1] ?? '')) {
    throw new QaVerificationCommandRejectedError(
      'Only named verification scripts may be run.',
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

const escapesWorkspace = (workspacePath: string, candidate: string) => {
  if (!candidate) return false;
  const pathLike =
    isAbsolute(candidate) ||
    /^[a-z]:/i.test(candidate) ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    candidate.startsWith('..\\');
  if (!pathLike) return false;
  const withinWorkspace = relative(
    workspacePath,
    resolve(workspacePath, candidate),
  );
  return (
    isAbsolute(withinWorkspace) ||
    withinWorkspace === '..' ||
    withinWorkspace.startsWith('../') ||
    withinWorkspace.startsWith('..\\')
  );
};

const assertWorkspaceBoundArguments = (
  workspacePath: string,
  args: readonly string[],
) => {
  for (const argument of args) {
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
    const assignedValue = argument.includes('=')
      ? argument.slice(argument.indexOf('=') + 1)
      : argument;
    if (escapesWorkspace(workspacePath, assignedValue)) {
      throw new QaVerificationCommandRejectedError(
        'Verification command paths must remain inside the assigned workspace.',
      );
    }
  }
};

export class QaVerificationRunner {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly readTrackedFile: (
      path: string,
    ) => Promise<Uint8Array> = readFile,
  ) {}

  async captureTrackedSource(workspacePath: string): Promise<string> {
    const assignedWorkspace = resolve(workspacePath);
    const result = await this.processes.run(
      'git',
      ['-C', assignedWorkspace, 'ls-files', '-z'],
      { cwd: assignedWorkspace },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Tracked source state could not be read: ${result.stderr}`,
      );
    }
    const hash = createHash('sha256');
    const trackedPaths = result.stdout.split('\0').filter(Boolean).sort();
    for (const trackedPath of trackedPaths) {
      const absolutePath = resolve(assignedWorkspace, trackedPath);
      const withinWorkspace = relative(assignedWorkspace, absolutePath);
      if (
        isAbsolute(withinWorkspace) ||
        withinWorkspace === '..' ||
        withinWorkspace.startsWith(`..\\`) ||
        withinWorkspace.startsWith('../')
      ) {
        throw new Error('Tracked source path escaped the verified workspace.');
      }
      hash.update(trackedPath);
      hash.update('\0');
      hash.update(await this.readTrackedFile(absolutePath));
      hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  }

  async run(
    workspacePath: string,
    input: QaVerificationCommand,
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
    assertWorkspaceBoundArguments(assignedWorkspace, input.args);

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

    const result = await this.processes.run(executable, input.args, {
      cwd: assignedWorkspace,
    });
    return {
      ...result,
      command: [executable, ...input.args].map(quote).join(' '),
      stdout: result.stdout.slice(0, 32_000),
      stderr: result.stderr.slice(0, 32_000),
    };
  }
}
