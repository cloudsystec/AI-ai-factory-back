import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool.js";
import { readMacroScopeFromDisk } from "../lib/resolve-project-scope.js";
import { tenantMacroDir, tenantWorkspacesDir } from "../lib/tenant-paths.js";

/**
 * @param {string} microPath
 * @returns {object[]}
 */
function readMicrosFile(microPath) {
  if (!fs.existsSync(microPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(microPath, "utf-8").replace(/^\uFEFF/, ""));
    if (Array.isArray(raw)) return raw;
    for (const key of ["microscopes", "microScopes", "items"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} [macroId]
 */
export function countProjectMicros(tenantId, projectSlug, macroId = projectSlug) {
  const microPath = path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "scopes",
    "micro",
    `${macroId}.micro.json`
  );
  return readMicrosFile(microPath).length;
}

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function getProjectMacroScope(tenantId, slug) {
  const { rows } = await query(
    "SELECT name, scope_md FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, slug]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }

  let scopeMd = String(rows[0].scope_md ?? "").trim();
  const fromDisk = readMacroScopeFromDisk(tenantId, slug);
  if (!scopeMd && fromDisk.scopeMd) {
    scopeMd = fromDisk.scopeMd;
  }

  const microCount = countProjectMicros(tenantId, slug);

  return {
    slug,
    name: rows[0].name,
    scopeMd,
    microCount,
    editable: microCount === 0,
  };
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {string} scopeMd
 */
export async function updateProjectMacroScope(tenantId, slug, scopeMd) {
  const trimmed = String(scopeMd ?? "").trim();
  if (!trimmed) {
    throw Object.assign(new Error("Escopo macro não pode estar vazio."), { status: 400 });
  }

  if (countProjectMicros(tenantId, slug) > 0) {
    throw Object.assign(
      new Error(
        "O escopo macro não pode ser editado depois de existirem microescopos. Remova os micros no CLI ou repõe o planeamento."
      ),
      { status: 409, code: "MACRO_SCOPE_LOCKED" }
    );
  }

  const { rows } = await query(
    "SELECT name FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, slug]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }

  const name = String(rows[0].name ?? "").trim() || slug;

  await query(
    `UPDATE projects SET scope_md = $3 WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug, trimmed]
  );

  const macroPath = path.join(tenantMacroDir(tenantId), `${slug}.md`);
  fs.mkdirSync(path.dirname(macroPath), { recursive: true });
  fs.writeFileSync(macroPath, `# ${name}\n\n${trimmed}\n`, "utf-8");

  return { slug, name, scopeMd: trimmed, editable: true, microCount: 0 };
}
