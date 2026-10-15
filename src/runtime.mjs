/**
 * Governed Multi-Step AI Agent Runtime
 * Enforces:
 * 1. Provider-independent model invocation (OpenAI / Anthropic / Gemini / Local adapters)
 * 2. Full call observability & data provenance recording (model, instructionVersion, provenance, qualityChecks)
 * 3. Accountable action ownership & deterministic pre-execution safeguards
 * 4. Action-level & Campaign-level approval workflows (with statistical sample sizing)
 * 5. Automatic quality-based capability suspension (Kill Switch / Circuit Breaker)
 */

import crypto from "node:crypto";
import { calculateReviewSampleSize, wilsonErrorConfidenceBounds } from "./statistics.mjs";

export class ModelProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(providerName, adapterFn) {
    if (!providerName || typeof adapterFn !== "function") {
      throw new Error("Invalid provider registration");
    }
    this.providers.set(providerName, adapterFn);
  }

  get(providerName) {
    const adapter = this.providers.get(providerName);
    if (!adapter) {
      throw new Error(`Provider '${providerName}' is not registered`);
    }
    return adapter;
  }
}

export class GovernedAgentRuntime {
  constructor({ providerRegistry, capabilities = {} }) {
    this.providerRegistry = providerRegistry;
    this.capabilities = new Map();
    this.auditLedger = [];
    this.campaignApprovals = new Map();

    for (const [id, config] of Object.entries(capabilities)) {
      this.registerCapability(id, config);
    }
  }

  registerCapability(capabilityId, config) {
    if (!config.owner || !config.actionType) {
      throw new Error(`Capability '${capabilityId}' requires an accountable 'owner' and 'actionType'`);
    }
    this.capabilities.set(capabilityId, {
      capabilityId,
      owner: config.owner,
      actionType: config.actionType, // 'send_message' | 'update_record' | 'prepare_decision'
      irreversible: Boolean(config.irreversible),
      externalCommunication: Boolean(config.externalCommunication),
      requiresHumanApproval: Boolean(config.requiresHumanApproval || config.irreversible || config.externalCommunication),
      maxErrorRateUpperBound: config.maxErrorRateUpperBound ?? 0.08,
      minSampleForAutoSuspension: config.minSampleForAutoSuspension ?? 10,
      allowedDataClassifications: new Set(config.allowedDataClassifications ?? ["public", "internal"]),
      deterministicChecks: config.deterministicChecks ?? [],
      suspended: false,
      suspensionReason: null,
      rollingOutcomes: [], // true = pass, false = fail
    });
  }

  /**
   * Records every model call with model ID, instruction version, data provenance, and quality checks.
   */
  async invokeModel({
    provider,
    model,
    instructionVersion,
    systemInstruction,
    prompt,
    dataProvenance,
    qualityValidators = [],
  }) {
    if (!provider || !model || !instructionVersion) {
      throw new Error("Model call requires provider, model, and instructionVersion");
    }
    if (!dataProvenance || !dataProvenance.sourceId || !dataProvenance.classification) {
      throw new Error("Model call requires dataProvenance with sourceId and classification");
    }

    const adapter = this.providerRegistry.get(provider);
    const callId = crypto.randomUUID();
    const startedAt = Date.now();
    const instructionHash = crypto.createHash("sha256").update(String(systemInstruction || "")).digest("hex").slice(0, 16);

    const response = await adapter({ model, systemInstruction, prompt });
    const latencyMs = Date.now() - startedAt;

    const qualityCheckResults = qualityValidators.map((validator) => {
      const passed = Boolean(validator.check(response.output));
      return { name: validator.name, passed };
    });

    const allQualityChecksPassed = qualityCheckResults.every((c) => c.passed);

    const record = Object.freeze({
      callId,
      timestamp: new Date().toISOString(),
      provider,
      model,
      instructionVersion,
      instructionHash,
      dataProvenance: Object.freeze({ ...dataProvenance }),
      qualityChecks: Object.freeze(qualityCheckResults),
      qualityPassed: allQualityChecksPassed,
      latencyMs,
      outputPreview: String(response.output).slice(0, 160),
    });

    this.auditLedger.push(record);
    return { callId, output: response.output, auditRecord: record };
  }

  /**
   * Registers & validates a campaign-level approval with statistically sized review sample before high-volume release.
   */
  submitCampaignReview({
    campaignId,
    capabilityId,
    populationSize,
    reviewedSampleSize,
    observedErrorsInSample,
    approverId,
    confidenceLevel = 0.95,
    marginOfError = 0.05,
    expectedErrorRate = 0.03,
  }) {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) throw new Error(`Unknown capability '${capabilityId}'`);

    const requiredSampleSize = calculateReviewSampleSize({
      populationSize,
      confidenceLevel,
      marginOfError,
      expectedErrorRate,
    });

    const bounds = wilsonErrorConfidenceBounds({
      observedErrors: observedErrorsInSample,
      sampleSize: reviewedSampleSize,
      confidenceLevel,
    });

