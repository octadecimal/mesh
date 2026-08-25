import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';

export type AbsolutePath = string & { readonly __absolutePath: unique symbol };

export interface WorkspacePathFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface WorkspacePathAdapter {
  basename(path: string): string;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  resolve(...paths: string[]): string;
}

export interface ResolveWorkspacePathOptions {
  baseDirectory: string;
  allowMissingLeaf?: boolean;
  fs?: WorkspacePathFileSystem;
  path?: WorkspacePathAdapter;
}

const defaultFileSystem: WorkspacePathFileSystem = nodeFs;

export const resolveWorkspacePath = async (
  input: string,
  options: ResolveWorkspacePathOptions,
): Promise<AbsolutePath> => {
  if (input.includes('\0') || options.baseDirectory.includes('\0')) {
    throw new Error('Workspace paths cannot contain a NUL byte');
  }

  const path = options.path ?? nodePath;
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(options.baseDirectory, input);
  const fs = options.fs ?? defaultFileSystem;
  let canonical: string;
  let missingLeaf = false;
  try {
    canonical = await fs.realpath(candidate);
  } catch (error) {
    if (!options.allowMissingLeaf) {
      throw error;
    }
    const canonicalParent = await fs.realpath(path.dirname(candidate));
    const parentStat = await fs.stat(canonicalParent);
    if (!parentStat.isDirectory()) {
      throw new Error(
        `Workspace path parent must be a directory: ${candidate}`,
      );
    }
    canonical = path.resolve(canonicalParent, path.basename(candidate));
    missingLeaf = true;
  }
  if (!missingLeaf) {
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      throw new Error(
        `Workspace path must resolve to a directory: ${candidate}`,
      );
    }
  }
  if (!path.isAbsolute(canonical)) {
    throw new Error(
      `Workspace path did not resolve to an absolute path: ${candidate}`,
    );
  }
  return canonical as AbsolutePath;
};
