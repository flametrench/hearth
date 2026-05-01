import { Link } from 'react-router-dom';

export function Team() {
  return (
    <div className="py-6" data-testid="team-page">
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-3 text-zinc-600">
        Stub — wire to <span className="font-mono">GET /v1/orgs/:org_id/members</span> for member
        list, and <span className="font-mono">/v1/orgs/:org_id/invitations</span> for pending
        invitations.
      </p>
      <Link
        to="/team/invite"
        className="mt-4 inline-block underline"
        data-testid="team-invite-link"
      >
        Send an invitation →
      </Link>
    </div>
  );
}
