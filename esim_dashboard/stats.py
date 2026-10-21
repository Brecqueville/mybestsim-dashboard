"""Calcul de toutes les statistiques du dashboard.

Principe : Python calcule, le navigateur affiche. Aucun chiffre n'est recalculé en JavaScript,
il n'y a donc qu'une seule source de vérité, testée (voir tests/).
"""

from __future__ import annotations

import math

import pandas as pd

from .formatting import fmt_eur, fmt_int, fmt_num, fmt_pct

PRICE_THRESHOLD = 100.0  # « plus de 100 € » = strictement supérieur à 100 €
HISTOGRAM_STEP = 10  # largeur des tranches de prix, en euros
UNLIMITED_LABEL = "Illimité"
# Deux produits sont « le même forfait » pour un voyageur s'ils ont
# la même destination, le même volume et la même durée.
OFFER_COLUMNS = ["country_code", "data_display", "validity_days"]


def build_stats(products: pd.DataFrame) -> dict:
    """Assemble l'ensemble des statistiques, prêtes à être sérialisées en JSON."""
    products = products.assign(tier=tier_labels(products))
    tiers = ordered_tiers(products)
    edges = histogram_edges(products["price"])
    stats = {
        "overview": profile(products, tiers, edges),
        "by_provider": {name: profile(group, tiers, edges) for name, group in products.groupby("provider")},
        "providers": provider_table(products),
        "market": market_comparison(products),
        "network": network_effect(products),
        "destinations": destination_stats(products),
        "unlimited": unlimited_stats(products),
    }
    stats["insights"] = insights(stats)
    stats["headlines"] = headlines(stats)
    stats["takeaways"] = takeaways(stats)
    return stats


# --- Indicateurs demandés -------------------------------------------------------------------


def kpis(df: pd.DataFrame) -> dict:
    """Les indicateurs demandés dans le sujet, pour un sous-ensemble du catalogue."""
    limited = df.loc[~df["is_unlimited"], "data_gb"]
    over = df["price"] > PRICE_THRESHOLD
    cheapest = df.loc[df["price"].idxmin()]
    priciest = df.loc[df["price"].idxmax()]
    return {
        "products": len(df),
        "over_threshold": int(over.sum()),
        "over_threshold_share": _f(over.mean()),
        "price_min": _f(cheapest["price"], 2),
        "price_min_product": _product_ref(cheapest),
        "price_max": _f(priciest["price"], 2),
        "price_max_product": _product_ref(priciest),
        "price_mean": _f(df["price"].mean(), 2),
        "price_median": _f(df["price"].median(), 2),
        "price_q1": _f(df["price"].quantile(0.25), 2),
        "price_q3": _f(df["price"].quantile(0.75), 2),
        # Moyenne de data calculée sur les forfaits chiffrés : un forfait illimité n'a pas de volume.
        "data_mean_gb": _f(limited.mean(), 2),
        "data_median_gb": _f(limited.median(), 2),
        "limited_count": len(limited),
        "unlimited_count": int(df["is_unlimited"].sum()),
        "unlimited_share": _f(df["is_unlimited"].mean()),
        "providers": int(df["provider"].nunique()),
        "destinations": int(df["country_code"].nunique()),
    }


