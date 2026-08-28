import {
  v2CommandEnvelopeSchema,
  v2CommandResultSchema,
  v2ErrorCodeSchema,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  type V2CommandEnvelope,
  type V2CommandResult,
  type V2ErrorCode,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';
import { z } from 'zod';

export interface V2Api {
  systemSnapshot(signal?: AbortSignal): Promise<V2SystemSnapshot>;
  projectSnapshot(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<V2ProjectSnapshot>;
  command(
    envelope: V2CommandEnvelope,
    signal?: AbortSignal,
  ): Promise<V2CommandResult>;
}

export class V2HttpError extends Error {
  readonly name = 'V2HttpError';

  constructor(
    readonly status: number,
    readonly code: V2ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: v2ErrorCodeSchema,
    message: z.string().trim().min(1).max(4096),
  }),
});

export type V2ApiOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
};

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/$/, '')}${path}`;

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const request = async <T>(
  fetcher: typeof fetch,
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
) => {
  const response = await fetcher(url, init);
  const body = await parseJson(response);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    if (parsed.success) {
      throw new V2HttpError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
      );
    }
    throw new V2HttpError(response.status, 'internal_error', 'Request failed.');
  }
  return schema.parse(body);
};

export const createV2Api = (options: V2ApiOptions = {}): V2Api => {
  const baseUrl = options.baseUrl ?? '';
  const fetcher = options.fetcher ?? fetch;

  return {
    systemSnapshot: (signal) =>
      request(
        fetcher,
        joinUrl(baseUrl, '/api/v2/snapshot'),
        v2SystemSnapshotSchema,
        { signal },
      ),
    projectSnapshot: (projectId, signal) =>
      request(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v2/projects/${encodeURIComponent(projectId)}/snapshot`,
        ),
        v2ProjectSnapshotSchema,
        { signal },
      ),
    command: (envelope, signal) => {
      const body = v2CommandEnvelopeSchema.parse(envelope);
      return request(
        fetcher,
        joinUrl(baseUrl, '/api/v2/commands'),
        v2CommandResultSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
    },
  };
};
