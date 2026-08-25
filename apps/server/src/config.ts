import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

const apiBillingOverrideVariables = ['ANTHROPIC_API_KEY'] as const;

export type BillingOverrideVariable =
  (typeof apiBillingOverrideVariables)[number];

export interface BillingConflict {
  variable: BillingOverrideVariable;
}

export const detectBillingOverrides = (
  environment: Readonly<Record<string, string | undefined>>,
): BillingConflict[] =>
  apiBillingOverrideVariables
    .filter((variable) => environment[variable]?.trim())
    .map((variable) => ({ variable }));

export interface ServerConfig {
  host: string;
  port: number;
  baseDirectory: string;
  databasePath: string;
  developmentOrigin?: string;
  webRoot?: string;
}

export const isLoopbackAddress = (host: string): boolean => {
  const normalized =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return (
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.split('.')[0] === '127')
  );
};

const readDevelopmentOrigin = (
  value: string | undefined,
): string | undefined => {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      !isLoopbackAddress(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('MESH_DEV_ORIGIN must be an exact loopback HTTP origin');
  }
};

export const loadServerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  currentDirectory = process.cwd(),
): ServerConfig => {
  const host = environment.MESH_HOST?.trim() || '127.0.0.1';
  if (!isLoopbackAddress(host)) {
    throw new Error('MESH_HOST must be a loopback address');
  }
  const port = Number(environment.MESH_PORT ?? '3737');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MESH_PORT must be an integer between 1 and 65535');
  }
  const baseDirectory = resolve(
    environment.MESH_WORKSPACE_ROOT ?? currentDirectory,
  );
  const dataDirectory = resolve(
    environment.MESH_DATA_DIR ?? join(homedir(), '.mesh-session-platform'),
  );
  return {
    host,
    port,
    baseDirectory,
    databasePath: resolve(
      dataDirectory,
      environment.MESH_DATABASE_PATH ?? 'session-platform.sqlite',
    ),
    developmentOrigin:
      environment.NODE_ENV === 'production'
        ? undefined
        : readDevelopmentOrigin(
            environment.MESH_DEV_ORIGIN ??
              (environment.NODE_ENV === 'development'
                ? 'http://127.0.0.1:4200'
                : undefined),
          ),
    webRoot:
      environment.NODE_ENV === 'production'
        ? resolve(currentDirectory, 'dist/apps/web')
        : undefined,
  };
};
