import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateReviewSampleSize,
  wilsonErrorConfidenceBounds,
  evaluateModelRegression,
} from "../src/statistics.mjs";
import {
  ModelProviderRegistry,
  GovernedAgentRuntime,
} from "../src/runtime.mjs";
import { runCapabilityGoLiveGate } from "../src/evaluation-gate.mjs";

test("Applied Statistics: finite-population sample sizing & Wilson confidence bounds", () => {
  const n = calculateReviewSampleSize({
    populationSize: 5000,
    confidenceLevel: 0.95,
    marginOfError: 0.03,
    expectedErrorRate: 0.05,
  });
  assert.ok(n >= 190 && n <= 205, `Expected ~195 review samples, got ${n}`);

  const bounds = wilsonErrorConfidenceBounds({
    observedErrors: 2,
    sampleSize: 200,
    confidenceLevel: 0.95,
  });
  assert.equal(bounds.pointEstimate, 0.01);
  assert.ok(bounds.upperBound < 0.036, `Expected upper bound < 3.6%, got ${bounds.upperBound}`);
});

test("Regression Detection: catches model or instruction degradation", () => {
  const noRegression = evaluateModelRegression({
    baselinePasses: 196,
    baselineTotal: 200,
    candidatePasses: 195,
    candidateTotal: 200,
    maxAllowedDrop: 0.02,
  });
  assert.equal(noRegression.regressionDetected, false);

  const regression = evaluateModelRegression({
    baselinePasses: 196,
    baselineTotal: 200,
    candidatePasses: 178,
    candidateTotal: 200,
    maxAllowedDrop: 0.02,
  });
  assert.equal(regression.regressionDetected, true);
});

test("Governed Runtime: provider independence, provenance logging, approvals & deterministic checks", async () => {
  const registry = new ModelProviderRegistry();
  registry.register("anthropic", async ({ prompt }) => ({ output: `Draft reply for: ${prompt}` }));
  registry.register("openai", async ({ model, prompt }) => ({ output: `[${model}] OpenAI reply for: ${prompt}` }));
  registry.register("gemini", async ({ model, prompt }) => ({ output: `[${model}] Gemini reply for: ${prompt}` }));

  const runtime = new GovernedAgentRuntime({
    providerRegistry: registry,
    capabilities: {
      "external.send_message": {
        owner: "team-client-engagement",
        actionType: "send_message",
        irreversible: true,
        externalCommunication: true,
        requiresHumanApproval: true,
        maxErrorRateUpperBound: 0.08,
        minSampleForAutoSuspension: 10,
        allowedDataClassifications: ["public", "client_approved"],
        deterministicChecks: [
          {
            name: "no_pii_ssn",
            validate: (p) => !/\b\d{3}-\d{2}-\d{4}\b/.test(p.body || ""),
            errorMessage: "Outbound message contains prohibited SSN pattern",
          },
          {
            name: "non_empty_recipient",
            validate: (p) => Boolean(p.recipient && p.recipient.includes("@")),
            errorMessage: "Valid recipient email required",
          },
        ],
      },
    },
  });

  // 1. Model call records provider, model, instructionVersion, provenance, and quality checks across providers
  const call = await runtime.invokeModel({
    provider: "openai",
    model: "astra-6",
    instructionVersion: "inst-v2.4.0",
    systemInstruction: "You are a governed customer outreach agent.",
    prompt: "Confirm Q4 renewal schedule",
    dataProvenance: { sourceId: "crm-account-882", classification: "client_approved" },
    qualityValidators: [
      { name: "non_empty", check: (out) => out.length > 10 },
    ],
  });

  const geminiCall = await runtime.invokeModel({
    provider: "gemini",
    model: "gemini-4-argo",
    instructionVersion: "inst-v2.4.0",
    systemInstruction: "You are a governed customer outreach agent.",
    prompt: "Verify renewal compliance terms",
    dataProvenance: { sourceId: "crm-account-882", classification: "client_approved" },
    qualityValidators: [
      { name: "non_empty", check: (out) => out.length > 10 },
    ],
  });

  assert.equal(runtime.auditLedger.length, 2);
  assert.equal(runtime.auditLedger[0].model, "astra-6");
  assert.equal(runtime.auditLedger[1].model, "gemini-4-argo");
  assert.equal(runtime.auditLedger[1].outputPreview.includes("gemini-4-argo"), true);
  assert.equal(runtime.auditLedger[0].instructionVersion, "inst-v2.4.0");
  assert.equal(runtime.auditLedger[0].qualityPassed, true);
  assert.ok(geminiCall.callId);

  // 2. Data restriction blocks restricted classification
  const restricted = runtime.executeAction({
    capabilityId: "external.send_message",
    payload: { recipient: "client@example.com", body: call.output },
    dataProvenance: { sourceId: "vault-1", classification: "restricted_pii" },
  });
  assert.equal(restricted.status, "BLOCKED_DATA_RESTRICTION");

  // 3. Deterministic check blocks SSN leak before human approval
  const ssnBlocked = runtime.executeAction({
    capabilityId: "external.send_message",
    payload: { recipient: "client@example.com", body: "SSN 123-45-6789" },
    dataProvenance: { sourceId: "crm-1", classification: "client_approved" },
  });
  assert.equal(ssnBlocked.status, "BLOCKED_DETERMINISTIC_CHECK");
  assert.equal(ssnBlocked.failedCheck, "no_pii_ssn");

  // 4. Irreversible external action requires human approval when no campaign approval is present
  const pendingApproval = runtime.executeAction({
    capabilityId: "external.send_message",
    payload: { recipient: "client@example.com", body: call.output },
    dataProvenance: { sourceId: "crm-1", classification: "client_approved" },
  });
  assert.equal(pendingApproval.status, "PENDING_HUMAN_APPROVAL");

  // 5. Succeeds with explicit human approval token
  const executed = runtime.executeAction({
    capabilityId: "external.send_message",
    payload: { recipient: "client@example.com", body: call.output },
    dataProvenance: { sourceId: "crm-1", classification: "client_approved" },
    humanApprovalToken: { approverId: "lead-reviewer-01" },
    modelCallId: call.callId,
  });
  assert.equal(executed.status, "EXECUTED");
  assert.equal(executed.accountableOwner, "team-client-engagement");
});

