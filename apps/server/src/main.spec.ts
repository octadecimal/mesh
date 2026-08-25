import { relative, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadServerConfig } from './config.js';
import { FakeClaudeSessionDriver } from './claude/fake-driver.js';
import {
  createProcessLifecycle,
  originFromAddress,
  selectClaudeDriver,
} from './main.js';

describe('server configuration', () => {
  it('permits fake-driver injection only in explicit test configuration', () => {
    const fakeDriver = new FakeClaudeSessionDriver();
    const createSdkDriver = vi.fn(() => new FakeClaudeSessionDriver());

    expect(
      selectClaudeDriver([], createSdkDriver, fakeDriver, {
        NODE_ENV: 'test',
      }),
    ).toBe(fakeDriver);
    expect(createSdkDriver).not.toHaveBeenCalled();
    expect(() =>
      selectClaudeDriver([], createSdkDriver, fakeDriver, {
        NODE_ENV: 'production',
      }),
    ).toThrow('Fake Claude driver is restricted to test configuration');
  });

  it('permits an ephemeral port only in explicit test configuration', () => {
    expect(loadServerConfig({ NODE_ENV: 'test', MESH_PORT: '0' }).port).toBe(0);
    expect(() =>
      loadServerConfig({ NODE_ENV: 'production', MESH_PORT: '0' }),
    ).toThrow('MESH_PORT must be an integer between 1 and 65535');
  });

  it('defaults to loopback and keeps runtime data outside the repository', () => {
    const repository = resolve('C:/code/mesh');
    const config = loadServerConfig({}, repository);

    expect(config.host).toBe('127.0.0.1');
    expect(relative(repository, config.databasePath).startsWith('..')).toBe(
      true,
    );
  });

  it.each(['0.0.0.0', '192.168.1.5', 'mesh.local', 'localhost', '127.999.0.1'])(
    'rejects non-loopback host %s',
    (host) => {
      expect(() => loadServerConfig({ MESH_HOST: host })).toThrow(
        'MESH_HOST must be a loopback address',
      );
    },
  );

  it('derives the exact browser origin from the actual listening address', () => {
    expect(
      originFromAddress({ address: '127.0.0.1', family: 'IPv4', port: 43210 }),
    ).toBe('http://127.0.0.1:43210');
    expect(
      originFromAddress({ address: '::1', family: 'IPv6', port: 43210 }),
    ).toBe('http://[::1]:43210');
    expect(() =>
      originFromAddress({ address: '0.0.0.0', family: 'IPv4', port: 43210 }),
    ).toThrow('Server listened on a non-loopback address');
  });

  it('allows only the explicit loopback Vite origin in development', () => {
    expect(
      loadServerConfig({ NODE_ENV: 'development' }).developmentOrigin,
    ).toBe('http://127.0.0.1:4200');
    expect(() =>
      loadServerConfig({ MESH_DEV_ORIGIN: 'http://192.168.1.5:4200' }),
    ).toThrow('MESH_DEV_ORIGIN must be an exact loopback HTTP origin');
    expect(
      loadServerConfig({
        NODE_ENV: 'production',
        MESH_DEV_ORIGIN: 'http://127.0.0.1:4200',
      }).developmentOrigin,
    ).toBeUndefined();
  });
});

describe('process lifecycle', () => {
  it('stops commands/upgrades before bounded runtime interruption and socket close', async () => {
    const order: string[] = [];
    const lifecycle = createProcessLifecycle({
      stopAccepting: () => order.push('stop'),
      shutdownRuntime: async () => {
        order.push('runtime');
      },
      closeSockets: async () => {
        order.push('sockets');
      },
      auditStatus: () => 'available',
      signalFailure: vi.fn(),
    });

    await lifecycle.shutdown();

    expect(order).toEqual(['stop', 'runtime', 'sockets']);
  });

  it('closes remaining resources and signals failure when persistence is untrusted', async () => {
    const closeSockets = vi.fn(async () => undefined);
    const signalFailure = vi.fn();
    const lifecycle = createProcessLifecycle({
      stopAccepting: vi.fn(),
      shutdownRuntime: async () => undefined,
      closeSockets,
      auditStatus: () => 'audit_unavailable',
      signalFailure,
    });

    await lifecycle.shutdown();

    expect(closeSockets).toHaveBeenCalledOnce();
    expect(signalFailure).toHaveBeenCalledWith(1);
  });
});
