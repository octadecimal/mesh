import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type {
  GitProcessCall,
  GitProcessResult,
  GitProcessRunner,
} from '../projects/repository-identity.js';
import { nodeGitProcessRunner } from '../projects/repository-identity.js';
import { isContainedPath } from './paths.js';

export type TrustedV2GitExecutable = Readonly<{
  path: string;
  identity: string;
  workspaceRoot: string;
}>;

export class V2GitExecutableError extends Error {
  readonly code = 'git_executable_unavailable' as const;

  constructor() {
    super('An approved absolute Git executable is unavailable');
    this.name = 'V2GitExecutableError';
  }
}

const identity = (stat: Awaited<ReturnType<typeof lstat>>) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(
    ':',
  );

const approve = async (
  candidate: string,
  workspaceRoot: string,
  platform: NodeJS.Platform,
): Promise<TrustedV2GitExecutable | undefined> => {
  try {
    const [path, root] = await Promise.all([
      realpath(candidate),
      realpath(workspaceRoot),
    ]);
    const stat = await lstat(path);
    const expectedName = platform === 'win32' ? 'git.exe' : 'git';
    return isAbsolute(path) &&
      stat.isFile() &&
      !isContainedPath(root, path) &&
      basename(path).toLowerCase() === expectedName &&
      (platform === 'win32' || (stat.mode & 0o111) !== 0)
      ? { path, identity: identity(stat), workspaceRoot: root }
      : undefined;
  } catch {
    return undefined;
  }
};

export const approveV2GitExecutable = async ({
  configuredPath,
  pathValue,
  workspaceRoot,
  platform = process.platform,
}: {
  configuredPath?: string;
  pathValue?: string;
  workspaceRoot: string;
  platform?: NodeJS.Platform;
}): Promise<TrustedV2GitExecutable> => {
  const candidates = configuredPath
    ? [configuredPath]
    : (pathValue?.split(platform === 'win32' ? ';' : ':') ?? [])
        .filter((entry) => isAbsolute(entry.trim()))
        .map((entry) =>
          join(entry.trim(), platform === 'win32' ? 'git.exe' : 'git'),
        );
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    const trusted = await approve(resolve(candidate), workspaceRoot, platform);
    if (trusted) return trusted;
  }
  throw new V2GitExecutableError();
};

const stillTrusted = async (trusted: TrustedV2GitExecutable) => {
  const [path, stat] = await Promise.all([
    realpath(trusted.path),
    lstat(trusted.path),
  ]);
  return path === trusted.path && identity(stat) === trusted.identity;
};

export const createV2GitProcessRunner = (
  trusted: TrustedV2GitExecutable,
): GitProcessRunner => ({
  async run(call: GitProcessCall): Promise<GitProcessResult> {
    if (call.executable !== trusted.path || !(await stillTrusted(trusted))) {
      return {
        outcome: 'spawn_failure',
        message: 'Approved Git executable changed after startup',
      };
    }
    return nodeGitProcessRunner.run(call);
  },
});
