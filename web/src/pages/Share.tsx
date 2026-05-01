import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, setShareToken } from '../api.js';

interface TicketView {
  ticket: {
    id: string;
    subject: string;
    body: string;
    status: 'open' | 'pending' | 'resolved';
    customer_email: string;
    created_at: string;
    updated_at: string;
  };
  comments: Array<{
    id: string;
    source: 'agent' | 'customer';
    body: string;
    created_at: string;
  }>;
}

export function Share() {
  const { token = '' } = useParams();
  const [view, setView] = useState<TicketView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShareToken(token);
      const data = await api<TicketView>('/app/customer/ticket', { bearer: 'share' });
      setView(data);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onReply(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/app/customer/comment', {
        method: 'POST',
        body: { body: reply },
        bearer: 'share',
      });
      setReply('');
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reply failed');
    } finally {
      setBusy(false);
    }
  }

  if (err)
    return (
      <p className="py-8 text-red-600" data-testid="share-error">
        {err}
      </p>
    );
  if (!view) return <p className="py-8 text-zinc-500">Loading…</p>;

  return (
    <div className="py-6 max-w-2xl" data-testid="share-view">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold flex-1">{view.ticket.subject}</h1>
        <StatusPill status={view.ticket.status} />
      </div>
      <p className="text-sm text-zinc-500 mt-1">{view.ticket.id}</p>

      <Bubble source="customer" body={view.ticket.body} />
      {view.comments.map((c) => (
        <Bubble key={c.id} source={c.source} body={c.body} />
      ))}

      <form onSubmit={onReply} className="mt-6" data-testid="share-reply-form">
        <textarea
          rows={4}
          required
          className="input"
          placeholder="Write a reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          data-testid="share-reply-body"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-2 bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="share-reply-submit"
        >
          {busy ? 'Sending…' : 'Send reply'}
        </button>
      </form>
    </div>
  );
}

function Bubble({ source, body }: { source: 'agent' | 'customer'; body: string }) {
  const align = source === 'customer' ? 'ml-0 mr-auto bg-blue-50' : 'ml-auto mr-0 bg-zinc-100';
  return (
    <div className={`my-3 max-w-md p-3 rounded-md ${align}`}>
      <div className="text-xs uppercase text-zinc-500 mb-1">{source}</div>
      <div className="whitespace-pre-wrap text-sm">{body}</div>
    </div>
  );
}

function StatusPill({ status }: { status: 'open' | 'pending' | 'resolved' }) {
  const color =
    status === 'open'
      ? 'bg-amber-100 text-amber-900'
      : status === 'pending'
        ? 'bg-blue-100 text-blue-900'
        : 'bg-emerald-100 text-emerald-900';
  return (
    <span className={`text-xs px-2 py-1 rounded-full ${color}`} data-testid="share-status">
      {status}
    </span>
  );
}
