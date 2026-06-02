import test from "node:test";
import assert from "node:assert/strict";
import {
  assessProjectCompletion,
  isProjectFullyComplete,
  tryCompleteProjectFromLiveState,
} from "./project-completion-service.js";

const baseScope = {
  wavesCompleteScenario: true,
  microCount: 2,
  microsPendingPo: 0,
  microsApproved: 2,
  openMicro: null,
  micros: [{ id: "M1" }, { id: "M2" }],
};

const mergedReleases = new Map([
  ["M1", { release_status: "merged", merged_at: new Date() }],
  ["M2", { release_status: "merged", merged_at: new Date() }],
]);

function completionOpts(overrides = {}) {
  return {
    waveOpenMicroId: null,
    releaseByMicro: mergedReleases,
    approvedMicroIds: ["M1", "M2"],
    ...overrides,
  };
}

test("isProjectFullyComplete: exige wavesCompleteScenario e tasks done", () => {
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: true, allTasksSuccessful: true }, [
      { id: "T1", status: "done" },
    ]),
    true
  );
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: true, allTasksSuccessful: true }, [
      { id: "T1", status: "blocked", blockReason: "agent" },
    ]),
    false
  );
  assert.equal(
    isProjectFullyComplete({ wavesCompleteScenario: false, allTasksSuccessful: true }, [
      { id: "T1", status: "done" },
    ]),
    false
  );
});

test("assessProjectCompletion: exige runtime done (backlog done não basta)", () => {
  const backlog = [{ id: "T1", sourceMicroId: "M1", status: "done" }];
  const runtime = [{ id: "T1", status: "development" }];
  assert.equal(
    assessProjectCompletion(baseScope, backlog, runtime, completionOpts()),
    false
  );
});

test("assessProjectCompletion: tasks done mas micro sem release merged", () => {
  const backlog = [
    { id: "T1", sourceMicroId: "M1", status: "done" },
    { id: "T2", sourceMicroId: "M2", status: "done" },
  ];
  const runtime = [
    { id: "T1", status: "done" },
    { id: "T2", status: "done" },
  ];
  assert.equal(
    assessProjectCompletion(baseScope, backlog, runtime, completionOpts({ releaseByMicro: new Map() })),
    false
  );
});

test("assessProjectCompletion: task done com failedStep impede finalização", () => {
  const backlog = [{ id: "T1", sourceMicroId: "M1", status: "done" }];
  const runtime = [{ id: "T1", status: "done", failedStep: "qa" }];
  assert.equal(
    assessProjectCompletion(baseScope, backlog, runtime, completionOpts()),
    false
  );
});

test("assessProjectCompletion: micro aberto impede finalização", () => {
  const scope = {
    ...baseScope,
    wavesCompleteScenario: false,
    openMicro: { id: "M2" },
  };
  const backlog = [{ id: "T1", sourceMicroId: "M1", status: "done" }];
  assert.equal(
    assessProjectCompletion(scope, backlog, [], completionOpts({ waveOpenMicroId: "M2" })),
    false
  );
});

test("assessProjectCompletion: runtime done sem ondas completas não finaliza", () => {
  const scope = {
    ...baseScope,
    wavesCompleteScenario: false,
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
  assert.equal(
    assessProjectCompletion(scope, backlog, runtime, completionOpts()),
    false
  );
});

test("assessProjectCompletion: tudo concluído com sucesso", () => {
  const backlog = [
    { id: "T1", sourceMicroId: "M1", status: "done" },
    { id: "T2", sourceMicroId: "M2", status: "done" },
  ];
  const runtime = [
    { id: "T1", status: "done" },
    { id: "T2", status: "done" },
  ];
  assert.equal(
    assessProjectCompletion(baseScope, backlog, runtime, completionOpts()),
    true
  );
});

test("tryCompleteProjectFromLiveState exportado", () => {
  assert.equal(typeof tryCompleteProjectFromLiveState, "function");
});
