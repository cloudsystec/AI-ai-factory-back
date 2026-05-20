/**
 * Validação de slug (sem dependência do orchestrator).
 * @param {string} project
 */
export function isValidProjectSlug(project) {
  return typeof project === "string" && /^[a-zA-Z0-9_-]+$/.test(project);
}
