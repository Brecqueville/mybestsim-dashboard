"""Point d'entrée : python -m esim_dashboard --data data --out site"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .loader import load_catalog
from .quality import run_checks
from .render import write_site
from .stats import build_stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m esim_dashboard",
        description="Génère le dashboard du catalogue eSIM à partir des CSV fournisseurs.",
    )
    parser.add_argument("--data", type=Path, default=Path("data"), help="dossier des CSV fournisseurs (défaut : data)")
    parser.add_argument("--out", type=Path, default=Path("site"), help="dossier de sortie du site (défaut : site)")
    parser.add_argument("--repo-url", default=None, help="lien vers le code source à afficher dans le dashboard (aucun par défaut)")
    args = parser.parse_args(argv)

    catalog = load_catalog(args.data)
    checks = run_checks(catalog)
    stats = build_stats(catalog.products)
    index = write_site(args.out, catalog, checks, stats, repo_url=args.repo_url)

    kpis = stats["overview"]["kpis"]
    print(f"{kpis['products']} produits, {kpis['providers']} fournisseurs, {len(catalog.rejected)} ligne(s) écartée(s)")
    print(f"Dashboard généré : {index}")
    in_github_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    for check in checks:
        if check.status in {"warning", "error"}:
            if in_github_actions:
                # Annotation visible dans l'onglet Actions de GitHub.
                level = "error" if check.status == "error" else "warning"
                print(f"::{level} title={_escape_property(check.label)}::{_escape_data(check.detail)}")
            else:
                print(f"[{check.status}] {check.label} : {check.detail}")
    return 0


def _escape_data(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(text: str) -> str:
    return _escape_data(text).replace(":", "%3A").replace(",", "%2C")


if __name__ == "__main__":
    sys.exit(main())
