from pathlib import Path

import pytest

HEADER = "sku,provider,product_name,country_code,country_name,data_gb,data_display,validity_days,price,currency,network,top_up"
REAL_DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def write_csv(tmp_path):
    """Écrit un CSV fournisseur dans un dossier temporaire et renvoie ce dossier."""

    def _write(name: str, rows: list[str], header: str = HEADER, sep: str = ",") -> Path:
        lines = [header.replace(",", sep), *rows]
        (tmp_path / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        return tmp_path

    return _write


@pytest.fixture
def small_catalog(write_csv):
    """Mini-catalogue aux résultats connus, calculables à la main."""
    write_csv(
        "alpha.csv",
        [
            "alpha-1,Alpha,eSIM France 1 Go 7 jours,FR,France,1,1 Go,7,10,EUR,4G,oui",
            "alpha-2,Alpha,eSIM France 5 Go 15 jours,FR,France,5,5 Go,15,20,EUR,5G,non",
            "alpha-3,Alpha,eSIM Europe Illimité 30 jours,EU,Europe,,Illimité,30,150,EUR,5G,oui",
        ],
    )
    return write_csv(
        "beta.csv",
        [
            "beta-1,Beta,eSIM France 1 Go 7 jours,FR,France,1,1 Go,7,12,EUR,4G,oui",
            "beta-2,Beta,eSIM Amérique du Nord 10 Go 30 jours,NA,Amérique du Nord,10,10 Go,30,100,EUR,4G,non",
        ],
    )
