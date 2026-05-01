import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, getActiveOrgSlug } from '../api.js';

interface Ticket {
  id: string;
  subject: string;
  customer_email: string;
  status: 'open' | 'pending' | 'resolved';
  updated_at: string;
}

interface InboxResponse {
  tickets: Ticket[];
  org: { id: string; name: string | null; slug: string | null };
}

const STATUS_FILTERS = ['all', 'open', 'pending', 'resolved'] as const;

export function Inbox() {
  const slug = getActiveOrgSlug();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('open');
  const [data, setData] = useState<InboxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setErr(
        'No active org. Sign up creates an org; otherwise set hearth.org_slug in localStorage.',
      );
      return;
    }
    api<InboxResponse>(`/app/orgs/${slug}/tickets?status=${filter}`, { bearer: 'session' })
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Inbox load failed'));
  }, [slug, filter]);

  return (
    <div className="py-6">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-semibold flex-1">Inbox</h1>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-md text-sm ${
              filter === f ? 'bg-zinc-900 text-white' : 'border border-zinc-300 hover:bg-zinc-100'
            }`}
            data-testid={`inbox-filter-${f}`}
          >
            {f}
          </button>
        ))}
      </div>
      {err && (
        <p className="text-red-600 text-sm" data-testid="inbox-error">
          {err}
        </p>
      )}
      {data && (
        <div data-testid="inbox-list">
          {data.tickets.length === 0 ? (
            <p className="text-zinc-500">No tickets at status: {filter}</p>
          ) : (
            <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md bg-white">
              {data.tickets.map((t) => (
                <li key={t.id} className="p-3 hover:bg-zinc-50">
                  <Link
                    to={`/tickets/${t.id}`}
                    className="block"
                    data-testid={`inbox-ticket-${t.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-medium flex-1">{t.subject}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          t.status === 'open'
                            ? 'bg-amber-100 text-amber-900'
                            : t.status === 'pending'
                              ? 'bg-blue-100 text-blue-900'
                              : 'bg-emerald-100 text-emerald-900'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {t.customer_email} · {new Date(t.updated_at).toLocaleString()}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
