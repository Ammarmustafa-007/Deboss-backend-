# DEBOSS API

Node/Express API for privileged operations. The Next.js application uses Supabase directly for sign-in and normal read access. This API owns actions requiring the Supabase service role: creating staff accounts, changing passwords, and activating/deactivating users.

## Setup

1. Copy `.env.example` to `.env`.
2. Add the Supabase URL, publishable key, and service-role key. Never expose the service-role key to the frontend or commit `.env`.
3. Run `npm run dev`.

## Database

Create `admin@debossglobal.com` in Supabase Dashboard > Authentication > Users, then run `supabase/migrations/20261012_001_identity_departments.sql` once in Supabase SQL Editor. The migration creates every required table, trigger, policy, and automatically promotes that Auth user to Super Admin.

For Brokerage Sales and Brokerage Operations, run these in order after the identity migrations:

1. `supabase/migrations/20261013_003_brokerage_module.sql`
2. `supabase/migrations/20261013_004_brokerage_workflows.sql`
3. `supabase/migrations/20261013_005_brokerage_finance_collaboration.sql`
4. `supabase/migrations/20261013_006_brokerage_access_lifecycle.sql`
5. `supabase/migrations/20261013_007_brokerage_completion.sql`
6. `supabase/migrations/20261014_008_brokerage_finalization.sql`

Together they create Teams, Team Lead permissions, customer leads, activities, quotes, Operations handoffs, shipments, finance and invoices, documents, notifications, direct permissions, quote attachments/history, exception ownership, and customers. Brokerage tables are accessed through this API using the service role; the browser receives no direct table policy.

## Routes

- `GET /health`
- `GET /api/v1/users` - Super Admin only
- `POST /api/v1/users` - Super Admin only
- `PATCH /api/v1/users/:id` - Super Admin only, including password changes
- `GET /api/v1/brokerage/workspace` - role and permission-scoped Brokerage workspace
- `GET|POST|PATCH /api/v1/brokerage/teams` - Brokerage Manager team setup and Team Lead permission delegation
- `POST /api/v1/brokerage/leads` - Brokerage Sales only
- `PATCH /api/v1/brokerage/leads/:id` - permission-scoped Sales lead updates
- `POST /api/v1/brokerage/leads/:id/activities` - add Sales activity or follow-up
- `POST /api/v1/brokerage/leads/:id/convert` - convert a lead into a customer
- `POST /api/v1/brokerage/quotes` - Brokerage Sales only
- `PATCH /api/v1/brokerage/quotes/:id` - update draft or rejected quote
- `POST /api/v1/brokerage/quotes/:id/review` - manager or delegated Team Lead approval/rejection
- `POST /api/v1/brokerage/quotes/:id/handoff` - approved quote to Brokerage Operations
- `GET /api/v1/brokerage/quotes/:id/detail` - quote comments, history, and attachments
- `POST /api/v1/brokerage/quotes/:id/upload-url` - private quote attachment upload URL
- `POST /api/v1/brokerage/quotes/:id/attachments` - create quote attachment record
- `POST /api/v1/brokerage/quotes/:id/comments` - create quote comment
- `PATCH /api/v1/brokerage/shipments/:id` - Operations assignment, status, exceptions, and invoice readiness
- `POST /api/v1/brokerage/shipments/:id/invoice` - generate a delivery invoice
- `GET /api/v1/brokerage/invoices` - Operations invoice ledger
- `PATCH /api/v1/brokerage/invoices/:id` - update invoice amount, payment, due date, or status
- `POST /api/v1/brokerage/shipments/:id/documents` - document records
- `PATCH /api/v1/brokerage/documents/:id/review` - document review
- `GET /api/v1/brokerage/customers/:id/profile` - customer workspace data
- `POST /api/v1/brokerage/customers/:id/comments` - customer discussion
- `GET|PATCH /api/v1/brokerage/notifications` - personal notification feed
- `GET /api/v1/brokerage/reports` - permission-scoped Sales/Operations reporting
- `GET /api/v1/brokerage/overview` - Super Admin Brokerage oversight and audit trail
