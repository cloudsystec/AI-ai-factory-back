# Deploy no Railway — API e billing poller separados

Dois **serviços** no projeto Railway, mesmo repositório, pastas distintas.

| Serviço | Root Directory | Config file | Start | Health |
|---------|----------------|-------------|-------|--------|
| **API** | `ai-factory-back` | `railway.json` | `node src/index.js` (migrate no boot) | `/health` |
| **Billing poller** | `ai-factory-poller` | `railway.json` | `node src/index.js` | `/health` (só liveness) |

O poller **não** corre na API.

---

## Passo a passo no Railway

### 1. Serviço API (já existente ou novo)

1. **New Service** → ligar ao repo `ai-factory`.
2. **Root Directory:** `ai-factory-back`
3. **Settings → Config-as-code:** `railway.json` (default na raiz do back)
4. **Variables:** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `WORKER_SECRET`, `CORS_ORIGIN`, `PUBLIC_BACK_URL`, etc. (ver `.env.example`)
5. Deploy: migrações correm no arranque da API (HTTP `/health` responde imediatamente).

### 2. Serviço billing poller (novo)

1. No **mesmo projeto** Railway: **New Service** → mesmo repo.
2. **Root Directory:** `ai-factory-poller`
3. **Settings → Config-as-code → Config file path:** `railway.json`
4. **Variables** — mínimo em [`ai-factory-poller/.env.example`](../../ai-factory-poller/.env.example):
   - `DATABASE_URL` → **Reference Variable** do serviço Postgres/API
   - `REDIS_URL` → referência ao Redis da API (recomendado)
   - `ENCRYPTION_KEY` → **mesmo valor** da API (chaves Cursor por tenant)
   - Opcional: `BILLING_CURSOR_POLL_INTERVAL_MS`, buffers/match (ver `.env.example` do poller)
5. **Não** copiar `JWT_SECRET`, `CORS_ORIGIN`.
6. **Networking:** não precisa de domínio público; pode ser serviço interno.
7. **Replicas:** 1 (`numReplicas` no json) — evita dois pollers a claimar os mesmos eventos.

### 3. Validar

- API: `GET https://<api>/health` → `{ ok: true }`
- Poller: logs do deploy devem mostrar arranque do intervalo; na BD, calls `pending`/`estimated` com `ended_at` passam a `settled` + `source = cursor_admin_api`.

---

## Variáveis: quem precisa do quê

| Variável | API | Poller |
|----------|:---:|:------:|
| `DATABASE_URL` | ✓ | ✓ |
| `ENCRYPTION_KEY` | ✓ | ✓ |
| `REDIS_URL` | ✓ | ✓ (recomendado) |
| `JWT_SECRET` | ✓ | — |
| `CORS_ORIGIN` | ✓ | — |
| `WORKER_SECRET` | ✓ | — |
| `BILLING_CURSOR_POLL_INTERVAL_MS` | — | ✓ |
| `BILLING_MAX_MATCH_DELTA_MS` | — | ✓ |

---

## Desenvolvimento local (dois processos)

```bash
# Terminal 1 — API + WebSocket
cd ai-factory-back && npm run dev

# Terminal 2 — poller
cd ai-factory-poller && npm run dev
```

**Erro `EADDRINUSE` na porta 4000:** o `.env` da API define `PORT=4000`. O poller local **não** abre HTTP nessa porta (só o settle). Se quiseres health local no poller, usa `BILLING_POLLER_HEALTH_PORT=4100`.

---

## Settle (resumo)

Incremental por ticks: ledger em `billing_cursor_event_claims`, calls por `ended_at` ASC, evento Cursor mais antigo na folga temporal. Detalhes em comentários em [`ai-factory-poller/src/billing-settle-poller.js`](../../ai-factory-poller/src/billing-settle-poller.js).

Debug local (F5, tick manual): [`ai-factory-poller/docs/DEBUG.md`](../../ai-factory-poller/docs/DEBUG.md).
