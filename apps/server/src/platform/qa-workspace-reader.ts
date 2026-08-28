import {
  lstat as fsLstat,
  open as fsOpen,
  opendir as fsOpendir,
  realpath as fsRealpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path';

const maxReadBytes = 32_000;
const maxSearchFileBytes = 128_000;
const maxSearchFiles = 500;
const maxSearchMatches = 100;
const maxSearchDirectories = 128;
const maxSearchEntries = 1_000;
const maxSearchPending = 256;

export type FileSystemStat = {
  dev: bigint | number;
  ino: bigint | number;
  mode: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type FileHandle = {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<FileSystemStat>;
};

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type DirectoryHandle = AsyncIterable<DirectoryEntry> & {
  close(): Promise<void>;
};

export type QaWorkspaceFileSystem = {
  lstat(path: string): Promise<FileSystemStat>;
  open(path: string, flags: 'r'): Promise<FileHandle>;
  opendir(path: string): Promise<DirectoryHandle>;
  realpath(path: string): Promise<string>;
};

type RootSnapshot = {
  lexicalRoot: string;
  root: string;
  rootIdentity: string;
};

export type WorkspaceRootBinding = {
  lexicalRoot: string;
  root: string;
  rootObjectIdentity: string;
};

type BoundSnapshot = RootSnapshot & {
  identity: string;
  lexicalPath: string;
  parentIdentity: string;
  parentPath: string;
  path: string;
  stat: FileSystemStat;
};

const defaultFileSystem: QaWorkspaceFileSystem = {
  lstat: async (path) => fsLstat(path),
  open: async (path, flags) => fsOpen(path, flags),
  opendir: async (path) => fsOpendir(path),
  realpath: fsRealpath,
};

export class QaWorkspacePathRejectedError extends Error {
  readonly code = 'qa_workspace_path_rejected';

  constructor() {
    super('QA workspace access must remain inside the assigned workspace.');
    this.name = 'QaWorkspacePathRejectedError';
  }
}

export class QaWorkspaceOperationCancelledError extends Error {
  readonly code = 'qa_workspace_operation_cancelled';

  constructor() {
    super('QA workspace access was cancelled with its owning runtime.');
    this.name = 'QaWorkspaceOperationCancelledError';
  }
}

const throwIfSearchAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new QaWorkspaceOperationCancelledError();
};

const within = (root: string, candidate: string) => {
  const child = relative(root, candidate);
  return (
    child !== '..' &&
    !child.startsWith('../') &&
    !child.startsWith('..\\') &&
    !isAbsolute(child)
  );
};

const samePath = (left: string, right: string) => relative(left, right) === '';

const relativeInput = (candidate: string) => {
  const normalized = candidate.replace(/\\/g, '/');
  if (isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) {
    throw new QaWorkspacePathRejectedError();
  }
  return normalized;
};

const hasParentTraversal = (candidate: string) =>
  candidate.split('/').some((segment) => segment === '..');

const safeBraceAlternative = /^[A-Za-z0-9_-]+$/u;

const hasOnlySafeBraceAlternatives = (pattern: string): boolean => {
  let openBrace = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '{') {
      if (openBrace !== -1) return false;
      openBrace = index;
      continue;
    }
    if (pattern[index] !== '}') continue;
    if (openBrace === -1) return false;
    const alternatives = pattern.slice(openBrace + 1, index).split(',');
    if (
      alternatives.length < 2 ||
      alternatives.some(
        (alternative) => !safeBraceAlternative.test(alternative),
      )
    ) {
      return false;
    }
    openBrace = -1;
  }
  return openBrace === -1;
};

