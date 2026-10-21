"""Génération du site statique : index.html, stats.json et catalogue consolidé (CSV)."""

from __future__ import annotations

import hashlib
import json
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from .formatting import fmt_eur, fmt_int, fmt_num, fmt_pct
from .loader import Catalog
from .quality import Check
from .stats import PRICE_THRESHOLD

PACKAGE_DIR = Path(__file__).parent
PARIS = ZoneInfo("Europe/Paris")
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
STATIC_FILES = ["dashboard.css", "dashboard.js"]


def write_site(
    out_dir: Path,
    catalog: Catalog,
    checks: list[Check],
    stats: dict,
    repo_url: str | None = None,
    now: datetime | None = None,
) -> Path:
    """Écrit le dashboard et ses exports dans out_dir, puis renvoie le chemin de index.html."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    now = now or datetime.now(PARIS)
    products = catalog.products

    meta = {
        "generated_label": f"{now.day} {MONTHS[now.month - 1]} {now.year} à {now:%H:%M}",
        "generated_iso": now.isoformat(timespec="seconds"),
        "files": len(catalog.files),
        "rows_read": sum(report.rows_read for report in catalog.files),
        "products": len(products),
        "threshold": PRICE_THRESHOLD,
        "repo_url": repo_url,
    }
    payload = {
        "meta": meta,
        "stats": stats,
        "checks": [check.to_dict() for check in checks],
        "files": [
            {
                "name": report.name,
                "providers": report.providers,
                "rows_read": report.rows_read,
                "rows_kept": report.rows_kept,
                "error": report.error,
            }
            for report in catalog.files
        ],
        "explorer": explorer_payload(products),
    }

    versions = copy_static(out_dir / "assets")
    env = Environment(loader=FileSystemLoader(PACKAGE_DIR / "templates"), autoescape=select_autoescape(["html", "j2"]))
    html = env.get_template("index.html.j2").render(
        meta=meta,
        summary=noscript_summary(stats["overview"]["kpis"]),
        rows_read=fmt_int(meta["rows_read"]),
        versions=versions,
        payload_json=script_json(payload),
    )
    index = out_dir / "index.html"
    index.write_text(html, encoding="utf-8")

    public = {key: payload[key] for key in ("meta", "stats", "checks", "files")}
    (out_dir / "stats.json").write_text(json.dumps(public, ensure_ascii=False, indent=2), encoding="utf-8")
    export_catalog(products, out_dir / "catalogue-consolide.csv")
    return index


def explorer_payload(products: pd.DataFrame) -> dict:
    """Catalogue compact (tableaux d'index) pour le comparateur côté navigateur."""
    providers = sorted(products["provider"].unique(), key=str.casefold)
    destinations = products.drop_duplicates("country_code")[["country_code", "country_name", "is_region"]]
    destinations = destinations.assign(_key=destinations["country_name"].map(sort_key))
    destinations = destinations.sort_values(["is_region", "_key"], ascending=[False, True]).reset_index(drop=True)
    gb_values = sorted(products.loc[~products["is_unlimited"], "data_gb"].unique())
    tiers = [f"{fmt_num(gb, 0 if float(gb).is_integer() else 1)} Go" for gb in gb_values]
    if products["is_unlimited"].any():
        tiers.append("Illimité")

    provider_index = {name: i for i, name in enumerate(providers)}
    destination_index = {code: i for i, code in enumerate(destinations["country_code"])}
    tier_index = {gb: i for i, gb in enumerate(gb_values)}
    unlimited_index = len(gb_values)

    rows = [
        [
            row.sku,
            provider_index[row.provider],
            destination_index[row.country_code],
            unlimited_index if row.is_unlimited else tier_index[row.data_gb],
            None if row.is_unlimited else float(row.data_gb),
            int(row.validity_days),
            round(float(row.price), 2),
            row.network,
            None if pd.isna(row.top_up) else bool(row.top_up),
        ]
        for row in products.itertuples()
    ]
    return {
        "providers": providers,
        "destinations": [
            {"code": row.country_code, "name": row.country_name, "is_region": bool(row.is_region)}
            for row in destinations.itertuples()
        ],
        "tiers": tiers,
        "validities": sorted(int(days) for days in products["validity_days"].unique()),
        "networks": sorted(products["network"].unique()),
        "columns": ["sku", "provider", "destination", "tier", "data_gb", "validity_days", "price", "network", "top_up"],
        "rows": rows,
    }


def export_catalog(products: pd.DataFrame, path: Path) -> None:
    """Catalogue consolidé, au format CSV « Excel français » (point-virgule, virgule décimale, BOM)."""
    export = products.drop(columns=["tier"], errors="ignore").copy()
    export["price_per_gb"] = (export["price"] / export["data_gb"]).round(2)
    export.to_csv(path, index=False, sep=";", decimal=",", encoding="utf-8-sig")


def sort_key(text: str) -> str:
    """Clé de tri insensible aux accents : « Égypte » se range avec les E, pas après « Z »."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold()


def copy_static(assets_dir: Path) -> dict[str, str]:
    """Copie le CSS et le JS, et renvoie une empreinte courte de chacun (anti-cache navigateur)."""
    assets_dir.mkdir(parents=True, exist_ok=True)
    versions = {}
    for name in STATIC_FILES:
        source = PACKAGE_DIR / "static" / name
        shutil.copyfile(source, assets_dir / name)
        versions[name] = hashlib.sha256(source.read_bytes()).hexdigest()[:10]
    return versions


def script_json(payload: dict) -> Markup:
    """JSON sûr à insérer dans une balise <script> : les chevrons et & sont échappés."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    text = text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return Markup(text)


def noscript_summary(kpis: dict) -> list[tuple[str, str]]:
    """Les indicateurs principaux, lisibles même sans JavaScript."""
    return [
        ("Cartes eSIM", fmt_int(kpis["products"])),
        (f"Produits à plus de {fmt_int(int(PRICE_THRESHOLD))}\u00a0€", f"{fmt_int(kpis['over_threshold'])} ({fmt_pct(kpis['over_threshold_share'])})"),
        ("Fourchette de prix", f"{fmt_eur(kpis['price_min'])} à {fmt_eur(kpis['price_max'])}"),
        ("Data moyenne par carte", f"{fmt_num(kpis['data_mean_gb'])} Go (hors forfaits illimités)"),
        ("Prix moyen", fmt_eur(kpis["price_mean"])),
        ("Fournisseurs", fmt_int(kpis["providers"])),
    ]
