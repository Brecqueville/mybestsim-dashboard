"""Contrôles qualité affichés dans le dashboard.

Chaque contrôle renvoie un statut lisible par un humain :
ok (rien à signaler), info (choix de traitement), warning (à vérifier), error (données perdues).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .formatting import fmt_int, fmt_pct
from .loader import REGION_CODES, SUPPORTED_CURRENCY, Catalog

# Fiche technique d'un produit : deux lignes identiques sur ces colonnes
# mais avec des prix différents sont des doublons possibles.
SPEC_COLUMNS = ["provider", "country_code", "data_display", "validity_days", "network", "top_up"]


@dataclass
class Check:
    label: str
    status: str
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


def run_checks(catalog: Catalog) -> list[Check]:
    """Passe le catalogue au crible et renvoie la liste des contrôles."""
    products, rejected, files = catalog.products, catalog.rejected, catalog.files
    checks: list[Check] = []

    bad_files = [report for report in files if report.error]
    if bad_files:
        names = " ; ".join(f"{report.name} ({report.error})" for report in bad_files)
        checks.append(Check("Schéma des fichiers", "error", f"{len(bad_files)} fichier(s) ignoré(s) : {names}"))
    else:
        checks.append(Check("Schéma des fichiers", "ok", f"{len(files)}/{len(files)} fichiers lus, 12 colonnes conformes"))

    rows_read = sum(report.rows_read for report in files)
    if len(rejected):
        reasons = rejected["reason"].value_counts()
        summary = ", ".join(f"{label} : {fmt_int(count)}" for label, count in reasons.items())
        checks.append(Check("Lignes écartées", "warning", f"{fmt_int(len(rejected))} ligne(s) sur {fmt_int(rows_read)} ({summary})"))
    else:
        checks.append(Check("Validité des lignes", "ok", f"{fmt_int(rows_read)}/{fmt_int(rows_read)} lignes valides : prix > 0, durée et volume cohérents"))

    duplicated_skus = int((rejected["reason"] == "SKU en double").sum())
    checks.append(
        Check("Unicité des SKU", "warning" if duplicated_skus else "ok",
              f"{fmt_int(duplicated_skus)} SKU en double écarté(s), première occurrence conservée" if duplicated_skus
              else f"{fmt_int(products['sku'].nunique())} SKU, tous distincts")
    )

    other_currency = int((rejected["reason"] == "devise non gérée").sum())
    checks.append(
        Check("Devise", "warning" if other_currency else "ok",
              f"{fmt_int(other_currency)} ligne(s) dans une autre devise que l'{SUPPORTED_CURRENCY} écartée(s) (pas de taux de change fiable)"
              if other_currency else f"100 % des prix en {SUPPORTED_CURRENCY}, aucune conversion nécessaire")
    )

    mixed = [report.name for report in files if len(report.providers) > 1]
    checks.append(
        Check("Un fichier = un fournisseur", "warning" if mixed else "ok",
              f"Plusieurs fournisseurs dans : {', '.join(mixed)}" if mixed else "Chaque fichier ne contient qu'un seul fournisseur")
    )

    expected_names = "eSIM " + products["country_name"] + " " + products["data_display"] + " " + products["validity_days"].astype(str) + " jours"
    inconsistent = int((expected_names != products["product_name"]).sum())
    checks.append(
        Check("Nom produit cohérent", "warning" if inconsistent else "ok",
              f"{fmt_int(inconsistent)} nom(s) de produit ne correspondent pas aux colonnes" if inconsistent
              else "Le nom de chaque produit correspond à sa destination, son volume et sa durée")
    )

    unlimited = int(products["is_unlimited"].sum())
    checks.append(
        Check("Forfaits illimités", "info",
              f"{fmt_int(unlimited)} forfaits ({fmt_pct(unlimited / len(products))}) n'ont pas de volume chiffré : "
              "ils sont comptés partout sauf dans la moyenne de data par carte")
    )

    present_regions = sorted(set(products["country_code"]) & REGION_CODES)
    checks.append(
        Check("Codes de zone non ISO", "info",
              f"{', '.join(present_regions)} désignent des zones multi-pays. "
              "« NA » (Amérique du Nord) est lu en texte strict pour ne pas devenir une valeur manquante")
    )

    priced = products.groupby(SPEC_COLUMNS, dropna=False)["price"].agg(["count", "nunique"])
    duplicates = priced[(priced["count"] > 1) & (priced["nunique"] > 1)]
    if len(duplicates):
        checks.append(
            Check("Doublons possibles", "warning",
                  f"{fmt_int(len(duplicates))} groupes ({fmt_int(int(duplicates['count'].sum()))} produits) ont la même fiche technique "
                  "(fournisseur, destination, data, durée, réseau, recharge) mais des prix différents. "
                  "Conservés car leurs SKU diffèrent ; à confirmer avec les fournisseurs")
        )
    else:
        checks.append(Check("Doublons possibles", "ok", "Aucune fiche technique en double à prix différent"))

    return checks
