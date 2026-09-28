---
name: setup-pstack
description: Configure the Pi models pstack delegates to by role. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
disable-model-invocation: true
---

# Set up pstack for Pi

Use `/setup-pstack` to open the Pi-native interactive model picker. It lists models configured for this Pi session and writes the chosen role mappings to `~/.pi/agent/pstack/models.json`.

If interactive UI is unavailable, call `pstack_config` with `action: "list-models"`, then set each needed role with `action: "set"`. Values use Pi's exact `provider/model` format. Before each native child launch, call `pstack_config` with `action: "resolve"`, the role, and a zero-based slot. Pass the returned model to `subagent`. `inherit-parent` resolves to the current parent model.

## Rules

- Never write an unlisted model selector.
- Start with `inherit-parent` for any role without a deliberate model choice.
- Panel roles can be configured as an ordered array only by editing the JSON deliberately. Resolve each panel slot separately. The pool cycles when the slot exceeds its length.
- Re-run `/setup-pstack` whenever models or provider access changes.

The config is user-level and applies to every later pstack session. It is not repository configuration and must not be committed.
