import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool.js";
import { tenantMacroDir } from "./tenant-paths.js";

/**
 * Lê escopo do ficheiro macro no volume do CLI (`scopes/macro/<slug>.md`).
 * @param {string} tenantId
 * @param {string} slug
 */
export function readMacroScopeFromDisk(tenantId, slug) {
  const macroPath = path.join(tenantMacroDir(tenantId), `${slug}.md`);
  if (!fs.existsSync(macroPath)) {
    return { scopeMd: "", name: null };
  }

  const raw = fs.readFileSync(macroPath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  let name = null;
  let bodyStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim() || null;
    bodyStart = 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
      bodyStart += 1;
    }
  }

  const scopeMd = lines.slice(bodyStart).join("\n").trim();
  return { scopeMd, name };
}

/**
 * Escopo canónico: BD primeiro; se vazio, macro no disco; repõe BD sem apagar escopo existente.
 * @param {string} tenantId
 * @param {{ slug: string, name?: string|null, scope_md?: string|null }} project
 */
export async function resolveProjectScopeMd(tenantId, project) {
  const slug = project.slug;
  let scopeMd = String(project.scope_md ?? "").trim();
  let name = String(project.name ?? "").trim() || slug;

  const fromDisk = readMacroScopeFromDisk(tenantId, slug);

  if (!scopeMd && fromDisk.scopeMd) {
    scopeMd = fromDisk.scopeMd;
    if (fromDisk.name) name = fromDisk.name;
    await query(
      `UPDATE projects SET scope_md = $3 WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, slug, scopeMd]
    );
  }

  if (!scopeMd) {
    throw Object.assign(
      new Error(
        "Escopo não encontrado. Defina o escopo ao criar o projeto ou mantenha scopes/macro/<slug>.md no volume do tenant."
      ),
      { status: 400, code: "SCOPE_MISSING" }
    );
  }

  return { name, scopeMd };
}
