/**
 * Logging HTTP / serviços — stdout para Docker.
 * AI_FACTORY_LOG_COLOR=1 | AI_FACTORY_LOG_LEVEL=debug|info|warn|error
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function useColor() {
  if (process.env.AI_FACTORY_LOG_COLOR === "0") return false;
  if (process.env.AI_FACTORY_LOG_COLOR === "1") return true;
  return process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY);
}

function minLevel() {
  const v = (process.env.AI_FACTORY_LOG_LEVEL || "info").toLowerCase();
  return LEVELS[v] ?? LEVELS.info;
}

/**
 * @param {string} s
 * @param {string} [code]
 */
function paint(s, code) {
  if (!useColor() || !code) return s;
  return `${code}${s}${C.reset}`;
}

function ts() {
  return new Date().toISOString();
}

/**
 * @param {string} component
 */
export function createLogger(component) {
  const tag = `[${component}]`;

  /**
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} msg
   * @param {Record<string, unknown>} [meta]
   */
  function write(level, msg, meta) {
    if (LEVELS[level] < minLevel()) return;
    const levelColors = {
      debug: C.gray,
      info: C.green,
      warn: C.yellow,
      error: C.red,
    };
    const lvl = level.toUpperCase().padEnd(5);
    let line = `${paint(ts(), C.gray)} ${paint(lvl, levelColors[level])} ${paint(tag, C.dim)} ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      line += paint(
        ` ${Object.entries(meta)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
        C.dim
      );
    }
    const out = level === "error" ? process.stderr : process.stdout;
    out.write(line + "\n");
  }

  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}

const httpLog = createLogger("http");

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} ms
 */
export function logHttpRequest(req, res, ms) {
  if (req.path === "/health") return;
  const status = res.statusCode;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const statusPaint =
    status >= 500 ? C.red : status >= 400 ? C.yellow : status >= 300 ? C.cyan : C.green;
  const msg = paint(String(status), statusPaint) + ` ${req.method} ${req.originalUrl || req.url}`;
  httpLog[level](msg, { ms, ip: req.ip });
}

export const log = createLogger("back");
