import { resolve } from 'node:path';

const apiBillingOverrideVariables = ['ANTHROPIC_API_KEY'] as const;

export type BillingOverrideVariable = (typeof apiBillingOverrideVariables)[number];

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
  host: '127.0.0.1';
  port: number;
  baseDirectory: string;
  databasePath: string;
}

export const loadServerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  currentDirectory = process.cwd(),
): ServerConfig => {
  const port = Number(environment.MESH_PORT ?? '3737');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MESH_PORT must be an integer between 1 and 65535');
  }
  const baseDirectory = resolve(environment.MESH_WORKSPACE_ROOT ?? currentDirectory);
  return {
    host: '127.0.0.1',
    port,
    baseDirectory,
    databasePath: resolve(
      baseDirectory,
      environment.MESH_DATABASE_PATH ?? '.mesh/session-platform.sqlite',
    ),
  };
};
