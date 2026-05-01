import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setSession } from '../api.js';

interface VerifyResponse {
  usr_id: string;
  cred_id: string;
  mfa_required?: boolean;
}

interface SessionResponse {
  session: { id: string; expiresAt: string };
  token: string;
}

export function Signin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const verify = await api<VerifyResponse>('/v1/credentials/verify', {
        method: 'POST',
        body: { type: 'password', identifier: email, proof: { password } },
      });
      if (verify.mfa_required) {
        sessionStorage.setItem('hearth.mfa_pending', JSON.stringify(verify));
        navigate('/mfa-challenge');
        return;
      }
      const session = await api<SessionResponse>('/v1/sessions', {
        method: 'POST',
        body: { usr_id: verify.usr_id, cred_id: verify.cred_id, ttl_seconds: 3600 },
      });
      setSession({
        token: session.token,
        usr_id: verify.usr_id,
        expires_at: session.session.expiresAt,
      });
      navigate('/inbox');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md py-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-3" data-testid="signin-form">
        <label className="block">
          <span className="text-sm text-zinc-700">Email</span>
          <input
            type="email"
            required
            className="input mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="signin-email"
          />
        </label>
        <label className="block">
          <span className="text-sm text-zinc-700">Password</span>
          <input
            type="password"
            required
            className="input mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="signin-password"
          />
        </label>
        {err && (
          <p className="text-red-600 text-sm" data-testid="signin-error">
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-50"
          data-testid="signin-submit"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
