import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QaWorkspaceReader } from './qa-workspace-reader.js';

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
});
