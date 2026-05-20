/**
 * Estado mínimo de scope-state quando ainda não há snapshot no Postgres.
 * Espelha o formato de orchestrator/scope-dashboard-state.js.
 * @param {string} project
 */
export function emptyScopeState(project) {
  return {
    project,
    macroId: project,
    paths: { macro: "", micro: "", backlog: "" },
    macroExists: false,
    microCount: 0,
    microsPendingPo: 0,
    microsApproved: 0,
    openMicro: null,
    waveTaskStats: {
      total: 0,
      pendingTl: 0,
      todoApproved: 0,
      allDone: false,
    },
    current: {
      key: "awaiting_sync",
      label: "A aguardar sincronização do worker",
      hint: "Crie o projeto ou execute Scope no CLI; o snapshot aparece após o job.",
    },
    scopeSteps: [
      { key: "macro", label: "Macro", state: "active" },
      { key: "micro", label: "Micros & PO", state: "pending" },
      { key: "tasking", label: "Tasks (onda)", state: "pending" },
      { key: "dev", label: "Implementação", state: "pending" },
    ],
    devPipelineActive: false,
    wavesCompleteScenario: false,
  };
}
