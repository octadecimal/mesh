import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const maxReadBytes = 32_000;
const maxSearchFileBytes = 128_000;
const maxSearchFiles = 500;
const maxSearchMatches = 100;

export class QaWorkspacePathRejectedError extends Error {
  readonly code = 'qa_workspace_path_rejected';

  constructor() {
    super('QA workspace access must remain inside the assigned workspace.');
    this.name = 'QaWorkspacePathRejectedError';
  }
}

const within = (root: string, candidate: string) => {
  const child = relative(root, candidate);
  return (
    child !== '..' &&
    !child.startsWith('../') &&
    !child.startsWith('..\\') &&
    !isAbsolute(child)
  );
};

const relativeInput = (candidate: string) => {
  const normalized = candidate.replace(/\\/g, '/');
  if (isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) {
    throw new QaWorkspacePathRejectedError();
  }
  return normalized;
};

const readBounded = async (path: string, limit: number) => {
  const handle = await open(path, 'r');
  try {
    const output = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(output, 0, output.length, 0);
    return {
      content: output.subarray(0, Math.min(bytesRead, limit)).toString('utf8'),
      truncated: bytesRead > limit,
    };
  } finally {
    await handle.close();
  }
};

export class QaWorkspaceReader {
  private async resolveBound(workspacePath: string, inputPath: string) {
    const lexicalRoot = resolve(workspacePath);
    const lexicalCandidate = resolve(lexicalRoot, relativeInput(inputPath));
    if (!within(lexicalRoot, lexicalCandidate)) {
      throw new QaWorkspacePathRejectedError();
    }
    const root = await realpath(lexicalRoot);
    const path = await realpath(lexicalCandidate);
    if (!within(root, path)) throw new QaWorkspacePathRejectedError();
    return { root, path };
  }

  async read(workspacePath: string, inputPath: string) {
    const { root, path } = await this.resolveBound(workspacePath, inputPath);
    const info = await lstat(path);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new QaWorkspacePathRejectedError();
    }
    return {
      path: relative(root, path),
      ...(await readBounded(path, maxReadBytes)),
    };
  }

  async list(workspacePath: string, inputPath: string) {
    const { root, path } = await this.resolveBound(workspacePath, inputPath);
    const entries = await readdir(path, { withFileTypes: true });
    return {
      path: relative(root, path) || '.',
      entries: entries.slice(0, maxSearchFiles).map((entry) => ({
        path: relative(root, resolve(path, entry.name)),
        type: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symbolic_link'
              : 'other',
      })),
      truncated: entries.length > maxSearchFiles,
    };
  }

  async search(workspacePath: string, inputPath: string, query: string) {
    const { root, path: start } = await this.resolveBound(
      workspacePath,
      inputPath,
    );
    const pending = [start];
    const files: string[] = [];
    while (pending.length > 0 && files.length < maxSearchFiles) {
      const current = pending.pop();
      if (!current) break;
      const info = await lstat(current);
      if (info.isSymbolicLink()) continue;
      if (info.isFile()) {
        files.push(current);
        continue;
      }
      if (!info.isDirectory()) continue;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.reverse()) {
        if (entry.isSymbolicLink()) continue;
        pending.push(resolve(current, entry.name));
      }
    }

    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files) {
      const read = await readBounded(file, maxSearchFileBytes);
      if (read.content.includes('\0')) continue;
      for (const [index, line] of read.content.split(/\r?\n/).entries()) {
        if (!line.includes(query)) continue;
        matches.push({
          path: relative(root, file),
          line: index + 1,
          text: line,
        });
        if (matches.length >= maxSearchMatches) break;
      }
      if (matches.length >= maxSearchMatches) break;
    }
    return {
      path: relative(root, start) || '.',
      matches,
      truncated:
        files.length >= maxSearchFiles || matches.length >= maxSearchMatches,
    };
  }
}
