import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks secret-looking keys recursively', () => {
    const input = {
      api_key: 'sk-123',
      nested: { password: 'hunter2', vcpus: 4 },
      list: [{ token: 'abc' }, { name: 'web-01' }],
    };
    const out = redact(input);
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.nested.password).toBe('[REDACTED]');
    expect(out.nested.vcpus).toBe(4);
    expect(out.list[0].token).toBe('[REDACTED]');
    expect(out.list[1].name).toBe('web-01');
  });

  it('leaves non-secret data untouched', () => {
    expect(redact({ name: 'x', memory: 8192 })).toEqual({ name: 'x', memory: 8192 });
  });
});
