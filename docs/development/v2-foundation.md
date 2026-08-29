# V2 foundation development

Mesh V2 Milestone 1 is an implemented foundation that runs beside the existing
session platform. It has separate Nx projects, wire contracts, settings, ports,
and SQLite storage. It does not replace, upgrade, read, or migrate V1. For V1
operation, see [Session platform development](session-platform.md).

## Start the V2 applications

From the repository root, start each application in a separate terminal:

```powershell
corepack pnpm nx dev v2-server
```

```powershell
corepack pnpm nx dev v2-web
```

The server listens on `http://127.0.0.1:3838` by default. The web application
listens on `http://127.0.0.1:4300` and proxies `/api/v2` HTTP and WebSocket
traffic to the server. The server development command admits that exact web
origin when `MESH_V2_DEV_ORIGIN` is unset; an explicit setting takes precedence.
Both hosts remain loopback-only.

The parallel projects and defaults are:

| Surface | V1 | V2 Milestone 1 |
| --- | --- | --- |
| Server | `server`, port `3737` | `v2-server`, port `3838` |
| Web | `web`, port `4200` | `v2-web`, port `4300` |
| Contracts | `contracts` | `v2-contracts` |
| Acceptance | `e2e` | `v2-e2e` |
| Settings | `MESH_*` | `MESH_V2_*` |
| Default database | `~/.mesh-session-platform/session-platform.sqlite` | `~/.mesh/v2/mesh-v2.sqlite` |

## V2 settings and data

| Setting | Default and constraint |
| --- | --- |
| `MESH_V2_HOST` | `127.0.0.1`; only `127.0.0.1` and `::1` are accepted |
| `MESH_V2_PORT` | `3838` |
| `MESH_V2_WORKSPACE_ROOT` | the operator's home directory; overrides must be absolute |
| `MESH_V2_DATA_DIR` | `~/.mesh/v2`; overrides must be absolute |
| `MESH_V2_DATABASE_PATH` | `mesh-v2.sqlite` inside the V2 data directory; overrides must be absolute |
| `MESH_V2_DEV_ORIGIN` | exact loopback HTTP origin; the V2 server development command defaults it to `http://127.0.0.1:4300` |
| `MESH_V2_GIT_EXECUTABLE` | optional absolute Git executable override |
| `MESH_V2_WEB_ROOT` | optional absolute path to built V2 web assets |

V2 marks and migrates a fresh empty database with its own application identity.
It refuses a nonempty unmarked database or a database with another application
identity without mutating it. Point `MESH_V2_DATABASE_PATH` only at storage
owned by V2; the V1 database is deliberately outside this boundary.

`MESH_V2_FAKE_HOLD_AFTER_CURSOR` is an acceptance-test control. It is rejected
outside test mode and is not a normal operating setting.

## Foundation flow and verification

M1 supports V2 project registration, profile discovery and approval, and the
`foundation-check` execution kind. A browser command is validated through
`v2-contracts`, handled under `/api/v2`, committed with its durable event, and
then published to the browser projection. On restart, the server opens the V2
database, reconciles nonterminal execution evidence, publishes committed
recovery events, and restores the snapshot and replay path before accepting new
work.

Run the deterministic Chromium acceptance scenario with:

```powershell
corepack pnpm nx e2e v2-e2e --project=chromium
```

That suite runs the built V2 processes against a temporary Todo repository and
temporary V2 database. Its `Todo foundation survives restart without V1 state`
scenario starts a fake execution, restarts the backend with a fresh fake
adapter, and verifies durable execution and event recovery without V1 state.

Normal V2 M1 execution uses only the fake harness adapter. M1 has no real
harness smoke test and must not contact Claude, use subscription capacity, or
use API-billed traffic. The focused web shell contains inert placeholders for
later workflow domains; project intents, requirements, task boards, runs, QA,
integration, and worktree orchestration are not implemented in M1.
