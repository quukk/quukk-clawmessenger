function stringLeaves(value: unknown, seen: Set<object>, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') output.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      stringLeaves(descriptor.value, seen, output);
    }
  }
}

export function expectNoSentinels(material: unknown, sentinels: readonly string[]): void {
  const leaves: string[] = [];
  stringLeaves(material, new Set(), leaves);
  for (const [sentinelIndex, sentinel] of sentinels.entries()) {
    if (sentinel.length === 0) throw new Error(`empty_redaction_sentinel:${sentinelIndex}`);
    if (leaves.some((leaf) => leaf.includes(sentinel))) {
      throw new Error(`e2e_redaction_leak:${sentinelIndex}`);
    }
  }
}

export function parseJsonLogRecords(text: string): unknown[] {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (error) {
      throw new Error(`invalid_e2e_log_json:${index + 1}`, { cause: error });
    }
  });
}
