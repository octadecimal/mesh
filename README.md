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

### Viewing from Windows under WSL2

The dev server binds every interface, so the viewer opens in a native Windows
browser at either:

```
http://localhost:5173      # via WSL localhost forwarding
http://<wsl-ip>:5173       # direct; find it with `hostname -I`
```

Use the second if the first does not answer — localhost forwarding is the part
that breaks. Only the frontend is exposed this way; the API stays bound to
`127.0.0.1` and is reached through the Vite proxy inside WSL. Windows does not
forward the WSL network onward, so the page is reachable from the host, not
from the wider LAN.

## Testing

```bash
npm test
```

Tests replay recorded streams from `tests/fixtures/streams/` and never spawn a
real `claude` process, so the suite costs no quota.

### End-to-end

Browser tests drive the viewer in headless Chromium against those same recorded
streams:

```bash
npm run test:e2e
```

The first run needs the browser and its system libraries. Playwright's
`install --with-deps` shortcut shells out to `sudo` and needs an interactive
terminal, which fails under WSL2 tooling — so install the two halves
separately, the second from your own terminal:

```bash
npx playwright install chromium
sudo apt-get install -y libnss3 libnspr4 libasound2t64
```

Those package names are Ubuntu 24.04 (noble). On 22.04 the last one is
`libasound2`. If Chromium still refuses to start, list what is missing with:

```bash
ldd ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep 'not found'
```

To drive the real `claude` binary through the browser instead of the stub:

```bash
npm run test:e2e:real
```

That one spends subscription quota, so it is skipped unless `MESH_E2E_REAL=1`.

## Configuration

`.mesh/config.json` in the target repository. Created on first run and
gitignored. The project manager's session id is written there so restarts
resume the same conversation.
