"""Spreadsheet output safety shared by every file VIPER produces for Excel (explorer CSV, workbook
export): which texts a spreadsheet would evaluate as a formula when typed or opened (formula / CSV
injection). A signed plain number (`+33612345678`, `-12,5`) is data, not a formula.
"""

import re

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
SIGNED_NUMBER = re.compile(r"[+-][0-9][0-9 .,]*")


def looks_like_formula(text: str) -> bool:
    return text.startswith(FORMULA_PREFIXES) and not SIGNED_NUMBER.fullmatch(text)