def profile(df: pd.DataFrame, tiers: list[str], edges: list[float]) -> dict:
    """Indicateurs et répartitions d'un sous-ensemble (tout le catalogue ou un fournisseur)."""
    limited = df[~df["is_unlimited"]]
    price_per_gb = (limited["price"] / limited["data_gb"]).groupby(limited["tier"]).median()
    validities = sorted(df["validity_days"].unique())
    matrix = df.pivot_table(index="tier", columns="validity_days", values="price", aggfunc="median")
    result = {
        "kpis": kpis(df),
        "over_threshold_text": over_threshold_text(df),
        "data_mix": _counts(df["tier"], tiers),
        "validity_mix": [{"label": f"{days} jours", "count": int((df["validity_days"] == days).sum())} for days in validities],
        "network_mix": _counts(df["network"], sorted(df["network"].unique())),
        "top_up_mix": [
            {"label": "Rechargeable", "count": int(df["top_up"].eq(True).sum())},
            {"label": "Non rechargeable", "count": int(df["top_up"].eq(False).sum())},
        ],
        "price_histogram": histogram(df["price"], edges),
        "price_per_gb": [{"label": tier, "value": _f(price_per_gb.get(tier), 2)} for tier in tiers if tier in price_per_gb],
        "price_matrix": {
            "rows": [tier for tier in tiers if tier in matrix.index],
            "columns": [f"{days} j" for days in validities],
            "values": [
                [_f(matrix.at[tier, days], 2) if days in matrix.columns else None for days in validities]
                for tier in tiers
                if tier in matrix.index
            ],
        },
    }
    result["headlines"] = profile_headlines(result)
    return result


def provider_table(df: pd.DataFrame) -> list[dict]:
    """Répartition par fournisseur, du plus gros catalogue au plus petit."""
    grouped = df.groupby("provider")
    table = pd.DataFrame(
        {
            "products": grouped.size(),
            "destinations": grouped["country_code"].nunique(),
            "price_mean": grouped["price"].mean(),
            "price_median": grouped["price"].median(),
            "data_mean_gb": grouped["data_gb"].mean(),  # les illimités (NaN) sont ignorés
            "unlimited_share": grouped["is_unlimited"].mean(),
            "share_5g": grouped["network"].agg(lambda s: (s == "5G").mean()),
            "top_up_share": grouped["top_up"].agg(lambda s: s.eq(True).mean()),
        }
    )
    table["share"] = table["products"] / len(df)
    table = table.sort_values(["products", "price_median"], ascending=[False, True])
    return [
        {
            "provider": name,
            "products": int(row["products"]),
            "share": _f(row["share"]),
            "destinations": int(row["destinations"]),
            "price_mean": _f(row["price_mean"], 2),
            "price_median": _f(row["price_median"], 2),
            "data_mean_gb": _f(row["data_mean_gb"], 2),
            "unlimited_share": _f(row["unlimited_share"]),
            "share_5g": _f(row["share_5g"]),
            "top_up_share": _f(row["top_up_share"]),
        }
        for name, row in table.iterrows()
    ]


# --- Statistiques bonus ---------------------------------------------------------------------


def market_comparison(df: pd.DataFrame) -> dict:
    """Ce que rapporte la comparaison : écarts de prix à forfait identique, et qui est le moins cher."""
    offers = df.groupby(OFFER_COLUMNS)
    summary = offers["price"].agg(["min", "max", "mean", "median", "count"])
    summary["providers"] = offers["provider"].nunique()
    competitive = summary[summary["providers"] >= 2]

    # Chaque produit comparé au prix médian des offres du même forfait.
    enriched = df.join(summary[["min", "median", "providers"]], on=OFFER_COLUMNS)
    in_competition = enriched[enriched["providers"] >= 2]
    presence = in_competition.drop_duplicates(["provider", *OFFER_COLUMNS]).groupby("provider").size()
    winners = in_competition[in_competition["price"] == in_competition["min"]]
    wins = winners.drop_duplicates(["provider", *OFFER_COLUMNS]).groupby("provider").size()
    price_index = (enriched["price"] / enriched["median"] - 1).groupby(enriched["provider"]).mean()

    rows = [
        {
            "provider": provider,
            "wins": int(wins.get(provider, 0)),
            "presence": int(presence.get(provider, 0)),
            "win_rate": _f(wins.get(provider, 0) / presence[provider]) if presence.get(provider) else None,
            "price_index": _f(price_index.get(provider)),
        }
        for provider in sorted(df["provider"].unique(), key=str.casefold)
    ]
    rows.sort(key=lambda row: (row["win_rate"] or 0), reverse=True)

    result = {
        "offers": len(summary),
        "competitive_offers": len(competitive),
        "avg_offers_per_offer": _f(summary["count"].mean(), 1),
        "saving_vs_mean": None,
        "saving_vs_max": None,
        "best_example": None,
        "providers": rows,
    }
    if competitive.empty:
        return result

    saving_vs_mean = 1 - competitive["min"] / competitive["mean"]
    saving_vs_max = 1 - competitive["min"] / competitive["max"]
    best_key = saving_vs_max.idxmax()
    best = competitive.loc[best_key]
    best_product = df.loc[offers["price"].idxmin()[best_key]]
    result.update(
        saving_vs_mean=_f(saving_vs_mean.mean()),
        saving_vs_max=_f(saving_vs_max.mean()),
        best_example={
            "label": _offer_label(best_product),
            "min": _f(best["min"], 2),
            "max": _f(best["max"], 2),
            "saving": _f(saving_vs_max[best_key]),
            "offers": int(best["count"]),
        },
    )
    return result


