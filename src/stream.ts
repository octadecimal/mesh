import type { RawEvent } from './types.ts';

/**
 * Stateful line splitter. Child stdout arrives in arbitrary chunks, so the
 * tail of an incomplete line is held until the rest arrives.
 */
export function createLineSplitter(): (chunk: string) => string[] {
  let remainder = '';
  return (chunk: string): string[] => {
    const combined = remainder + chunk;
    const parts = combined.split('\n');
    remainder = parts.pop() ?? '';
    return parts.filter((line) => line.trim().length > 0);
  };
}

/** Parse one NDJSON line. Returns null for anything unusable. */
export function parseLine(line: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.type !== 'string') return null;
  return candidate as RawEvent;
}
