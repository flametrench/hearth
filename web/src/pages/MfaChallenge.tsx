export function MfaChallenge() {
  return (
    <div className="py-8 max-w-md" data-testid="mfa-challenge">
      <h1 className="text-2xl font-semibold">MFA challenge</h1>
      <p className="mt-3 text-zinc-600">
        Stub — wire to <span className="font-mono">POST /v1/users/:usr_id/mfa/verify</span> after
        MFA enrollment lands.
      </p>
    </div>
  );
}
