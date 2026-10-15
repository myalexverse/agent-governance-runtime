import unittest
from governance_stats import calculate_review_sample_size, wilson_error_confidence_bounds


class TestGovernanceStatistics(unittest.TestCase):
    def test_sample_sizing(self):
        n = calculate_review_sample_size(
            population_size=5000,
            confidence_level=0.95,
            margin_of_error=0.03,
            expected_error_rate=0.05,
        )
        self.assertTrue(190 <= n <= 205)

    def test_wilson_bounds(self):
        bounds = wilson_error_confidence_bounds(observed_errors=2, sample_size=200, confidence_level=0.95)
        self.assertAlmostEqual(bounds.point_estimate, 0.01)
        self.assertLess(bounds.upper_bound, 0.036)
        self.assertGreater(bounds.upper_bound, bounds.point_estimate)


if __name__ == "__main__":
    unittest.main()
