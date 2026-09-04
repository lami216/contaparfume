#!/usr/bin/env python3
from pathlib import Path
import argparse, shutil, datetime, sys

START = "<!-- ECC-CODEX-KIT:START -->"
END = "<!-- ECC-CODEX-KIT:END -->"

def main():
    ap = argparse.ArgumentParser(description="Install ECC-Codex-Kit into a repository.")
    ap.add_argument("target", help="Path to target repository")
    ap.add_argument("--replace-config", action="store_true", help="Back up and replace existing .codex/config.toml")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    kit = Path(__file__).resolve().parent
    src = kit / "drop-in"
    target = Path(args.target).expanduser().resolve()
    if not src.exists():
        raise SystemExit("drop-in directory not found beside install.py")
    if not target.exists() or not target.is_dir():
        raise SystemExit(f"Target directory does not exist: {target}")

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = target / ".ecc-kit-backups" / stamp

    def log(msg):
        print(msg)

    def backup(path):
        rel = path.relative_to(target)
        dst = backup_root / rel
        log(f"BACKUP {rel} -> {dst.relative_to(target)}")
        if not args.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dst)

    def copy_file(s, d):
        rel = d.relative_to(target)
        if d.exists():
            try:
                if s.read_bytes() == d.read_bytes():
                    log(f"SKIP   {rel} (already current)")
                    return
            except OSError:
                pass
            backup(d)
        log(f"COPY   {rel}")
        if not args.dry_run:
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)

    # Root AGENTS: preserve existing custom instructions and append baseline once.
    src_agents = src / "AGENTS.md"
    dst_agents = target / "AGENTS.md"
    kit_text = src_agents.read_text(encoding="utf-8")
    block = f"\n\n{START}\n{kit_text}\n{END}\n"
    if dst_agents.exists():
        current = dst_agents.read_text(encoding="utf-8")
        if START in current and END in current:
            log("SKIP   AGENTS.md (ECC-Codex-Kit block already present)")
        else:
            backup(dst_agents)
            log("APPEND AGENTS.md")
            if not args.dry_run:
                dst_agents.write_text(current.rstrip() + block, encoding="utf-8")
    else:
        log("COPY   AGENTS.md")
        if not args.dry_run:
            dst_agents.write_text(kit_text, encoding="utf-8")

    # Merge all files except root AGENTS and config (handled specially).
    for s in sorted(src.rglob("*")):
        if not s.is_file():
            continue
        rel = s.relative_to(src)
        if rel.as_posix() in {"AGENTS.md", ".codex/config.toml"}:
            continue
        d = target / rel
        copy_file(s, d)

    src_cfg = src / ".codex" / "config.toml"
    dst_cfg = target / ".codex" / "config.toml"
    if dst_cfg.exists() and not args.replace_config:
        log("SKIP   .codex/config.toml (existing config preserved; pass --replace-config to use kit config)")
        alt = target / ".ecc-kit" / "suggested-codex-config.toml"
        log(f"COPY   {alt.relative_to(target)} (reference copy)")
        if not args.dry_run:
            alt.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_cfg, alt)
    else:
        copy_file(src_cfg, dst_cfg)

    log("DONE")
    if not args.dry_run:
        log("Review `git diff` / `git status` before committing.")

if __name__ == "__main__":
    main()
