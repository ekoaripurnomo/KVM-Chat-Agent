import type { Proposal } from './api';

interface Props {
  proposal: Proposal;
  busy: boolean;
  onCreate: () => void;
  onCancel: () => void;
}

function ram(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

/**
 * Visual configuration card (spec §23). The Create button maps to a
 * server-side confirmation action, not to arbitrary text.
 */
export function ProposalCard({ proposal, busy, onCreate, onCancel }: Props) {
  const rows: [string, string][] = [
    ['Nama', proposal.name],
    ['OS', proposal.os],
    ['CPU', `${proposal.vcpus} vCPU`],
    ['RAM', ram(proposal.memory_mb)],
    ['Disk', `${proposal.disk_gb} GB`],
    ['Network', proposal.network],
    ['Display', proposal.display.toUpperCase()],
  ];

  return (
    <div className="proposal-card">
      <div className="proposal-header">Konfigurasi VM</div>
      <table className="proposal-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="proposal-key">{k}</td>
              <td className="proposal-val">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="proposal-actions">
        <button className="btn btn-primary" disabled={busy} onClick={onCreate}>
          {busy ? 'Memproses…' : 'Buat VM'}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Batal
        </button>
      </div>
    </div>
  );
}
