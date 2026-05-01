import { Link } from 'react-router-dom';

export function Splash() {
  return (
    <div className="py-16">
      <h1 className="text-4xl font-bold text-zinc-900">Hearth</h1>
      <p className="mt-3 text-lg text-zinc-600">
        A customer-support inbox built on the Flametrench v0.2 specification — a reference
        application that exercises identity, tenancy, share tokens, and the multi-SDK transactional
        bootstrap.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          to="/signup"
          className="bg-zinc-900 text-white px-4 py-2 rounded-md hover:bg-zinc-800"
          data-testid="splash-signup"
        >
          Create a support team
        </Link>
        <Link
          to="/signin"
          className="border border-zinc-300 px-4 py-2 rounded-md hover:bg-zinc-100"
          data-testid="splash-signin"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
