# DEBOSS GLOBAL CRM: backend documentation

This folder explains the backend completely enough to rebuild it from scratch. Read the files in order the first time.

| # | File | What it covers |
|---|---|---|
| 1 | [01-architecture.md](01-architecture.md) | Stack, folder layout, environment, request lifecycle, authentication, caching, testing, deployment |
| 2 | [02-roles-and-access.md](02-roles-and-access.md) | Roles, business units, departments, teams, Team Leads, delegated permissions, who can see and do what |
| 3 | [03-data-model.md](03-data-model.md) | Every table and column, enums, relationships, row-level security, the migration list |
| 4 | [04-api-reference.md](04-api-reference.md) | Every endpoint: method, path, who may call it, what it does, and the rules it enforces |
| 5 | [05-brokerage.md](05-brokerage.md) | Brokerage Sales and Operations: leads, customers, loads, quotes, approvals, load lifecycle, invoices, documents |
| 6 | [06-fronters.md](06-fronters.md) | Fronters (lead mining), the Sales agent link, qualifying, the Sales "Fronter mining sheet" |
| 7 | [07-dispatch.md](07-dispatch.md) | Dispatch Sales and Operations: carriers, trucks, loads, invoices, active sales, targets, reports |
| 8 | [08-chat.md](08-chat.md) | Direct messages, team groups, company channels, automatic posts, realtime |
| 9 | [09-hr-payroll.md](09-hr-payroll.md) | HR and payroll: every rule and formula, attendance, costs, department P&L, profit share, payslips |
| 10 | [10-users-audit-finance.md](10-users-audit-finance.md) | User administration, deletion, audit log, notifications, the Super Admin finance overview |

The front end (Next.js) has its own documentation in the `Deboss-admin` repository, under `docs/`.

## Quick start

```bash
npm install
cp .env.example .env    # then fill in the Supabase values
npm run dev             # http://localhost:4000
```

Run every migration in `supabase/migrations/` in filename order in the Supabase SQL editor (see [03-data-model.md](03-data-model.md)).

```bash
npm run typecheck
npm test
```
