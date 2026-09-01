import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
  createRepositoryIdentityResolver,
  nodeGitProcessRunner,
  type GitProcessCall,
  type GitProcessResult,
  type GitProcessRunner,
} from '../projects/repository-identity.js';
import {
  createManagedWorkspace,
  deriveManagedWorkspace,
  observeManagedWorkspace,
} from './managed-workspace.js';

const ids = {
  projectId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  attemptId: '00000000-0000-4000-8000-000000000003',
} as const;

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
    { cwd, encoding: 'utf8', windowsHide: true },
  ).trim();

const removeFixture = (directory: string): void => {
  const resolved = resolve(directory);
  const fromTemporaryDirectory = relative(resolve(tmpdir()), resolved);
  if (
    fromTemporaryDirectory.startsWith('..') ||
    fromTemporaryDirectory === '' ||
    !basename(resolved).startsWith('mesh-v2-managed-workspace-test-')
  ) {
    throw new Error(
      'Refusing to remove an unverified managed-workspace fixture',
    );
  }
  rmSync(resolved, { recursive: true, force: true });
};

const createRepository = (parent: string): string => {
  const repository = join(parent, 'repository');
  git(['init', '--quiet', repository]);
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
  return repository;
};

class RecordingRunner implements GitProcessRunner {
  readonly calls: GitProcessCall[] = [];

  async run(call: GitProcessCall): Promise<GitProcessResult> {
    this.calls.push(call);
    return nodeGitProcessRunner.run(call);
  }
}

