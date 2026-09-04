# Changelog

## 2026-09-01

Sync upstream `cursor/plugins/pstack` to version `0.14.3` in PR #1, covering commits `63d938c` (Grok default bump — *not applicable*, this port configures models via `~/.pi/agent/pstack/models.json` and `inherit-parent` defaults, so no hardcoded slug to bump), `4612556` (workflow and boundary guidance), and `bdf7aa3` (verified-checklist multi-PR plan + `check-plan.mjs` validator). All content was adapted to the pi workflow per the four skip buckets in `AGENTS.md` (no port, no pi compatible, cursor only, grok only).

The two newer upstream commits `799151d` (#271) and `6fecddb` (#275), both about the `make-bot-ui` skill, are deliberately skipped under the *cursor only* + *no pi compatible* rules — they rely on Cursor's automation API (`update_state`, `api2.cursor.sh` webhooks) and the Grok Bot wake mechanism, which have no pi equivalent. Future syncs should keep skipping `make-bot-ui` unless a pi-native equivalent appears.

### Changed: coexist with other `subagent` extensions

The extension no longer registers its `subagent` tool at load time. Pi treats two extensions registering the same tool name as a fatal load error in non-interactive runs, which broke every `pi -p` invocation when pi-cohort (or pi-subagents, `@tintinweb/pi-subagents`, ...) was installed alongside. Registration now happens in `session_start`, after pi's extension-conflict scan. When the `subagent` name is taken, pstack registers the same tool as `pstack_subagent` instead of standing down, so its semantics survive everywhere: bundled `poteto-agent`, `role`-based model routing, and chain templating are lost if delegation silently routes through another extension's tool. A `promptGuidelines` bullet and the Poteto Mode system prompt name whichever delegation tool is active in the session.

### Added: persistent pstack opt-in (`/pstack`)

New extension command in the style of ponytail's `/ponytail`: opt-in flag file at `~/.pi/agent/.pstack-active`, opt-in by default. `/pstack on` enables Poteto Mode for the current session and writes the flag so every future session auto-starts with the status bar showing `pstack: poteto mode`. `/pstack off` deletes the flag file and returns to the default-off state. `/pstack status` reports both states. On every session start the flag is applied after the session-branch walk, so it wins over stale in-session toggles: `/poteto-mode off` stays session-only, `/pstack on` survives restarts. `/poteto-mode` shows a one-time hint pointing at `/pstack on` when the flag is unset, so users stop toggling it every session.
