# ai-factory-back

**Backend** da plataforma AI Factory: API Express + PostgreSQL.

- Autenticação (JWT), tenants, planos e billing
- Fila de jobs, API do worker (claim / complete / dashboard)
- Snapshots de Kanban e scope no Postgres
- Logs de execução via **Redis** (LIST + Pub/Sub); metadados de job na BD

**API-only** em produção: não monta disco de projetos do cliente. Em dev local, `TENANT_DATA_DIR` aponta para o volume do CLI apenas para `pull-tenant-env` e rotas de desenvolvimento.

## Desenvolvimento interno (localhost)

| Serviço | URL |
|---------|-----|
| API | `http://localhost:4000` |
| Front (CORS) | `http://localhost:5173` |
| Postgres | `docker-compose.dev.yml` |
| Redis (logs) | `redis://127.0.0.1:6379` (back); worker Docker usa `TENANT_REDIS_URL` → `host.docker.internal` |

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npm run db:migrate
npm run db:seed
npm run db:seed-agents
npm run dev
```

`GET http://localhost:4000/health` → `{ "ok": true }`

Com as quatro pastas lado a lado no disco, use no `.env`:

`TENANT_DATA_DIR=../ai-factory-cli/data/tenants`

## Produção (em breve)

Deploy previsto no **Railway** (API + plugin PostgreSQL). Variáveis: ver [.env.example](.env.example).

O **cliente** (CLI Docker por tenant) liga-se a esta API com `BACK_URL` e `WORKER_SECRET`. O **frontend** usa `VITE_API_URL` apontando para o mesmo host publicado.

## Comandos úteis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | API com reload |
| `npm run db:migrate` | Migrations SQL |
| `npm run db:seed` | Tenant de smoke |
| `npm run db:seed-agents` | Templates de agentes |
| `npm run pull-tenant-env -- <tenant-id>` | Gera `.env` do worker no volume do CLI |
| `npm test` | Testes (billing, job-log-redis) |

## Stripe (webhook)

Cadastre no Dashboard: `POST https://<api>/webhooks/stripe` com eventos `checkout.session.completed` e `invoice.paid`.

Variáveis: `STRIPE_WEBHOOK_SECRET` (obrigatório), `STRIPE_SECRET_KEY` (opcional), `STRIPE_DEFAULT_USER_PASSWORD` (só dev).

Em cada **Payment Link**, metadata `plan_id`: `starter` | `team` | `scale` | `business`.

Ative **coleta de nome da empresa** no link (`name_collection.business`) — o back grava em `tenants.name` a partir de `collected_information.business_name` (Checkout Session).

Cada webhook processado fica em `stripe_events` com `payload` (JSON completo do evento), `event_type` e `tenant_id` quando houver provisionamento.

Teste local: `stripe listen --forward-to localhost:4000/webhooks/stripe`

## Debug (Cursor / VS Code)

1. Abra **Run and Debug** (F5) e escolha **Back: API (debug)** — usa o `.env` do back e para em breakpoints.
2. Ou no terminal: `npm run dev:debug` e depois **Back: attach :9229**.

Breakpoints úteis no webhook: `src/routes/stripe.js` → `handleStripeWebhook`, `handleStripeEvent`, `provisionFromCheckoutSession`.

Logs: `AI_FACTORY_LOG_LEVEL=debug` no `.env` para mais detalhe no terminal.

## Docker

```bash
docker build -t ai-factory-back .
```

## Relacionados

- Frontend: [../ai-factory-front/README.md](../ai-factory-front/README.md)
- Cliente (worker): [../ai-factory-cli/README.md](../ai-factory-cli/README.md)
