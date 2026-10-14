import random
import unittest

from gacha_sim import Banner, BehaviorConfig, PityConfig, expected_pulls_table, simulate


class PityTest(unittest.TestCase):
    def test_hard_pity_never_exceeded(self):
        cfg = PityConfig()
        b = Banner(cfg, random.Random(1))
        for _ in range(100_000):
            b.pull()
            self.assertLessEqual(b.pity, cfg.hard_pity - 1)

    def test_featured_within_double_ceiling(self):
        cfg = PityConfig()
        rng = random.Random(2)
        for _ in range(5_000):
            b = Banner(cfg, rng)
            while b.pull() != "featured":
                pass
            self.assertLessEqual(b.pulls, cfg.max_pulls_for_featured)

    def test_expected_table_matches_monte_carlo(self):
        cfg = PityConfig()
        rng = random.Random(3)
        n, total = 40_000, 0
        for _ in range(n):
            b = Banner(cfg, rng)
            while b.pull() != "featured":
                pass
            total += b.pulls
        self.assertAlmostEqual(total / n, expected_pulls_table(cfg)[0][0], delta=1.0)

    def test_disclosed_version_respects_break_even(self):
        beh = BehaviorConfig(finish_ratio=0.0)
        res = simulate(2_000, seed=5, beh=beh)
        self.assertTrue(all(r.spent <= beh.item_value for r in res["A"]))


if __name__ == "__main__":
    unittest.main()
