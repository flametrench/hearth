import { getSession } from '../api.js';

export function Account() {
  const session = getSession();
  return (
    <div className="py-6 max-w-md" data-testid="account-page">
      <h1 className="text-2xl font-semibold">Account</h1>
      <p className="mt-3 text-sm text-zinc-600">
        Signed in as <span className="font-mono">{session?.usr_id}</span>
      </p>
      <p className="mt-3 text-zinc-600">
        Stub — display-name update, MFA enrollment, and session-list/revoke land here.
      </p>
    </div>
  );
}
