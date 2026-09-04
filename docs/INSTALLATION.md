# Installation

## Method A — manual (recommended for new repos)

Copy the contents of `drop-in/` to the repository root.

Expected result:

```text
your-repo/
├── AGENTS.md
├── .agents/
│   └── skills/
├── .codex/
│   ├── config.toml
│   └── agents/
├── .ecc-kit/
│   ├── PROJECT-CONTEXT.template.md
│   └── profiles/
└── ...your existing project...
```

Commit these files if you want a cloud checkout of the repository to receive them.

## Method B — safe installer

```bash
python install.py /path/to/repo
```

Options:

```text
--replace-config    Back up and replace an existing .codex/config.toml
--dry-run           Show intended operations without writing
```

Behavior with collisions:
- Existing `AGENTS.md`: preserve it and append a clearly marked ECC-Codex-Kit baseline once.
- Existing `.codex/config.toml`: preserve by default; the skills and AGENTS instructions still install. Use `--replace-config` only if you want the included multi-agent roles/config.
- Existing kit skill with same name: back it up under `.ecc-kit-backups/<timestamp>/` before replacement.

## Optional project context

Copy:
`.ecc-kit/PROJECT-CONTEXT.template.md`
to:
`.ecc-kit/PROJECT-CONTEXT.md`

Fill it only when the repository needs extra product/business context. Do not put secrets in it.

## Removing the kit

If installed manually, remove only kit-owned files you added.
If a repository had an existing `AGENTS.md`, remove the text between:
`<!-- ECC-CODEX-KIT:START -->`
and
`<!-- ECC-CODEX-KIT:END -->`

Always review the Git diff before committing removal.
