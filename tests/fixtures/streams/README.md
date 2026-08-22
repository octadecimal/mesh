# Recorded Claude Code streams

Real `--output-format stream-json` recordings captured from Claude Code 2.1.239
on 2026-08-21 while probing the design in
`docs/superpowers/specs/2026-08-21-mesh-design.md`.

These are checked in deliberately. Regenerating them costs subscription quota,
and tests that replay them are deterministic and free.

| File | Contents |
| --- | --- |
| `simple-turn.ndjson` | One prompt, one reply. Includes `system/init`, `rate_limit_event`, and a `result` with full `usage`. |
| `multi-turn.ndjson` | Two user messages injected over `--input-format stream-json`. Two `result` events; shows cache reads on the second turn. |
| `subagent-conversation.ndjson` | A subagent dispatched, resumed via `SendMessage`, and collected. Contains `parent_tool_use_id` on subagent events and the full `task_started` / `task_updated` / `task_notification` / `background_tasks_changed` lifecycle. |
| `five-concurrent-worktrees.ndjson` | Five background subagents with `isolation: "worktree"` running concurrently. Contains `subagent_stats` and the worktree paths each agent reported. |

Do not edit these files. Add new recordings rather than modifying existing ones,
so tests keep a stable reference to observed behaviour.
