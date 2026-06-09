# Publicação Railway — projectos concluídos (Opção B)

Deploy de projectos **finalizados** via repo GitHub **privado** na org da plataforma + Railway `source=repo`.

## Pré-requisitos (plataforma)

1. **GitHub App** com `GITHUB_PLATFORM_INSTALLATION_ID` (mesma org dos repos managed).
2. **Railway** ligado à mesma org GitHub (Settings → Connections → GitHub) para build de repos privados.
3. Variáveis no `ai-factory-back`:

| Variável | Descrição |
|----------|-----------|
| `RAILWAY_API_TOKEN` | Token em railway.com/account/tokens |
| `RAILWAY_WORKSPACE_ID` | Workspace ID (Cmd+K → Copy Workspace ID) |
| `RAILWAY_CLIENT_PROJECT_PREFIX` | Prefixo do project Railway (default `df`) |
| `GITHUB_DEPLOY_REPO_PREFIX` | Prefixo repo deploy (default `df-deploy`) |

Workers CLI **não** precisam de Docker para build (build corre no Railway).

## Fluxo

1. User clica **Verificar publicação** no modal de projecto concluído.
2. Job `railway-publish`: agente gera `Dockerfile` / `railway.json` no workspace.
3. Sync para repo privado `{prefix}-deploy-{tenant8}-{slug}` branch `main`.
4. Backend cria project Railway `df-{tenant8}-{slug}` e faz deploy.

## Privacidade

- Repos deploy: **sempre private** (`createRepository({ private: true })`).
- Repo **não** aparece na UI do cliente.
- URL exposta ao user: apenas domínio Railway da app (`*.up.railway.app`).

## Teste manual

1. Finalizar projecto (status `completed`) **sem** GitHub do tenant ligado.
2. Clicar **Verificar publicação**.
3. Verificar no GitHub org: repo `df-deploy-*` private com Dockerfile.
4. Verificar Railway: project criado, deploy a correr, URL no modal.

## Re-deploy

Novo clique em **Verificar publicação** reutiliza o mesmo project Railway e faz push + redeploy.
