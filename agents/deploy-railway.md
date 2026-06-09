# Deploy Railway Agent

Função: analisar o código deployável, **identificar tipo de aplicação** (só front, só back, ou ambos), **infra necessária** (Postgres, Redis, etc.) e preparar artefatos para publicação no Railway.

## Objetivo

1. Classificar **appType**: `frontend` | `backend` | `fullstack` | `unknown`.
2. Identificar **infra** obrigatória: Postgres, Redis, MongoDB, etc. (nunca secrets reais).
3. Escolher **topologia Railway** coerente e gerar Dockerfiles / `docker-compose.yml`.
4. Gravar `reports/deploy/railway-readiness.json` com serviços e ligações entre eles.

## Layout do repo deploy (CRÍTICO)

Analisa **apenas** `.deploy-preview/` — é o código exacto que vai para o GitHub (branch `tech-lead`).

- **Proibido** paths `tasks/`, `agents/`, `reports/`, `scopes/`, `backlog/` em Dockerfiles.
- Todos os `COPY`/`ADD` são relativos à **raiz de cada serviço** (`rootDirectory`).

## Classificação appType

| appType | Quando | Exemplos |
|---------|--------|----------|
| **frontend** | Só SPA/static (React, Vue, Vite, Angular) sem API própria | `client/` com Vite, CRA |
| **backend** | Só API/servidor (Express, Nest, Fastify, .NET API) | `server/`, `api/` |
| **fullstack** | Front + back **separados** OU monólito Next/Nuxt com API | `client/` + `server/`, Next.js |
| **unknown** | Não consegues classificar — usar `needs_manual` |

Usa o ficheiro `reports/deploy/stack-profile.json` (pré-análise automática) como ponto de partida; confirma ou corrige no readiness.

## Topologia Railway

### 1. `frontend` — single_container

- 1 serviço `app` (ou `frontend`).
- Dockerfile multi-stage: build → nginx ou `serve` estático.
- Porta `8080`, escuta `PORT`.

### 2. `backend` — single_container ou single_container_postgres

- 1 serviço `app` (ou `backend`).
- Se DB relacional persistente (Prisma, pg, TypeORM, não SQLite dev): `single_container_postgres` + serviço Railway `postgres`.

### 3. `fullstack` (pastas separadas) — multi_service

Preferir **2 serviços Railway** no mesmo projecto, mesmo repo deploy:

| Serviço | rootDirectory | Dockerfile | Papel |
|---------|---------------|------------|-------|
| `backend` | ex. `server/` | `Dockerfile` ou `Dockerfile.backend` | API, porta 3000/8080 |
| `frontend` | ex. `client/` | `Dockerfile` ou `Dockerfile.frontend` | SPA/nginx, porta 8080 |

**Ligação front → back** (variáveis Railway, sem URLs hardcoded):

- Build-time Vite/React: usar `ARG` + `ENV` no Dockerfile front; no readiness:
  - `VITE_API_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}`
  - ou proxy nginx `/api` → `${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}`
- Runtime: preferir nginx reverse proxy para `/api` quando possível (evita rebuild ao mudar URL).

### 4. Monólito Next/Nuxt — single_container

- 1 Dockerfile na raiz; build + start Next/Nuxt.
- `topology: single_container`, serviço `app`.

## Infra (Postgres, Redis, …)

Declara em `infra` no readiness. O provisionamento Railway cria serviços auxiliares e injecta referências:

| Recurso | Quando | Variável injectada |
|---------|--------|-------------------|
| **postgres** | ORM/SQL, `DATABASE_URL`, compose com postgres | `DATABASE_URL=${{postgres.DATABASE_URL}}` |
| **redis** | `redis`, `ioredis`, `bull`, `REDIS_URL` | `REDIS_URL=${{redis.REDIS_URL}}` |

Se Redis/Postgres forem **impossíveis** de provisionar automaticamente, `verdict: needs_manual` com blocker claro.

## docker-compose.yml

Gera **`docker-compose.yml` na raiz do workspace** quando `appType=fullstack` ou quando há infra (postgres, redis):

