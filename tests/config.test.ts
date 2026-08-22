import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.ts';

test('loadConfig creates a default config file when none exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const config = await loadConfig(dir);

  assert.equal(config.targetRepo, dir);
  assert.equal(config.port, 4317);
  assert.equal(config.pm.sessionId, null);
  assert.equal(typeof config.pm.model, 'string');

  const onDisk = JSON.parse(await readFile(join(dir, '.mesh', 'config.json'), 'utf8'));
  assert.equal(onDisk.port, 4317);
});

test('loadConfig returns the persisted config on a second call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const first = await loadConfig(dir);
  first.pm.sessionId = 'abc-123';
  await saveConfig(dir, first);

  const second = await loadConfig(dir);
  assert.equal(second.pm.sessionId, 'abc-123');
});

test('loadConfig fills in keys missing from an older config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  await saveConfig(dir, { targetRepo: dir, port: 9999, pm: { model: 'claude-sonnet-5' } } as never);

  const config = await loadConfig(dir);
  assert.equal(config.port, 9999);
  assert.equal(config.pm.sessionId, null);
});

test('loadConfig rejects corrupt config and preserves the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const meshDir = join(dir, '.mesh');
  const configPath = join(meshDir, 'config.json');
  const corruptJson = '{ "invalid": json, "missing": "quotes" }';

  await mkdir(meshDir, { recursive: true });
  await writeFile(configPath, corruptJson, 'utf8');

  await assert.rejects(
    () => loadConfig(dir),
    (err) => err instanceof Error && err.message.includes('Failed to parse config')
  );

  const preserved = await readFile(configPath, 'utf8');
  assert.equal(preserved, corruptJson);
});
