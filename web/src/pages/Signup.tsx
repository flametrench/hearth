import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setSession, setActiveOrgSlug } from '../api.js';

interface UserResponse {
  id: string;
}
interface CredResponse {
  id: string;
}
interface VerifyResponse {
  usr_id: string;
  cred_id: string;
}
interface SessionResponse {
  token: string;
  session: { expiresAt: string };
}
interface OrgResponse {
  org: { id: string };
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
      const usr = await api<UserResponse>('/v1/users', {
        method: 'POST',
        body: {},
      });
      await api<CredResponse>('/v1/credentials', {
        method: 'POST',
        body: { usr_id: usr.id, type: 'password', identifier: email, password },
      });
      // updateUser display_name (PATCH /v1/users/:id) — not exposed by server v0.0.1; skip for demo

      const verify = await api<VerifyResponse>('/v1/credentials/verify', {
        method: 'POST',
        body: { type: 'password', identifier: email, proof: { password } },
      });
      const session = await api<SessionResponse>('/v1/sessions', {
        method: 'POST',
        body: { usr_id: verify.usr_id, cred_id: verify.cred_id, ttl_seconds: 3600 },
      });
      setSession({
        token: session.token,
        usr_id: verify.usr_id,
        expires_at: session.session.expiresAt,
      });

      const org = await api<OrgResponse>('/v1/orgs', {
        method: 'POST',
        body: {},
        bearer: 'session',
      });
      await api('/app/orgs/' + org.org.id + '/settings', {
        method: 'POST',
        body: { name: orgName, slug: orgSlug },
        bearer: 'session',
      });
      setActiveOrgSlug(orgSlug);
      void displayName;
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
