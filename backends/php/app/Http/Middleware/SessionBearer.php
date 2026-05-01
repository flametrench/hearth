<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Flametrench\Identity\IdentityStore;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

class SessionBearer
{
    public function __construct(private readonly IdentityStore $identityStore) {}

    public function handle(Request $request, Closure $next): Response
    {
        $header = (string) $request->header('Authorization', '');
        if (stripos($header, 'bearer ') !== 0) {
            return response()->json([
                'error' => ['code' => 'unauthenticated', 'message' => 'Missing or malformed Authorization header'],
            ], 401);
        }
        $token = trim(substr($header, strlen('bearer ')));
        try {
            $session = $this->identityStore->verifySessionToken($token);
        } catch (Throwable) {
            return response()->json([
                'error' => ['code' => 'unauthenticated', 'message' => 'Invalid or expired session token'],
            ], 401);
        }
        $request->attributes->set('session', $session);

        return $next($request);
    }
}