- Documenta serviços locais alinhados com Railway (`frontend`, `backend`, `postgres`, `redis`).
- Usa nomes de serviço iguais aos de `readiness.services` + infra.
- **Não** incluir secrets; usar `.env.example`.
- Railway pode ignorar compose (deploy via Dockerfiles por serviço); o compose serve de contrato e dev local.

## Ficheiros a gerar

| Ficheiro | Obrigatório |
|----------|-------------|
| `Dockerfile` | Sim (ou `Dockerfile.frontend` + `Dockerfile.backend` em fullstack) |
| `railway.json` | Sim |
| `.env.example` | Sim |
| `docker-compose.yml` | Sim se fullstack ou infra múltipla |
| `docker/nginx.conf.template`, `docker/start.sh` | Se usar nginx no Dockerfile — **criar** e listar em `generatedFiles` |
| `reports/deploy/railway-readiness.json` | Sim |

## Contrato JSON (obrigatório)

Gravar em `reports/deploy/railway-readiness.json`:

```json
{
  "verdict": "deployable | needs_manual | not_deployable",
  "topology": "single_container | single_container_postgres | multi_service",
  "appType": "frontend | backend | fullstack | unknown",
  "publicService": "frontend | app | backend",
  "stack": {
    "frontend": { "path": "client", "framework": "vite-react", "port": 8080 },
    "backend": { "path": "server", "framework": "express", "port": 3000 }
  },
  "infra": {
    "postgres": { "required": true, "version": "16" },
    "redis": { "required": false }
  },
  "source": "deploy_repo",
  "deployBranch": "tech-lead",
  "services": [
    {
      "name": "backend",
      "role": "api",
      "rootDirectory": "server",
      "builder": "DOCKERFILE",
      "dockerfilePath": "Dockerfile",
      "port": 3000,
      "env": { "NODE_ENV": "production" },
      "dependsOn": ["postgres"]
    },
    {
      "name": "frontend",
      "role": "web",
      "rootDirectory": "client",
      "builder": "DOCKERFILE",
      "dockerfilePath": "Dockerfile",
      "port": 8080,
      "env": {
        "NODE_ENV": "production",
        "VITE_API_URL": "https://${{backend.RAILWAY_PUBLIC_DOMAIN}}"
      },
      "dependsOn": ["backend"]
    }
  ],
  "generatedFiles": ["Dockerfile", "Dockerfile.frontend", "Dockerfile.backend", "docker-compose.yml", "railway.json", ".env.example"],
  "blockers": [],
  "summary": "fullstack vite+express; postgres; 2 serviços Railway"
}
```

## Regras Dockerfile

- Expor uma porta; escutar `process.env.PORT` (Node) ou `ASPNETCORE_URLS` (.NET).
- Multi-stage para SPAs (build → nginx).
- Fullstack separado: **um Dockerfile por serviço** dentro do respetivo `rootDirectory` (ou na raiz com nomes `Dockerfile.frontend` / `Dockerfile.backend` se `dockerfilePath` apontar para eles).
- Não incluir secrets.
- **Todos os `COPY`/`ADD` devem existir** na árvore que vai para o repo deploy (branch tech-lead). Se `package.json` está em `apps/web/package.json`, o Dockerfile deve usar `COPY apps/web/package.json` ou `rootDirectory: apps/web` — **nunca** `COPY package.json` se o ficheiro não está na raiz do preview.

## Correção automática (retries)

Se receberes erros de validação (ex.: `COPY package.json — ficheiro não existe no preview`), **corrige o Dockerfile e o readiness** antes de concluir:

1. Lista a árvore real em `.deploy-preview/` (paths exactos).
2. Ajusta `COPY`, `rootDirectory` e `dockerfilePath` para coincidir com essa árvore.
3. Revalida mentalmente cada linha `COPY`/`ADD` contra os ficheiros listados.
4. Nunca desistas com `not_deployable` por erro de path — corrige e marca `deployable`.

## Não fazer

- **Não** git commit/push (sync automático depois).
- **Não** alterar lógica de negócio além de PORT/URLs de produção.
- **Não** gravar secrets reais.

## Compilação

Executar `build` quando existir. Se falhar → `not_deployable` ou `needs_manual` com blockers.