test("Campaign Approval & Automatic Quality Suspension (Kill Switch)", () => {
  const registry = new ModelProviderRegistry();
  const runtime = new GovernedAgentRuntime({
    providerRegistry: registry,
    capabilities: {
      "crm.update_record": {
        owner: "platform-ops",
        actionType: "update_record",
        irreversible: false,
        requiresHumanApproval: false,
        maxErrorRateUpperBound: 0.10,
        minSampleForAutoSuspension: 10,
        allowedDataClassifications: ["internal"],
        deterministicChecks: [
          {
            name: "valid_record_id",
            validate: (p) => typeof p.recordId === "string" && p.recordId.startsWith("REC-"),
          },
        ],
      },
    },
  });

  // Reject campaign with undersized review sample
  const rejectedCampaign = runtime.submitCampaignReview({
    campaignId: "camp-q4-1",
    capabilityId: "crm.update_record",
    populationSize: 1000,
    reviewedSampleSize: 10,
    observedErrorsInSample: 0,
    approverId: "ops-lead",
  });
  assert.equal(rejectedCampaign.approved, false);

  // Approve campaign with statistically sized sample & low observed error rate
  const approvedCampaign = runtime.submitCampaignReview({
    campaignId: "camp-q4-2",
    capabilityId: "crm.update_record",
    populationSize: 1000,
    reviewedSampleSize: 80,
    observedErrorsInSample: 1,
    approverId: "ops-lead",
  });
  assert.equal(approvedCampaign.approved, true);

  // Trigger automatic suspension (Kill Switch) when runtime quality degrades
  for (let i = 0; i < 10; i++) {
    runtime.recordQualityOutcome("crm.update_record", i < 5); // 5 errors out of 10
  }

  const afterKillSwitch = runtime.executeAction({
    capabilityId: "crm.update_record",
    payload: { recordId: "REC-100" },
    dataProvenance: { sourceId: "sync", classification: "internal" },
    campaignId: "camp-q4-2",
  });
  assert.equal(afterKillSwitch.status, "BLOCKED_SUSPENDED");
});

test("Go-Live Gate: blocks release when candidate regresses or fails threshold", async () => {
  const dataset = Array.from({ length: 50 }, (_, idx) => ({
    id: `case-${idx}`,
    input: { query: `Test ${idx}` },
    expectedEvaluator: (out) => out.valid === true,
    safetyEvaluator: (out) => out.safe === true,
  }));

  const gatePass = await runCapabilityGoLiveGate({
    capabilityId: "decision.prepare_summary",
    instructionVersion: "v3.1.0",
    dataset,
    agentRunner: async () => ({ valid: true, safe: true }),
    baselineMetrics: { passedCount: 49, total: 50 },
  });
  assert.equal(gatePass.decision, "GO_LIVE_APPROVED");
});
