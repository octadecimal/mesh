import {
  lstat as fsLstat,
  open as fsOpen,
  opendir as fsOpendir,
  realpath as fsRealpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const maxReadBytes = 32_000;
const maxSearchFileBytes = 128_000;
const maxSearchFiles = 500;
const maxSearchMatches = 100;
const maxSearchDirectories = 128;
const maxSearchEntries = 1_000;
const maxSearchPending = 256;

type FileSystemStat = {
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

export class QaWorkspaceSearchCancelledError extends Error {
  readonly code = 'qa_workspace_search_cancelled';

  constructor() {
    super('QA workspace search was cancelled with its owning runtime.');
    this.name = 'QaWorkspaceSearchCancelledError';
  }
}

const throwIfSearchAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new QaWorkspaceSearchCancelledError();
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

const identity = (stat: FileSystemStat) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(
    ':',
  );

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

  constructor(fileSystem: Partial<QaWorkspaceFileSystem> = {}) {
    this.fileSystem = { ...defaultFileSystem, ...fileSystem };
  }

  private async rootSnapshot(workspacePath: string): Promise<RootSnapshot> {
    const lexicalRoot = resolve(workspacePath);
    const root = await this.fileSystem.realpath(lexicalRoot);
    const rootStat = await this.fileSystem.lstat(root);
    if (!rootStat.isDirectory()) throw new QaWorkspacePathRejectedError();
    return { lexicalRoot, root };
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
    const [stat, parentStat] = await Promise.all([
      this.fileSystem.lstat(path),
      this.fileSystem.lstat(parentPath),
    ]);
    if (
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

  async read(workspacePath: string, inputPath: string) {
    const snapshot = await this.resolveBound(workspacePath, inputPath);
    return {
      path: relative(snapshot.root, snapshot.path),
      ...(await this.readSnapshot(snapshot, maxReadBytes)),
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
    throwIfSearchAborted(options.signal);
    const start = await this.resolveBound(workspacePath, inputPath);
    const root: RootSnapshot = {
      lexicalRoot: start.lexicalRoot,
      root: start.root,
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
      throwIfSearchAborted(options.signal);
      const current = pending.pop();
      if (!current) break;
      const snapshot = await this.captureBound(root, current);
      throwIfSearchAborted(options.signal);
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
        options.signal,
      );
      entriesVisited += streamed.entries.length;
      if (streamed.truncated) traversalTruncated = true;
      for (const entry of streamed.entries.reverse()) {
        throwIfSearchAborted(options.signal);
        if (entry.isSymbolicLink()) continue;
        if (pending.length >= maxSearchPending) {
          traversalTruncated = true;
          break;
        }
        pending.push(resolve(snapshot.path, entry.name));
      }
    }
    if (pending.length > 0) traversalTruncated = true;

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
      truncated:
        traversalTruncated ||
        files.length >= maxSearchFiles ||
        matches.length >= maxSearchMatches,
    };
  }
}
