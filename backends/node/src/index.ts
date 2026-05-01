import cors from '@fastify/cors';
import { createFlametrenchServer } from '@flametrench/server';
import { PostgresIdentityStore } from '@flametrench/identity/postgres';
import { PostgresTenancyStore } from '@flametrench/tenancy/postgres';
import { PostgresTupleStore, PostgresShareStore } from '@flametrench/authz/postgres';

import { loadEnv } from './env.js';
import { createPool } from './db.js';
import { ensureSchema } from './schema.js';
import { registerInstallRoute } from './install.js';
import { registerCustomerRoutes } from './customer.js';
import { registerAgentRoutes } from './agent.js';
import { Mailer } from './email.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);

  await ensureSchema(pool);

  const identityStore = new PostgresIdentityStore(pool);
  const tenancyStore = new PostgresTenancyStore(pool);
  const tupleStore = new PostgresTupleStore(pool);
  const shareStore = new PostgresShareStore(pool);

  const mailer = new Mailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    from: env.SMTP_FROM,
    publicBaseUrl: env.HEARTH_PUBLIC_BASE_URL,
  });

  const app = await createFlametrenchServer({
    identityStore,
    tenancyStore,
    tupleStore,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
  });

  await app.register(
    async (instance) => {
      registerInstallRoute(instance, { pool });
      registerCustomerRoutes(instance, { pool, shareStore, mailer });
      registerAgentRoutes(instance, {
        pool,
        identityStore,
        tenancyStore,
        tupleStore,
        shareStore,
        mailer,
      });
    },
    { prefix: '/app' },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`hearth-node listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
