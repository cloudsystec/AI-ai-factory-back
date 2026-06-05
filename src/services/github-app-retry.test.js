import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Espelha isRetryableGitHubError de github-app-service.js (não exportada).
 * @param {unknown} e
 */
function isRetryableGitHubError(e) {
  const status = Number(e?.status);
  if ([401, 403, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(e?.cause?.code || e?.code || "");
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(code);
}

describe("github app retry policy", () => {
  it("retries 401 Bad credentials intermitente", () => {
    assert.equal(isRetryableGitHubError({ status: 401, message: "Bad credentials" }), true);
  });

  it("retries 429 rate limit", () => {
    assert.equal(isRetryableGitHubError({ status: 429 }), true);
  });

  it("não retenta 404/422 de negócio", () => {
    assert.equal(isRetryableGitHubError({ status: 404 }), false);
    assert.equal(isRetryableGitHubError({ status: 422 }), false);
  });

  it("retenta erros de rede", () => {
    assert.equal(isRetryableGitHubError({ cause: { code: "ECONNRESET" } }), true);
  });
});
