const SECRET_KEY_RE =
  /(api[_-]?key|authorization|password|passwd|secret|token|private[_-]?key|ssh[_-]?key|credential)/i;

/**
 * Recursively redact values whose keys look secret. Used before writing audit
 * logs so credentials are never persisted (spec §21 / §6.2).
 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
