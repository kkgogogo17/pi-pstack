# pi-pstack agent notes

## Source

This package is a Pi-native port of [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack). Every skill, reference, playbook, and script under `skills/` is derived from the upstream tree; the local changes are restricted to the pi port adaptations listed in `CHANGELOG.md` and the per-skill pi vocabulary swaps (`subagent_type` → `agent`, `pstack/skills/` → `skills/`, `/goal` → standing objective, `/loop` → watcher wake via the loop skill, `control-ui`/`control-cli` from `cursor-team-kit` → project verification skills, hardcoded Grok model names → configured swarm-workers model from `~/.pi/agent/pstack/models.json`).

## Sync policy

When syncing upstream `cursor/plugins/pstack` into this port, items in any of the following four buckets are **deliberately skipped** — porting them would either fail to compile against pi, re-introduce Cursor-only mechanisms we already removed, or carry a hardcoded model that breaks the user-configurable model path. The list is exhaustive; the rationale is the same in each case.

- **No port** — upstream change touches no skill, reference, playbook, or script that this port carries.
- **No pi compatible** — upstream change relies on a Cursor-only surface (the `Task`/`subagent_type` model, Cursor Cloud VMs, Cursor transcript directories, the `cursor-team-kit` skill bundle, the Cursor automation API).
- **Cursor only** — upstream change lives entirely inside `.cursor-plugin/` or assumes Cursor's command and rule surface.
- **Grok only** — upstream change hardcodes a Grok model slug (e.g. `grok-4.6-fast-xhigh`) instead of going through the configured model; this port resolves models through `~/.pi/agent/pstack/models.json` and `inherit-parent` defaults, so the bump would be invisible or wrong.

The latest sync is PR #1, which covers upstream commits `63d938c`, `4612556`, `bdf7aa3` and skips the `make-bot-ui` pair (`#271`/`#275`) under the *Cursor only* + *no pi compatible* rules above. See `CHANGELOG.md` for the entry dated 2026-09-01.
