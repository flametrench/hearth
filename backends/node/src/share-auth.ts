import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ShareStore, VerifiedShare } from '@flametrench/authz';

declare module 'fastify' {
  interface FastifyRequest {
    verifiedShare?: VerifiedShare;
  }
}

export function buildShareAuthHook(shareStore: ShareStore) {
  return async function shareAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      reply.code(401).send({
        error: { code: 'unauthenticated', message: 'Missing or malformed Authorization header' },
      });
      return;
    }
    const token = header.slice('bearer '.length).trim();
    try {
      request.verifiedShare = await shareStore.verifyShareToken(token);
    } catch {
      reply.code(401).send({
        error: {
          code: 'invalid_share_token',
          message: 'Share token is invalid, expired, or revoked',
        },
      });
      return;
    }
  };
}
