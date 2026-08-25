import { useEffect, useRef, useState } from 'react';
import { confirmVm, getHealth, type Proposal, sendChat } from './api';
import { ProposalCard } from './ProposalCard';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  proposal?: Proposal;
}

const SUGGESTIONS = [
  'Saya mau buat Ubuntu Server dengan 4 CPU, RAM 8 GB, disk 100 GB.',
  'Buat VM Ubuntu 24.04, 2 core, 4GB RAM, 40 GB disk, nama web-01.',
  'Daftar VM',
];

export function App() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      content:
        'Halo! Jelaskan VM yang ingin Anda buat dalam bahasa sehari-hari. ' +
        'Contoh: "Buat Ubuntu Server 4 CPU, RAM 8 GB, disk 100 GB, nama web-01."',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeProposal, setActiveProposal] = useState<Proposal | null>(null);
  const [health, setHealth] = useState<{ mcp: string; llm: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getHealth()
      .then((h) => setHealth({ mcp: h.mcp, llm: h.llm }))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    setActiveProposal(null);
    setMessages((m) => [...m, { role: 'user', content: trimmed }]);
    setInput('');
    try {
      const res = await sendChat(conversationId, trimmed);
      setConversationId(res.conversation_id);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.message, proposal: res.proposal },
      ]);
      if (res.requires_confirmation && res.proposal) {
        setActiveProposal(res.proposal);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(confirmed: boolean) {
    if (!conversationId || !activeProposal || busy) return;
    setError(null);
    setBusy(true);
    const proposal = activeProposal;
    setActiveProposal(null);
    try {
      const res = await confirmVm(conversationId, proposal.confirmation_id, confirmed);
      setMessages((m) => [...m, { role: 'assistant', content: res.message }]);
    } catch (err) {
      setError((err as Error).message);
      // Re-enable the card so the user can retry the decision.
      setActiveProposal(proposal);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">KVM Chat Agent</div>
        {health && (
          <div className="header-status">
            <span className={`pill pill-${health.mcp}`}>MCP: {health.mcp}</span>
            <span className={`pill pill-${health.llm === 'configured' ? 'ok' : 'warn'}`}>
              LLM: {health.llm}
            </span>
          </div>
        )}
      </header>

      <main className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`row row-${m.role}`}>
            <div className={`bubble bubble-${m.role}`}>
              <div className="bubble-text">{m.content}</div>
              {m.proposal && activeProposal?.confirmation_id === m.proposal.confirmation_id && (
                <ProposalCard
                  proposal={m.proposal}
                  busy={busy}
                  onCreate={() => decide(true)}
                  onCancel={() => decide(false)}
                />
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="row row-assistant">
            <div className="bubble bubble-assistant bubble-loading">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      {error && <div className="error-banner">{error}</div>}

      {messages.length <= 1 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" disabled={busy} onClick={() => submit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          className="composer-input"
          placeholder="Tulis pesan… (mis. Buat Ubuntu 4 CPU 8GB RAM 100GB disk)"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
          Kirim
        </button>
      </form>
    </div>
  );
}