const safeGlobPattern = (pattern: string): string => {
  if (
    pattern.trim().length === 0 ||
    isAbsolute(pattern) ||
    win32.isAbsolute(pattern) ||
    hasParentTraversal(pattern) ||
    pattern.includes(':') ||
    pattern.includes('\\') ||
    pattern.includes('[') ||
    pattern.includes(']') ||
    /[?*+@!]\(/u.test(pattern) ||
    !hasOnlySafeBraceAlternatives(pattern)
  ) {
    throw new QaWorkspacePathRejectedError();
  }
  return pattern;
};

const regexSpecial = /[\\^$.*+?()[\]{}|]/u;

const globExpression = (pattern: string): RegExp => {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '{') {
      const close = pattern.indexOf('}', index + 1);
      const alternatives = pattern.slice(index + 1, close).split(',');
      source += `(?:${alternatives.join('|')})`;
      index = close;
      continue;
    }
    source += regexSpecial.test(character ?? '') ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`, 'u');
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const workspaceStatIdentity = (stat: FileSystemStat) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(
    ':',
  );

const identity = workspaceStatIdentity;

export const workspaceObjectIdentity = (stat: FileSystemStat) =>
  [stat.dev, stat.ino, stat.mode].join(':');

const readBounded = async (handle: FileHandle, limit: number) => {
  const output = Buffer.alloc(limit + 1);
  const { bytesRead } = await handle.read(output, 0, output.length, 0);
  return {
    content: output.subarray(0, Math.min(bytesRead, limit)).toString('utf8'),
    truncated: bytesRead > limit,
  };
};

export class QaWorkspaceReader {
  private readonly fileSystem: QaWorkspaceFileSystem;

  constructor(
    fileSystem: Partial<QaWorkspaceFileSystem> = {},
    private readonly rootBinding?: WorkspaceRootBinding,
  ) {
    this.fileSystem = { ...defaultFileSystem, ...fileSystem };
  }

  private async rootSnapshot(workspacePath: string): Promise<RootSnapshot> {
    const lexicalRoot = resolve(workspacePath);
    const root = await this.fileSystem.realpath(lexicalRoot);
    const rootStat = await this.fileSystem.lstat(root);
    if (!rootStat.isDirectory()) throw new QaWorkspacePathRejectedError();
    const rootIdentity = identity(rootStat);
    if (
      this.rootBinding &&
      (!samePath(this.rootBinding.lexicalRoot, lexicalRoot) ||
        !samePath(this.rootBinding.root, root) ||
        this.rootBinding.rootObjectIdentity !==
          workspaceObjectIdentity(rootStat))
    ) {
      throw new QaWorkspacePathRejectedError();
    }
    return { lexicalRoot, root, rootIdentity };
  }

  private async captureBound(
    root: RootSnapshot,
    lexicalPath: string,
  ): Promise<BoundSnapshot> {
    if (
      !within(root.lexicalRoot, lexicalPath) &&
      !within(root.root, lexicalPath)
    ) {
      throw new QaWorkspacePathRejectedError();
    }
    const path = await this.fileSystem.realpath(lexicalPath);
    if (!within(root.root, path)) throw new QaWorkspacePathRejectedError();
    const parentLexicalPath = samePath(root.root, path)
      ? root.lexicalRoot
      : dirname(lexicalPath);
    const parentPath = await this.fileSystem.realpath(parentLexicalPath);
    if (!within(root.root, parentPath)) {
      throw new QaWorkspacePathRejectedError();
    }
    const [stat, parentStat] = await Promise.all([
      this.fileSystem.lstat(path),
      this.fileSystem.lstat(parentPath),
    ]);
    return {
      ...root,
      identity: identity(stat),
      lexicalPath,
      parentIdentity: identity(parentStat),
      parentPath,
      path,
      stat,
    };
  }

  private async resolveBound(
    workspacePath: string,
    inputPath: string,
  ): Promise<BoundSnapshot> {
    const root = await this.rootSnapshot(workspacePath);
    return this.captureBound(
      root,
      resolve(root.lexicalRoot, relativeInput(inputPath)),
    );
  }

  private async revalidate(snapshot: BoundSnapshot): Promise<void> {
    const [root, path, parentPath] = await Promise.all([
      this.fileSystem.realpath(snapshot.lexicalRoot),
      this.fileSystem.realpath(snapshot.lexicalPath),
      this.fileSystem.realpath(
        samePath(snapshot.root, snapshot.path)
          ? snapshot.lexicalRoot
          : dirname(snapshot.lexicalPath),
      ),
    ]);
    if (
      !samePath(root, snapshot.root) ||
      !samePath(path, snapshot.path) ||
      !samePath(parentPath, snapshot.parentPath) ||
      !within(root, path) ||
      !within(root, parentPath)
    ) {
      throw new QaWorkspacePathRejectedError();
    }
    const [rootStat, stat, parentStat] = await Promise.all([
      this.fileSystem.lstat(root),
      this.fileSystem.lstat(path),
      this.fileSystem.lstat(parentPath),
    ]);
    if (
      !rootStat.isDirectory() ||
      identity(rootStat) !== snapshot.rootIdentity ||
      identity(stat) !== snapshot.identity ||
      identity(parentStat) !== snapshot.parentIdentity
    ) {
      throw new QaWorkspacePathRejectedError();
    }
  }

  private async readSnapshot(
    snapshot: BoundSnapshot,
    limit: number,
    signal?: AbortSignal,
  ) {
    throwIfSearchAborted(signal);
    if (!snapshot.stat.isFile()) throw new QaWorkspacePathRejectedError();
    const handle = await this.fileSystem.open(snapshot.path, 'r');
    try {
      throwIfSearchAborted(signal);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || identity(openedStat) !== snapshot.identity) {
        throw new QaWorkspacePathRejectedError();
      }
      await this.revalidate(snapshot);
      throwIfSearchAborted(signal);
      const result = await readBounded(handle, limit);
      throwIfSearchAborted(signal);
      await this.revalidate(snapshot);
      throwIfSearchAborted(signal);
      return result;
    } finally {
      await handle.close();
    }
  }

  private async readDirectoryStream(
    snapshot: BoundSnapshot,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
    throwIfSearchAborted(signal);
    if (!snapshot.stat.isDirectory()) throw new QaWorkspacePathRejectedError();
    const handle = await this.fileSystem.opendir(snapshot.path);
    const entries: DirectoryEntry[] = [];
    let exhausted = false;
    let traversalError: unknown;
    try {
      const iterator = handle[Symbol.asyncIterator]();
      while (entries.length < limit) {
        throwIfSearchAborted(signal);
        const next = await iterator.next();
        throwIfSearchAborted(signal);
        if (next.done) {
          exhausted = true;
          break;
        }
        entries.push(next.value);
      }
    } catch (error) {
      traversalError = error;
    }
    let cleanupError: unknown;
    try {
      await handle.close();
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ERR_DIR_CLOSED'
      ) {
        cleanupError = error;
      }
    }
    try {
      await this.revalidate(snapshot);
    } catch (error) {
      cleanupError ??= error;
    }
    if (traversalError !== undefined) throw traversalError;
    if (cleanupError !== undefined) throw cleanupError;
    throwIfSearchAborted(signal);
    return { entries, truncated: !exhausted && entries.length >= limit };
  }

  private async walk(
    workspacePath: string,
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<{
    files: BoundSnapshot[];
    root: RootSnapshot;
    start: BoundSnapshot;
    truncated: boolean;
  }> {
    throwIfSearchAborted(signal);
    const start = await this.resolveBound(workspacePath, inputPath);
    const root: RootSnapshot = {
      lexicalRoot: start.lexicalRoot,
      root: start.root,
      rootIdentity: start.rootIdentity,
    };
    const pending = [start.path];
    const files: BoundSnapshot[] = [];
    let directories = 0;
    let entriesVisited = 0;
    let traversalTruncated = false;
    while (
      pending.length > 0 &&
      files.length < maxSearchFiles &&
      directories < maxSearchDirectories &&
      entriesVisited < maxSearchEntries
    ) {
      throwIfSearchAborted(signal);
      const current = pending.pop();
      if (!current) break;
      const snapshot = await this.captureBound(root, current);
      throwIfSearchAborted(signal);
      if (snapshot.stat.isFile()) {
        files.push(snapshot);
        continue;
      }
      if (!snapshot.stat.isDirectory()) continue;
      directories += 1;
      const remainingEntries = maxSearchEntries - entriesVisited;
      const remainingPending = maxSearchPending - pending.length;
      const entryBudget = Math.min(remainingEntries, remainingPending);
      if (entryBudget <= 0) {
        traversalTruncated = true;
        break;
      }
      const streamed = await this.readDirectoryStream(
        snapshot,
        entryBudget,
        signal,
      );
      entriesVisited += streamed.entries.length;
      if (streamed.truncated) traversalTruncated = true;
      for (const entry of streamed.entries.reverse()) {
        throwIfSearchAborted(signal);
        if (entry.isSymbolicLink()) continue;
        if (pending.length >= maxSearchPending) {
          traversalTruncated = true;
          break;
        }
        pending.push(resolve(snapshot.path, entry.name));
      }
    }
    if (pending.length > 0) traversalTruncated = true;
    return {
      files,
      root,
      start,
      truncated: traversalTruncated || files.length >= maxSearchFiles,
    };
  }

  async read(
    workspacePath: string,
    inputPath: string,
    options: { signal?: AbortSignal } = {},
  ) {
    throwIfSearchAborted(options.signal);
    const snapshot = await this.resolveBound(workspacePath, inputPath);
    throwIfSearchAborted(options.signal);
    return {
      path: relative(snapshot.root, snapshot.path),
      ...(await this.readSnapshot(snapshot, maxReadBytes, options.signal)),
    };
  }

  async list(
    workspacePath: string,
    inputPath: string,
    options: { signal?: AbortSignal } = {},
  ) {
    throwIfSearchAborted(options.signal);
    const snapshot = await this.resolveBound(workspacePath, inputPath);
    throwIfSearchAborted(options.signal);
    const streamed = await this.readDirectoryStream(
      snapshot,
      maxSearchFiles + 1,
      options.signal,
    );
    const entries = streamed.entries.slice(0, maxSearchFiles);
    return {
      path: relative(snapshot.root, snapshot.path) || '.',
      entries: entries.map((entry) => ({
        path: relative(snapshot.root, resolve(snapshot.path, entry.name)),
        type: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symbolic_link'
              : 'other',
      })),
      truncated: streamed.truncated || streamed.entries.length > maxSearchFiles,
    };
  }

  async search(
    workspacePath: string,
    inputPath: string,
    query: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const { files, root, start, truncated } = await this.walk(
      workspacePath,
      inputPath,
      options.signal,
    );

    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files) {
      throwIfSearchAborted(options.signal);
      const read = await this.readSnapshot(
        file,
        maxSearchFileBytes,
        options.signal,
      );
      if (read.content.includes('\0')) continue;
      for (const [index, line] of read.content.split(/\r?\n/).entries()) {
        throwIfSearchAborted(options.signal);
        if (!line.includes(query)) continue;
        matches.push({
          path: relative(root.root, file.path),
          line: index + 1,
          text: line,
        });
        if (matches.length >= maxSearchMatches) break;
      }
      if (matches.length >= maxSearchMatches) break;
    }
    return {
      path: relative(root.root, start.path) || '.',
      matches,
      truncated: truncated || matches.length >= maxSearchMatches,
    };
  }

  async glob(
    workspacePath: string,
    inputPath: string,
    pattern: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const expression = globExpression(safeGlobPattern(pattern));
    const { files, root, start, truncated } = await this.walk(
      workspacePath,
      inputPath,
      options.signal,
    );
    const matches = files
      .map((file) => relative(start.path, file.path))
      .filter((path) => expression.test(path.replace(/\\/gu, '/')))
      .sort(compareCodeUnits)
      .map(
        (path) =>
          relative(root.root, resolve(start.path, path)) ||
          relative(root.root, start.path),
      );
    throwIfSearchAborted(options.signal);
    return {
      path: relative(root.root, start.path) || '.',
      files: matches,
      truncated,
    };
  }
}
