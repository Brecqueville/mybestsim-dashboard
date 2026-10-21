"""Lecture, validation et typage des fichiers CSV fournisseurs.

Chaque fichier est lu en texte brut, contrôlé, puis converti en types exploitables.
Une ligne invalide n'est jamais corrigée en silence : elle est écartée avec son motif,
pour que le rapport qualité du dashboard puisse l'afficher.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

EXPECTED_COLUMNS = [
    "sku",
    "provider",
    "product_name",
    "country_code",
    "country_name",
    "data_gb",
    "data_display",
    "validity_days",
    "price",
    "currency",
    "network",
    "top_up",
]

# Zones multi-pays du catalogue. Ce ne sont pas des codes ISO 3166 :
# en ISO, AS désigne les Samoa américaines et NA la Namibie.
REGION_CODES = frozenset({"EU", "AS", "NA", "WW"})

SUPPORTED_CURRENCY = "EUR"

TOP_UP_VALUES = {
    "oui": True,
    "non": False,
    "yes": True,
    "no": False,
    "true": True,
    "false": False,
    "1": True,
    "0": False,
}

_DATA_DISPLAY = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(go|gb|mo|mb)\s*$", re.IGNORECASE)


@dataclass
class FileReport:
    """Bilan de lecture d'un fichier fournisseur."""

    name: str
    providers: list[str]
    rows_read: int
    rows_kept: int
    error: str | None = None


@dataclass
class Catalog:
    """Catalogue consolidé : produits valides, lignes écartées et bilan par fichier."""

    products: pd.DataFrame
    rejected: pd.DataFrame
    files: list[FileReport]


def load_catalog(data_dir: Path) -> Catalog:
    """Lit tous les CSV d'un dossier et renvoie le catalogue consolidé."""
    paths = sorted(Path(data_dir).glob("*.csv"))
    if not paths:
        raise FileNotFoundError(f"Aucun fichier CSV trouvé dans {data_dir}")

    raw_frames: list[pd.DataFrame] = []
    files: list[FileReport] = []
    for path in paths:
        try:
            raw = read_raw_csv(path)
        except ValueError as exc:
            files.append(FileReport(path.name, [], 0, 0, error=str(exc)))
            continue
        raw_frames.append(raw)
        files.append(FileReport(path.name, sorted(raw["provider"].unique()), len(raw), 0))

    if not raw_frames:
        raise ValueError("Aucun fichier exploitable : tous les fichiers ont été rejetés")

    raw = pd.concat(raw_frames, ignore_index=True)
    products, rejected = parse_rows(raw)

    kept_per_file = products["source_file"].value_counts()
    for report in files:
        report.rows_kept = int(kept_per_file.get(report.name, 0))

    return Catalog(products=products, rejected=rejected, files=files)


def read_raw_csv(path: Path) -> pd.DataFrame:
    """Lit un CSV en texte brut et vérifie la présence des colonnes attendues.

    keep_default_na=False est indispensable : sans lui, pandas transforme le code
    « NA » (Amérique du Nord) en valeur manquante.
    """
    raw_bytes = path.read_bytes()
    try:
        text_head = raw_bytes[:2048].decode("utf-8-sig")
        encoding = "utf-8-sig"
    except UnicodeDecodeError:
        text_head = raw_bytes[:2048].decode("cp1252")
        encoding = "cp1252"
    first_line = text_head.splitlines()[0] if text_head else ""
    sep = ";" if first_line.count(";") > first_line.count(",") else ","

    try:
        frame = pd.read_csv(path, dtype=str, keep_default_na=False, sep=sep, encoding=encoding)
    except pd.errors.EmptyDataError as exc:
        raise ValueError("fichier vide") from exc
    except pd.errors.ParserError as exc:
        raise ValueError(f"CSV illisible ({exc})") from exc
    frame.columns = [column.strip().lower() for column in frame.columns]
    missing = [column for column in EXPECTED_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"colonnes manquantes : {', '.join(missing)}")

    frame = frame[EXPECTED_COLUMNS].apply(lambda column: column.str.strip())
    frame["source_file"] = path.name
    frame["source_line"] = frame.index + 2  # +1 pour l'en-tête, +1 car les lignes commencent à 1
    return frame


def parse_rows(raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Type les colonnes et sépare les lignes valides des lignes à écarter."""
    price = pd.to_numeric(raw["price"].str.replace(",", ".", regex=False), errors="coerce")
    validity = pd.to_numeric(raw["validity_days"], errors="coerce")
    currency = raw["currency"].str.upper()
    is_unlimited = raw["data_display"].str.lower().str.startswith("illimit")
    data_gb = pd.to_numeric(raw["data_gb"].str.replace(",", ".", regex=False), errors="coerce")
    from_label = pd.to_numeric(raw["data_display"].map(parse_data_display), errors="coerce")
    data_gb = data_gb.fillna(from_label).where(~is_unlimited)

    # Première règle non respectée = motif de rejet (l'ordre compte).
    rules = [
        (raw["sku"].eq(""), "SKU manquant"),
        (raw["provider"].eq(""), "fournisseur manquant"),
        (raw["country_code"].eq(""), "destination manquante"),
        (price.isna(), "prix non numérique"),
        (price.le(0), "prix nul ou négatif"),
        (currency.ne(SUPPORTED_CURRENCY), "devise non gérée"),
        (validity.isna() | validity.le(0) | (validity % 1).ne(0), "durée de validité invalide"),
        (~is_unlimited & (data_gb.isna() | data_gb.le(0)), "volume de data invalide"),
    ]
    reason = pd.Series("", index=raw.index)
    for mask, label in reversed(rules):
        reason = reason.mask(mask.fillna(False), label)
    duplicated_sku = raw["sku"].ne("") & raw["sku"].duplicated(keep="first")
    reason = reason.mask(reason.eq("") & duplicated_sku, "SKU en double")

    valid = reason.eq("")
    products = pd.DataFrame(
        {
            "sku": raw["sku"],
            "provider": raw["provider"],
            "product_name": raw["product_name"],
            "country_code": raw["country_code"].str.upper(),
            "country_name": raw["country_name"],
            "is_region": raw["country_code"].str.upper().isin(REGION_CODES),
            "data_gb": data_gb,
            "is_unlimited": is_unlimited,
            "data_display": raw["data_display"],
            "validity_days": validity,
            "price": price,
            "currency": currency,
            "network": raw["network"].str.upper(),
            "top_up": raw["top_up"].str.lower().map(TOP_UP_VALUES).astype("boolean"),
            "source_file": raw["source_file"],
        }
    )[valid].reset_index(drop=True)
    products["validity_days"] = products["validity_days"].astype(int)

    rejected = raw.loc[~valid, ["source_file", "source_line", "sku", "product_name", "price", "currency"]].copy()
    rejected["reason"] = reason[~valid]
    return products, rejected.reset_index(drop=True)


def parse_data_display(label: str) -> float | None:
    """Convertit un libellé de volume (« 5 Go », « 500 Mo ») en Go, sinon None."""
    match = _DATA_DISPLAY.match(label or "")
    if not match:
        return None
    value = float(match.group(1).replace(",", "."))
    return value / 1000 if match.group(2).lower() in {"mo", "mb"} else value
