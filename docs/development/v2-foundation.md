# V2 foundation development

Mesh V2 Milestones 1–3 are implemented beside the existing session
platform. V2 has separate Nx projects, wire contracts, settings, ports, and
SQLite storage. It does not replace, upgrade, read, or migrate V1. For V1
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

| Surface          | V1                                                 | V2 Milestones 1–3           |
| ---------------- | -------------------------------------------------- | --------------------------- |
| Server           | `server`, port `3737`                              | `v2-server`, port `3838`    |
| Web              | `web`, port `4200`                                 | `v2-web`, port `4300`       |
| Contracts        | `contracts`                                        | `v2-contracts`              |
| Acceptance       | `e2e`                                              | `v2-e2e`                    |
| Settings         | `MESH_*`                                           | `MESH_V2_*`                 |
| Default database | `~/.mesh-session-platform/session-platform.sqlite` | `~/.mesh/v2/mesh-v2.sqlite` |

## V2 settings and data

| Setting                  | Default and constraint                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MESH_V2_HOST`           | `127.0.0.1`; only `127.0.0.1` and `::1` are accepted                                                                                |
| `MESH_V2_PORT`           | `3838`                                                                                                                              |
| `MESH_V2_WORKSPACE_ROOT` | the operator's home directory; overrides must be absolute; used only as the base for relative repository paths, not as an allowlist |
| `MESH_V2_DATA_DIR`       | `~/.mesh/v2`; overrides must be absolute                                                                                            |
| `MESH_V2_DATABASE_PATH`  | `mesh-v2.sqlite` inside the V2 data directory; overrides must be absolute                                                           |
| `MESH_V2_DEV_ORIGIN`     | exact loopback HTTP origin; the V2 server development command defaults it to `http://127.0.0.1:4300`                                |
| `MESH_V2_GIT_EXECUTABLE` | optional absolute Git executable override                                                                                           |
| `MESH_V2_WEB_ROOT`       | optional absolute path to built V2 web assets                                                                                       |

V2 marks and migrates a fresh empty database with its own application identity.
It refuses a nonempty unmarked database or a database with another application
identity without mutating it. Point `MESH_V2_DATABASE_PATH` only at storage
owned by V2; the V1 database is deliberately outside this boundary.

`MESH_V2_FAKE_HOLD_AFTER_CURSOR` is an acceptance-test control. It is rejected
outside test mode and is not a normal operating setting.

Project registration accepts readable local Git working trees anywhere on the
machine. Absolute paths, `..`-relative paths, links, and linked worktrees may
resolve outside `MESH_V2_WORKSPACE_ROOT`; the server still canonicalizes Git's
top-level and common-directory paths and requires one committed 40- or
64-character `HEAD`.

`MESH_V2_TEST_FAKE_PM_SCENARIO=todo` selects the deterministic Todo project
manager conversation used by V2 acceptance. The server accepts it only when
`NODE_ENV=test`; it is not a production setting or a real project-manager mode.

The V2 process fixture also gives each built test process an absolute,
fixture-owned `MESH_V2_DATA_DIR`, repository root, database path, web root,
`HOME`, and `USERPROFILE`, and asks the server to select an ephemeral port. It
uses only loopback traffic and removes the temporary repository, database, and
processes it owns. These controls prevent acceptance from reading operator data
or starting a real agent.

## Foundation, intent-ledger, planning, and Board flow

M1 supports V2 project registration, profile discovery and approval, and the
`foundation-check` execution kind. A browser command is validated through
`v2-contracts`, handled under `/api/v2`, committed with its durable event, and
then published to the browser projection. On restart, the server opens the V2
database, reconciles nonterminal execution evidence, publishes committed
recovery events, and restores the snapshot and replay path before accepting new
work.

M2 adds project-owned planning cycles and the approved intent ledger. Each
human turn launches at most one finite project-manager execution. That execution
must return one structured set of questions or one complete proposal; it does
not remain as an open-ended chat session. Planning turns, questions, proposal
revisions, recovery state, and terminal history are durable across restart.
Human approval is the atomic boundary that creates immutable project-intent and
ledger revisions with record provenance and relationships. The Requirements
pane renders the approved intent plus requirement, assumption, decision,
question, and risk records.

M3 adds a separate durable delivery-planning cycle. A project manager can
propose and revise a multi-milestone plan, but its revisions remain immutable
proposals until explicit human approval. Approval atomically creates the
canonical delivery-plan revision, milestones, task contracts, dependencies,
and requirement traces. The server derives actionable and blocked work from
canonical lifecycle and dependency state, persists the cross-milestone Board
filter, and returns the versioned Board projection. Refresh, replay, retained-
gap resync, and restart rebuild the browser from durable server truth.

M3 stops at planning and deterministic readiness. M4 owns workspace allocation
and `DeveloperAttempt`; M5 owns `ExecutionRun` scheduling, concurrency, and
dependency-wave orchestration.

Run the deterministic Chromium acceptance scenario with:

```powershell
corepack pnpm nx e2e v2-e2e --project=chromium
```

That suite runs the built V2 processes against a temporary Todo repository and
temporary V2 database. Its `Todo foundation survives restart without V1 state`
scenario starts a fake execution, restarts the backend with a fresh fake
adapter, and verifies durable execution and event recovery without V1 state.
Its `conversation becomes an approved intent ledger` scenario uses the
test-only Todo PM script, restarts the same temporary database between both
turns and after approval, forces a retained-gap resynchronization, and proves
that transcript, questions, intent revision 1, ledger revision 1, provenance,
and relationships remain identical.

Planning acceptance stays thin and vertical. Its primary
`approved delivery plan becomes a deterministic Board` journey covers proposal,
revision, explicit approval, traceable multi-milestone Board state,
deterministic readiness, representative cross-milestone filtering, and refresh.
The separate `approved planning state survives a built server restart` journey
proves byte-equivalent planning history, proposal revisions, canonical plan,
dependencies, traces, saved filter, readiness, and Board state after reopening
the same fixture database. Repository and service integration tests own the
exhaustive atomicity, idempotency, revision, corruption, rollback, readiness,
and replay-boundary matrices; component tests own UI-state and filter matrices.
The existing intent-ledger browser journey already proves retained-gap browser
resynchronization, so M3 does not duplicate it with another reconnect journey.
Tests wait for observable commands, snapshots, and UI state rather than sleeps
or retries.

V2 M1–M3 execution currently uses only the fake harness adapter. The real
Claude smoke test documented for the established session platform is separate,
opt-in, and consumes subscription capacity; it is never part of V2 acceptance
or default verification. Do not supply `ANTHROPIC_API_KEY` or use API-billed
traffic. V2 acceptance neither requires nor authorizes real-agent traffic.
