import test from "node:test";
import assert from "node:assert/strict";
import {
  assessProjectCompletion,
  isProjectFullyComplete,
  tryCompleteProjectFromLiveState,
} from "./project-completion-service.js";

test("isProjectFullyComplete: exige wavesCompleteScenario e tasks done", () => {
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: true }, [
      { id: "T1", status: "done" },
    ]),
    true
  );
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: true }, [
      { id: "T1", status: "blocked", blockReason: "agent" },
    ]),
    false
  );
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: false }, [
      { id: "T1", status: "done" },
    ]),
    false
  );
});

test("assessProjectCompletion: backlog done com runtime desincronizado", () => {
  const scope = {
    wavesCompleteScenario: true,
    microCount: 1,
    microsPendingPo: 0,
    microsApproved: 1,
    openMicro: null,
  };
  const backlog = [{ id: "T1", sourceMicroId: "M1", status: "done" }];
  const runtime = [{ id: "T1", status: "development" }];
  assert.equal(
    assessProjectCompletion(scope, backlog, runtime, null),
    true
  );
});

test("assessProjectCompletion: runtime done com backlog todo e openMicro stale", () => {
  const scope = {
    wavesCompleteScenario: false,
    microCount: 2,
    microsPendingPo: 0,
    microsApproved: 2,
    openMicro: { id: "M1" },
  };
  const backlog = [
    { id: "T1", sourceMicroId: "M1", status: "todo" },
    { id: "T2", sourceMicroId: "M2", status: "todo" },
  ];
  const runtime = [
    { id: "T1", status: "done" },
    { id: "T2", status: "done" },
  ];
  assert.equal(assessProjectCompletion(scope, backlog, runtime, null), true);
});

test("assessProjectCompletion: micro aberto impede finalização", () => {
  const scope = { wavesCompleteScenario: false, openMicro: { id: "M2" } };
  const backlog = [{ id: "T1", sourceMicroId: "M1", status: "done" }];
  assert.equal(assessProjectCompletion(scope, backlog, [], "M2"), false);
});

test("assessProjectCompletion: wavesCompleteScenario ignora openMicroId stale na wave", () => {
  const scope = {
    wavesCompleteScenario: true,
    microCount: 2,
    microsPendingPo: 0,
    microsApproved: 2,
    openMicro: null,
  };
  const backlog = [
    { id: "T1", sourceMicroId: "M1", status: "done" },
    { id: "T2", sourceMicroId: "M2", status: "done" },
  ];
  assert.equal(assessProjectCompletion(scope, backlog, [], "M2"), true);
});

test("tryCompleteProjectFromLiveState exportado", () => {
  assert.equal(typeof tryCompleteProjectFromLiveState, "function");
});