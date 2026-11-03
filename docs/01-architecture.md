# 1. Architecture

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, TypeScript run directly with `tsx` (no build step) |
| HTTP | Express 5, `helmet`, `cors`, `morgan`, JSON bodies up to 1 MB |
| Validation | `zod` (every request body, query and path id is parsed before use) |
| Database, auth, storage, realtime | Supabase (Postgres + Auth + Storage + Realtime) |
| Front end | Next.js app in the separate `Deboss-admin` repository |

The backend owns all business rules. The browser talks to it with a Supabase access token, and the backend talks to Supabase with the **service role** key, so row-level security does not limit the API: every permission check is written in the API code. The browser also talks to Supabase directly, protected by row-level security, for these things only:

| What | Why it is allowed |
|---|---|
| Signing in and the session | Supabase Auth |
| Reading the signed-in user's own profile | Policy "users view their profile" |
| Departments: the Super Admin's Departments page lists and creates them | Policies "super admins manage departments" and "authenticated users can view active departments" |
| Chat messages (insert and realtime) and typing indicators | Chat policies (see [08-chat.md](08-chat.md)) |

Everything else goes through this API.

## Folder layout

```
src/
  server.ts        Express app, authentication, users, Brokerage (leads, customers, loads, quotes, invoices, documents, teams, reports), route registration
  fronter.ts       Fronter lead mining and commodities
  dispatch.ts      Dispatch Sales and Operations (carriers, trucks, loads, invoices, targets, reports)
  chat.ts          Chat: inbox, direct messages, team groups, channels, system posts
  payroll.ts       HR and payroll: rules, employees, attendance, costs, department P&L, payroll runs, performance, finance overview
  hr-rules.ts      Pure pay arithmetic (no database), unit tested
  *.test.ts        Tests (node:test), run with `npm test`
  fake-supabase.ts In-memory Supabase stand-in used by the route tests
supabase/
  migrations/      28 SQL migrations, run in filename order
  scripts/         One-off maintenance scripts (not migrations; run by hand only when needed)
```

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default 4000) |
| `FRONTEND_URL` | Allowed CORS origins, comma-separated (for example `http://localhost:3100,https://deboss-crm.vercel.app`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Public key, used only to verify user tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, used for every database call. Never expose it to the browser |

## Request lifecycle

1. The front end sends `Authorization: Bearer <Supabase access token>`.
2. A guard verifies the token. `verifiedUserId()` calls `auth.getClaims()`, which checks the JWT signature locally against the project's public keys (JWKS), so no network call per request.
3. The guard loads the caller's profile (`role`, `department_id`, `is_active`, and the department's `business_unit` and `function`) and attaches it as `request.actor`.
4. The route parses its input with zod. A zod failure returns `400` with the first problem in plain words, for example `Reference number: must be at least 3 characters.`, plus the full `issues` list.
5. The route checks permissions with the helpers described in [02-roles-and-access.md](02-roles-and-access.md), does the work with the service-role client, writes an audit event for every change, sends notifications, and returns JSON.
6. Errors, all as `{ "error": "message" }`:
   - deliberate refusals: `403` (not allowed), `404` (not found or outside your scope), `409` (conflict, such as a finalized month or a user who can't be deleted), `422` (a business rule, such as "A shipment must be delivered before invoicing.")
   - a unique-constraint violation from the database (Postgres `23505`) returns `409` ("That shipment reference number is already in use…" or "This record already exists")
   - anything else returns `500` with the error's message
   - `GET /health` returns `{ status: "ok" }` without authentication

### Guards

| Guard | Who passes |
|---|---|
| `requireSuperAdmin` | An active `SUPER_ADMIN` |
| `requireBrokerageUser` | Any active signed-in user (despite its name, it is the general staff guard; each module adds its own check) |
| Module guards | `fronterOnly` (Fronters + Super Admin), `fronterOrSales` (Fronters, Brokerage Sales, Super Admin), `dispatchOnly` (Dispatch + Super Admin), `chatUser` (managers, agents, Super Admin) |

### Caches

`profileCache` and `teamScopeCache` keep a user's profile and team rights for 30 seconds. `clearAccessCache(userId)` empties them whenever access changes (user edits, team edits, deactivation, an exit), so changes apply immediately.

### Background job

`registerPayrollRoutes` starts an hourly sweep (`removeLeaverLogins`) that deactivates the login of anyone whose last working day has passed. It also runs once at startup and after every exit is recorded.

## Testing

```bash
npm test
```

- `hr-rules.test.ts`: the pay formulas, including the client document's worked examples.
- `payroll.test.ts`: the whole monthly calculation (`monthFigures`) on in-memory data.
- `payroll-routes.test.ts`, `dispatch-routes.test.ts`, `fronter-routes.test.ts`: the real Express routes on an in-memory database, with simulated users of each role.

## Deployment

The backend runs anywhere Node runs. Set the environment variables, run `npm start`, and allow the front end's domain in `FRONTEND_URL`. Apply new migrations **before** deploying code that needs them. Deploy the backend and front end together when both change.
