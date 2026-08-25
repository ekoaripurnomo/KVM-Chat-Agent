/**
 * Canonical internal VM intent. Mirrors schemas/vm-intent.schema.json.
 * This object is INTERNAL and never shown raw to normal users.
 */
export type VmOperation =
  | 'create_vm'
  | 'list_vms'
  | 'start_vm'
  | 'stop_vm'
  | 'reboot_vm'
  | 'get_vm';

export type ValidationStatus = 'valid' | 'invalid' | 'incomplete' | 'unknown';

export interface VmIntent {
  operation: VmOperation;
  vm: {
    name?: string | null;
    os?: {
      family?: string | null;
      version?: string | null;
      variant?: string | null;
      installation?: 'iso' | 'master_image' | null;
    };
    resources?: {
      vcpus?: number | null;
      memory_mb?: number | null;
      disk_gb?: number | null;
    };
    storage?: {
      disk_path?: string | null;
      disk_format?: 'qcow2' | null;
      master_image?: string | null;
    };
    network?: {
      bridge?: string | null;
    };
    display?: {
      type?: 'vnc' | null;
    };
  };
  missing_fields: string[];
  warnings: string[];
  validation_status: ValidationStatus;
  requires_confirmation: boolean;
}

/**
 * Fully-resolved, validated configuration used to build MCP arguments.
 * Produced only after successful validation. No nulls for required fields.
 */
export interface NormalizedConfig {
  name: string;
  osFamily: string;
  osVersion: string | null;
  osVariant: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  network: string;
  display: string;
}

export function emptyIntent(operation: VmOperation = 'create_vm'): VmIntent {
  return {
    operation,
    vm: {
      name: null,
      os: { family: null, version: null, variant: null, installation: null },
      resources: { vcpus: null, memory_mb: null, disk_gb: null },
      storage: { disk_path: null, disk_format: 'qcow2', master_image: null },
      network: { bridge: null },
      display: { type: 'vnc' },
    },
    missing_fields: [],
    warnings: [],
    validation_status: 'unknown',
    requires_confirmation: true,
  };
}

/** Human-readable one-line OS label for proposals. */
export function osLabel(intent: VmIntent): string {
  const os = intent.vm.os ?? {};
  const family = (os.family ?? '').trim();
  const version = (os.version ?? '').trim();
  if (!family && !version) return 'Unspecified OS';
  const nice = family
    ? family.charAt(0).toUpperCase() + family.slice(1)
    : '';
  return [nice, version].filter(Boolean).join(' ').trim() || 'Unspecified OS';
}
