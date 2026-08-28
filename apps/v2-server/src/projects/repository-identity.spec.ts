import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
  createRepositoryIdentityResolver,
  nodeGitProcessRunner,
  normalizeRepositoryIdentityPath,
  type GitProcessCall,
  type GitProcessResult,
  type GitProcessRunner,
} from './repository-identity.js';

const git = (args: readonly string[], cwd?: string): string =>
  execFileSync(
    'git',
    [
      '-c',
      'credential.interactive=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();

const removeVerifiedDirectory = (directory: string): void => {
  const resolved = resolve(directory);
  const relativeToTemp = relative(resolve(tmpdir()), resolved);
  if (
    relativeToTemp.startsWith('..') ||
    relativeToTemp === '' ||
    !basename(resolved).startsWith('mesh-v2-project-test-')
  ) {
    throw new Error('Refusing to remove an unverified project test directory');
  }
  rmSync(resolved, { recursive: true, force: true });
};

const createRepository = (
  parent: string,
  name: string,
  options: { commit: boolean; objectFormat?: 'sha256' } = { commit: true },
): string => {
  const repository = join(parent, name);
  git([
    'init',
    '--quiet',
    ...(options.objectFormat
      ? [`--object-format=${options.objectFormat}`]
      : []),
    repository,
  ]);
  if (options.commit) {
    writeFileSync(join(repository, 'README.md'), '# Todo\n');
    git(['add', 'README.md'], repository);
    git(
      [
        '-c',
        'user.name=Mesh Tests',
        '-c',
        'user.email=mesh-tests@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'initial',
      ],
      repository,
    );
  }
  return repository;
};

class RecordingRunner implements GitProcessRunner {
  readonly calls: GitProcessCall[] = [];

  constructor(private readonly headOverride?: GitProcessResult) {}

  async run(call: GitProcessCall): Promise<GitProcessResult> {
    this.calls.push(call);
    if (this.headOverride && call.args.includes('HEAD^{commit}')) {
      return this.headOverride;
    }
    return nodeGitProcessRunner.run(call);
  }
}

describe('repository identity', () => {
  let directory: string;
  let workspaceRoot: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mesh-v2-project-test-'));
    workspaceRoot = join(directory, 'workspace');
    mkdirSync(workspaceRoot);
  });

  afterEach(() => removeVerifiedDirectory(directory));

  it('resolves canonical top-level, common directory, and a separately verified commit without Git writes', async () => {
    const repository = createRepository(workspaceRoot, 'todo');
    const statusBefore = git(['status', '--porcelain=v1'], repository);
    const headBefore = git(['rev-parse', 'HEAD'], repository);
    const runner = new RecordingRunner();
    const resolveIdentity = createRepositoryIdentityResolver({
      workspaceRoot,
      processRunner: runner,
    });

    const identity = await resolveIdentity(join(repository, '.'));

    expect(identity).toEqual({
      canonicalPath: resolve(repository),
      commonDirectory: resolve(repository, '.git'),
      repositoryIdentity: normalizeRepositoryIdentityPath(
        resolve(repository, '.git'),
      ),
      headCommit: headBefore,
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toEqual({
      executable: 'git',
      args: [
        '-c',
        'credential.interactive=false',
        '-C',
        resolve(repository),
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
      ],
      cwd: resolve(repository),
      timeoutMs: 10_000,
    });
    expect(runner.calls[1]?.args).toEqual([
      '-c',
      'credential.interactive=false',
      '-C',
      identity.canonicalPath,
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    expect(git(['status', '--porcelain=v1'], repository)).toBe(statusBefore);
    expect(git(['rev-parse', 'HEAD'], repository)).toBe(headBefore);
  });

  it('accepts a workspace-relative path and resolves an enclosing Git top-level', async () => {
    const repository = createRepository(workspaceRoot, 'todo');
    mkdirSync(join(repository, 'src'));
    const resolveIdentity = createRepositoryIdentityResolver({ workspaceRoot });

    const identity = await resolveIdentity(join('todo', 'src'));

    expect(identity.canonicalPath).toBe(resolve(repository));
    expect(identity.commonDirectory).toBe(resolve(repository, '.git'));
  });

  it('accepts one lowercase 64-character commit ID from a real SHA-256 repository', async () => {
    const repository = createRepository(workspaceRoot, 'sha256', {
      commit: true,
      objectFormat: 'sha256',
    });
    const resolveIdentity = createRepositoryIdentityResolver({ workspaceRoot });

    const identity = await resolveIdentity(repository);

    expect(identity.headCommit).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity.headCommit).toBe(git(['rev-parse', 'HEAD'], repository));
  });

  it('case-folds Windows identity comparisons without changing display paths', () => {
    const displayPath = 'C:\\Mesh\\Repositories\\Todo\\.git';

    expect(normalizeRepositoryIdentityPath(displayPath, 'win32')).toBe(
      'c:\\mesh\\repositories\\todo\\.git',
    );
    expect(displayPath).toBe('C:\\Mesh\\Repositories\\Todo\\.git');
  });

  it('rejects a non-repository as repository_invalid', async () => {
    const path = join(workspaceRoot, 'plain-directory');
    mkdirSync(path);
    const resolveIdentity = createRepositoryIdentityResolver({ workspaceRoot });

    await expect(resolveIdentity(path)).rejects.toMatchObject({
      code: 'repository_invalid',
    });
  });

  it('rejects a canonical top-level reached through a symlink or junction escape before running Git', async () => {
    const outside = createRepository(directory, 'outside');
    const link = join(workspaceRoot, 'escaped');
    symlinkSync(
      outside,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const runner = new RecordingRunner();
    const resolveIdentity = createRepositoryIdentityResolver({
      workspaceRoot,
      processRunner: runner,
    });

    await expect(resolveIdentity(link)).rejects.toMatchObject({
      code: 'repository_path_escape',
    });
    expect(runner.calls).toEqual([]);
  });

  it('rejects a linked worktree whose real common directory escapes the workspace', async () => {
    const source = createRepository(directory, 'source');
    const linked = join(workspaceRoot, 'linked');
    git(
      ['worktree', 'add', '--quiet', '-b', 't04-linked', linked, 'HEAD'],
      source,
    );
    const resolveIdentity = createRepositoryIdentityResolver({ workspaceRoot });

    await expect(resolveIdentity(linked)).rejects.toMatchObject({
      code: 'repository_path_escape',
    });
  });

  it('classifies an actual git init repository with no commit as unborn', async () => {
    const repository = createRepository(workspaceRoot, 'unborn', {
      commit: false,
    });
    const runner = new RecordingRunner();
    const resolveIdentity = createRepositoryIdentityResolver({
      workspaceRoot,
      processRunner: runner,
    });

    await expect(resolveIdentity(repository)).rejects.toMatchObject({
      code: 'repository_head_unborn',
    });
    expect(runner.calls).toHaveLength(2);
  });

  it.each([
    [
      'spawn failure',
      { outcome: 'spawn_failure', message: 'spawn failed' },
      'repository_head_failed',
    ],
    [
      'timeout',
      { outcome: 'timeout', message: 'timed out' },
      'repository_head_failed',
    ],
    [
      'nonzero failure',
      {
        outcome: 'completed',
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: unable to read object',
      },
      'repository_head_failed',
    ],
    [
      'Git ambiguity',
      {
        outcome: 'completed',
        exitCode: 128,
        stdout: '',
        stderr: "fatal: ambiguous argument 'HEAD^{commit}'",
      },
      'repository_head_ambiguous',
    ],
    [
      'multiple successful lines',
      {
        outcome: 'completed',
        exitCode: 0,
        stdout: `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`,
        stderr: '',
      },
      'repository_head_ambiguous',
    ],
    [
      'invalid successful object ID',
      {
        outcome: 'completed',
        exitCode: 0,
        stdout: `${'A'.repeat(40)}\n`,
        stderr: '',
      },
      'repository_head_ambiguous',
    ],
  ] as const)(
    'rejects injected %s HEAD evidence as %s',
    async (_name, outcome, code) => {
      const repository = createRepository(workspaceRoot, 'todo');
      const runner = new RecordingRunner(outcome);
      const resolveIdentity = createRepositoryIdentityResolver({
        workspaceRoot,
        processRunner: runner,
      });

      await expect(resolveIdentity(repository)).rejects.toMatchObject({ code });
      expect(runner.calls).toHaveLength(2);
    },
  );
});
