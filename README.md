<div align="center">

# 🛡️ Agent Governance & Statistical Evaluation Runtime

**Production-grade evaluation gates, applied statistics (sample sizing & Wilson confidence bounds), deterministic runtime safeguards, approval workflows, data provenance observability, and automatic kill switches for tool-using, multi-step AI agents.**

[![TypeScript / ESM](https://img.shields.io/badge/Runtime-Node.js_%2F_TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](src/runtime.mjs)
[![Python 3](https://img.shields.io/badge/Statistics-Python_3.11%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](python/governance_stats.py)
[![Tests Passing](https://img.shields.io/badge/Tests-100%25_Passing-10B981?style=for-the-badge&logo=checkmarx&logoColor=white)](tests/governance.test.mjs)
[![Architecture ADR](https://img.shields.io/badge/Design_Notes-ADR--0001-FF6B2C?style=for-the-badge&logo=readthedocs&logoColor=white)](docs/ADR-0001-governed-agent-runtime.md)

[**🌐 Live Interactive Portfolio & Simulator →**](https://myalexverse.github.io)

</div>

---

## 🎯 Overview

When AI agents transition from passive chat interfaces to **taking real actions**—sending external communications (`send_message`), mutating records (`update_record`), and preparing operational decisions (`prepare_decision`)—safety and quality must be enforced **deterministically in code**, not merely requested in prompts.

This repository implements a **provider-independent Agent Governance & Evaluation Runtime** (in both **JavaScript/TypeScript ESM** and **Python**) that converts written governance rules, acceptance scenarios, and statistical quality thresholds into executable gates:

1. **📊 Applied Statistics for Evaluation & Campaign Review (`src/statistics.mjs` & `python/governance_stats.py`):**
   - **Finite-Population Review Sample Sizing:** Computes statistically required review sample sizes using Cochran's formula with finite-population correction before releasing high-volume campaigns.
   - **Wilson Score Confidence Bounds (`90% / 95% / 99%`):** Estimates true error-rate upper bounds from finite review samples so small sample sizes never mask quality risk.
   - **Two-Proportion Z-Test Regression Detection:** Re-evaluates agent capabilities after every model weight or instruction version change and flags statistically significant degradations.
2. **🔒 Governed Agent Runtime & Kill Switches (`src/runtime.mjs`):**
   - **Accountable Ownership:** Every registered capability requires an explicit accountable owner and action taxonomy (`send_message`, `update_record`, `prepare_decision`).
   - **Data Provenance & Classification Restrictions:** Enforces allowed data classifications (`public`, `internal`, `client_approved`, `restricted_pii`) before tool execution.
   - **Deterministic Pre-Execution Checks:** Code-level validators (PII/SSN leak guards, recipient domain checks, record ID invariants) execute prior to any irreversible side effect.
   - **Single-Action & Campaign-Level Approval Workflows:** Enforces human-in-the-loop sign-off for irreversible/external actions and statistical sample approval for batch campaigns.
   - **Automatic Quality-Based Suspension (Kill Switch):** Continuously tracks rolling outcomes and automatically suspends a capability when the 95% Wilson upper error bound exceeds policy thresholds.
3. **🔌 Model Provider Abstraction & Observability Ledger:**
   - Decouples agent workflows from any single vendor (`anthropic`, `openai`, `gemini`, `local`) via `ModelProviderRegistry`.
   - Records every model invocation with `callId`, `provider`, `model`, `instructionVersion`, SHA-256 `instructionHash`, `dataProvenance`, `latencyMs`, and deterministic output quality checks.
4. **🚦 Pre-Release Go-Live Gate (`src/evaluation-gate.mjs`):**
   - Runs golden datasets against candidate model/instruction versions, evaluates task pass rate, deterministic safety rate, 95% error upper bound, and regression vs. baseline, returning a deterministic `GO_LIVE_APPROVED` or `HOLD_RELEASE` decision.

---

## 🏗️ Runtime Governance Architecture

```mermaid
flowchart TB
    subgraph EvalGate["1. Pre-Release & Regression Go-Live Gate"]
        Dataset["Golden Evaluation Dataset\n+ Acceptance Scenarios"] --> Runner["Candidate Agent\n(Model + Instruction vX.Y)"]
        Runner --> Stats["Statistical Verifier\n• Wilson 95% Error Upper Bound\n• Two-Proportion Z-Test vs Baseline"]
        Stats --> Gate{"Go-Live Gate\nThresholds Met?"}
    end

    subgraph Runtime["2. Governed Agent Runtime (Defense-in-Depth)"]
        Provider["ModelProviderRegistry\n(OpenAI / Anthropic / Gemini / Local)"]
        Ledger[("Immutable Audit Ledger\nmodel • instructionVersion • hash\ndataProvenance • qualityChecks")]
        Action["Tool Action Request\nsend_message | update_record | prepare_decision"]
        KillSwitch{"1. Kill Switch\nCapability Suspended?"}
        DataGuard{"2. Data Provenance\nClassification Allowed?"}
        DetCheck{"3. Deterministic Checks\nSchema / PII / Invariants?"}
        Approval{"4. Approval Gate\nHITL Token or Statistically\nSized Campaign Sample?"}
        Exec["Execute Action with\nAccountable Owner Attribution"]
    end

    Gate -->|"GO_LIVE_APPROVED"| Provider
    Provider --> Ledger
    Provider --> Action
    Action --> KillSwitch
    KillSwitch -->|"Active"| DataGuard
    DataGuard -->|"Permitted"| DetCheck
    DetCheck -->|"Passed"| Approval
    Approval -->|"Approved"| Exec
    DetCheck -.->|"Failure Recorded"| KillSwitch
```

---

## 📐 Applied Statistics in Code

### 1. Statistically Sized Campaign Review Samples
Before approving a high-volume campaign of $N$ actions, the runtime computes the minimum required review sample size $n$ for confidence level $Z$, expected error rate $p$, and margin of error $e$:

$$n_0 = \frac{Z^2 \cdot p(1 - p)}{e^2}, \qquad n = \left\lceil \frac{n_0}{1 + \frac{n_0 - 1}{N}} \right\rceil$$

### 2. Wilson Score 95% Error Upper Bound Gating
Rather than trusting raw point estimates ($\hat{p} = k / n$), release gates and automatic suspension triggers evaluate the upper bound of the Wilson interval:

$$U_{\text{95\%}} = \frac{\hat{p} + \frac{z^2}{2n} + z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}}$$

---

## 🧪 Running the Verification Suites (Node.js + Python)

Zero external dependencies are required—both suites run with the standard library:

```bash
# Run both Node.js ESM governance tests and Python statistical unit tests
npm test
```

Individual suites:

```bash
# Node.js / TypeScript Runtime & Go-Live Gate Tests
node --test tests/governance.test.mjs

# Python Applied Statistics & Confidence Bound Tests
python3 -m unittest discover -s python -p 'test_*.py'
```

---

## 📄 Design Notes & Architecture Decision Records

- [**ADR-0001: Governed Multi-Step Agent Runtime, Statistical Release Gates & Kill Switches**](docs/ADR-0001-governed-agent-runtime.md)

---

## 👨‍💻 Author

**Abel Alejandro Tovar** — *Senior Software & AI Systems Engineer*
- 🌐 **Portfolio:** [myalexverse.github.io](https://myalexverse.github.io)
- 💼 **LinkedIn:** [Abel Alejandro Tovar Amezola](https://www.linkedin.com/in/abel-alejandro-tovar-amezola-scendlabs)
- ✉️ **Contact:** [myalexverse@gmail.com](mailto:myalexverse@gmail.com)