def network_effect(df: pd.DataFrame) -> dict:
    """Écart de prix 5G / 4G, brut puis à forfait identique (pour isoler l'effet de mix)."""
    medians = df.groupby("network")["price"].median()
    if not {"4G", "5G"} <= set(medians.index):
        return {"available": False}
    paired = df.pivot_table(index=OFFER_COLUMNS, columns="network", values="price", aggfunc="mean").dropna(subset=["4G", "5G"])
    if paired.empty:
        return {"available": False}
    is_5g = df["network"] == "5G"
    return {
        "available": True,
        "median_4g": _f(medians["4G"], 2),
        "median_5g": _f(medians["5G"], 2),
        "raw_gap": _f(medians["5G"] / medians["4G"] - 1),
        "same_offer_gap": _f((paired["5G"] / paired["4G"] - 1).mean()),
        "paired_offers": len(paired),
        "share_5g": _f(is_5g.mean()),
        "share_5g_unlimited": _f(is_5g[df["is_unlimited"]].mean()),
        "share_5g_limited": _f(is_5g[~df["is_unlimited"]].mean()),
    }


def destination_stats(df: pd.DataFrame) -> dict:
    """Couverture et niveau de prix par destination, forfaits pays contre forfaits multi-pays."""
    limited = df[~df["is_unlimited"]]
    price_per_gb = limited["price"] / limited["data_gb"]
    ppg_by_code = price_per_gb.groupby(limited["country_code"]).median()
    grouped = df.groupby(["country_code", "country_name", "is_region"])
    table = pd.DataFrame(
        {
            "offers": grouped.size(),
            "providers": grouped["provider"].nunique(),
            "price_median": grouped["price"].median(),
        }
    ).reset_index()
    table["price_per_gb"] = table["country_code"].map(ppg_by_code)
    table = table.sort_values(["offers", "country_name"], ascending=[False, True])

    region_ppg = price_per_gb[limited["is_region"]].median()
    country_ppg = price_per_gb[~limited["is_region"]].median()
    return {
        "count": len(table),
        "countries": int((~table["is_region"]).sum()),
        "regions": int(table["is_region"].sum()),
        "region_names": sorted(table.loc[table["is_region"], "country_name"]),
        "region_price_per_gb": _f(region_ppg, 2),
        "country_price_per_gb": _f(country_ppg, 2),
        "region_premium_per_gb": _f(region_ppg / country_ppg - 1) if country_ppg else None,
        "table": [
            {
                "code": row.country_code,
                "name": row.country_name,
                "is_region": bool(row.is_region),
                "offers": int(row.offers),
                "providers": int(row.providers),
                "price_median": _f(row.price_median, 2),
                "price_per_gb": _f(row.price_per_gb, 2),
            }
            for row in table.itertuples()
        ],
    }


