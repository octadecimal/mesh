# Mesh

A local viewer for a long-lived Claude Code process. The server owns one
`claude` child in bidirectional stream-json mode, classifies its output, and
streams it to a browser over Server-Sent Events.

This is milestone one of the design in
`docs/superpowers/specs/2026-08-21-mesh-design.md`. There is no board yet.

## Requirements

- Node 24 or later
- Claude Code logged in with a subscription (`claude` on `PATH`)

Mesh never sets `ANTHROPIC_API_KEY` and never uses pay-per-token API billing.

## Running

```bash
npm install
npm run dev        # server on 127.0.0.1:4317
npm run dev:web    # browser on 127.0.0.1:5173
```

Pass a path to watch a different repository: `npm run dev -- /path/to/repo`.

## Testing

```bash
npm test
```

Tests replay recorded streams from `tests/fixtures/streams/` and never spawn a
real `claude` process, so the suite costs no quota.

## Configuration

`.mesh/config.json` in the target repository. Created on first run and
gitignored. The project manager's session id is written there so restarts
resume the same conversation.