    const sampleSufficient = reviewedSampleSize >= requiredSampleSize;
    const qualityWithinThreshold = bounds.upperBound <= cap.maxErrorRateUpperBound;
    const approved = Boolean(approverId) && sampleSufficient && qualityWithinThreshold;

    const status = {
      campaignId,
      capabilityId,
      populationSize,
      requiredSampleSize,
      reviewedSampleSize,
      observedErrorsInSample,
      errorUpperBound: bounds.upperBound,
      maxAllowedErrorBound: cap.maxErrorRateUpperBound,
      approverId,
      approved,
      reason: !sampleSufficient
        ? `Insufficient review sample: reviewed ${reviewedSampleSize}, required >= ${requiredSampleSize}`
        : !qualityWithinThreshold
        ? `Error rate 95% upper bound (${(bounds.upperBound * 100).toFixed(2)}%) exceeds threshold (${(cap.maxErrorRateUpperBound * 100).toFixed(2)}%)`
        : "Campaign approved for release",
    };

    this.campaignApprovals.set(campaignId, status);
    return status;
  }

  /**
   * Records runtime quality outcome and triggers automatic suspension (Kill Switch) if threshold is breached.
   */
  recordQualityOutcome(capabilityId, passed) {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) throw new Error(`Unknown capability '${capabilityId}'`);

    cap.rollingOutcomes.push(Boolean(passed));
    if (cap.rollingOutcomes.length > 100) {
      cap.rollingOutcomes.shift();
    }

    if (cap.rollingOutcomes.length >= cap.minSampleForAutoSuspension) {
      const errors = cap.rollingOutcomes.filter((ok) => !ok).length;
      const bounds = wilsonErrorConfidenceBounds({
        observedErrors: errors,
        sampleSize: cap.rollingOutcomes.length,
        confidenceLevel: 0.95,
      });

      if (bounds.upperBound > cap.maxErrorRateUpperBound) {
        cap.suspended = true;
        cap.suspensionReason = `Auto-suspended: 95% error upper bound (${(bounds.upperBound * 100).toFixed(1)}%) exceeded max threshold (${(cap.maxErrorRateUpperBound * 100).toFixed(1)}%) over ${cap.rollingOutcomes.length} actions.`;
      }
    }

    return {
      capabilityId,
      suspended: cap.suspended,
      suspensionReason: cap.suspensionReason,
    };
  }

  /**
   * Executes a governed agent action with accountability, data restrictions, deterministic checks, and approvals.
   */
  executeAction({
    capabilityId,
    payload,
    dataProvenance,
    humanApprovalToken = null,
    campaignId = null,
    modelCallId = null,
  }) {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) {
      throw new Error(`Unregistered capability '${capabilityId}'`);
    }

    // 1. Check Kill Switch / Quality Suspension
    if (cap.suspended) {
      return {
        status: "BLOCKED_SUSPENDED",
        owner: cap.owner,
        reason: cap.suspensionReason,
      };
    }

    // 2. Enforce Data Classification Restrictions
    if (!dataProvenance || !cap.allowedDataClassifications.has(dataProvenance.classification)) {
      return {
        status: "BLOCKED_DATA_RESTRICTION",
        owner: cap.owner,
        reason: `Data classification '${dataProvenance?.classification}' is not permitted for capability '${capabilityId}'`,
      };
    }

    // 3. Run Deterministic Pre-Execution Safeguards
    for (const check of cap.deterministicChecks) {
      const ok = Boolean(check.validate(payload));
      if (!ok) {
        this.recordQualityOutcome(capabilityId, false);
        return {
          status: "BLOCKED_DETERMINISTIC_CHECK",
          owner: cap.owner,
          failedCheck: check.name,
          reason: check.errorMessage || `Failed deterministic check: ${check.name}`,
        };
      }
    }

    // 4. Enforce Campaign-Level or Single-Action Approval
    if (campaignId) {
      const campaign = this.campaignApprovals.get(campaignId);
      if (!campaign || !campaign.approved || campaign.capabilityId !== capabilityId) {
        return {
          status: "BLOCKED_CAMPAIGN_APPROVAL",
          owner: cap.owner,
          reason: campaign?.reason || `Campaign '${campaignId}' does not have valid statistical review approval`,
        };
      }
    } else if (cap.requiresHumanApproval && !humanApprovalToken) {
      return {
        status: "PENDING_HUMAN_APPROVAL",
        owner: cap.owner,
        reason: `Capability '${capabilityId}' (${cap.actionType}) requires explicit human approval before execution`,
      };
    }

    this.recordQualityOutcome(capabilityId, true);

    return {
      status: "EXECUTED",
      actionId: crypto.randomUUID(),
      capabilityId,
      actionType: cap.actionType,
      accountableOwner: cap.owner,
      modelCallId,
      campaignId,
      approvedBy: humanApprovalToken?.approverId || this.campaignApprovals.get(campaignId)?.approverId || "policy-auto",
    };
  }
}
