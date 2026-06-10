import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";

/**
 * @param {string | string[]} to
 * @returns {string[]}
 */
export function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : [to];
  return list
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

/**
 * @param {ReturnType<import('../email-config.js').loadEmailConfig>} cfg
 * @returns {import('../types.js').EmailProvider}
 */
export function createSesEmailProvider(cfg) {
  const client = new SESv2Client({
    region: cfg.region,
    credentials: {
      accessKeyId: String(process.env.AWS_ACCESS_KEY_ID || ""),
      secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || ""),
    },
  });

  const fromAddress = cfg.fromName
    ? `${cfg.fromName} <${cfg.from}>`
    : cfg.from;

  return {
    async send(input) {
      const to = normalizeRecipients(input.to);
      if (to.length === 0) {
        throw Object.assign(new Error("Destinatário obrigatório"), {
          status: 400,
        });
      }

      const hasText = Boolean(input.text?.trim());
      const hasHtml = Boolean(input.html?.trim());
      if (!hasText && !hasHtml) {
        throw Object.assign(
          new Error("text ou html obrigatório para envio de e-mail"),
          { status: 400 }
        );
      }

      /** @type {import('@aws-sdk/client-sesv2').SendEmailCommandInput} */
      const params = {
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: to },
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: {},
          },
        },
      };

      if (hasText) {
        params.Content.Simple.Body.Text = {
          Data: input.text,
          Charset: "UTF-8",
        };
      }
      if (hasHtml) {
        params.Content.Simple.Body.Html = {
          Data: input.html,
          Charset: "UTF-8",
        };
      }

      if (input.replyTo || cfg.replyTo) {
        params.ReplyToAddresses = [input.replyTo || cfg.replyTo].filter(Boolean);
      }

      if (cfg.configurationSet) {
        params.ConfigurationSetName = cfg.configurationSet;
      }

      try {
        const result = await client.send(new SendEmailCommand(params));
        return { messageId: result.MessageId || "ses-unknown" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Falha ao enviar e-mail via SES: ${message}`);
      }
    },
  };
}
