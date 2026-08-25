import { describe, expect, it } from 'vitest';
import { ValidationEngine } from './engine.js';
import { emptyIntent } from '../vm/intent.js';
import { testConfig } from '../test-helpers.js';

function completeCreateIntent() {
  const intent = emptyIntent('create_vm');
  intent.vm.name = 'web-01';
  intent.vm.os = { family: 'ubuntu', version: '24.04', variant: null, installation: 'master_image' };
  intent.vm.resources = { vcpus: 4, memory_mb: 8192, disk_gb: 100 };
  intent.vm.network = { bridge: null };
  return intent;
}

describe('ValidationEngine schema (Layer 1)', () => {
  const engine = new ValidationEngine(testConfig());

  it('accepts a well-formed intent', () => {
    expect(engine.validateSchema(completeCreateIntent())).toEqual([]);
  });

  it('rejects an unknown operation', () => {
    const bad = { ...completeCreateIntent(), operation: 'delete_everything' };
    expect(engine.validateSchema(bad).length).toBeGreaterThan(0);
  });

  it('rejects additional properties', () => {
    const bad = { ...completeCreateIntent(), hacked: true } as unknown;
    expect(engine.validateSchema(bad).length).toBeGreaterThan(0);
  });
});

describe('ValidationEngine create (Layers 2-3)', () => {
  const engine = new ValidationEngine(testConfig());

  it('normalizes a valid, complete config and applies default network', () => {
    const res = engine.validateCreate(completeCreateIntent());
    expect(res.ok).toBe(true);
    expect(res.normalized).toMatchObject({
      name: 'web-01',
      vcpus: 4,
      memoryMb: 8192,
      diskGb: 100,
      network: 'brforvms',
      display: 'vnc',
    });
    expect(res.warnings.some((w) => /default/i.test(w))).toBe(true);
  });

  it('reports missing required fields as incomplete', () => {
    const intent = emptyIntent('create_vm');
    intent.vm.os = { family: 'ubuntu' };
    const res = engine.validateCreate(intent);
    expect(res.status).toBe('incomplete');
    expect(res.missingFields).toContain('name');
    expect(res.missingFields).toContain('vcpus');
    expect(res.ok).toBe(false);
  });

  it('enforces policy minimums (RAM 0 is invalid)', () => {
    const intent = completeCreateIntent();
    intent.vm.resources = { vcpus: 4, memory_mb: 1, disk_gb: 100 };
    const res = engine.validateCreate(intent);
    // memory_mb 1 passes schema (>=1) but fails policy minimum 512
    expect(res.ok).toBe(false);
    expect(res.status).toBe('invalid');
    expect(res.errors.some((e) => e.field === 'memory_mb')).toBe(true);
  });

  it('enforces admin maximums', () => {
    const intent = completeCreateIntent();
    intent.vm.resources = { vcpus: 999, memory_mb: 8192, disk_gb: 100 };
    const res = engine.validateCreate(intent);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.field === 'vcpus')).toBe(true);
  });

  it('does not invent defaults for required fields', () => {
    const intent = completeCreateIntent();
    intent.vm.resources = { vcpus: null, memory_mb: 8192, disk_gb: 100 };
    const res = engine.validateCreate(intent);
    expect(res.status).toBe('incomplete');
    expect(res.missingFields).toContain('vcpus');
  });
});

describe('ValidationEngine infrastructure preconditions (Layer 3)', () => {
  it('blocks create when master_image missing in stdio mode', () => {
    const cfg = testConfig({
      mcp: { ...testConfig().mcp, mode: 'stdio', defaultMasterImage: '' },
    });
    const engine = new ValidationEngine(cfg);
    const pre = engine.checkCreatePreconditions();
    expect(pre?.ok).toBe(false);
    expect(pre?.category).toBe('missing_resource');
  });

  it('allows create in mock mode without master_image', () => {
    const cfg = testConfig({
      mcp: { ...testConfig().mcp, mode: 'mock', defaultMasterImage: '' },
    });
    const engine = new ValidationEngine(cfg);
    expect(engine.checkCreatePreconditions()).toBeNull();
  });
});
