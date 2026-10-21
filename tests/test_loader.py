import math

from esim_dashboard.loader import load_catalog, parse_data_display


def test_na_code_stays_north_america(small_catalog):
    products = load_catalog(small_catalog).products
    north_america = products[products["sku"] == "beta-2"].iloc[0]
    assert north_america["country_code"] == "NA"
    assert north_america["is_region"]


def test_unlimited_plan_is_kept_without_volume(small_catalog):
    products = load_catalog(small_catalog).products
    unlimited = products[products["sku"] == "alpha-3"].iloc[0]
    assert unlimited["is_unlimited"]
    assert math.isnan(unlimited["data_gb"])


def test_invalid_rows_are_rejected_with_a_reason(write_csv):
    folder = write_csv(
        "gamma.csv",
        [
            "g-1,Gamma,eSIM Italie 3 Go 7 jours,IT,Italie,3,3 Go,7,9.5,EUR,4G,oui",
            "g-2,Gamma,eSIM Italie 3 Go 7 jours,IT,Italie,3,3 Go,7,abc,EUR,4G,oui",
            "g-3,Gamma,eSIM Italie 3 Go 7 jours,IT,Italie,3,3 Go,7,-4,EUR,4G,oui",
            "g-4,Gamma,eSIM Italie 3 Go 7 jours,IT,Italie,3,3 Go,7,9.5,USD,4G,oui",
            "g-1,Gamma,eSIM Italie 3 Go 7 jours,IT,Italie,3,3 Go,7,9.9,EUR,4G,oui",
            "g-5,Gamma,eSIM Italie 3 Go 0 jours,IT,Italie,3,3 Go,0,9.5,EUR,4G,oui",
        ],
    )
    catalog = load_catalog(folder)
    assert list(catalog.products["sku"]) == ["g-1"]
    assert list(catalog.rejected["reason"]) == [
        "prix non numérique",
        "prix nul ou négatif",
        "devise non gérée",
        "SKU en double",
        "durée de validité invalide",
    ]
    assert catalog.files[0].rows_read == 6
    assert catalog.files[0].rows_kept == 1


def test_semicolon_separator_and_decimal_comma(write_csv):
    folder = write_csv(
        "delta.csv",
        ["d-1;Delta;eSIM Japon 500 Mo 7 jours;JP;Japon;;500 Mo;7;4,90;eur;5g;Oui"],
        sep=";",
    )
    row = load_catalog(folder).products.iloc[0]
    assert row["price"] == 4.9
    assert row["data_gb"] == 0.5  # volume déduit du libellé « 500 Mo »
    assert row["currency"] == "EUR"
    assert row["network"] == "5G"
    assert bool(row["top_up"])


def test_file_with_missing_column_is_reported_not_fatal(write_csv):
    write_csv("ok.csv", ["o-1,Ok,eSIM Grèce 1 Go 7 jours,GR,Grèce,1,1 Go,7,6,EUR,4G,oui"])
    folder = write_csv("broken.csv", ["b-1,Broken,eSIM Grèce 1 Go 7 jours,GR"], header="sku,provider,product_name,country_code")
    catalog = load_catalog(folder)
    broken = next(report for report in catalog.files if report.name == "broken.csv")
    assert "colonnes manquantes" in broken.error
    assert list(catalog.products["sku"]) == ["o-1"]


def test_parse_data_display():
    assert parse_data_display("5 Go") == 5
    assert parse_data_display("500 Mo") == 0.5
    assert parse_data_display("2,5 GB") == 2.5
    assert parse_data_display("Illimité") is None
