import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { V2ErrorCode } from '@mesh/v2-contracts';

export type RepositoryIdentity = {
  canonicalPath: string;
  commonDirectory: string;
  repositoryIdentity: string;
  headCommit: string;
};

export type ResolveRepositoryIdentity = (
  repositoryPath: string,
) => Promise<RepositoryIdentity>;

export type GitProcessCall = {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
};

export type GitProcessResult =
  | { outcome: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { outcome: 'spawn_failure' | 'timeout'; message: string };

export interface GitProcessRunner {
  run(call: GitProcessCall): Promise<GitProcessResult>;
}

export class RepositoryIdentityError extends Error {
  constructor(
    readonly code: Extract<
      V2ErrorCode,
      | 'repository_head_ambiguous'
      | 'repository_head_failed'
      | 'repository_head_unborn'
      | 'repository_invalid'
      | 'repository_path_escape'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryIdentityError';
  }
}

export const normalizeRepositoryIdentityPath = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): string => (platform === 'win32' ? path.toLowerCase() : path);

const isContained = (
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean => {
  const rootKey = normalizeRepositoryIdentityPath(root, platform);
  const candidateKey = normalizeRepositoryIdentityPath(candidate, platform);
  const pathFromRoot = relative(rootKey, candidateKey);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
};

const requireContained = (
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): void => {
  if (!isContained(root, candidate, platform)) {
    throw new RepositoryIdentityError(
      'repository_path_escape',
      'Repository path escapes the configured V2 workspace root',
    );
  }
};

export const nodeGitProcessRunner: GitProcessRunner = {
  run(call) {
    return new Promise((resolveResult) => {
      const child = (() => {
        try {
          return spawn(call.executable, [...call.args], {
            cwd: call.cwd,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          resolveResult({
            outcome: 'spawn_failure',
            message: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      })();
      if (!child) return;
      let settled = false;
      let stdout = '';
      let stderr = '';
      const finish = (result: GitProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({
          outcome: 'timeout',
          message: `Git process exceeded ${call.timeoutMs} ms`,
        });
      }, call.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish({ outcome: 'spawn_failure', message: error.message });
      });
      child.on('close', (exitCode) => {
        finish({
          outcome: 'completed',
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        });
      });
    });
  },
};

const outputLines = (stdout: string): string[] =>
  stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const invalidRepository = (message: string): RepositoryIdentityError =>
  new RepositoryIdentityError('repository_invalid', message);

const classifyCompletedHeadFailure = (
  result: Extract<GitProcessResult, { outcome: 'completed' }>,
): never => {
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (/ambiguous/iu.test(diagnostic)) {
    throw new RepositoryIdentityError(
      'repository_head_ambiguous',
      'Repository HEAD lookup returned ambiguous evidence',
    );
  }
  if (
    /needed a single revision|unknown revision or path not in the working tree/iu.test(
      diagnostic,
    )
  ) {
    throw new RepositoryIdentityError(
      'repository_head_unborn',
      'Repository HEAD does not contain a commit',
    );
  }
  throw new RepositoryIdentityError(
    'repository_head_failed',
    'Repository HEAD lookup failed',
  );
};

export type RepositoryIdentityResolverOptions = {
  workspaceRoot: string;
  gitExecutable?: string;
  processRunner?: GitProcessRunner;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
};

export const createRepositoryIdentityResolver = ({
  workspaceRoot,
  gitExecutable = 'git',
  processRunner = nodeGitProcessRunner,
  platform = process.platform,
  timeoutMs = 10_000,
}: RepositoryIdentityResolverOptions): ResolveRepositoryIdentity => {
  const configuredRoot = resolve(workspaceRoot);

  return async (repositoryPath) => {
    const requested = isAbsolute(repositoryPath)
      ? resolve(repositoryPath)
      : resolve(configuredRoot, repositoryPath);
    requireContained(configuredRoot, requested, platform);

    let canonicalWorkspaceRoot: string;
    let canonicalRequested: string;
    try {
      [canonicalWorkspaceRoot, canonicalRequested] = await Promise.all([
        realpath(configuredRoot),
        realpath(requested),
      ]);
    } catch {
      throw invalidRepository('Repository path is not readable');
    }
    requireContained(canonicalWorkspaceRoot, canonicalRequested, platform);

    const rootResult = await processRunner.run({
      executable: gitExecutable,
      args: [
        '-c',
        'credential.interactive=false',
        '-C',
        canonicalRequested,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
      ],
      cwd: canonicalRequested,
      timeoutMs,
    });
    if (rootResult.outcome !== 'completed' || rootResult.exitCode !== 0) {
      throw invalidRepository('Path is not a readable Git working tree');
    }
    const paths = outputLines(rootResult.stdout);
    if (paths.length !== 2 || paths.some((path) => !isAbsolute(path))) {
      throw invalidRepository('Git returned invalid repository identity paths');
    }

    let canonicalPath: string;
    let commonDirectory: string;
    try {
      [canonicalPath, commonDirectory] = await Promise.all([
        realpath(paths[0]),
        realpath(paths[1]),
      ]);
    } catch {
      throw invalidRepository('Git repository identity paths are not readable');
    }
    requireContained(canonicalWorkspaceRoot, canonicalPath, platform);
    requireContained(canonicalWorkspaceRoot, commonDirectory, platform);

    const headResult = await processRunner.run({
      executable: gitExecutable,
      args: [
        '-c',
        'credential.interactive=false',
        '-C',
        canonicalPath,
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ],
      cwd: canonicalPath,
      timeoutMs,
    });
    if (headResult.outcome !== 'completed') {
      throw new RepositoryIdentityError(
        'repository_head_failed',
        `Repository HEAD lookup failed: ${headResult.message}`,
      );
    }
    if (headResult.exitCode !== 0) {
      classifyCompletedHeadFailure(headResult);
    }
    const headLines = outputLines(headResult.stdout);
    if (
      headLines.length !== 1 ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headLines[0])
    ) {
      throw new RepositoryIdentityError(
        'repository_head_ambiguous',
        'Repository HEAD lookup returned invalid commit evidence',
      );
    }

    return {
      canonicalPath,
      commonDirectory,
      repositoryIdentity: normalizeRepositoryIdentityPath(
        commonDirectory,
        platform,
      ),
      headCommit: headLines[0],
    };
  };
};
