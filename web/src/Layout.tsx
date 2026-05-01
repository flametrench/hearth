import { Link, useNavigate } from 'react-router-dom';
import { clearSession, getSession, getActiveOrgSlug, clearActiveOrgSlug } from './api.js';

export function Layout({ children }: { children: React.ReactNode }) {
  const session = getSession();
  const orgSlug = getActiveOrgSlug();
  const navigate = useNavigate();

  function signOut() {
    clearSession();
    clearActiveOrgSlug();
    navigate('/');
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-zinc-200">
        <nav className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold text-zinc-900">
            Hearth
          </Link>
          {session ? (
            <>
              <Link
                to="/inbox"
                className="text-zinc-600 hover:text-zinc-900"
                data-testid="nav-inbox"
              >
                Inbox
              </Link>
              <Link to="/team" className="text-zinc-600 hover:text-zinc-900" data-testid="nav-team">
                Team
              </Link>
              <Link
                to="/account"
                className="text-zinc-600 hover:text-zinc-900"
                data-testid="nav-account"
              >
                Account
              </Link>
              <Link
                to="/admin/users"
                className="text-zinc-600 hover:text-zinc-900"
                data-testid="nav-admin-users"
              >
                Admin
              </Link>
              <span className="ml-auto text-zinc-500">{orgSlug ? `org: ${orgSlug}` : ''}</span>
              <button
                onClick={signOut}
                className="text-zinc-600 hover:text-zinc-900"
                data-testid="nav-signout"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link
                to="/signin"
                className="ml-auto text-zinc-600 hover:text-zinc-900"
                data-testid="nav-signin"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="bg-zinc-900 text-white px-3 py-1.5 rounded-md hover:bg-zinc-800"
                data-testid="nav-signup"
              >
                Sign up
              </Link>
            </>
          )}
        </nav>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">{children}</main>
      <footer className="border-t border-zinc-200 py-3 text-center text-xs text-zinc-500">
        Hearth — Flametrench v0.2 reference application
      </footer>
    </div>
  );
}
