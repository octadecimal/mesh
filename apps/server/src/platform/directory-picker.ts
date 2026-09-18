import { spawn } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';

const powershellExecutable =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const script = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = 'Mesh: choose a folder'",
  '$dialog.SelectedPath = $env:MESH_DIRECTORY_PICKER_ROOT',
  '$dialog.ShowNewFolderButton = $false',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
].join('; ');

export class DirectoryPickerError extends Error {
  constructor(
    readonly code:
      | 'directory_picker_unavailable'
      | 'directory_picker_busy'
      | 'directory_picker_invalid_path',
    message: string,
  ) {
    super(message);
    this.name = 'DirectoryPickerError';
  }
}

export interface DirectoryPickerRunner {
  run(workspaceRoot: string): Promise<string | null>;
}

export interface DirectoryPickerFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface DirectoryPickerOptions {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  runner?: DirectoryPickerRunner;
  fs?: DirectoryPickerFileSystem;
  path?: Pick<typeof nodePath, 'isAbsolute' | 'relative'>;
}

class PowerShellDirectoryPickerRunner implements DirectoryPickerRunner {
  async run(workspaceRoot: string): Promise<string | null> {
    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(
        powershellExecutable,
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, MESH_DIRECTORY_PICKER_ROOT: workspaceRoot },
        },
      );
      const output: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectResult(error);
        else resolveResult(result ?? null);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(
          new DirectoryPickerError(
            'directory_picker_unavailable',
            'The folder picker timed out. Enter the directory manually.',
          ),
        );
      }, 120_000);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 4096) {
          child.kill();
          finish(
            new DirectoryPickerError(
              'directory_picker_unavailable',
              'The folder picker returned too much output. Enter the directory manually.',
            ),
          );
          return;
        }
        output.push(chunk);
      });
      child.once('error', () =>
        finish(
          new DirectoryPickerError(
            'directory_picker_unavailable',
            'The Windows folder picker is unavailable. Enter the directory manually.',
          ),
        ),
      );
      child.once('close', (code) => {
        if (code !== 0) {
          finish(
            new DirectoryPickerError(
              'directory_picker_unavailable',
              'The Windows folder picker could not open. Enter the directory manually.',
            ),
          );
          return;
        }
        const selected = Buffer.concat(output).toString('utf8').trim();
        finish(undefined, selected || null);
      });
    });
  }
}

const contains = (
  root: string,
  candidate: string,
  path: NonNullable<DirectoryPickerOptions['path']>,
) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !relative.startsWith('../') &&
      !relative.startsWith('..\\') &&
      !path.isAbsolute(relative))
  );
};

export class DirectoryPicker {
  private active?: Promise<string | null>;
  private readonly platform: NodeJS.Platform;
  private readonly runner: DirectoryPickerRunner;
  private readonly fs: DirectoryPickerFileSystem;
  private readonly path: DirectoryPickerOptions['path'];

  constructor(private readonly options: DirectoryPickerOptions) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new PowerShellDirectoryPickerRunner();
    this.fs = options.fs ?? nodeFs;
    this.path = options.path;
  }

  select(): Promise<string | null> {
    if (this.active) {
      throw new DirectoryPickerError(
        'directory_picker_busy',
        'A folder picker is already open.',
      );
    }
    const active = this.selectOne().finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active;
  }

  private async selectOne(): Promise<string | null> {
    if (this.platform !== 'win32') {
      throw new DirectoryPickerError(
        'directory_picker_unavailable',
        'The native folder picker is available on Windows only. Enter the directory manually.',
      );
    }
    try {
      const root = await this.fs.realpath(this.options.workspaceRoot);
      const selected = await this.runner.run(root);
      if (selected === null) return null;
      const canonical = await this.fs.realpath(selected);
      if (
        !this.pathOrNode().isAbsolute(canonical) ||
        !contains(root, canonical, this.pathOrNode()) ||
        !(await this.fs.stat(canonical)).isDirectory()
      ) {
        throw new DirectoryPickerError(
          'directory_picker_invalid_path',
          'The selected folder is outside the configured workspace. Choose a folder inside it.',
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error;
      throw new DirectoryPickerError(
        'directory_picker_unavailable',
        'The folder picker could not verify the selected directory. Enter the directory manually.',
      );
    }
  }

  private pathOrNode() {
    return this.path ?? (this.platform === 'win32' ? nodePath.win32 : nodePath);
  }
}
