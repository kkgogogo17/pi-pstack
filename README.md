# pi-pstack

A Pi-native port of [pstack](https://github.com/cursor/plugins/tree/main/pstack). It includes all 44 upstream skills and their references, playbooks, and scripts, plus `poteto-agent` and `comment-sicko` definitions for pi-subagents.

## Install

Install pi-subagents and this modified checkout as a local Pi package:

```bash
pi install npm:pi-subagents@0.73.1
pi install /path/to/this/pi-pstack-checkout
```

The published `pi-pstack@v0.1.0` still registers its own `subagent` tool. Do not load that tag alongside pi-subagents. Restart Pi after switching packages. Use `pi config` to enable or disable package resources.

If Pi fails to start after installing pi-subagents 0.73.1, an older `~/.pi/agent/extensions/subagent/config.json` may contain the removed `modelExclusions` setting. Remove that setting from your existing operator configuration before restarting. Do not edit it automatically.

## Start

```text
/setup-pstack
/poteto-mode investigate and fix the retry regression, then verify it
/poteto-mode off
```

`/setup-pstack` is an extension command. It maps pstack roles to models available in Pi and saves them in `~/.pi/agent/pstack/models.json`.

`/poteto-mode` enables sticky Poteto Mode for the current Pi session and expands the bundled `poteto-mode` skill. `/poteto-mode off` disables it. Individual skills use Pi's standard form, for example `/skill:how` and `/skill:no-comments`.

## Delegate with pi-subagents

pi-pstack does not register a second `subagent` tool or run child processes. Install pi-subagents and use its native tools. When delegation is authorized by the current request or applicable instructions, call `subagents_enable({})` to expose `subagent`.

Resolve each child model before launch:

```js
const selection = await pstack_config({ action: "resolve", role: "feature, refactoring", slot: 0 });
await subagent({ agent: "pi-pstack.poteto-agent", task: "Implement the change and verify it", model: selection.model, async: true, isolation: "worktree" });
```

`slot` is a zero-based position in the configured role pool. A single configured model works for every slot. A model pool cycles by slot. `inherit-parent` resolves to the current Pi model. `pstack_config` rejects unknown roles, invalid slots, missing parent models, and configured models that are unavailable or ambiguous.

Launch direct async work with `subagent({agent, task, model, async: true})`. Concurrent writers must use `isolation: "worktree"`. Managed worktree allocation requires a clean source checkout. If the source is dirty, create a separate clean worktree and launch the writer from there. Leave existing changes alone.

An isolated writer's edits do not land in the parent checkout automatically. Inspect native `status`, the run's handoff, and its durable patch. Verify the patch, then explicitly apply or merge it before declaring the task done.

Read-only children do not need worktree isolation. Use `workflowScript` with `runs.all` for fanout and `runs.run` for sequential work. Native `status` reports lifecycle state, and `resume` continues only eligible retained runs. pi-subagents owns execution, limits, and receipts. Consult its installed guide for action and workflow limits. pi-pstack adds no parallelism or lifecycle limits.

The package manifest exposes `./agents` through `pi.subagents.agents`. The bundled `poteto-agent` must read the full `poteto-mode` skill before working. `comment-sicko` reviews comments only.

Delegation needs authorization from the current request or applicable instructions. Complexity alone does not grant permission. Get explicit user confirmation before any external or irreversible action, including pushes, pull-request changes, merges, deployments, infrastructure changes, recursive deletion, or customer messages. The extension checks recognizable commands in `bash`, native `subagent` `gate` and `acceptance.verify` commands, and the named `run-ci` workflow before execution. It rejects raw `workflowScript` host calls. This guard is not a sandbox. It cannot prove that an arbitrary command or child action is harmless. Do not describe native subagents as sandboxed.

## Safety and compatibility

This port removes Cursor-only setup and behavior:

| Cursor pstack behavior | Pi equivalent |
|---|---|
| `Task` and `subagent_type` | Native pi-subagents and Markdown agent definitions |
| Cursor model slugs and rules | `/setup-pstack`, `pstack_config`, and Pi `provider/model` selectors |
| sticky `mode: true` | Session-persisted `/poteto-mode` extension command |
| Cursor todo list | `pstack_todo` tool |
| Cursor transcript directories | `$PI_SESSION_FILE` and `pstack_sessions` |
| `/loop`, cloud-agent resume | Explicit project watchers and native pi-subagents status/resume |
| Cursor Team Kit skills | Capability detection and project-native verification tooling |

The upstream `watch-pr` and orchestration helper scripts are retained. Their runtime requirements remain project-specific. In particular, the script package uses Bun and GitHub workflows require `gh` authentication.

## License and provenance

Derived from Cursor's pstack, licensed under MIT. See [LICENSE](LICENSE).
