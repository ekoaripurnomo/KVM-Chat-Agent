import Ajv, { type ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { NormalizedConfig, VmIntent } from '../vm/intent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src/validation -> repo root schemas/
const SCHEMA_PATH = resolve(__dirname, '../../../schemas/vm-intent.schema.json');

export interface ValidationIssue {
  field?: string;
  message: string;
}

export type ValidationCategory =
  | 'user'
  | 'missing_resource'
  | 'infrastructure'
  | 'mcp'
  | 'internal';

export interface ValidationResult {
  ok: boolean;
  status: 'valid' | 'invalid' | 'incomplete';
  category?: ValidationCategory;
  missingFields: string[];
  errors: ValidationIssue[];
  warnings: string[];
  /** present only when ok === true and operation === create_vm */
  normalized?: NormalizedConfig;
}

const REQUIRED_CREATE_FIELDS = [
  'name',
  'os',
  'vcpus',
  'memory_mb',
  'disk_gb',
] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

let cachedValidator: ValidateFunction | null = null;

function schemaValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/**
 * Deterministic validation engine (spec §9).
 * Layer 1 schema, Layer 2 policy, Layer 3 infrastructure, Layer 4 mcp args.
 * The LLM output is treated as untrusted and re-validated here.
 */
export class ValidationEngine {
  constructor(private readonly cfg: AppConfig) {}

  /** Layer 1: JSON Schema validation of the raw intent object. */
  validateSchema(intent: unknown): ValidationIssue[] {
    const validate = schemaValidator();
    const ok = validate(intent);
    if (ok) return [];
    return (validate.errors ?? []).map((e) => ({
      field: e.instancePath || e.schemaPath,
      message: `${e.instancePath || 'intent'} ${e.message ?? 'is invalid'}`,
    }));
  }

  /**
   * Full validation for a create_vm intent. Returns the normalized config on
   * success. Applies admin-configured defaults only (never invented values).
   */
  validateCreate(intent: VmIntent): ValidationResult {
    const errors: ValidationIssue[] = [];
    const warnings: string[] = [...(intent.warnings ?? [])];

    // Layer 1 - schema
    const schemaErrors = this.validateSchema(intent);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        status: 'invalid',
        category: 'user',
        missingFields: [],
        errors: schemaErrors,
        warnings,
      };
    }

    const res = intent.vm.resources ?? {};
    const os = intent.vm.os ?? {};

    // Missing-field detection (spec §8)
    const missing: string[] = [];
    if (!intent.vm.name) missing.push('name');
    if (!os.family) missing.push('os');
    if (res.vcpus == null) missing.push('vcpus');
    if (res.memory_mb == null) missing.push('memory_mb');
    if (res.disk_gb == null) missing.push('disk_gb');

    if (missing.length > 0) {
      return {
        ok: false,
        status: 'incomplete',
        category: 'user',
        missingFields: missing,
        errors,
        warnings,
      };
    }

    // Layer 2 - policy validation
    const { policy } = this.cfg;
    const vcpus = res.vcpus as number;
    const memoryMb = res.memory_mb as number;
    const diskGb = res.disk_gb as number;
    const name = intent.vm.name as string;

    if (!NAME_RE.test(name)) {
      errors.push({
        field: 'name',
        message:
          'Nama VM tidak valid. Gunakan huruf, angka, titik, garis bawah, atau tanda hubung (maks 63 karakter).',
      });
    }
    if (vcpus < policy.minVcpu) {
      errors.push({ field: 'vcpus', message: `vCPU minimal ${policy.minVcpu}.` });
    }
    if (vcpus > policy.maxVcpu) {
      errors.push({ field: 'vcpus', message: `vCPU maksimal ${policy.maxVcpu}.` });
    }
    if (memoryMb < policy.minMemoryMb) {
      errors.push({
        field: 'memory_mb',
        message: `RAM minimal ${policy.minMemoryMb} MB.`,
      });
    }
    if (memoryMb > policy.maxMemoryMb) {
      errors.push({
        field: 'memory_mb',
        message: `RAM maksimal ${policy.maxMemoryMb} MB.`,
      });
    }
    if (diskGb < policy.minDiskGb) {
      errors.push({
        field: 'disk_gb',
        message: `Disk minimal ${policy.minDiskGb} GB.`,
      });
    }
    if (diskGb > policy.maxDiskGb) {
      errors.push({
        field: 'disk_gb',
        message: `Disk maksimal ${policy.maxDiskGb} GB.`,
      });
    }

    if (errors.length > 0) {
      return {
        ok: false,
        status: 'invalid',
        category: 'user',
        missingFields: [],
        errors,
        warnings,
      };
    }

    // Apply admin-configured defaults (only for optional fields)
    const network = intent.vm.network?.bridge ?? this.cfg.defaults.network;
    const variant = os.variant ?? this.cfg.defaults.osVariant;
    const display = intent.vm.display?.type ?? this.cfg.defaults.display;

    if (!intent.vm.network?.bridge) {
      warnings.push(`Menggunakan network default: ${network}.`);
    }

    const normalized: NormalizedConfig = {
      name,
      osFamily: os.family as string,
      osVersion: os.version ?? null,
      osVariant: variant,
      vcpus,
      memoryMb,
      diskGb,
      network,
      display,
    };

    return {
      ok: true,
      status: 'valid',
      missingFields: [],
      errors: [],
      warnings,
      normalized,
    };
  }

  /**
   * Layer 3 - infrastructure precondition check performed before execution.
   * For the real MCP tool, create_vm requires a host-side master_image which
   * the LLM must never invent. If not configured, fail explicitly (Rule 11).
   */
  checkCreatePreconditions(): ValidationResult | null {
    if (this.cfg.mcp.mode === 'stdio' && !this.cfg.mcp.defaultMasterImage) {
      return {
        ok: false,
        status: 'invalid',
        category: 'missing_resource',
        missingFields: ['master_image'],
        errors: [
          {
            field: 'master_image',
            message:
              'Master image belum dikonfigurasi pada server (MCP_DEFAULT_MASTER_IMAGE). VM belum dibuat.',
          },
        ],
        warnings: [],
      };
    }
    return null;
  }
}
