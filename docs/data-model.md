# Data Model

## Canonical VM Intent

Defined by `schemas/vm-intent.schema.json` and mirrored by the TypeScript type
`VmIntent` in `backend/src/vm/intent.ts`. It is an **internal** object and is
never shown raw to normal users.

```
operation           create_vm | list_vms | start_vm | stop_vm | reboot_vm | get_vm
vm.name             string | null   (pattern ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$)
vm.os.family        string | null
vm.os.version       string | null
vm.os.variant       string | null
vm.os.installation  iso | master_image | null
vm.resources.vcpus      int | null   (>= 1)
vm.resources.memory_mb  int | null   (>= 1)
vm.resources.disk_gb    int | null   (>= 1)
vm.storage.disk_path    string | null
vm.storage.disk_format  qcow2 | null
vm.storage.master_image string | null
vm.network.bridge       string | null
vm.display.type         vnc | null
missing_fields          string[]
warnings                string[]
validation_status       valid | invalid | incomplete | unknown
requires_confirmation   boolean
```

## Conversation

```
Conversation {
  id: string
  state: NEW | UNDERSTANDING | COLLECTING_INFORMATION | VALIDATING
       | PROPOSING | CONFIRMED | EXECUTING | COMPLETED | FAILED
  messages: { role: user|assistant, content: string, ts: number }[]
  pendingProposal?: {
    confirmationId: string
    intent: VmIntent            // frozen, validated
    normalized: NormalizedConfig
    createdAt: number
    consumed: boolean
  }
  lastRequestId?: string        // idempotency
}
```

## Audit record

```
AuditRecord {
  timestamp, requestId, conversationId, confirmationId,
  operation, requestedConfiguration, validatedConfiguration,
  confirmation, mcpTool, mcpArguments, result, error, durationMs
}
```
Secrets (API keys, passwords, private keys) are never included.
