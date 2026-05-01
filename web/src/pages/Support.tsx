import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api.js';

interface SubmitResponse {
  ticket: { id: string; status: string };
  share: { id: string; expires_at: string };
  share_url: string;
}

export function Support() {
  const { slug = '' } = useParams();
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitted, setSubmitted] = useState<SubmitResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const resp = await api<SubmitResponse>('/app/tickets/submit', {
        method: 'POST',
        body: { org_slug: slug, customer_email: email, subject, body },
      });
      setSubmitted(resp);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Submit failed');
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <div className="py-8" data-testid="support-success">
        <h1 className="text-2xl font-semibold">Thanks — we got your ticket.</h1>
        <p className="mt-3 text-zinc-600">
          We sent a link to <span className="font-mono">{email}</span>. You can also{' '}
          <a
            className="underline"
            href="http://localhost:8025"
            target="_blank"
            rel="noreferrer"
            data-testid="support-mailpit-link"
          >
            open mailpit
          </a>{' '}
          to see captured email.
        </p>
        <p className="mt-3 text-sm font-mono text-zinc-500">{submitted.ticket.id}</p>
      </div>
    );
  }

  return (
    <div className="py-8 max-w-xl">
      <h1 className="text-2xl font-semibold">Contact support</h1>
      <p className="text-zinc-600 mt-1">
        Submitting to org: <span className="font-mono">{slug}</span>
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-3" data-testid="support-form">
        <Field label="Your email">
          <input
            type="email"
            required
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="support-email"
          />
        </Field>
        <Field label="Subject">
          <input
            type="text"
            required
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            data-testid="support-subject"
          />
        </Field>
        <Field label="What's going on?">
          <textarea
            required
            rows={6}
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            data-testid="support-body"
          />
        </Field>
        {err && (
          <p className="text-red-600 text-sm" data-testid="support-error">
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="support-submit"
        >
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
