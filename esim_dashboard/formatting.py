"""Mise en forme des nombres à la française (5 056 ; 29,30 € ; 1,1 %)."""

from __future__ import annotations

THOUSANDS = " "  # espace fine insécable, comme Intl.NumberFormat("fr-FR")
UNIT_SPACE = " "  # espace insécable avant € et %


def fmt_num(value: float, decimals: int = 1) -> str:
    text = f"{value:,.{decimals}f}"
    return text.replace(",", THOUSANDS).replace(".", ",")


def fmt_int(value: int) -> str:
    return fmt_num(value, 0)


def fmt_eur(value: float) -> str:
    return f"{fmt_num(value, 2)}{UNIT_SPACE}€"


def fmt_pct(ratio: float, decimals: int = 1) -> str:
    return f"{fmt_num(ratio * 100, decimals)}{UNIT_SPACE}%"
