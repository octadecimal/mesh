import { isAbsolute, join, resolve } from 'node:path';

export type V2ServerConfig = {
  host: '127.0.0.1' | '::1';
  port: number;
  workspaceRoot: string;
  databasePath: string;
  developmentOrigin?: string;
  webRoot?: string;
  testFakeHoldAfterAdapterCursor?: number;
  testFakePmScenario?: 'todo';
};

export type V2ConfigErrorCode =
  | 'invalid_v2_host'
  | 'invalid_v2_origin'
  | 'invalid_v2_path'
  | 'invalid_v2_port'
  | 'invalid_v2_test_option';

export class V2ConfigError extends Error {
  constructor(
    readonly code: V2ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'V2ConfigError';
  }
}

const absolute = (value: string, name: string): string => {
  if (!isAbsolute(value)) {
    throw new V2ConfigError('invalid_v2_path', `${name} must be absolute`);
  }
  return resolve(value);
};

const loopbackOrigin = (value: string): string => {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new V2ConfigError('invalid_v2_origin', 'V2 origin is invalid');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.origin !== value
  ) {
    throw new V2ConfigError(
      'invalid_v2_origin',
      'V2 origin must be an exact loopback HTTP origin',
    );
  }
  return origin.origin;
};

const integer = (value: string, code: V2ConfigErrorCode, name: string) => {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new V2ConfigError(code, `${name} must be an integer`);
  }
  return Number(value);
};

export const loadV2ServerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  defaultRoot = process.cwd(),
): V2ServerConfig => {
  const host = environment.MESH_V2_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new V2ConfigError(
      'invalid_v2_host',
      'V2 host must be a loopback address',
    );
  }

  const port = integer(
    environment.MESH_V2_PORT ?? '3838',
    'invalid_v2_port',
    'V2 port',
  );
  if (port > 65_535 || (port === 0 && environment.NODE_ENV !== 'test')) {
    throw new V2ConfigError('invalid_v2_port', 'V2 port is outside its mode');
  }

  const workspaceRoot = absolute(
    environment.MESH_V2_WORKSPACE_ROOT ?? defaultRoot,
    'V2 workspace root',
  );
  const dataDirectory = absolute(
    environment.MESH_V2_DATA_DIR ?? join(defaultRoot, '.mesh', 'v2'),
    'V2 data directory',
  );
  const databasePath = absolute(
    environment.MESH_V2_DATABASE_PATH ?? join(dataDirectory, 'mesh-v2.sqlite'),
    'V2 database path',
  );

  const fakeCursor = environment.MESH_V2_FAKE_HOLD_AFTER_CURSOR;
  if (fakeCursor !== undefined && environment.NODE_ENV !== 'test') {
    throw new V2ConfigError(
      'invalid_v2_test_option',
      'Fake cursor hold is test-only',
    );
  }
  const testFakeHoldAfterAdapterCursor =
    fakeCursor === undefined
      ? undefined
      : integer(fakeCursor, 'invalid_v2_test_option', 'Fake cursor hold');
  if (
    testFakeHoldAfterAdapterCursor !== undefined &&
    testFakeHoldAfterAdapterCursor > 6
  ) {
    throw new V2ConfigError(
      'invalid_v2_test_option',
      'Fake cursor hold is outside the fake script',
    );
  }
  const fakePmScenario = environment.MESH_V2_TEST_FAKE_PM_SCENARIO;
  if (
    fakePmScenario !== undefined &&
    (environment.NODE_ENV !== 'test' || fakePmScenario !== 'todo')
  ) {
    throw new V2ConfigError(
      'invalid_v2_test_option',
      'Fake PM scenario must be todo in the test environment',
    );
  }
  const developmentOrigin =
    environment.MESH_V2_DEV_ORIGIN ??
    (environment.NODE_ENV === 'development'
      ? 'http://127.0.0.1:4300'
      : undefined);

  return {
    host,
    port,
    workspaceRoot,
    databasePath,
    ...(developmentOrigin === undefined
      ? {}
      : { developmentOrigin: loopbackOrigin(developmentOrigin) }),
    ...(environment.MESH_V2_WEB_ROOT === undefined
      ? {}
      : {
          webRoot: absolute(environment.MESH_V2_WEB_ROOT, 'V2 web root'),
        }),
    ...(testFakeHoldAfterAdapterCursor === undefined
      ? {}
      : { testFakeHoldAfterAdapterCursor }),
    ...(fakePmScenario === undefined
      ? {}
      : { testFakePmScenario: fakePmScenario }),
  };
};
