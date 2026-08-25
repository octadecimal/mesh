import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        shell: false,
        signal: options.signal,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (exitCode) => {
        resolve({ exitCode: exitCode ?? -1, stdout, stderr });
      });
    });
  }
}
