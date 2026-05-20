# ai-factory-back

API Express + PostgreSQL (**API-only**, sem disco de tenant).

## Local

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npm run db:migrate
npm run db:seed
npm run db:seed-agents
npm run dev
```

Com as 4 pastas lado a lado, `TENANT_DATA_DIR` no `.env` aponta para `../ai-factory-cli/data/tenants`.

## Docker

```bash
docker build -t ai-factory-back .
```

**Docs:** `../ai-factory-meta/docs/GUIA-CORE-MVP.md`
