import { spawn } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';

const powershellExecutable =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const script = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog
{
    [PreserveSig]
    int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
    void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
    void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem folder);
    void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    void AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem item, uint location);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
}

[ComImport]
[Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem
{
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
    void GetDisplayName(uint format, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare([MarshalAs(UnmanagedType.Interface)] IShellItem other, uint hint, out int order);
}

public static class NativeFolderPicker
{
    private static readonly Guid FileOpenDialogId =
        new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    private static readonly Guid ShellItemId =
        new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    private const uint NoChangeDirectory = 0x8;
    private const uint PickFolders = 0x20;
    private const uint ForceFileSystem = 0x40;
    private const uint PathMustExist = 0x800;
    private const uint FileSystemPath = 0x80058000;
    private const int Cancelled = unchecked((int)0x800704C7);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Select(string root, IntPtr owner)
    {
        IFileDialog dialog = null;
        IShellItem folder = null;
        IShellItem result = null;
        try
        {
            dialog = (IFileDialog)Activator.CreateInstance(
                Type.GetTypeFromCLSID(FileOpenDialogId));
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(
                options |
                NoChangeDirectory |
                PickFolders |
                ForceFileSystem |
                PathMustExist);
            dialog.SetTitle("Mesh: choose a folder");

            var shellItemId = ShellItemId;
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(
                root,
                IntPtr.Zero,
                ref shellItemId,
                out folder));
            dialog.SetFolder(folder);

            var showResult = dialog.Show(owner);
            if (showResult == Cancelled) return null;
            Marshal.ThrowExceptionForHR(showResult);

            dialog.GetResult(out result);
            IntPtr path;
            result.GetDisplayName(FileSystemPath, out path);
            try
            {
                return Marshal.PtrToStringUni(path);
            }
            finally
            {
                Marshal.FreeCoTaskMem(path);
            }
        }
        finally
        {
            if (result != null) Marshal.ReleaseComObject(result);
            if (folder != null) Marshal.ReleaseComObject(folder);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$owner = New-Object System.Windows.Forms.Form
$owner.Opacity = 0
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
try {
  $owner.Show()
  # WinForms applies the native topmost style only after the hidden process creates the handle.
  $owner.TopMost = $true
  $selected = [NativeFolderPicker]::Select(
    $env:MESH_DIRECTORY_PICKER_ROOT,
    $owner.Handle)
  if ($null -ne $selected) { [Console]::Out.Write($selected) }
} finally {
  $owner.Close()
  $owner.Dispose()
}`;

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
