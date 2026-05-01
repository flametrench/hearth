import { createFlametrenchServer } from '@flametrench/server';
import { PostgresIdentityStore } from '@flametrench/identity/postgres';
import { PostgresTenancyStore } from '@flametrench/tenancy/postgres';
import { PostgresTupleStore } from '@flametrench/authz/postgres';

import { loadEnv } from './env.js';
import { createPool } from './db.js';
import { ensureSchema } from './schema.js';
import { registerInstallRoute } from './install.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);

  await ensureSchema(pool);

  const identityStore = new PostgresIdentityStore(pool);
  const tenancyStore = new PostgresTenancyStore(pool);
  const tupleStore = new PostgresTupleStore(pool);

  const app = await createFlametrenchServer({
    identityStore,
    tenancyStore,
    tupleStore,
  });

  await app.register(
    async (instance) => {
      registerInstallRoute(instance, { pool });
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
