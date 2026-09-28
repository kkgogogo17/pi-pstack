---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /skill:swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N native pi-subagents workers. They may cover separate slices, race the same brief, or mix both. The parent collects the results and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the cloud concurrency limit.
4. Use the `swarm workers` role pool in `~/.pi/agent/pstack/models.json`. Resolve a model for each zero-based slot with `pstack_config({action: "resolve", role: "swarm workers", slot})`. An unconfigured role resolves to the parent model.
5. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`.

## Phase B: Fan out

When delegation is authorized, call `subagents_enable({})`, resolve each worker's model, and launch native `subagent` calls with `agent: "pi-pstack.poteto-agent"`, a self-contained `task`, and the selected `model`. For fanout, use a `workflowScript` with `runs.all`. Give each task explicit file pointers and prevent concurrent writes to shared paths. Do not assume sandboxing or isolation.

Use native pi-subagents workflow options for branch or worktree behavior. Check its guide for supported parameters and limits.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
