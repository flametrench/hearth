import { useParams } from 'react-router-dom';

export function InvitationLanding() {
  const { invId } = useParams();
  return (
    <div className="py-6 max-w-md" data-testid="invitation-page">
      <h1 className="text-2xl font-semibold">Invitation</h1>
      <p className="mt-3 text-zinc-600">
        Stub — wire to <span className="font-mono">GET /v1/invitations/{invId}</span> +
        signin/signup-and-accept flow.
      </p>
    </div>
  );
}
