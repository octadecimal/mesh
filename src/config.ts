import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeshConfig } from './types.ts';

const MESH_DIR = '.mesh';
const CONFIG_FILE = 'config.json';

export function defaultConfig(repoRoot: string): MeshConfig {
  return {
    targetRepo: repoRoot,
    port: 4317,
    pm: { model: 'claude-opus-5', sessionId: null },
  };
}

/**
 * Write atomically: a crash mid-write must not truncate the config.
 * The same temp-then-rename discipline applies to ticket files in M2.
 */
export async function saveConfig(repoRoot: string, config: MeshConfig): Promise<void> {
  const dir = join(repoRoot, MESH_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, CONFIG_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function loadConfig(repoRoot: string): Promise<MeshConfig> {
  const target = join(repoRoot, MESH_DIR, CONFIG_FILE);
  const fallback = defaultConfig(repoRoot);

  let stored: Partial<MeshConfig>;
  try {
    stored = JSON.parse(await readFile(target, 'utf8')) as Partial<MeshConfig>;
  } catch {
    await saveConfig(repoRoot, fallback);
    return fallback;
  }

  return {
    targetRepo: stored.targetRepo ?? fallback.targetRepo,
    port: stored.port ?? fallback.port,
    pm: {
      model: stored.pm?.model ?? fallback.pm.model,
      sessionId: stored.pm?.sessionId ?? null,
    },
  };
}
