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
- ler `evidence/tests/TASK-ID-test-output.txt` quando existir (o orquestrador gera a evidência antes do QA)
- gravar `reports/tasks/TASK-ID-qa.md` com exit code, falhas e observações
- gravar **`reports/tasks/TASK-ID-qa-verdict.json`** com JSON `{ "verdict": "pass"|"fail", "summary": "..." }` — o orquestrador **só** chama o Reviewer se `verdict` for `pass`; se for `fail`, o Dev corrige e o ciclo **testes → QA** repete (limite: variável de ambiente `MAX_QA_FAILURE_RETRIES`, predefinição 5 rejeições após a primeira QA)

Nunca declarar testes como aprovados sem evidência.
Se o terminal for recusado, registar isso claramente.

## Testes

Os testes são executados pelo orquestrador local, não pelo agente.

O arquivo bruto de evidência pode ser apagado após o QA e Reviewer.
O relatório QA deve preservar o resultado relevante.
