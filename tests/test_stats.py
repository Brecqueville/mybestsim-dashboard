import json

import pytest

from esim_dashboard.loader import load_catalog
from esim_dashboard.quality import run_checks
from esim_dashboard.stats import build_stats

from .conftest import REAL_DATA


@pytest.fixture
def stats(small_catalog):
    return build_stats(load_catalog(small_catalog).products)


def test_required_kpis_on_a_known_catalog(stats):
    k = stats["overview"]["kpis"]
    assert k["products"] == 5
    assert k["over_threshold"] == 1  # 150 € ; 100 € pile n'est pas « plus de 100 € »
    assert k["price_min"] == 10
    assert k["price_max"] == 150
    assert k["price_mean"] == pytest.approx((10 + 20 + 150 + 12 + 100) / 5)
    assert k["data_mean_gb"] == pytest.approx((1 + 5 + 1 + 10) / 4)  # l'illimité est exclu
    assert k["unlimited_count"] == 1


def test_provider_breakdown(stats):
    counts = {row["provider"]: row["products"] for row in stats["providers"]}
    assert counts == {"Alpha": 3, "Beta": 2}
    assert stats["providers"][0]["provider"] == "Alpha"  # trié du plus gros au plus petit


def test_market_comparison_on_identical_offers(stats):
    market = stats["market"]
    # Seul « France 1 Go 7 jours » est vendu par deux fournisseurs : 10 € (Alpha) et 12 € (Beta).
    assert market["competitive_offers"] == 1
    assert market["saving_vs_max"] == pytest.approx(1 - 10 / 12, abs=1e-4)
    assert market["saving_vs_mean"] == pytest.approx(1 - 10 / 11, abs=1e-4)
    winners = {row["provider"]: row["wins"] for row in market["providers"]}
    assert winners == {"Alpha": 1, "Beta": 0}


def test_profile_per_provider(stats):
    alpha = stats["by_provider"]["Alpha"]["kpis"]
    assert alpha["products"] == 3
    assert alpha["over_threshold"] == 1
    assert alpha["data_mean_gb"] == pytest.approx(3)


@pytest.mark.skipif(not REAL_DATA.exists(), reason="données réelles absentes")
def test_real_data_is_consistent():
    catalog = load_catalog(REAL_DATA)
    result = build_stats(catalog.products)
    k = result["overview"]["kpis"]
    assert sum(row["products"] for row in result["providers"]) == k["products"] == len(catalog.products)
    assert k["price_min"] <= k["price_median"] <= k["price_max"]
    assert k["price_min"] <= k["price_mean"] <= k["price_max"]
    assert sum(b["count"] for b in result["overview"]["price_histogram"]) == k["products"]
    assert result["insights"]
    assert run_checks(catalog)
    json.dumps(result)  # tout doit être sérialisable pour le dashboard
