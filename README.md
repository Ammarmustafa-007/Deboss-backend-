# DEBOSS API

Node/Express backend of the DEBOSS GLOBAL CRM: Brokerage (Sales, Operations, Fronters), Dispatch (Sales, Operations), Chat, and HR and payroll. It owns every business rule and permission check and talks to Supabase with the service role. The Next.js front end (`Deboss-admin`) signs in with Supabase and calls this API for everything else.

> **Full documentation:** [docs/README.md](docs/README.md): architecture, roles and hierarchy, data model, every API endpoint, each module's flow, and every HR and payroll calculation.

## Setup

1. Copy `.env.example` to `.env`.
2. Add the Supabase URL, publishable key and service-role key, and the front end's origin(s) in `FRONTEND_URL` (comma-separated). Never expose the service-role key to the front end or commit `.env`.
3. `npm install`, then `npm run dev` (port 4000).

## Database

1. Create `admin@debossglobal.com` in Supabase Dashboard → Authentication → Users.
2. Run every file in `supabase/migrations/` **in filename order** in the Supabase SQL Editor. The first migration promotes that login to Super Admin. 009 and 010, and 020 and 021, must each run as separate steps. Details: [docs/03-data-model.md](docs/03-data-model.md).

`supabase/scripts/` holds one-off maintenance scripts. They are not migrations; run one only when you mean to.

## Checks

```bash
npm run typecheck
npm test
```
