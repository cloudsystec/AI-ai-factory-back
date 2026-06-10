/**

 * @returns {string | null}

 */

export function resolvePublicFrontUrl() {

  const explicit = String(process.env.PUBLIC_FRONT_URL || "").trim();

  if (explicit) return explicit.replace(/\/$/, "");

  const cors = String(process.env.CORS_ORIGIN || "")

    .split(",")

    .map((v) => v.trim())

    .filter(Boolean)[0];

  return cors || null;

}



/**

 * URL de login no front (PUBLIC_FRONT_URL/login). Opcionalmente pré-preenche ?email=

 * @param {string} [recipientEmail]

 * @returns {string}

 */

export function resolveLoginUrl(recipientEmail) {

  const base =

    resolvePublicFrontUrl() ||

    String(process.env.LOGIN_URL || "").trim().replace(/\/$/, "") ||

    "https://www.devforless.com.br";

  const loginPath = base.endsWith("/login") ? base : `${base}/login`;

  const email = String(recipientEmail || "").trim();

  if (!email) return loginPath;

  const sep = loginPath.includes("?") ? "&" : "?";

  return `${loginPath}${sep}email=${encodeURIComponent(email)}`;

}



/**

 * @returns {string | null}

 */

export function resolveEmailLogoUrl() {

  const base = resolvePublicFrontUrl();

  if (!base) return null;

  return `${base}/brand/devforless-lockup-white.svg`;

}



/**

 * @param {string | undefined | null} raw

 * @returns {string}

 */

function normalizeProviderName(raw) {

  const v = String(raw || "").trim().toLowerCase();

  if (v === "ses" || v === "postmark" || v === "console" || v === "noop") {

    return v;

  }

  return "";

}



/**

 * @returns {boolean}

 */

export function hasSesCredentials() {

  return Boolean(

    String(process.env.AWS_ACCESS_KEY_ID || "").trim() &&

      String(process.env.AWS_SECRET_ACCESS_KEY || "").trim() &&

      String(process.env.AWS_REGION || "").trim()

  );

}



/**

 * @returns {boolean}

 */

export function hasPostmarkCredentials() {

  return Boolean(

    String(process.env.POSTMARK_SERVER_TOKEN || "").trim() ||

      String(process.env.POSTMARK_API_TOKEN || "").trim()

  );

}



/**

 * @returns {string}

 */

export function resolveEmailProviderName() {

  const explicit = normalizeProviderName(process.env.EMAIL_PROVIDER);

  if (explicit) return explicit;

  if (hasSesCredentials()) return "ses";

  return "console";

}



/**

 * @returns {{

 *   provider: string,

 *   from: string,

 *   fromName: string | null,

 *   replyTo: string | null,

 *   region: string | null,

 *   configurationSet: string | null,

 *   postmarkMessageStream: string | null,

 *   publicFrontUrl: string | null,

 * }}

 */

export function loadEmailConfig() {

  const from = String(process.env.EMAIL_FROM || "").trim();

  const fromName = String(process.env.EMAIL_FROM_NAME || "").trim() || null;

  const replyTo = String(process.env.EMAIL_REPLY_TO || "").trim() || null;

  const region = String(process.env.AWS_REGION || "").trim() || null;

  const configurationSet =

    String(process.env.AWS_SES_CONFIGURATION_SET || "").trim() || null;

  const postmarkMessageStream =

    String(process.env.POSTMARK_MESSAGE_STREAM || "").trim() || "outbound";



  return {

    provider: resolveEmailProviderName(),

    from,

    fromName,

    replyTo,

    region,

    configurationSet,

    postmarkMessageStream,

    publicFrontUrl: resolvePublicFrontUrl(),

  };

}



/**

 * @returns {boolean}

 */

export function isEmailConfigured() {

  const cfg = loadEmailConfig();

  if (!cfg.from) return false;

  if (cfg.provider === "noop" || cfg.provider === "console") return true;

  if (cfg.provider === "ses") {

    return hasSesCredentials();

  }

  if (cfg.provider === "postmark") {

    return hasPostmarkCredentials();

  }

  return false;

}



/**

 * @returns {import('./types.js').EmailProvider}

 */

export async function createEmailProvider() {

  const cfg = loadEmailConfig();

  const name = cfg.provider;



  if (name === "noop") {

    const { createNoopEmailProvider } = await import("./providers/noop-provider.js");

    return createNoopEmailProvider();

  }



  if (name === "console") {

    const { createConsoleEmailProvider } = await import(

      "./providers/console-provider.js"

    );

    return createConsoleEmailProvider();

  }



  if (name === "ses") {

    if (!cfg.from) {

      throw new Error("EMAIL_FROM não configurado");

    }

    if (!hasSesCredentials()) {

      throw new Error(

        "AWS SES não configurado: defina AWS_REGION, AWS_ACCESS_KEY_ID e AWS_SECRET_ACCESS_KEY"

      );

    }

    const { createSesEmailProvider } = await import("./providers/ses-provider.js");

    return createSesEmailProvider(cfg);

  }



  if (name === "postmark") {

    if (!cfg.from) {

      throw new Error("EMAIL_FROM não configurado");

    }

    const { createPostmarkEmailProvider } = await import(

      "./providers/postmark-provider.js"

    );

    return createPostmarkEmailProvider(cfg);

  }



  throw new Error(`EMAIL_PROVIDER desconhecido: ${name}`);

}


