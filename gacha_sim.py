"""천장(pity) 시스템 뽑기 모델 + 손익분기점 명시/미명시 비교 시뮬레이션.

두 버전은 확률·천장 규칙이 완전히 같고, 플레이어에게 보여주는 정보만 다르다.

  A. 손익분기점 명시: 누적 지출(원), 손익분기점, 천장까지 남은 횟수,
     기대 잔여 비용을 보여준다.
  B. 손익분기점 미명시: 재화(원석) 사용량만 보여주고 금액·천장 카운트는 숨긴다.

사용법:
    python3 gacha_sim.py                 # 기본 설정으로 비교
    python3 gacha_sim.py --players 50000 --value 150000 --seed 7
    python3 gacha_sim.py --csv out.csv   # 플레이어별 결과 저장
"""

from __future__ import annotations

import argparse
import csv
import math
import random
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# 1. 천장 시스템 (두 버전 공통)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PityConfig:
    base_rate: float = 0.006      # 기본 최고등급 확률 0.6%
    soft_pity_start: int = 74     # 이 회차부터 확률 상승 (소프트 천장)
    soft_pity_step: float = 0.06  # 회차마다 +6%p
    hard_pity: int = 90           # 이 회차에서 100% (하드 천장)
    featured_rate: float = 0.5    # 최고등급 중 픽업 확률 (50/50)
    guarantee_after_loss: bool = True  # 픽업 실패 시 다음 최고등급은 픽업 확정
    cost_per_pull: int = 3000     # 1회 뽑기 가격(원)
    gems_per_pull: int = 160      # 1회 뽑기에 쓰이는 재화 수

    def rate(self, k: int) -> float:
        """마지막 최고등급 이후 k번째(1부터) 뽑기의 최고등급 확률."""
        if k >= self.hard_pity:
            return 1.0
        if k >= self.soft_pity_start:
            return min(1.0, self.base_rate + (k - self.soft_pity_start + 1) * self.soft_pity_step)
        return self.base_rate

    @property
    def max_pulls_for_featured(self) -> int:
        """픽업을 확정으로 얻기까지 최악의 횟수 (반천장 포함)."""
        return self.hard_pity * (2 if self.guarantee_after_loss else 1)


class Banner:
    """천장 상태를 가진 뽑기 기계."""

    def __init__(self, cfg: PityConfig, rng: random.Random):
        self.cfg = cfg
        self.rng = rng
        self.pity = 0          # 마지막 최고등급 이후 뽑은 횟수
        self.guaranteed = False  # 다음 최고등급이 픽업 확정인지
        self.pulls = 0

    def pull(self) -> str:
        """1회 뽑기. 'featured' | 'off' (픽뚫) | 'common' 반환."""
        self.pulls += 1
        self.pity += 1
        if self.rng.random() < self.cfg.rate(self.pity):
            self.pity = 0
            if self.guaranteed or self.rng.random() < self.cfg.featured_rate:
                self.guaranteed = False
                return "featured"
            self.guaranteed = self.cfg.guarantee_after_loss
            return "off"
        return "common"


def expected_pulls_table(cfg: PityConfig) -> tuple[list[float], list[float]]:
    """천장 카운트 k(0..hard_pity-1)에서 픽업까지의 기대 잔여 횟수.

    반환: (확정 아님일 때 E[k], 확정일 때 E[k])
    """
    h = cfg.hard_pity
    # 다음 최고등급까지의 기대 횟수 F[k]
    f = [0.0] * (h + 1)
    for k in range(h - 1, -1, -1):
        p = cfg.rate(k + 1)
        f[k] = 1 + (1 - p) * f[k + 1]
    guaranteed = f[:h]
    f0 = f[0]
    if cfg.guarantee_after_loss:
        miss_cost = f0                      # 픽뚫이면 확정 상태로 처음부터
    else:
        miss_cost = f0 / cfg.featured_rate  # 매번 50/50 반복
    not_guaranteed = [f[k] + (1 - cfg.featured_rate) * miss_cost for k in range(h)]
    return not_guaranteed, guaranteed


# ---------------------------------------------------------------------------
# 2. 플레이어 행동 모델
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BehaviorConfig:
    item_value: int = 200_000     # 플레이어가 픽업 캐릭터에 매기는 가치(원)
    budget_sigma: float = 0.45    # 심리적 예산의 로그정규 분산 (중앙값 = item_value)
    # A 버전: 손익분기점이 보이면 그 선에서 멈추되, 기대 잔여 비용이
    # 가치의 finish_ratio 이하로 작으면 '마저 채우는' 합리적 판단을 한다.
    finish_ratio: float = 0.25
    # B 버전: 금액이 재화로 가려져 지출을 과소 인식하고(perceive),
    # 많이 뽑을수록 매몰비용 때문에 한도가 늘어난다(sunk_cost).
    perceive: float = 0.7
    sunk_cost: float = 0.6


@dataclass
class PlayerResult:
    version: str
    budget: float
    pulls: int
    spent: int
    got_featured: bool
    off_banners: int
    net: int  # (얻었으면 아이템 가치) - 지출


