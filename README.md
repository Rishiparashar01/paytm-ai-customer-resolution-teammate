# Paytm AI Customer Resolution Teammate

An outcome-driven autonomous AI agent for fintech customer support — full-stack SaaS with an npm-workspaces monorepo (`backend/` + `frontend/`).

The agent receives a customer complaint (failed transaction), gathers context, uses an AI planner to propose a resolution action, runs it through a deterministic **policy engine (RP_001–RP_007)**, executes the tool only if allowed, verifies the outcome by **re-reading the database**, and records every step in an **immutable append-only audit log**. High-value or risky actions pause for human supervisor approval.

## Three demo scenarios (end-to-end)

| Scenario | Case | Result |
|---|---|---|
| **A** | ₹1,250 failed Airtel recharge, account `ACTIVE` | Fully autonomous retry → `VERIFIED_SUCCESS` |
| **B** | ₹3,500 failed Tata Power payment | Exceeds ₹2,000 autonomous cap → `HUMAN_REVIEW`; supervisor approves → retry succeeds → `VERIFIED_SUCCESS` |
| **C** | Account `FROZEN`, ₹890 metro card txn | `BLOCKED` at **RP_002** → no mutation → `VERIFIED_FAILURE`, escalated to support |

**Non-negotiable invariants**

- No financial mutation without a fresh idempotency key (`idemp_<uuid>`).
- No action executes without passing policy evaluation.
- "Success" is only claimed after the DB is re-read and a new `SUCCESS` transaction is confirmed.
- Every state transition writes an immutable audit entry.
- A human-approved action re-enters policy evaluation before execution.

## Tech stack

- **Backend:** Node ≥ 18.18 · Express 4 · TypeScript (strict, `Node16` resolution) · Prisma 6 · PostgreSQL
- **Frontend:** React 19 · Vite 6 · TypeScript · lucide-react — dark "Control Room" dashboard
- **AI:** Google Gemini adapter with a deterministic **offline fallback** (used automatically when `GEMINI_API_KEY` is empty)

## Quick start

```bash
# 1. Install (workspaces)
npm install

# 2. Database — Docker:
docker compose up -d postgres
#    (or any PostgreSQL 16+ with DATABASE_URL below)

# 3. Configure backend/.env  (copy from .env.example)
cp backend/.env.example backend/.env
#    edit DATABASE_URL / GEMINI_API_KEY (optional)

# 4. Create schema (either is fine for a demo bootstrap)
npm --workspace=backend exec -- prisma migrate dev --name init   # one migration
npm --workspace=backend exec -- prisma db push                   # or plain push

# 5. Run
npm run dev:backend     # API on http://localhost:4000
npm run dev:frontend    # UI  on http://localhost:5173
```

Then open <http://localhost:5173>, pick a scenario and press **Run Workflow**.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev:backend` | `tsx watch src/server.ts` |
| `npm run dev:frontend` | Vite dev server |
| `npm run build:backend` | `prisma generate && tsc` |
| `npm run build:frontend` | `tsc -b && vite build` |
| `npm run build:all` | Both builds |
| `npm run test:all` | 5 test suites (`tsx`, **requires live PostgreSQL**) |

## API (`/api/v1`)

- `GET  /health` — liveness (also at `/api/v1/health`)
- `GET  /demo/scenarios` — the 3 scenario descriptors
- `POST /demo/seed-scenario` `{scenario}` → `{sessionId, customerId, transactionId}`
- `POST /sessions/:sessionId/run` `{maxSteps?}` → runs the orchestrator loop + snapshot
- `GET  /sessions/:sessionId` → snapshot (session + steps + reviews + audit)
- `POST /sessions/:sessionId/human-review/:reviewId/verdict` `{verdict, reviewerNotes?, modifiedParams?}`

## Architecture

```
backend/src/
  app.ts / server.ts          Express app factory + graceful server entry
  config/env.ts               Validated env (PORT, DATABASE_URL, Gemini, policy caps)
  middleware/                 security headers · rate limiter (120/min/IP) · CORS allowlist · 404 · error handler
  orchestrator/orchestrator.ts  State machine: INTAKE → GATHERING_CONTEXT → FORMULATING_PLAN
                                → POLICY_EVALUATION → EXECUTING_STEP → VERIFYING_OUTCOME
                                → RESOLVED_SUCCESS | RESOLVED_FAILURE | ESCALATED (+ HUMAN_REVIEW)
  policy/engine.ts            RP_001…RP_007 (first-hit wins) + NOTIF_001…005
  planners/geminiAdapter.ts   Gemini JSON planner + deterministic offline fallback
  services/                   audit (append-only) · transaction (retryPayment idempotency)
                              · mockBillerGateway · notification · support · customer
  tools/                      Zod-validated registry: retry_payment, send_customer_notification,
                              escalate_to_human_support, read-only lookups
  routes/                     demo + session routes
  test_*.ts                   5 live-DB suites (run with tsx)
```

**Policy order (first hit wins):** `RP_001` idempotency → `RP_002` account ACTIVE → `RP_003` transaction integrity → `RP_004` retry eligibility → `RP_005` retry budget → `RP_006` ₹2,000 amount cap (`REQUIRES_HUMAN`, `Infinity` after approval) → `RP_007` final gate.

**retryPayment idempotency:** existing key + `SUCCESS` → replay; existing key + non-success → `409 IDEMPOTENCY_CONFLICT`; gateway success creates a `SUCCESS` txn inside a try/catch that converts Prisma `P2002` races into a replay of the winner (never a 500).

## Frontend (Control Room)

`Header` · `MetricsStrip` (autonomy rate, avg resolution time, success rate, human escalations, audit events) · `ScenarioSelector` · `WorkflowPipeline` (7-step, done=green / active=cyan pulse / blocked=red) · `CasePanel` · `AiPlannerPanel` · `PolicyEnginePanel` (RP_001–RP_007 rows: PASS/FAIL/REVIEW/SKIP + verdict banner) · `ExecutionAndOutcomePanel` · `HumanReviewModal` (Approve / Reject / Modify) · `AuditTimeline`.

API base is **100% env-driven** via `VITE_API_BASE_URL` (no hardcoded production URL).

## Deployment

- **`Dockerfile.backend`** — multi-stage `node:22-alpine` (`prisma generate` → `tsc` → `npm ci --omit=dev` → `prisma migrate deploy || prisma db push && node dist/server.js`)
- **`docker-compose.yml`** — `postgres:16` + backend with healthcheck dependency
- **Railway** — `railway.json` + `nixpacks.toml` (workspaces install → `build:backend` → `npm --workspace=backend start`, healthcheck `/health`)
- **Vercel full-stack** — `vercel.json` + `api/app.ts` (serverless Express mount); env: `DATABASE_URL` (pooled), `CORS_ORIGIN`, `NODE_ENV`, optional `GEMINI_API_KEY`

## Security notes

- `.env` never committed (only `.env.example` with placeholders)
- Prisma `binaryTargets` include Linux targets (shipped client isn't Windows-only)
- CORS is explicit allowlist only — never `origin: true` with credentials
- 500 responses never leak `err.message` in production
- In-memory sliding-window rate limiting (120 req/min/IP) + security headers
- Tests: `src/test_live_servers.ts`, `test_part5.ts`, `test_part5_1_audit.ts`, `test_demo_e2e.ts`, `test_part6_1_audit.ts`
