# AI Factory Agents

Regras gerais:
- Nunca alterar arquivos fora do workspace da tarefa.
- Sempre criar testes quando possível.
- Sempre rodar lint/testes antes de finalizar.
- Sempre gerar resumo final.
- Não fazer deploy sem aprovação humana.

**Entrega principal:** incremento de **sistema utilizável** (código em `src/` ou equivalente, mais testes automatizados quando couber). Documentação e relatórios são **evidência e rastreabilidade**, não substituem comportamento verificável no produto.

Evitar micros/tasks cujo **único** resultado seja texto em `docs/` sem mudança observável no app, API, persistência ou contrato executável (exceto se o orquestrador ou backlog declarar explicitamente uma exceção pontual, com critério de encerramento objetivo).

Fluxo:
1. Entender tarefa.
2. Planejar.
3. Implementar.
4. Testar.
5. Corrigir.
6. Entregar relatório.

## Evidências obrigatórias

Cada agente deve gravar **relatórios e artefatos de task** nos caminhos abaixo. O valor de negócio vem do **software testável** entregue; os ficheiros listados comprovam o processo e o resultado.

O orquestrador indica no prompt o **diretório do projeto** (por exemplo `workspaces/barber-scheduler/`). Todos os artefatos da task ficam **dentro desse diretório**, nos caminhos relativos abaixo.

Para cada task, usar estes caminhos (relativos à raiz do projeto em `workspaces/<PROJETO>/`):

- docs/tasks/TASK-ID.md
- reports/tasks/TASK-ID-planner.md
- reports/tasks/TASK-ID-dev.md
- reports/tasks/TASK-ID-qa.md
- reports/tasks/TASK-ID-qa-verdict.json
- reports/tasks/TASK-ID-reviewer.md
- evidence/tests/TASK-ID-test-output.txt

O Dev Agent deve:
- listar arquivos alterados (código e testes)
- informar comandos executados
- **compilar o projeto com sucesso** (`npm run build --prefix workspaces/<projeto>` ou equivalente) **antes** de encerrar a entrega
- documentar build na secção **## Compilação** de `reports/tasks/TASK-ID-dev.md` (comando, exit code, resumo)
- informar se conseguiu rodar testes

Não há passo separado de build no orquestrador: a compilação é critério de saída do Dev (abordagem soft). Erros de compilação não devem ser deixados para o QA.

O QA Agent deve:
- ler `evidence/tests/TASK-ID-test-output.txt` quando existir (gerado na task de fechamento)
- na **task de fechamento**, gravar veredito em `reports/scopes/<MICRO-ID>-qa-verdict.json` e relatório em `reports/scopes/<MICRO-ID>-qa.md`
- em fluxo legado por task: `reports/tasks/TASK-ID-qa-verdict.json`
- se `verdict` for `fail`, o Dev corrige e o ciclo **testes → QA** repete (limite: `MAX_QA_FAILURE_RETRIES`)

Nunca declarar testes como aprovados sem evidência.
Se o terminal for recusado, registar isso claramente.

## Testes

**Tasks intermediárias:** sem `npm test` nem QA Agent no orquestrador.

**Task de fechamento:** testes integrados + QA do micro (critérios em `micro.acceptance` / `micro.testStrategy`).

O arquivo bruto de evidência pode ser apagado após o QA.
O relatório QA deve preservar o resultado relevante.

## Criação de projeto (descoberta PO/SM)

Agente: `agents/project-discovery.md` — conduz brainstorm **antes** de `POST /api/projects`.

- Sessão em `project_discovery_sessions`; resposta JSON com `decisions`, `readyToCreate`, `proposedName`, `proposedSlug`, `scopeMd`.
- **Nunca assumir** decisões — operador confirma cada item da checklist.
- Criação exige `discoverySessionId` com `status: ready`; escopo vem da sessão, não do body livre.

Agente `agents/macro-scope-help.md` (MacroHelp) permanece só para **refinar** escopo macro de projetos já existentes.
