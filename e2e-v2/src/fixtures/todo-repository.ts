import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const assertContainedPath = (parent: string, target: string) => {
  const resolvedParent = resolve(parent);
  const resolvedTarget = resolve(target);
  const relation = relative(resolvedParent, resolvedTarget);
  if (
    relation === '' ||
    relation.startsWith('..') ||
    resolve(resolvedParent, relation) !== resolvedTarget
  ) {
    throw new Error(`Refusing path outside owned root: ${resolvedTarget}`);
  }
  return resolvedTarget;
};

const git = async (repository: string, ...arguments_: string[]) => {
  await exec('git', arguments_, {
    cwd: repository,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: repository,
      USERPROFILE: repository,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
};

export const createTodoRepository = async (fixtureRoot: string) => {
  const repository = assertContainedPath(
    fixtureRoot,
    join(fixtureRoot, 'todo-repository'),
  );
  await mkdir(repository);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Mesh V2 test');
  await git(repository, 'config', 'user.email', 'mesh-v2-test@example.invalid');
  await writeFile(
    join(repository, 'README.md'),
    '# Todo\n\n- [ ] Prove the Mesh V2 foundation.\n',
    'utf8',
  );
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'chore: seed todo fixture');
  return repository;
};
