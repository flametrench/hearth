<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Flametrench\Authz\ShareStore;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

class ShareBearer
{
    public function __construct(private readonly ShareStore $shareStore) {}

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
            $verified = $this->shareStore->verifyShareToken($token);
        } catch (Throwable) {
            return response()->json([
                'error' => ['code' => 'invalid_share_token', 'message' => 'Share token is invalid, expired, or revoked'],
            ], 401);
        }
        $request->attributes->set('verified_share', $verified);

        return $next($request);
    }
}
