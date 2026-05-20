/**
 * Catálogo fixo de roles de agente (role_key ↔ ficheiro no volume do tenant).
 */

/** @type {readonly { roleKey: string, file: string }[]} */
export const AGENT_ROLES = [
  { roleKey: "global", file: "AGENTS.md" },
  { roleKey: "planner", file: "agents/planner.md" },
  { roleKey: "dev", file: "agents/dev.md" },
  { roleKey: "qa", file: "agents/qa.md" },
  { roleKey: "reviewer", file: "agents/reviewer.md" },
  { roleKey: "macro_to_micro", file: "agents/macro-to-micro.md" },
  { roleKey: "po_micro_validator", file: "agents/po-micro-validator.md" },
  { roleKey: "micro_refiner", file: "agents/micro-refiner.md" },
  { roleKey: "micro_prioritizer", file: "agents/micro-prioritizer.md" },
  { roleKey: "micro_to_tasks", file: "agents/micro-to-tasks.md" },
  { roleKey: "techlead_task_validator", file: "agents/techlead-task-validator.md" },
  { roleKey: "task_refiner", file: "agents/task-refiner.md" },
  { roleKey: "task_prioritizer", file: "agents/task-prioritizer.md" },
];

const fileToRole = new Map(AGENT_ROLES.map((r) => [r.file, r.roleKey]));
const roleToFile = new Map(AGENT_ROLES.map((r) => [r.roleKey, r.file]));

export function fileForRole(roleKey) {
  const f = roleToFile.get(roleKey);
  if (!f) throw new Error(`role_key desconhecido: ${roleKey}`);
  return f;
}

export function roleKeyForAgentPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return fileToRole.get(normalized) || null;
}

export function allRoleKeys() {
  return AGENT_ROLES.map((r) => r.roleKey);
}
