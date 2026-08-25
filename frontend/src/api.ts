export interface Proposal {
  confirmation_id: string;
  name: string;
  os: string;
  vcpus: number;
  memory_mb: number;
  disk_gb: number;
  network: string;
  display: string;
}

export interface ChatResponse {
  conversation_id: string;
  state: string;
  message: string;
  proposal?: Proposal;
  requires_confirmation: boolean;
  warnings: string[];
  vms?: VmSummary[];
}

export interface ConfirmResponse {
  conversation_id: string;
  state: string;
  message: string;
  ok: boolean;
}

export interface VmSummary {
  name: string;
  id: number;
  state: string;
  autostart: boolean;
  persistent: boolean;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? 'Terjadi kesalahan.';
    throw new Error(msg);
  }
  return data as T;
}

export function sendChat(conversationId: string | null, message: string): Promise<ChatResponse> {
  return post<ChatResponse>('/api/chat', {
    conversation_id: conversationId ?? undefined,
    message,
  });
}

export function confirmVm(
  conversationId: string,
  confirmationId: string,
  confirmed: boolean,
): Promise<ConfirmResponse> {
  return post<ConfirmResponse>('/api/vm/confirm', {
    conversation_id: conversationId,
    confirmation_id: confirmationId,
    confirmed,
  });
}

export async function getHealth(): Promise<{ status: string; mcp: string; llm: string }> {
  const res = await fetch('/api/health');
  return res.json();
}
