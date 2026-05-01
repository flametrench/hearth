import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, getSession } from '../api.js';

interface TicketDetail {
  ticket: {
    id: string;
    subject: string;
    body: string;
    status: 'open' | 'pending' | 'resolved';
    customer_email: string;
    org_id: string;
  };
  comments: Array<{
    id: string;
    source: 'agent' | 'customer';
    author_usr_id: string | null;
    body: string;
    created_at: string;
  }>;
  shares: Array<{
    id: string;
    expires_at: string;
    revoked_at: string | null;
    consumed_at: string | null;
  }>;
}

export function Ticket() {
  const { ticketId = '' } = useParams();
  const [data, setData] = useState<TicketDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<TicketDetail>(`/app/tickets/${ticketId}`, { bearer: 'session' });
      setData(d);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Load failed');
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function comment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/app/tickets/${ticketId}/comment`, {
        method: 'POST',
        body: { body: reply },
        bearer: 'session',
      });
      setReply('');
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Comment failed');
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, body?: unknown) {
    setBusy(true);
    try {
      await api(`/app/tickets/${ticketId}${path}`, {
        method: 'POST',
        body: body ?? {},
        bearer: 'session',
      });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(shrId: string) {
    setBusy(true);
    try {
      await api(`/app/shares/${shrId}/revoke`, { method: 'POST', bearer: 'session' });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (err && !data)
    return (
      <p className="py-8 text-red-600" data-testid="ticket-error">
        {err}
      </p>
    );
  if (!data) return <p className="py-8 text-zinc-500">Loading…</p>;

  const session = getSession();

  return (
    <div className="py-6 max-w-3xl" data-testid="ticket-detail">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold flex-1">{data.ticket.subject}</h1>
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            data.ticket.status === 'open'
              ? 'bg-amber-100 text-amber-900'
              : data.ticket.status === 'pending'
                ? 'bg-blue-100 text-blue-900'
                : 'bg-emerald-100 text-emerald-900'
          }`}
          data-testid="ticket-status"
        >
          {data.ticket.status}
        </span>
      </div>
      <p className="text-sm text-zinc-500 mt-1">
        {data.ticket.id} · from {data.ticket.customer_email}
      </p>

      <Bubble source="customer" body={data.ticket.body} />
      {data.comments.map((c) => (
        <Bubble key={c.id} source={c.source} body={c.body} />
      ))}

      <form onSubmit={comment} className="mt-6" data-testid="ticket-reply-form">
        <textarea
          rows={3}
          required
          className="input"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply to the customer…"
          data-testid="ticket-reply-body"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-2 bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="ticket-reply-submit"
        >
          Send reply
        </button>
      </form>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          onClick={() => action('/assign', { assignee_usr_id: session?.usr_id })}
          className="border border-zinc-300 px-3 py-1.5 rounded-md hover:bg-zinc-100 text-sm"
          data-testid="ticket-assign-self"
        >
          Assign to me
        </button>
        {data.ticket.status !== 'resolved' ? (
          <button
            onClick={() => action('/resolve')}
            className="border border-zinc-300 px-3 py-1.5 rounded-md hover:bg-zinc-100 text-sm"
            data-testid="ticket-resolve"
          >
            Resolve
          </button>
        ) : (
          <button
            onClick={() => action('/reopen')}
            className="border border-zinc-300 px-3 py-1.5 rounded-md hover:bg-zinc-100 text-sm"
            data-testid="ticket-reopen"
          >
            Reopen
          </button>
        )}
        <button
          onClick={() => action('/share', { resend_email: true })}
          className="border border-zinc-300 px-3 py-1.5 rounded-md hover:bg-zinc-100 text-sm"
          data-testid="ticket-mint-share"
        >
          Resend customer link
        </button>
      </div>

      {data.shares.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-zinc-700">Customer share links</h2>
          <ul className="mt-2 divide-y divide-zinc-200 border border-zinc-200 rounded-md bg-white">
            {data.shares.map((s) => (
              <li
                key={s.id}
                className="p-2 text-sm flex items-center gap-3"
                data-testid={`ticket-share-${s.id}`}
              >
                <span className="font-mono flex-1">{s.id}</span>
                <span className="text-xs text-zinc-500">
                  expires {new Date(s.expires_at).toLocaleDateString()}
                </span>
                {s.revoked_at ? (
                  <span className="text-xs text-zinc-500">revoked</span>
                ) : (
                  <button
                    onClick={() => revokeShare(s.id)}
                    className="text-xs underline text-red-600"
                    data-testid={`ticket-share-revoke-${s.id}`}
                  >
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
