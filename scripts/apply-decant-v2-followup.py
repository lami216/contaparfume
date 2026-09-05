from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

replace_once(
    "app/report-types.ts",
    'kind: "sale" | "purchase" | "expense";',
    'kind: "sale" | "decant-sale" | "purchase" | "decant-purchase" | "expense";',
)
replace_once(
    "app/conta-app.tsx",
    ': [], [data.products, term]);',
    ': [], [data.products, term, mode]);',
)
print("decant v2 follow-up patch applied")