def unlimited_stats(df: pd.DataFrame) -> dict:
    """Forfaits illimités : prix médian et coût par jour selon la durée."""
    unlimited = df[df["is_unlimited"]]
    if unlimited.empty:
        return {"count": 0, "share": 0, "by_validity": []}
    per_day = (unlimited["price"] / unlimited["validity_days"]).groupby(unlimited["validity_days"]).median()
    price = unlimited.groupby("validity_days")["price"].median()
    return {
        "count": len(unlimited),
        "share": _f(len(unlimited) / len(df)),
        "by_validity": [
            {"days": int(days), "price_median": _f(price[days], 2), "price_per_day": _f(per_day[days], 2)}
            for days in sorted(per_day.index)
        ],
    }


def insights(stats: dict) -> list[dict]:
    """Enseignements rédigés à partir des chiffres : ils se mettent à jour avec les données."""
    out: list[dict] = []
    overview = stats["overview"]["kpis"]
    market = stats["market"]

    if market["best_example"]:
        best = market["best_example"]
        out.append(
            {
                "title": "Comparer fait économiser",
                "text": (
                    f"Pour un même forfait (destination, volume, durée), l'offre la moins chère coûte en moyenne "
                    f"{fmt_pct(market['saving_vs_mean'])} de moins que la moyenne des offres, et "
                    f"{fmt_pct(market['saving_vs_max'])} de moins que la plus chère. Écart record : {best['label']}, "
                    f"de {fmt_eur(best['min'])} à {fmt_eur(best['max'])} ({fmt_pct(best['saving'], 0)} d'économie)."
                ),
            }
        )
        leader = market["providers"][0]
        spread = max(abs(row["price_index"] or 0) for row in market["providers"])
        out.append(
            {
                "title": "Aucun fournisseur n'est le moins cher partout",
                "text": (
                    f"{leader['provider']}, le plus souvent en tête, ne propose l'offre la moins chère que sur "
                    f"{fmt_pct(leader['win_rate'], 0)} des forfaits où il a au moins un concurrent. À forfait identique, "
                    f"le prix moyen de chaque fournisseur reste à ±{fmt_pct(spread)} du prix médian du marché : "
                    "l'économie se joue offre par offre."
                ),
            }
        )

    providers = stats["providers"]
    if len(providers) >= 4:
        top = providers[:3]
        all_destinations = overview["destinations"]
        full = [row for row in providers if row["destinations"] == all_destinations]
        narrowest = min(providers, key=lambda row: row["destinations"])
        out.append(
            {
                "title": "Un catalogue concentré, une couverture large",
                "text": (
                    f"Les 3 plus gros fournisseurs ({', '.join(row['provider'] for row in top)}) pèsent "
                    f"{fmt_pct(sum(row['share'] for row in top), 0)} des cartes. La couverture reste homogène : "
                    f"{len(full)} fournisseurs sur {len(providers)} couvrent les {all_destinations} destinations, et le moins "
                    f"couvrant ({narrowest['provider']}) en propose encore {narrowest['destinations']}."
                ),
            }
        )

    ppg = stats["overview"]["price_per_gb"]
    if len(ppg) >= 2 and ppg[-1]["value"]:
        first, last = ppg[0], ppg[-1]
        out.append(
            {
                "title": "Plus le forfait est gros, moins le Go coûte",
                "text": (
                    f"Le Go revient à {fmt_eur(first['value'])} sur un forfait {first['label']} contre "
                    f"{fmt_eur(last['value'])} sur un forfait {last['label']}, soit "
                    f"{fmt_num(first['value'] / last['value'])} fois moins cher (médianes)."
                ),
            }
        )

    destinations = stats["destinations"]
    if destinations["region_premium_per_gb"] is not None and destinations["regions"]:
        out.append(
            {
                "title": "Le multi-pays se paie",
                "text": (
                    f"Les forfaits multi-pays ({', '.join(destinations['region_names'])}) coûtent "
                    f"{fmt_pct(destinations['region_premium_per_gb'], 0)} de plus au Go que les forfaits pays "
                    f"({fmt_eur(destinations['region_price_per_gb'])} contre {fmt_eur(destinations['country_price_per_gb'])} "
                    "par Go, en médiane)."
                ),
            }
        )

    network = stats["network"]
    if network["available"]:
        if abs(network["same_offer_gap"]) < 0.02:
            title = "La 5G n'est pas (vraiment) plus chère"
            text = (
                f"En prix médian, la 5G paraît {fmt_pct(network['raw_gap'], 0)} plus chère que la 4G. Mais à forfait "
                f"identique, l'écart n'est que de {fmt_pct(network['same_offer_gap'])} : la 5G est simplement plus "
                f"fréquente sur les forfaits illimités ({fmt_pct(network['share_5g_unlimited'], 0)} d'entre eux, contre "
                f"{fmt_pct(network['share_5g_limited'], 0)} des autres). C'est un effet de mix, pas un surcoût."
            )
        else:
            title = "Le prix de la 5G"
            text = (
                f"À forfait identique, la 5G coûte en moyenne {fmt_pct(network['same_offer_gap'])} de plus que la 4G "
                f"(écart brut des prix médians : {fmt_pct(network['raw_gap'], 0)})."
            )
        out.append({"title": title, "text": text})

    if overview["over_threshold"]:
        out.append({"title": f"Qui dépasse {fmt_int(int(PRICE_THRESHOLD))}\u00a0€\u00a0?", "text": stats["overview"]["over_threshold_text"]})

    unlimited = stats["unlimited"]["by_validity"]
    if len(unlimited) >= 2:
        short, long = unlimited[0], unlimited[-1]
        out.append(
            {
                "title": "L'illimité devient rentable sur la durée",
                "text": (
                    f"En illimité, la journée revient à {fmt_eur(short['price_per_day'])} sur {short['days']} jours "
                    f"contre {fmt_eur(long['price_per_day'])} sur {long['days']} jours (médianes)."
                ),
            }
        )
    return out


