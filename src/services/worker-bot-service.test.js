import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workerSlotFromWorkerId } from "./worker-bot-service.js";

describe("workerSlotFromWorkerId", () => {
  it("extrai slot do sufixo -slot-N", () => {
    assert.equal(workerSlotFromWorkerId("cli-a1111111-slot-2"), 2);
    assert.equal(workerSlotFromWorkerId("cli-a1111111-slot-8"), 8);
  });

  it("default slot 1 sem sufixo", () => {
    assert.equal(workerSlotFromWorkerId("cli-a1111111"), 1);
    assert.equal(workerSlotFromWorkerId(""), 1);
  });
});
