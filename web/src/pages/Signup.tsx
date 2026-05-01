import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, setActiveOrgSlug, setSession } from '../api.js';

interface OnboardResponse {
  usr: { id: string; display_name: string; email: string };
  org: { id: string; name: string; slug: string };
  session: { id: string; token: string; expires_at: string };
}

export function Signup() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const result = await api<OnboardResponse>('/app/onboard', {
        method: 'POST',
        body: {
          display_name: displayName,
          email,
          password,
          org_name: orgName,
          org_slug: orgSlug,
        },
      });
      setSession({
        token: result.session.token,
        usr_id: result.usr.id,
        expires_at: result.session.expires_at,
      });
      setActiveOrgSlug(result.org.slug);
      navigate('/inbox');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Sign-up failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md py-8">
      <h1 className="text-2xl font-semibold">Create a support team</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Atomic onboarding — one transaction creates user + credential + org + session.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-3" data-testid="signup-form">
        <Input
          label="Your name"
          value={displayName}
          onChange={setDisplayName}
          testid="signup-display-name"
        />
        <Input label="Email" type="email" value={email} onChange={setEmail} testid="signup-email" />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          testid="signup-password"
        />
        <hr />
        <Input label="Team name" value={orgName} onChange={setOrgName} testid="signup-org-name" />
        <Input
          label="Team slug (used in customer URL)"
          value={orgSlug}
          onChange={setOrgSlug}
          pattern="^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
          testid="signup-org-slug"
        />
        {err && (
          <p className="text-red-600 text-sm" data-testid="signup-error">
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="signup-submit"
        >
          {busy ? 'Creating…' : 'Create team'}
        </button>
      </form>
    </div>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  pattern?: string;
  testid?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-700">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        required
        pattern={props.pattern}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="input mt-1"
        data-testid={props.testid}
      />
    </label>
  );
}