# --- Titres des graphiques ------------------------------------------------------------------
# Chaque graphique porte un titre qui énonce ce qu'il montre (« La moitié des cartes coûte moins
# de 21 € ») plutôt qu'un intitulé neutre. Ils sont calculés ici pour suivre les données.


def profile_headlines(profile_stats: dict) -> dict:
    """Titres des graphiques qui dépendent du filtre fournisseur."""
    k = profile_stats["kpis"]
    out = {"prices": f"La moitié des cartes coûte moins de {fmt_eur(k['price_median'])}"}

    mix = [m for m in profile_stats["data_mix"] if m["count"]]
    total = sum(m["count"] for m in mix) or 1
    shares = [m["count"] / total for m in mix]
    if shares and max(shares) - min(shares) < 0.05:
        out["data_mix"] = "Les volumes de data sont répartis presque à parts égales"
    elif mix:
        top = max(mix, key=lambda m: m["count"])
        out["data_mix"] = f"Le volume le plus fréquent est {top['label']} ({fmt_pct(top['count'] / total, 0)} des cartes)"

    networks = {m["label"]: m["count"] for m in profile_stats["network_mix"]}
    top_up = {m["label"]: m["count"] for m in profile_stats["top_up_mix"]}
    if networks and sum(top_up.values()):
        share_5g = networks.get("5G", 0) / sum(networks.values())
        share_top_up = top_up.get("Rechargeable", 0) / sum(top_up.values())
        out["composition"] = f"{fmt_pct(share_5g, 0)} des cartes en 5G, {fmt_pct(share_top_up, 0)} rechargeables"

    ppg = [p for p in profile_stats["price_per_gb"] if p["value"]]
    if len(ppg) >= 2:
        ratio = ppg[0]["value"] / ppg[-1]["value"]
        out["price_per_gb"] = f"Le Go coûte {fmt_num(ratio)} fois moins cher en {ppg[-1]['label']} qu'en {ppg[0]['label']}"

    matrix = profile_stats["price_matrix"]
    rows = [
        (label, values)
        for label, values in zip(matrix["rows"], matrix["values"])
        if label != UNLIMITED_LABEL and values and values[0] and values[-1]
    ]
    if len(rows) >= 2 and len(matrix["columns"]) >= 2:
        duration = sorted(values[-1] / values[0] - 1 for _, values in rows)[len(rows) // 2]
        volume = rows[-1][1][-1] / rows[0][1][-1]
        out["price_matrix"] = (
            f"De {matrix['columns'][0]} à {matrix['columns'][-1]}, le prix augmente de {fmt_pct(duration, 0)} ; "
            f"de {rows[0][0]} à {rows[-1][0]}, il est multiplié par {fmt_num(volume)}"
        )
    return out


def headlines(stats: dict) -> dict:
    """Titres des graphiques calculés sur tout le catalogue."""
    out: dict[str, str] = {}
    providers = stats["providers"]
    if len(providers) >= 4:
        out["providers"] = f"Les 3 premiers fournisseurs pèsent {fmt_pct(sum(p['share'] for p in providers[:3]), 0)} du catalogue"

    market = stats["market"]
    if market["best_example"]:
        out["savings"] = (
            f"Comparer fait économiser {fmt_pct(market['saving_vs_mean'])} en moyenne sur un même forfait, "
            f"et jusqu'à {fmt_pct(market['best_example']['saving'], 0)}"
        )
        leader = market["providers"][0]
        out["win_rate"] = f"{leader['provider']}, le plus souvent en tête, n'est le moins cher que sur {fmt_pct(leader['win_rate'], 0)} des forfaits"
        spread = max(abs(p["price_index"] or 0) for p in market["providers"])
        out["price_index"] = f"À forfait identique, chaque fournisseur reste à ±{fmt_pct(spread)} du prix du marché"

    network = stats["network"]
    if network["available"]:
        out["network"] = (
            f"La 5G paraît {fmt_pct(network['raw_gap'], 0)} plus chère, mais l'écart tombe à "
            f"{fmt_pct(network['same_offer_gap'])} à forfait identique"
        )

    unlimited = stats["unlimited"]["by_validity"]
    if len(unlimited) >= 2:
        short, long = unlimited[0], unlimited[-1]
        out["unlimited"] = (
            f"En illimité, la journée coûte {fmt_eur(short['price_per_day'])} sur {short['days']} jours, "
            f"{fmt_eur(long['price_per_day'])} sur {long['days']} jours"
        )

    destinations = stats["destinations"]
    if destinations["region_premium_per_gb"] is not None and destinations["regions"]:
        out["destinations"] = f"Les forfaits multi-pays coûtent {fmt_pct(destinations['region_premium_per_gb'], 0)} de plus au Go que les forfaits pays"
    return out


def takeaways(stats: dict) -> list[dict]:
    """Les trois enseignements mis en avant sur la vue d'ensemble : un chiffre, une phrase."""
    out: list[dict] = []
    market = stats["market"]
    if market["best_example"]:
        out.append(
            {
                "figure": fmt_pct(market["saving_vs_mean"], 0),
                "text": (
                    "d'économie moyenne en choisissant l'offre la moins chère d'un même forfait, "
                    f"et jusqu'à {fmt_pct(market['best_example']['saving'], 0)} ({market['best_example']['label']})."
                ),
            }
        )
        leader = market["providers"][0]
        out.append(
            {
                "figure": fmt_pct(leader["win_rate"], 0),
                "text": (
                    f"des forfaits seulement : c'est le score de {leader['provider']}, le fournisseur le plus souvent "
                    "le moins cher. Aucun ne l'est partout, d'où l'intérêt de comparer offre par offre."
                ),
            }
        )
    ppg = [p for p in stats["overview"]["price_per_gb"] if p["value"]]
    if len(ppg) >= 2:
        out.append(
            {
                "figure": f"×{fmt_num(ppg[0]['value'] / ppg[-1]['value'])}",
                "text": (
                    f"C'est l'écart de prix au Go entre un forfait {ppg[0]['label']} ({fmt_eur(ppg[0]['value'])}) "
                    f"et un forfait {ppg[-1]['label']} ({fmt_eur(ppg[-1]['value'])})."
                ),
            }
        )
    return out


# --- Outils ---------------------------------------------------------------------------------


def tier_labels(df: pd.DataFrame) -> pd.Series:
    """Libellé de volume homogène : « 5 Go », « 0,5 Go » ou « Illimité »."""
    def label(row) -> str:
        if row.is_unlimited:
            return UNLIMITED_LABEL
        gb = float(row.data_gb)
        return f"{fmt_num(gb, 0 if gb.is_integer() else 1)} Go"

    return pd.Series([label(row) for row in df[["is_unlimited", "data_gb"]].itertuples()], index=df.index)


def ordered_tiers(df: pd.DataFrame) -> list[str]:
    limited = df.loc[~df["is_unlimited"]].drop_duplicates("data_gb").sort_values("data_gb")
    tiers = list(limited["tier"])
    if df["is_unlimited"].any():
        tiers.append(UNLIMITED_LABEL)
    return tiers


def histogram_edges(prices: pd.Series) -> list[float]:
    top = math.ceil(prices.max() / HISTOGRAM_STEP) * HISTOGRAM_STEP
    return list(range(0, int(top) + HISTOGRAM_STEP, HISTOGRAM_STEP))


def histogram(prices: pd.Series, edges: list[float]) -> list[dict]:
    counts = pd.cut(prices, bins=edges, right=False).value_counts(sort=False)
    return [{"from": int(interval.left), "to": int(interval.right), "count": int(count)} for interval, count in counts.items()]


def over_threshold_text(df: pd.DataFrame) -> str:
    """Décrit la composition des produits au-dessus du seuil de prix."""
    over = df[df["price"] > PRICE_THRESHOLD]
    if over.empty:
        return f"Aucun produit au-dessus de {fmt_int(int(PRICE_THRESHOLD))}\u00a0€."
    unlimited, month, region = over["is_unlimited"].mean(), (over["validity_days"] >= 30).mean(), over["is_region"].mean()
    if unlimited == month == region == 1:
        zones = ", ".join(sorted(over["country_name"].unique()))
        return (
            f"Les {fmt_int(len(over))} produits à plus de {fmt_int(int(PRICE_THRESHOLD))}\u00a0€ sont tous des forfaits "
            f"illimités de 30 jours sur des zones multi-pays ({zones}). Aucun forfait pays n'atteint ce prix."
        )
    return (
        f"Sur les {fmt_int(len(over))} produits à plus de {fmt_int(int(PRICE_THRESHOLD))}\u00a0€, {fmt_pct(unlimited, 0)} sont "
        f"illimités, {fmt_pct(month, 0)} durent 30 jours ou plus et {fmt_pct(region, 0)} couvrent une zone multi-pays."
    )


def _counts(series: pd.Series, order: list) -> list[dict]:
    counts = series.value_counts()
    return [{"label": str(key), "count": int(counts.get(key, 0))} for key in order]


def _product_ref(row: pd.Series) -> dict:
    return {"name": row["product_name"], "provider": row["provider"], "sku": row["sku"]}


def _offer_label(row: pd.Series) -> str:
    return f"eSIM {row['country_name']} {row['tier']} {row['validity_days']} jours"


def _f(value, digits: int = 4):
    """Flottant JSON propre : arrondi, et None à la place de NaN."""
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)
