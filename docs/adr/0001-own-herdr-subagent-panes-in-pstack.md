# Pstack owns its Herdr subagent panes

Status: Accepted

## Context

The installed pstack extension split a pane for each visible subagent, returned the completed tool result, and left the pane open. The separate Herdr observer watches agents named `sub-*`, but it may need a parent handoff and exact acknowledgment before closing one. Two independent closers could also race after a child settles.

## Decision

Pstack names its own children `psub-*` and does not register them as observer-managed `sub-*` children. Before splitting, it checks the caller's `HERDR_PANE_ID` against `herdr pane current --current` and places the verified parent pane ID in the child's prompt. A missing or changed identity blocks delegation rather than giving the child the wrong pane. Pstack passes the agent's instructions as a system prompt when it starts Pi. It accepts a completed assistant message only when the child session appends that message after prompt submission. It does not use terminal display text as an answer. After capturing the result, pstack checks the named agent's original pane and terminal identity, foreground process, and settled state before closing its pane. It reports an open or unconfirmed pane ID rather than retrying an uncertain agent start or prompt, or closing on a blocked state or cancellation. The observer continues to manage children it owns through its receipt protocol.

## Consequences

The successful pstack tool result carries the child's answer; the observer does not request a duplicate handoff for that child. A crash before pstack returns or an uncertain close can leave a `psub-*` pane needing investigation. Herdr does not offer a conditional close by terminal identity, so pstack checks immediately before close but cannot make the identity check and close atomic. Do not treat the guard as permission to close a pane after its identity changes.
