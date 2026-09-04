# ECC-Codex-Kit

A reusable, project-local Codex engineering kit inspired by and adapted from **Everything Claude Code (ECC)**, with additional original rules and skills for:
- e-commerce;
- accounting/financial systems;
- SaaS/admin systems;
- community/platform products;
- APIs/backend services;
- modern frontend/product design;
- Arabic/RTL;
- databases, security, testing, operations, and AI-enabled features.

This package contains **138 project-local skills**, 8 read-only Codex specialist roles, project profiles, and a strong reusable `AGENTS.md`.

## Important design choice: “70%”

This kit targets roughly **70%+ of the practical reusable engineering coverage** we want from ECC for general product repositories. It intentionally does **not** copy 70% of ECC's raw repository files by count.

Copying 70% literally would pull in large amounts of:
- provider/editor-specific integrations;
- duplicate/localized/generated material;
- commands/hooks that do not apply cleanly to Codex Cloud;
- niche stacks and unrelated skills;
- MCP/API-key integrations that would make a drop-in template harder to use.

The goal here is high-value coverage with low setup friction.

## No API key required

The drop-in package itself contains no secrets and requires no API key or MCP server.
It uses project-local `AGENTS.md`, `.agents/skills/`, and optional `.codex/` multi-agent configuration.

## Fastest installation

1. Extract this ZIP somewhere you keep templates.
2. Copy **everything inside `drop-in/`** into the root of your target repository.
3. Make sure hidden folders are included:
   - `.agents/`
   - `.codex/`
   - `.ecc-kit/`
4. Commit the files with the project if you want Codex Cloud sessions for that repository to see them.
5. Open the repo in Codex and work normally.

For a new repository, that is all.

## Existing repository with its own AGENTS.md/config

Use `install.py` for a safer merge:
```bash
python install.py /path/to/your/repo
```

It:
- merges skills and specialist agent files;
- appends the kit baseline to an existing root `AGENTS.md` only once;
- backs up colliding kit-managed files;
- does not replace an existing `.codex/config.toml` unless you pass `--replace-config`.

See `docs/INSTALLATION.md`.

## Project profiles

Codex should infer which areas matter from the repository. Optional reference profiles live under:
`drop-in/.ecc-kit/profiles/`

Included profiles:
- general web app
- e-commerce
- accounting & finance
- community/platform
- SaaS/admin
- API service
- mobile app
- AI-enabled app

## What is intentionally excluded

- Mandatory MCP servers
- API keys
- hard-pinned Codex model names
- editor-specific hooks
- automatic destructive commands
- arbitrary test-coverage percentage requirements
- blanket dependency upgrades
- niche ECC skills that do not generalize to your normal product work

## Attribution

ECC is MIT licensed. This kit is a curated/adapted derivative plus original material.
See `LICENSES/ECC-MIT.txt` and `SOURCES.md`.
