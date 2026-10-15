"""
Python Applied Statistics & Runtime Governance Verifier
Provides sample sizing, Wilson score confidence bounds, model regression detection,
and deterministic kill-switch evaluation for multi-step AI agents.
"""

import math
from dataclasses import dataclass
from typing import Dict

Z_SCORES: Dict[float, float] = {
    0.90: 1.6448536269514722,
    0.95: 1.959963984540054,
    0.99: 2.5758293035489004,
}


@dataclass(frozen=True)
class ErrorConfidenceBounds:
    point_estimate: float
    lower_bound: float
    upper_bound: float
    confidence_level: float
    sample_size: int
    observed_errors: int


def calculate_review_sample_size(
    population_size: int,
    confidence_level: float = 0.95,
    margin_of_error: float = 0.03,
    expected_error_rate: float = 0.05,
) -> int:
    """Cochran sample size with finite-population correction for campaign review gates."""
    if population_size <= 0:
        raise ValueError("population_size must be positive")
    z = Z_SCORES[confidence_level]
    p = expected_error_rate
    n0 = (z * z * p * (1.0 - p)) / (margin_of_error * margin_of_error)
    n = math.ceil(n0 / (1.0 + (n0 - 1.0) / population_size))
    return min(population_size, max(1, n))


def wilson_error_confidence_bounds(
    observed_errors: int,
    sample_size: int,
    confidence_level: float = 0.95,
) -> ErrorConfidenceBounds:
    """Wilson score interval for error-rate estimation from finite evaluation samples."""
    if sample_size <= 0 or observed_errors < 0 or observed_errors > sample_size:
        raise ValueError("Invalid sample_size or observed_errors")
    z = Z_SCORES[confidence_level]
    z2 = z * z
    p_hat = observed_errors / sample_size
    denom = 1.0 + z2 / sample_size
    center = (p_hat + z2 / (2.0 * sample_size)) / denom
    half_width = (
        z * math.sqrt((p_hat * (1.0 - p_hat)) / sample_size + z2 / (4.0 * sample_size * sample_size))
    ) / denom
    return ErrorConfidenceBounds(
        point_estimate=round(p_hat, 6),
        lower_bound=round(max(0.0, center - half_width), 6),
        upper_bound=round(min(1.0, center + half_width), 6),
        confidence_level=confidence_level,
        sample_size=sample_size,
        observed_errors=observed_errors,
    )
