# Kit Architecture

## Why project-local

The kit is designed to travel with the repository so Codex can discover the same engineering guidance across local/App and cloud checkouts.

## Layers

1. **`AGENTS.md`** — compact cross-project operating contract.
2. **`.agents/skills/`** — 138 deeper, selectively activated engineering skills.
3. **`.codex/agents/`** — read-only specialist reviewer/explorer roles.
4. **`.codex/config.toml`** — optional multi-agent wiring without MCP/API-key dependencies.
5. **`.ecc-kit/profiles/`** — domain-specific priorities for different product types.

## Why the specialist agents are read-only

The main agent remains the single write owner. Specialists analyze in parallel and return findings. This lowers the chance of conflicting edits when several agents inspect the same repository.

## Why skills are granular

Codex can load the relevant skill for a task without carrying every domain rule in the root instruction file. The root `AGENTS.md` stays readable while deeper knowledge remains discoverable.
