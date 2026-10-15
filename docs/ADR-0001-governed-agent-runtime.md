# ADR-0001 — Governed Multi-Step Agent Runtime, Statistical Release Gates & Kill Switches

- **Status:** Accepted
- **Date:** October 2026
- **Author:** Abel Alejandro Tovar

## 1. Context & Problem Statement

When multi-step, tool-using LLM agents take real-world actions—such as sending external messages (`send_message`), mutating system-of-record entities (`update_record`), or preparing operational decisions (`prepare_decision`)—relying solely on prompt instructions or ad-hoc spot checks introduces unacceptable operational risk:

1. **Silent Regressions:** Model weight updates or instruction changes can degrade edge-case accuracy without failing happy-path smoke tests.
2. **Naive Point Estimates in Campaign Reviews:** Approving a 5,000-message campaign based on `0/15` errors in a tiny spot-check hides a 95% Wilson upper error bound of `>20%`.
3. **Unaccountable Execution:** Tool calls executed without explicit capability ownership, data classification guards, or deterministic pre-flight validation can leak restricted data or perform irreversible side effects.
4. **Provider Lock-In & Opaque Telemetry:** Coupling runtime logic to a single model vendor prevents rapid failover and leaves audit gaps around prompt versions and data provenance.

## 2. Architectural Decisions

### Decision 1: Gate on Wilson 95% Upper Error Confidence Bounds & Cochran Finite-Population Sample Sizing
- Campaign-level approvals (`submitCampaignReview`) calculate the minimum required human review sample $n$ using Cochran's formula with finite-population correction:
  $$n_0 = \frac{z^2 \cdot p(1 - p)}{e^2}, \quad n = \left\lceil \frac{n_0}{1 + \frac{n_0 - 1}{N}} \right\rceil$$
- Both pre-release Go-Live Gates and runtime Kill Switches evaluate the **95% Wilson Score Upper Bound** of the error rate rather than the raw point estimate $\hat{p}$, preventing small samples from masking high tail risk.

### Decision 2: Layered Runtime Defense-in-Depth (`GovernedAgentRuntime`)
Every tool action passes through four deterministic code-enforced stages before execution:
1. **Kill Switch / Circuit Breaker Check:** Rejects execution immediately if the capability's rolling error upper bound breached its quality threshold.
2. **Data Provenance & Classification Restriction:** Enforces that `dataProvenance.classification` belongs to the capability's explicit allowlist before any external or cross-boundary action.
3. **Deterministic Pre-Execution Checks:** Schema, recipient, invariant, and PII/SSN regex guards run deterministically in code. Failures increment the error ledger before reaching human reviewers.
4. **Action-Level or Campaign-Level Approval Verification:** Irreversible or external actions require either a verified single-action human approval token or an active, statistically validated campaign approval.

### Decision 3: Immutable Model Observability & Provider Abstraction
- All LLM invocations route through `ModelProviderRegistry` (`anthropic`, `openai`, `gemini`, `local`), recording an immutable audit entry containing `callId`, `provider`, `model`, `instructionVersion`, SHA-256 `instructionHash`, `dataProvenance`, latency, and deterministic output quality checks.
