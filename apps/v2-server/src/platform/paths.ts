import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const isContainedPath = (root: string, candidate: string): boolean => {
  const child = relative(resolve(root), resolve(candidate));
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
};

export const canonicalDirectory = (path: string): Promise<string> =>
  realpath(resolve(path));
