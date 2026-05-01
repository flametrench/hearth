import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';

export function AdminInstall() {
  const navigate = useNavigate();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mfa, setMfa] = useState<'off' | 'admins' | 'all'>('off');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ installed: boolean }>('/app/install/status')
      .then((s) => setInstalled(s.installed))
      .catch(() => setInstalled(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/app/install', {
        method: 'POST',
        body: {
          sysadmin_email: email,
          sysadmin_password: password,
          sysadmin_display_name: displayName,
          mfa_policy: mfa,
        },
      });
      navigate('/signin');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Install failed');
    } finally {
      setBusy(false);
    }
  }

  if (installed === null) return <p className="py-8 text-zinc-500">Checking install status…</p>;
  if (installed) {
    return (
      <div className="py-8" data-testid="install-already">
        <h1 className="text-2xl font-semibold">Already installed</h1>
        <p className="mt-3 text-zinc-600">
          Hearth has already been installed.{' '}
          <a href="/signin" className="underline">
            Sign in
          </a>{' '}
          instead.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-md py-8">
      <h1 className="text-2xl font-semibold">Install Hearth</h1>
      <p className="mt-2 text-sm text-zinc-600">
        First-run wizard. This will atomically apply Flametrench v0.2 schema, create the first
        sysadmin, and write the singleton install record (ADR 0013 demonstration).
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-3" data-testid="install-form">
        <Field label="Sysadmin email">
          <input
            type="email"
            required
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="install-email"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="install-password"
          />
        </Field>
        <Field label="Display name">
          <input
            type="text"
            required
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            data-testid="install-display-name"
          />
        </Field>
        <Field label="MFA policy">
          <select
            className="input"
            value={mfa}
            onChange={(e) => setMfa(e.target.value as 'off' | 'admins' | 'all')}
            data-testid="install-mfa"
          >
            <option value="off">Off</option>
            <option value="admins">Required for admins</option>
            <option value="all">Required for everyone</option>
          </select>
        </Field>
        {err && (
          <p className="text-red-600 text-sm" data-testid="install-error">
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="install-submit"
        >
          {busy ? 'Installing…' : 'Install'}
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
