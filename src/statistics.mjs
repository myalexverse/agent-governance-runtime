/**
 * Applied Statistics Engine for AI Agent Evaluation & Campaign Governance
 * - Finite-population review sample sizing (Cochran + finite population correction)
 * - Wilson score confidence intervals for error-rate estimation from review samples
 * - Statistical regression detection across model or instruction changes (Two-proportion z-test)
 */

const Z_SCORES = {
  0.90: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
};

export function getZScore(confidenceLevel = 0.95) {
  const z = Z_SCORES[confidenceLevel];
  if (!z) {
    throw new Error(`Unsupported confidence level: ${confidenceLevel}. Use 0.90, 0.95, or 0.99.`);
  }
  return z;
}

/**
 * Computes statistically sized human-review sample before releasing high-volume campaign actions.
 * Uses Cochran's formula with Finite Population Correction (FPC).
 */
export function calculateReviewSampleSize({
  populationSize,
  confidenceLevel = 0.95,
  marginOfError = 0.03,
  expectedErrorRate = 0.05,
}) {
  if (!Number.isInteger(populationSize) || populationSize <= 0) {
    throw new Error("populationSize must be a positive integer");
  }
  if (marginOfError <= 0 || marginOfError >= 1) {
    throw new Error("marginOfError must be in (0, 1)");
  }
  if (expectedErrorRate <= 0 || expectedErrorRate >= 1) {
    throw new Error("expectedErrorRate must be in (0, 1)");
  }

  const z = getZScore(confidenceLevel);
  const p = expectedErrorRate;
  const n0 = (z * z * p * (1 - p)) / (marginOfError * marginOfError);
  const n = Math.ceil(n0 / (1 + (n0 - 1) / populationSize));
  return Math.min(populationSize, Math.max(1, n));
}

/**
 * Computes the Wilson Score Confidence Interval [lowerBound, upperBound] for an observed error rate.
 * Critical for Go-Live Gates: we gate on the UPPER confidence bound of the error rate, not just point estimate.
 */
export function wilsonErrorConfidenceBounds({
  observedErrors,
  sampleSize,
  confidenceLevel = 0.95,
}) {
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new Error("sampleSize must be a positive integer");
  }
  if (!Number.isInteger(observedErrors) || observedErrors < 0 || observedErrors > sampleSize) {
    throw new Error("observedErrors must be an integer between 0 and sampleSize");
  }

  const z = getZScore(confidenceLevel);
  const z2 = z * z;
  const pHat = observedErrors / sampleSize;
  const denominator = 1 + z2 / sampleSize;
  const center = (pHat + z2 / (2 * sampleSize)) / denominator;
  const halfWidth =
    (z * Math.sqrt((pHat * (1 - pHat)) / sampleSize + z2 / (4 * sampleSize * sampleSize))) /
    denominator;

  return {
    pointEstimate: Number(pHat.toFixed(6)),
    lowerBound: Number(Math.max(0, center - halfWidth).toFixed(6)),
    upperBound: Number(Math.min(1, center + halfWidth).toFixed(6)),
    confidenceLevel,
    sampleSize,
    observedErrors,
  };
}

/**
 * Evaluates whether a model or instruction change caused a statistically significant quality regression.
 */
export function evaluateModelRegression({
  baselinePasses,
  baselineTotal,
  candidatePasses,
  candidateTotal,
  maxAllowedDrop = 0.02,
  confidenceLevel = 0.95,
}) {
  if (baselineTotal <= 0 || candidateTotal <= 0) {
    throw new Error("Sample totals must be positive");
  }
  const pBase = baselinePasses / baselineTotal;
  const pCand = candidatePasses / candidateTotal;
  const delta = pCand - pBase; // negative means degradation

  const pooled = (baselinePasses + candidatePasses) / (baselineTotal + candidateTotal);
  const se = Math.sqrt(
    Math.max(1e-12, pooled * (1 - pooled) * (1 / baselineTotal + 1 / candidateTotal))
  );
  const zStat = (pBase - pCand) / se;
  const zCritical = getZScore(confidenceLevel);

  const statisticallySignificantDrop = zStat >= zCritical && pCand < pBase;
  const exceedsDropTolerance = pBase - pCand > maxAllowedDrop;

  return {
    baselinePassRate: Number(pBase.toFixed(4)),
    candidatePassRate: Number(pCand.toFixed(4)),
    deltaPassRate: Number(delta.toFixed(4)),
    zStatistic: Number(zStat.toFixed(4)),
    regressionDetected: statisticallySignificantDrop || exceedsDropTolerance,
    reason:
      statisticallySignificantDrop
        ? "Statistically significant quality degradation detected"
        : exceedsDropTolerance
        ? `Quality drop (${((pBase - pCand) * 100).toFixed(2)}%) exceeds tolerance (${(maxAllowedDrop * 100).toFixed(2)}%)`
        : "No regression detected",
  };
}
