/**
 * Utilitários para task de fechamento (isMicroCloser) e QA no micro.
 * Espelho de ai-factory-cli/orchestrator/micro-task-utils.js
 */

const CLOSER_ACTIVE_STATUSES = new Set([
  "running",
  "development",
  "testing",
  "planning",
  "review",
  "queued",
  "in_progress",
]);

export function isMicroCloserTask(task) {
  return task?.isMicroCloser === true;
}

export function getMicroCloserTask(microTasks) {
  return microTasks.find((t) => isMicroCloserTask(t));
}

export function getNonCloserTasks(microTasks) {
  return microTasks.filter((t) => !isMicroCloserTask(t));
}

export function allNonCloserTasksDone(microTasks, stateByTaskId, isDone) {
  const nonCloser = getNonCloserTasks(microTasks);
  if (nonCloser.length === 0) return true;
  return nonCloser.every((t) => isDone(t, stateByTaskId));
}

export function shouldRunTaskQa(task, micro) {
  return isMicroCloserTask(task) && Boolean(micro);
}

export async function filterEligibleForMicroCloser(
  eligible,
  microTasks,
  stateByTaskId,
  isDone,
  nonCloserPrsMerged
) {
  const closer = getMicroCloserTask(microTasks);
  if (!closer) return eligible;

  const closerInEligible = eligible.some((t) => t.id === closer.id);
  const closerRunning = microTasks.some((t) => {
    if (!isMicroCloserTask(t)) return false;
    const rt = stateByTaskId.get(t.id);
    return rt?.status && CLOSER_ACTIVE_STATUSES.has(rt.status);
  });

  if (closerRunning) {
    return eligible.filter((t) => t.id === closer.id);
  }

  const nonCloserDone = allNonCloserTasksDone(microTasks, stateByTaskId, isDone);
  const prsMerged = nonCloserDone ? await nonCloserPrsMerged() : false;

  if (closerInEligible && nonCloserDone && prsMerged) {
    return eligible.filter((t) => t.id === closer.id);
  }

  return eligible.filter((t) => t.id !== closer.id);
}

export async function isCloserEligible(microTasks, stateByTaskId, isDone, nonCloserPrsMerged) {
  const closer = getMicroCloserTask(microTasks);
  if (!closer) return false;
  if (isDone(closer, stateByTaskId)) return false;
  if (!allNonCloserTasksDone(microTasks, stateByTaskId, isDone)) return false;
  return nonCloserPrsMerged();
}
