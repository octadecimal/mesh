import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  QaWorkspaceReader,
  type QaWorkspaceFileSystem,
} from './qa-workspace-reader.js';

const readerWithFileSystem = (fileSystem: Partial<QaWorkspaceFileSystem>) =>
  new QaWorkspaceReader(fileSystem);

describe('QaWorkspaceReader', () => {
  it('rejects reads, listings, and searches through an external directory link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'external secret');
      const link = join(root, 'external');
      symlinkSync(
        outside,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reader = new QaWorkspaceReader();

      await expect(
        reader.read(root, 'external/secret.txt'),
      ).rejects.toMatchObject({ code: 'qa_workspace_path_rejected' });
      await expect(reader.list(root, 'external')).rejects.toMatchObject({
        code: 'qa_workspace_path_rejected',
      });
      await expect(
        reader.search(root, 'external', 'external secret'),
      ).rejects.toMatchObject({ code: 'qa_workspace_path_rejected' });
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('keeps ordinary workspace-local reads useful', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-local-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'app.ts'), 'export const local = true;');
      const reader = new QaWorkspaceReader();

      await expect(reader.read(root, 'src/app.ts')).resolves.toMatchObject({
        path: join('src', 'app.ts'),
        content: 'export const local = true;',
        truncated: false,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('searches safely when the assigned workspace root is a directory link', async () => {
    const target = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-target-'));
    const links = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-links-'));
    const root = join(links, 'workspace');
    try {
      mkdirSync(join(target, 'src'));
      writeFileSync(join(target, 'src', 'app.ts'), 'const linked = true;');
      symlinkSync(
        target,
        root,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reader = new QaWorkspaceReader();

      await expect(reader.search(root, 'src', 'linked')).resolves.toMatchObject(
        {
          path: 'src',
          matches: [
            {
              path: join('src', 'app.ts'),
              line: 1,
              text: 'const linked = true;',
            },
          ],
        },
      );
    } finally {
      rmSync(links, { force: true, recursive: true });
      rmSync(target, { force: true, recursive: true });
    }
  });

  it('refuses a file replaced between canonical check and handle open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-swap-'));
    try {
      const source = join(root, 'app.ts');
      writeFileSync(source, 'safe source');
      let swapped = false;
      const reader = readerWithFileSystem({
        open: async (path, flags) => {
          if (!swapped) {
            swapped = true;
            writeFileSync(source, 'replacement content with a new identity');
          }
          return open(path, flags);
        },
      });

      await expect(reader.read(root, 'app.ts')).rejects.toMatchObject({
        code: 'qa_workspace_path_rejected',
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(['read', 'list', 'search'] as const)(
    'refuses an ancestor replaced by an external junction during %s',
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'mesh-qa-reader-outside-'));
      const source = join(root, 'src');
      try {
        mkdirSync(source);
        writeFileSync(join(source, 'app.ts'), 'safe source');
        writeFileSync(join(outside, 'app.ts'), 'external secret');
        let swapped = false;
        const swapAncestor = () => {
          if (swapped) return;
          swapped = true;
          rmSync(source, { force: true, recursive: true });
          symlinkSync(
            outside,
            source,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        };
        const reader = readerWithFileSystem(
          operation === 'read'
            ? {
                open: async (path, flags) => {
                  swapAncestor();
                  return open(path, flags);
                },
              }
            : {
                readdir: async (path) => {
                  swapAncestor();
                  return readdir(path, { withFileTypes: true });
                },
              },
        );

        const pending =
          operation === 'read'
            ? reader.read(root, 'src/app.ts')
            : operation === 'list'
              ? reader.list(root, 'src')
              : reader.search(root, 'src', 'external secret');
        await expect(pending).rejects.toMatchObject({
          code: 'qa_workspace_path_rejected',
        });
      } finally {
        rmSync(root, { force: true, recursive: true });
        rmSync(outside, { force: true, recursive: true });
      }
    },
  );
});