describe('managed workspaces', () => {
  let directory: string;
  let repository: string;
  let managedRoot: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mesh-v2-managed-workspace-test-'));
    repository = createRepository(directory);
    managedRoot = join(directory, 'managed');
  });

  afterEach(() => removeFixture(directory));

  const workspace = () => {
    const identity = git(['rev-parse', '--git-common-dir'], repository);
    return deriveManagedWorkspace({
      managedRoot,
      projectId: ids.projectId,
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      repositoryPath: repository,
      repositoryIdentity: resolve(repository, identity),
      baseCommit: git(['rev-parse', 'HEAD'], repository),
      createdAt: '2026-09-01T00:00:00.000Z',
    });
  };

  const dependencies = (runner = new RecordingRunner()) => ({
    managedRoot,
    gitExecutable: 'git',
    processRunner: runner,
    resolveRepositoryIdentity: createRepositoryIdentityResolver({
      workspaceRoot: directory,
      processRunner: runner,
    }),
    assertCreateReserved: (attemptId: string) =>
      expect(attemptId).toBe(ids.attemptId),
  });

  it('derives a deterministic branch and path without task text', () => {
    const first = workspace();

    expect(first.branch).toBe(
      `mesh/dev/${ids.projectId}/${ids.taskId}/${ids.attemptId}`,
    );
    expect(first.path).toBe(
      resolve(managedRoot, ids.projectId, ids.taskId, ids.attemptId),
    );
    expect(first.path).not.toContain('Persist Todo items');
    expect(first).toMatchObject({
      lifecycle: 'creating',
      observedHead: null,
      observedDirty: null,
      failure: null,
      revision: 0,
    });
  });

  it('requires the durable reservation immediately before its first mutation', async () => {
    const runner = new RecordingRunner();
    const calls: string[] = [];
    const result = await createManagedWorkspace(workspace(), {
      ...dependencies(runner),
      assertCreateReserved: () => calls.push('reserved'),
    });

    const creation = runner.calls.find((call) =>
      call.args.includes('worktree'),
    );
    expect(calls).toEqual(['reserved']);
    expect(creation).toEqual({
      executable: 'git',
      args: [
        '-c',
        'credential.interactive=false',
        '-C',
        resolve(repository),
        'worktree',
        'add',
        '-b',
        workspace().branch,
        workspace().path,
        workspace().baseCommit,
      ],
      cwd: resolve(repository),
      timeoutMs: 10_000,
    });
    expect(result.lifecycle).toBe('ready');
  });

  it('creates a clean owned worktree and observes it ready', async () => {
    const created = await createManagedWorkspace(workspace(), dependencies());

    expect(created).toMatchObject({
      lifecycle: 'ready',
      observedHead: created.baseCommit,
      observedDirty: false,
      failure: null,
    });
    const admin = git(['rev-parse', '--git-dir'], created.path);
    expect(
      JSON.parse(readFileSync(join(admin, 'mesh-owner.json'), 'utf8')),
    ).toMatchObject({
      schema: 'mesh.v2/developer-workspace-owner/v1',
      attemptId: created.attemptId,
      ownershipToken: created.ownershipToken,
      repositoryIdentity: created.repositoryIdentity,
      branch: created.branch,
      baseCommit: created.baseCommit,
    });
  });

  it('returns attention without cleanup for a branch collision or partial directory', async () => {
    const existing = workspace();
    const runner = new RecordingRunner();
    git(['branch', existing.branch, existing.baseCommit], repository);
    mkdirSync(existing.path, { recursive: true });
    writeFileSync(join(existing.path, 'preserve.txt'), 'do not remove');

    const result = await createManagedWorkspace(existing, dependencies(runner));

    expect(result).toMatchObject({ lifecycle: 'attention_required' });
    expect(readFileSync(join(existing.path, 'preserve.txt'), 'utf8')).toBe(
      'do not remove',
    );
    expect(
      runner.calls.some((call) =>
        call.args.some((arg) => ['remove', 'reset', 'clean'].includes(arg)),
      ),
    ).toBe(false);
  });

  it('returns attention for wrong repository identity, branch, HEAD, or ownership metadata', async () => {
    const created = await createManagedWorkspace(workspace(), dependencies());
    const cases = [
      { repositoryIdentity: 'wrong-identity' },
      { branch: 'mesh/dev/wrong' },
      { baseCommit: 'a'.repeat(40) },
    ];

    for (const change of cases) {
      await expect(
        observeManagedWorkspace({ ...created, ...change }, dependencies(), {
          requireClean: false,
        }),
      ).resolves.toMatchObject({ lifecycle: 'attention_required' });
    }
    const admin = git(['rev-parse', '--git-dir'], created.path);
    rmSync(join(admin, 'mesh-owner.json'));
    await expect(
      observeManagedWorkspace(created, dependencies(), { requireClean: false }),
    ).resolves.toMatchObject({ lifecycle: 'attention_required' });
  });

  it('permits a dirty active worktree but requires clean provisioning', async () => {
    const created = await createManagedWorkspace(workspace(), dependencies());
    writeFileSync(join(created.path, 'dirty.txt'), 'dirty');

    await expect(
      observeManagedWorkspace(created, dependencies(), { requireClean: false }),
    ).resolves.toMatchObject({ lifecycle: 'ready', observedDirty: true });
    await expect(
      observeManagedWorkspace(created, dependencies(), { requireClean: true }),
    ).resolves.toMatchObject({
      lifecycle: 'attention_required',
      observedDirty: true,
    });
  });

  it('normalizes Windows separator and case comparisons', () => {
    const first = deriveManagedWorkspace({
      ...workspace(),
      managedRoot: 'C:\\Mesh\\Managed',
      projectId: 'PROJECT',
      taskId: 'TASK',
      attemptId: 'ATTEMPT',
      platform: 'win32',
    });

    expect(first.path).toBe('C:\\Mesh\\Managed\\PROJECT\\TASK\\ATTEMPT');
  });

  it('does not create an ownership marker when worktree creation fails', async () => {
    const candidate = workspace();
    git(['branch', candidate.branch, candidate.baseCommit], repository);

    const result = await createManagedWorkspace(candidate, dependencies());

    expect(result.lifecycle).toBe('attention_required');
    expect(existsSync(join(candidate.path, '.git', 'mesh-owner.json'))).toBe(
      false,
    );
  });
});
