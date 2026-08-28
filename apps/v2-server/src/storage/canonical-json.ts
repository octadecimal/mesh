const normalizeForJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForJson(item)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeForJson(value));
