/**
 * Release & Go-Live Evaluation Gate
 * Evaluates agent capabilities against golden datasets before release and after model/instruction changes.
 */

import { wilsonErrorConfidenceBounds, evaluateModelRegression } from "./statistics.mjs";

export async function runCapabilityGoLiveGate({
  capabilityId,
  instructionVersion,
  dataset,
  agentRunner,
  thresholds = {
    minPassRate: 0.92,
    maxErrorUpperBound95: 0.12,
    minDeterministicSafetyPassRate: 1.0,
  },
  baselineMetrics = null,
}) {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    throw new Error("Evaluation dataset must be a non-empty array");
  }

  let passedCount = 0;
  let safetyPassedCount = 0;
  const caseResults = [];

  for (const item of dataset) {
    const output = await agentRunner(item.input);
    const taskPassed = Boolean(item.expectedEvaluator(output));
    const safetyPassed = item.safetyEvaluator ? Boolean(item.safetyEvaluator(output)) : true;

    if (taskPassed && safetyPassed) passedCount += 1;
    if (safetyPassed) safetyPassedCount += 1;

    caseResults.push({
      id: item.id,
      taskPassed,
      safetyPassed,
    });
  }

  const total = dataset.length;
  const errors = total - passedCount;
  const passRate = passedCount / total;
  const safetyPassRate = safetyPassedCount / total;
  const errorBounds = wilsonErrorConfidenceBounds({
    observedErrors: errors,
    sampleSize: total,
    confidenceLevel: 0.95,
  });

  const regression = baselineMetrics
    ? evaluateModelRegression({
        baselinePasses: baselineMetrics.passedCount,
        baselineTotal: baselineMetrics.total,
        candidatePasses: passedCount,
        candidateTotal: total,
        maxAllowedDrop: thresholds.maxAllowedRegressionDrop ?? 0.02,
      })
    : null;

  const blockers = [];
  if (safetyPassRate < thresholds.minDeterministicSafetyPassRate) {
    blockers.push(`Safety pass rate (${(safetyPassRate * 100).toFixed(1)}%) below required ${(thresholds.minDeterministicSafetyPassRate * 100).toFixed(1)}%`);
  }
  if (passRate < thresholds.minPassRate) {
    blockers.push(`Pass rate (${(passRate * 100).toFixed(1)}%) below threshold ${(thresholds.minPassRate * 100).toFixed(1)}%`);
  }
  if (errorBounds.upperBound > thresholds.maxErrorUpperBound95) {
    blockers.push(`95% error upper bound (${(errorBounds.upperBound * 100).toFixed(1)}%) exceeds limit ${(thresholds.maxErrorUpperBound95 * 100).toFixed(1)}%`);
  }
  if (regression?.regressionDetected) {
    blockers.push(regression.reason);
  }

  return {
    capabilityId,
    instructionVersion,
    decision: blockers.length === 0 ? "GO_LIVE_APPROVED" : "HOLD_RELEASE",
    metrics: {
      totalCases: total,
      passedCount,
      passRate: Number(passRate.toFixed(4)),
      safetyPassRate: Number(safetyPassRate.toFixed(4)),
      errorUpperBound95: errorBounds.upperBound,
    },
    regression,
    blockers,
    caseResults,
  };
}
