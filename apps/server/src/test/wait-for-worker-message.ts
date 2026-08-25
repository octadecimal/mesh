import type { Worker } from 'node:worker_threads';

const defaultTimeoutMs = 5_000;

export const waitForWorkerMessage = <Message = unknown>(
  worker: Worker,
  timeoutMs = defaultTimeoutMs,
): Promise<Message> =>
  new Promise<Message>((resolve, reject) => {
    let settled = false;
    const timeoutRef: { current?: NodeJS.Timeout } = {};

    const cleanup = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onMessage = (message: Message) => finish(() => resolve(message));
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) =>
      finish(() =>
        reject(
          new Error(`Worker exited with code ${code} before sending a message`),
        ),
      );

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    timeoutRef.current = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Timed out waiting for worker message after ${timeoutMs}ms`,
            ),
          ),
        ),
      timeoutMs,
    );
  });