def wants_next_pull(version: str, banner: Banner, cfg: PityConfig, beh: BehaviorConfig,
                    budget: float, e_table: tuple[list[float], list[float]]) -> bool:
    """다음 1회를 뽑을지 결정한다. 버전마다 보이는 정보가 다르다."""
    next_spent = (banner.pulls + 1) * cfg.cost_per_pull
    if version == "A":
        # 보이는 정보: 누적 지출, 손익분기점(= 아이템 가치), 기대 잔여 비용
        table = e_table[1] if banner.guaranteed else e_table[0]
        remaining_cost = table[banner.pity] * cfg.cost_per_pull
        limit = min(budget, beh.item_value)
        return next_spent <= limit or remaining_cost <= beh.finish_ratio * beh.item_value
    # B. 보이는 정보: 재화 사용량뿐 -> 지출 과소 인식 + 매몰비용으로 한도 상승
    perceived = next_spent * beh.perceive
    limit = budget * (1 + beh.sunk_cost * banner.pulls / cfg.hard_pity)
    return perceived <= limit


def play(version: str, cfg: PityConfig, beh: BehaviorConfig,
         budget: float, rng: random.Random,
         e_table: tuple[list[float], list[float]]) -> PlayerResult:
    banner = Banner(cfg, rng)
    off = 0
    result = "common"
    while wants_next_pull(version, banner, cfg, beh, budget, e_table):
        result = banner.pull()
        if result == "featured":
            break
        if result == "off":
            off += 1

    spent = banner.pulls * cfg.cost_per_pull
    got = result == "featured"
    return PlayerResult(version, budget, banner.pulls, spent, got, off,
                        (beh.item_value if got else 0) - spent)


def simulate(players: int = 20_000, seed: int = 42,
             cfg: PityConfig | None = None,
             beh: BehaviorConfig | None = None) -> dict[str, list[PlayerResult]]:
    """같은 플레이어 집단(같은 예산, 같은 난수열)을 두 버전에 각각 투입한다."""
    cfg = cfg or PityConfig()
    beh = beh or BehaviorConfig()
    e_table = expected_pulls_table(cfg)
    budget_rng = random.Random(seed)
    out: dict[str, list[PlayerResult]] = {"A": [], "B": []}
    for i in range(players):
        budget = beh.item_value * math.exp(budget_rng.gauss(0, beh.budget_sigma))
        for v in ("A", "B"):
            # 공통 난수: 두 버전이 같은 뽑기 결과열을 받아 정보 효과만 비교된다
            out[v].append(play(v, cfg, beh, budget, random.Random(seed * 1_000_003 + i), e_table))
    return out


def summarize(results: list[PlayerResult], item_value: int) -> dict[str, float]:
    n = len(results)
    spent = sorted(r.spent for r in results)
    got = [r for r in results if r.got_featured]
    return {
        "평균 지출(원)": sum(spent) / n,
        "지출 중앙값(원)": spent[n // 2],
        "상위 10% 지출(원)": spent[int(n * 0.9)],
        "평균 뽑기 횟수": sum(r.pulls for r in results) / n,
        "픽업 획득률(%)": 100 * len(got) / n,
        "손익분기점 초과 비율(%)": 100 * sum(r.spent > item_value for r in results) / n,
        "빈손 + 손익분기점 초과(%)": 100 * sum(r.spent > item_value and not r.got_featured for r in results) / n,
        "예산 초과 비율(%)": 100 * sum(r.spent > r.budget for r in results) / n,
        "평균 순손익(원)": sum(r.net for r in results) / n,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--players", type=int, default=20_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--value", type=int, default=200_000, help="픽업 캐릭터 가치(원)")
    ap.add_argument("--cost", type=int, default=3000, help="1회 뽑기 가격(원)")
    ap.add_argument("--perceive", type=float, default=0.7, help="B 버전 지출 인식 계수")
    ap.add_argument("--sunk", type=float, default=0.6, help="B 버전 매몰비용 계수")
    ap.add_argument("--csv", help="플레이어별 결과 CSV 경로")
    args = ap.parse_args()

    cfg = PityConfig(cost_per_pull=args.cost)
    beh = BehaviorConfig(item_value=args.value, perceive=args.perceive, sunk_cost=args.sunk)
    e_ng, _ = expected_pulls_table(cfg)

    print("== 천장 시스템 ==")
    print(f"기본 확률 {cfg.base_rate:.1%}, 소프트 천장 {cfg.soft_pity_start}회~, 하드 천장 {cfg.hard_pity}회, "
          f"픽업 {cfg.featured_rate:.0%} (실패 시 다음 확정)")
    print(f"픽업까지 기대 횟수 {e_ng[0]:.1f}회 = {e_ng[0] * cfg.cost_per_pull:,.0f}원, "
          f"최악 {cfg.max_pulls_for_featured}회 = {cfg.max_pulls_for_featured * cfg.cost_per_pull:,}원")
    print(f"손익분기점: 가치 {beh.item_value:,}원 ÷ {cfg.cost_per_pull:,}원 = {beh.item_value / cfg.cost_per_pull:.1f}회\n")

    res = simulate(args.players, args.seed, cfg, beh)
    sa, sb = summarize(res["A"], beh.item_value), summarize(res["B"], beh.item_value)
    print(f"== 플레이어 {args.players:,}명 비교 ==")
    print(f"{'지표':<22}{'A 명시':>14}{'B 미명시':>14}{'차이(B-A)':>14}")
    for key in sa:
        print(f"{key:<22}{sa[key]:>14,.1f}{sb[key]:>14,.1f}{sb[key] - sa[key]:>+14,.1f}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["player", "version", "budget", "pulls", "spent", "got_featured", "off_banners", "net"])
            for v in ("A", "B"):
                for i, r in enumerate(res[v]):
                    w.writerow([i, v, round(r.budget), r.pulls, r.spent, int(r.got_featured), r.off_banners, r.net])
        print(f"\nCSV 저장: {args.csv}")


if __name__ == "__main__":
    main()
