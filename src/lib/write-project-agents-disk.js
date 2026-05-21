import fs from "node:fs";
import path from "node:path";
import { fileForRole } from "./agent-roles.js";
import { tenantWorkspacesDir } from "./tenant-paths.js";
import { getEffectiveAgentConfigForProject } from "../services/agent-config-service.js";

/**
 * Escreve prompts efetivos do projeto no workspace (sem passar pelo worker).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function writeProjectAgentsToDisk(tenantId, projectSlug) {
  const roles = await getEffectiveAgentConfigForProject(tenantId, projectSlug);
  const wsRoot = path.join(tenantWorkspacesDir(tenantId), projectSlug);
  fs.mkdirSync(path.join(wsRoot, "agents"), { recursive: true });

  for (const [roleKey, content] of Object.entries(roles)) {
    const rel = fileForRole(roleKey);
    const dest =
      rel === "AGENTS.md"
        ? path.join(wsRoot, "AGENTS.md")
        : path.join(wsRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
  }

  return Object.keys(roles).length;
}
