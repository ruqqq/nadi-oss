/** Remove one provider's namespace from a providerOptions/providerMetadata
 *  record. Returns `undefined` when that was the only key, so callers can
 *  delete the field rather than leave an empty object behind. */
export function stripProviderEntry(value: unknown, provider: string): unknown {
  if (!isRecord(value) || !(provider in value)) return value;
  const next = { ...value };
  delete next[provider];
  return Object.keys(next).length === 0 ? undefined : next;
}

export function assignOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
