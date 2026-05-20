import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logListKey, logLiveChannel, getJobLogTtlSeconds } from "./job-log-redis.js";

describe("job-log-redis keys", () => {
  it("logListKey", () => {
    assert.equal(logListKey("job-1"), "aifactory:job:job-1:log");
  });

  it("logLiveChannel", () => {
    assert.equal(logLiveChannel("job-1"), "aifactory:job:job-1:live");
  });

  it("getJobLogTtlSeconds default", () => {
    const prev = process.env.JOB_LOG_TTL_SECONDS;
    delete process.env.JOB_LOG_TTL_SECONDS;
    assert.equal(getJobLogTtlSeconds(), 604800);
    if (prev !== undefined) process.env.JOB_LOG_TTL_SECONDS = prev;
  });
});
