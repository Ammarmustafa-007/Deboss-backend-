# 3. Data model

All data lives in Supabase Postgres, schema `public`. The schema is built **only** by the migrations in `supabase/migrations/`, run in filename order in the Supabase SQL editor. Every migration since 015 is safe to re-run. Two pairs must run as separate steps because Postgres can't use a new enum value in the same transaction that adds it: 009 then 010, and 020 then 021.

## 3.1 Migrations

| # | File | What it does |
|---|---|---|
| 001 | `identity_departments` | Enums `user_role`, `business_unit`, `department_function`; `departments`, `profiles`, `audit_events`; `handle_new_user` trigger that creates a profile for every new login; `is_super_admin()`. Create the first admin login in Supabase Auth before running it |
| 002 | `fix_auth_profile_bootstrap` | New logins start without a department; the API assigns role and department |
| 003 | `brokerage_module` | Teams, team members, Team Lead permissions, leads, quotes, shipments, shipment events and documents, the `brokerage-documents` bucket |
| 004 | `brokerage_workflows` | Workflow columns (review, hand-off, assignment) |
| 005 | `brokerage_finance_collaboration` | Invoices, comments, notifications |
| 006 | `brokerage_access_lifecycle` | `user_permissions`, access lifecycle |
| 007 | `brokerage_completion` | Lifecycle records |
| 008 | `brokerage_finalization` | Review and reporting metadata |
| 009–010 | `brokerage_sales_customer_shipments` | Customers and the Sales side of a load (`sales_status`), backfill |
| 011 | `brokerage_activity_completion` | `lead_activities.completed_at` |
| 012 | `brokerage_sales_shipment_rates` | `amount_quoted` and `amount_agreed` |
| 013 | `brokerage_callback_activity` | `CALLBACK` activity type |
| 014 | `payroll_compensation` | `compensation_settings`, `payroll_runs`, `payroll_lines` (the first payroll; the current rules are in 024) |
| 015 | `dispatch_module` | Dispatch carriers, trucks, documents, activities, loads, invoices, targets, the `dispatch-documents` bucket |
| 016 | `chat_and_fronters` | Chat tables and policies, `FRONTER` function, `fronter_prospects`, `fronter_commodities`, `chat-photos` bucket |
| 017 | `private_typing_channels` | Realtime policies so only members hear a conversation's typing broadcast |
| 018 | `lead_details` | Company detail columns shared by leads and prospects |
| 019 | `load_details_and_profit` | Load details, carrier rate, profit, Missed pickup and Cancelled |
| 020–021 | `lead_statuses_and_load_columns`, `move_lead_statuses` | Lead statuses Lead / Qualified / Quoting / Customer / Not qualified / Not interested; moves old values |
| 022 | `customer_ops_agent_and_ops_review` | One Operations agent per customer; the Operations Manager review (`OPS_REVIEW`, `OPS_REJECTED`) |
| 023 | `channels_and_load_statuses` | Company channels (Quotes, Updates, Announcements); load statuses Booked → Picked up → Delivered → Completed |
| 024 | `hr_payroll` | `hr_settings`, `employee_records`, `attendance_records`, `payroll_months`, `department_costs`, `ownership_transfers`, `payroll_lines.detail` |
| 025 | `employee_manager` | `employee_records.manager_id` (teams of departments with two managers) |
| 026 | `dispatch_invoice_loads` | `dispatch_loads.invoice_id`; several invoices per truck and week |
| 027 | `fronter_sales_agent` | `profiles.sales_agent_id` |
| 028 | `delete_unused_user` | `delete_unused_user(uuid)` function |

## 3.2 Enums

| Enum | Values |
|---|---|
| `user_role` | `SUPER_ADMIN`, `MANAGER`, `AGENT`, `STAFF` (unused) |
| `business_unit` | `BROKERAGE`, `DISPATCH` |
| `department_function` | `SALES`, `OPERATIONS`, `FRONTER` |
| `lead_stage` | In use: `LEAD`, `QUALIFIED`, `QUOTING`, `CUSTOMER`, `NOT_QUALIFIED`, `NOT_INTERESTED`. Old values kept in the enum: `NEW`, `CONTACTED`, `LOST` |
| `quote_stage` | `DRAFT`, `SUBMITTED`, `APPROVED`, `OPS_REVIEW`, `OPS_REJECTED`, `REJECTED` (returned for rework), `HANDED_OFF` |
| `shipment_stage` | In use: `BOOKED`, `PICKED_UP`, `MISSED_PICKUP`, `DELIVERED`, `COMPLETED`, `CANCELLED`. Old values kept: `QUOTED`, `CARRIER_ASSIGNED`, `IN_TRANSIT`, `EXCEPTION`, `PAID` |
| `invoice_status` (Brokerage) | `DRAFT`, `SENT`, `PENDING`, `PAID`, `OVERDUE`, `CANCELLED` |

Text columns with a fixed list (a `check` constraint) are listed with their tables below: for example Dispatch carrier `review_status`, truck `status`, invoice `status`, Fronter prospect `status`, document types.

## 3.3 Storage buckets

| Bucket | Public | Max size | Types | Used for |
|---|---|---|---|---|
| `brokerage-documents` | No | 10 MB | PDF, JPEG, PNG | Load documents (BOL, POD, rate confirmation, invoice, other) |
| `brokerage-quote-attachments` | No | 10 MB | PDF, JPEG, PNG | Quote attachments |
| `dispatch-documents` | No | 10 MB | PDF, JPEG, PNG | Carrier documents (MC authority, W-9, COI, packet, other) |
| `chat-photos` | Yes | 2 MB | JPEG, PNG, WebP | Team group photos |

Uploads go straight from the browser to Storage with a **signed upload URL** the API issues after a permission check (`…/upload-url` endpoints). The API then records the file (`…/documents`, `…/attachments`). Downloads use short-lived signed URLs (`…/download-url`).

## 3.4 Row-level security

RLS is enabled on every table. The API uses the service role, which bypasses RLS, so the policies only matter for what the **browser** reads or writes directly:

| Object | Policy |
|---|---|
| `departments` | Signed-in users read active departments; Super Admin manages |
| `profiles` | A user reads their own profile; Super Admin manages |
| `audit_events`, `payroll_runs`, `payroll_lines`, `compensation_settings` | Super Admin only (plus legacy "own line" read policies from 014) |
| `chat_conversations`, `chat_members`, `chat_messages` | Members read their conversations; members insert `USER` messages as themselves while active (`chat_can_post`) |
| `realtime.messages` | Typing broadcasts only between members of the conversation (`chat_typing_member`) |
| All tables added from 024 onward | RLS on, no browser policies: API only |

## 3.5 Database functions and triggers

| Function | Purpose |
|---|---|
| `handle_new_user()` (trigger on `auth.users`) | Creates the `profiles` row for each new login |
| `is_super_admin()` | Used by policies |
| `touch_updated_at()` | Keeps `updated_at` current on many tables |
| `is_chat_member(conversation)`, `chat_can_post(conversation)`, `chat_typing_member(topic)`, `mark_chat_read(conversation)`, `touch_chat_conversation()` | Chat membership checks, read markers and ordering (see [08-chat.md](08-chat.md)) |
| `delete_unused_user(target)` | Deletes a login and its profile inside one transaction; returns `DELETED`, `NOT_FOUND` or `IN_USE:<reason>` when a foreign key still points at the user |

## 3.6 How the main tables relate

```
departments ─┬─ profiles (role, department, sales_agent_id → profiles)
             ├─ teams ─ team_members, team_lead_permissions
             │
Brokerage    ├─ sales_leads ─ lead_activities, record_comments
             │      └─ brokerage_customers (one per qualified lead; operations_department_id, operations_agent_id)
             │             └─ brokerage_shipments (loads) ─ sales_quotes ─ quote_events, quote_attachments
             │                    ├─ shipment_events, shipment_documents
             │                    └─ brokerage_invoices (one per load)
Fronters     ├─ fronter_prospects (created_by Fronter, lead_id once qualified), fronter_commodities
Dispatch     ├─ dispatch_carriers ─ dispatch_trucks ─ dispatch_loads ─(invoice_id)→ dispatch_invoices
             │       ├─ dispatch_carrier_documents, dispatch_activities
             │       └─ dispatch_targets (per person)
Chat         ├─ chat_conversations (DIRECT / GROUP per team / CHANNEL) ─ chat_members, chat_messages
HR, payroll  └─ hr_settings (one row), employee_records, attendance_records, payroll_months,
                department_costs, payroll_runs ─ payroll_lines, ownership_transfers
Shared         audit_events, notifications, record_comments (entity_type + entity_id)
```

`record_comments`, `notifications` and `audit_events` are generic: they point at any record through `entity_type` + `entity_id`.

## 3.7 Every table and column

Generated from the migrations. "added in" marks a column added after the table was created.

### `departments`

Created in `20261012_001_identity_departments.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `name` | text not null check (char_length(trim(name)) between 2 and 80) |
| `business_unit` | public.business_unit not null |
| `function` | public.department_function not null |
| `is_active` | boolean not null default true |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `profiles`

Created in `20261012_001_identity_departments.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key references auth.users(id) on delete cascade |
| `full_name` | text not null default 'New team member' check (char_length(trim(full_name)) between 2 and 100) |
| `email` | text not null unique |
| `role` | public.user_role not null default 'STAFF' |
| `department_id` | uuid references public.departments(id) on delete set null |
| `is_active` | boolean not null default true |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `sales_agent_id` | uuid references public.profiles(id) on delete set null  _(added in 20261103_027)_ |

### `audit_events`

Created in `20261012_001_identity_departments.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `actor_id` | uuid references public.profiles(id) on delete set null |
| `action` | text not null |
| `entity_type` | text not null |
| `entity_id` | uuid |
| `detail` | jsonb not null default '{}'::jsonb |
| `created_at` | timestamptz not null default now() |

### `teams`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `department_id` | uuid not null references public.departments(id) on delete cascade |
| `name` | text not null check (char_length(trim(name)) between 2 and 80) |
| `manager_id` | uuid not null references public.profiles(id) |
| `team_lead_id` | uuid references public.profiles(id) on delete set null |
| `is_active` | boolean not null default true |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `team_members`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `team_id` | uuid not null references public.teams(id) on delete cascade |
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `created_at` | timestamptz not null default now() |

### `team_lead_permissions`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `team_id` | uuid not null references public.teams(id) on delete cascade |
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `permission_key` | text not null check (permission_key in ( 'sales.leads.view_team', 'sales.leads.edit_team', 'sales.leads.assign', 'sales.activities.view_team', 'sales.activities.assign', 'sales.quotes.view_team', 'sales.quotes.review', 'sales.quotes.handoff', 'sales.reports.view_team', 'operations.shipments.view_team', 'operations.shipments.assign', 'operations.shipments.update_team', 'operations.documents.review', 'operations.exceptions.resolve', 'operations.billing.mark_invoice_ready', 'operations.reports.view_team' )) |
| `granted_by` | uuid not null references public.profiles(id) |
| `created_at` | timestamptz not null default now() |

### `sales_leads`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `department_id` | uuid not null references public.departments(id) |
| `team_id` | uuid references public.teams(id) on delete set null |
| `owner_id` | uuid not null references public.profiles(id) |
| `company_name` | text not null |
| `contact_name` | text |
| `contact_email` | text |
| `contact_phone` | text |
| `stage` | public.lead_stage not null default 'NEW' |
| `estimated_monthly_value` | numeric(12,2) |
| `next_follow_up_at` | timestamptz |
| `source` | text |
| `notes` | text |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `archived_at` | timestamptz  _(added in 20261013_006)_ |
| `fronter_prospect_id` | uuid references public.fronter_prospects(id) on delete set null  _(added in 20261027_016)_ |
| `operator_name` | text  _(added in 20261028_018)_ |
| `operator_number` | text  _(added in 20261028_018)_ |
| `truck_type` | text  _(added in 20261028_018)_ |
| `load_type` | text  _(added in 20261028_018)_ |
| `shipping_volume` | text  _(added in 20261028_018)_ |
| `commodity` | text  _(added in 20261028_018)_ |
| `lanes` | text  _(added in 20261028_018)_ |
| `physical_address` | text  _(added in 20261028_018)_ |
| `other_locations` | text  _(added in 20261028_018)_ |
| `billing_address` | text  _(added in 20261028_018)_ |
| `billing_contact` | text  _(added in 20261028_018)_ |
| `billing_phone` | text  _(added in 20261028_018)_ |
| `billing_email` | text  _(added in 20261028_018)_ |
| `payment_terms` | text  _(added in 20261028_018)_ |
| `w9_received` | boolean not null default false  _(added in 20261028_018)_ |
| `ein` | text  _(added in 20261028_018)_ |
| `website` | text  _(added in 20261028_018)_ |

### `lead_activities`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `lead_id` | uuid not null references public.sales_leads(id) on delete cascade |
| `author_id` | uuid not null references public.profiles(id) |
| `activity_type` | text not null check (activity_type in ('CALL', 'EMAIL', 'NOTE', 'FOLLOW_UP', 'APPOINTMENT')) |
| `body` | text not null |
| `due_at` | timestamptz |
| `created_at` | timestamptz not null default now() |
| `completed_at` | timestamptz  _(added in 20261016_011)_ |

### `sales_quotes`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `lead_id` | uuid not null references public.sales_leads(id) |
| `created_by` | uuid not null references public.profiles(id) |
| `pickup_location` | text not null |
| `delivery_location` | text not null |
| `equipment_type` | text |
| `quoted_rate` | numeric(12,2) |
| `stage` | public.quote_stage not null default 'DRAFT' |
| `reviewed_by` | uuid references public.profiles(id) |
| `reviewed_at` | timestamptz |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `rejection_note` | text  _(added in 20261013_006)_ |
| `ops_rejection_note` | text  _(added in 20261028_022)_ |
| `ops_reviewed_by` | uuid references public.profiles(id) on delete set null  _(added in 20261028_022)_ |
| `ops_reviewed_at` | timestamptz  _(added in 20261028_022)_ |

### `brokerage_shipments`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `quote_id` | uuid unique references public.sales_quotes(id) |
| `sales_department_id` | uuid not null references public.departments(id) |
| `operations_department_id` | uuid references public.departments(id) |
| `team_id` | uuid references public.teams(id) on delete set null |
| `assigned_to` | uuid references public.profiles(id) on delete set null |
| `reference_number` | text not null unique |
| `customer_name` | text not null |
| `pickup_location` | text not null |
| `delivery_location` | text not null |
| `equipment_type` | text |
| `carrier_name` | text |
| `status` | public.shipment_stage not null default 'BOOKED' |
| `invoice_ready` | boolean not null default false |
| `exception_note` | text |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `amount_quoted` | numeric(12  _(added in 20261013_005)_ |
| `amount_invoiced` | numeric(12  _(added in 20261013_005)_ |
| `amount_paid` | numeric(12  _(added in 20261013_005)_ |
| `payment_status` | public.invoice_status not null default 'DRAFT'  _(added in 20261013_005)_ |
| `pickup_date` | date  _(added in 20261013_005)_ |
| `delivery_date` | date  _(added in 20261013_005)_ |
| `exception_owner_id` | uuid references public.profiles(id) on delete set null  _(added in 20261013_007)_ |
| `exception_resolved_at` | timestamptz  _(added in 20261013_007)_ |
| `exception_resolution` | text  _(added in 20261013_007)_ |
| `customer_id` | uuid references public.brokerage_customers(id) on delete set null  _(added in 20261015_010)_ |
| `sales_status` | public.shipment_stage not null default 'QUOTED'  _(added in 20261015_010)_ |
| `amount_agreed` | numeric(12  _(added in 20261016_012)_ |
| `carrier_mc` | text  _(added in 20261028_019)_ |
| `dispatcher_name` | text  _(added in 20261028_019)_ |
| `dispatcher_phone` | text  _(added in 20261028_019)_ |
| `dispatcher_email` | text  _(added in 20261028_019)_ |
| `driver_name` | text  _(added in 20261028_019)_ |
| `driver_phone` | text  _(added in 20261028_019)_ |
| `truck_type_size` | text  _(added in 20261028_019)_ |
| `truck_number` | text  _(added in 20261028_019)_ |
| `trailer_number` | text  _(added in 20261028_019)_ |
| `carrier_rate` | numeric(12  _(added in 20261028_019)_ |
| `pickup_facility` | text  _(added in 20261028_019)_ |
| `pickup_address` | text  _(added in 20261028_019)_ |
| `pickup_contact` | text  _(added in 20261028_019)_ |
| `pickup_notes` | text  _(added in 20261028_019)_ |
| `pickup_po` | text  _(added in 20261028_019)_ |
| `delivery_facility` | text  _(added in 20261028_019)_ |
| `delivery_address` | text  _(added in 20261028_019)_ |
| `delivery_contact` | text  _(added in 20261028_019)_ |
| `delivery_notes` | text  _(added in 20261028_019)_ |
| `commodity_product` | text  _(added in 20261028_019)_ |
| `commodity_weight` | text  _(added in 20261028_019)_ |
| `commodity_pieces` | text  _(added in 20261028_019)_ |
| `missed_pickup_reason` | text  _(added in 20261028_019)_ |
| `cancel_reason` | text  _(added in 20261028_019)_ |
| `cancelled_at` | timestamptz  _(added in 20261028_019)_ |
| `cancelled_by` | uuid references public.profiles(id) on delete set null  _(added in 20261028_019)_ |
| `miles` | numeric(10  _(added in 20261028_020)_ |
| `load_notes` | text  _(added in 20261028_020)_ |
| `ops_review` | text check (ops_review is null or ops_review in ('PENDING'  _(added in 20261028_022)_ |

### `shipment_documents`

Created in `20261013_003_brokerage_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `shipment_id` | uuid not null references public.brokerage_shipments(id) on delete cascade |
| `uploaded_by` | uuid not null references public.profiles(id) |
| `document_type` | text not null check (document_type in ('BOL', 'POD', 'RATE_CONFIRMATION', 'INVOICE', 'OTHER')) |
| `storage_path` | text not null |
| `is_verified` | boolean not null default false |
| `created_at` | timestamptz not null default now() |
| `reviewed_by` | uuid references public.profiles(id) on delete set null  _(added in 20261014_008)_ |
| `reviewed_at` | timestamptz  _(added in 20261014_008)_ |
| `review_note` | text  _(added in 20261014_008)_ |

### `brokerage_customers`

Created in `20261013_004_brokerage_workflows.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `lead_id` | uuid unique references public.sales_leads(id) on delete set null |
| `sales_department_id` | uuid not null references public.departments(id) |
| `owner_id` | uuid not null references public.profiles(id) |
| `company_name` | text not null |
| `contact_name` | text |
| `contact_email` | text |
| `contact_phone` | text |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `operations_department_id` | uuid references public.departments(id) on delete set null  _(added in 20261028_022)_ |
| `operations_agent_id` | uuid references public.profiles(id) on delete set null  _(added in 20261028_022)_ |
| `operations_assigned_at` | timestamptz  _(added in 20261028_022)_ |

### `shipment_events`

Created in `20261013_004_brokerage_workflows.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `shipment_id` | uuid not null references public.brokerage_shipments(id) on delete cascade |
| `actor_id` | uuid not null references public.profiles(id) |
| `event_type` | text not null check (event_type in ('ASSIGNED', 'STATUS_CHANGED', 'EXCEPTION_RAISED', 'EXCEPTION_RESOLVED', 'INVOICE_READY', 'NOTE')) |
| `body` | text |
| `from_status` | public.shipment_stage |
| `to_status` | public.shipment_stage |
| `created_at` | timestamptz not null default now() |

### `brokerage_invoices`

Created in `20261013_005_brokerage_finance_collaboration.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `shipment_id` | uuid not null unique references public.brokerage_shipments(id) on delete cascade |
| `customer_id` | uuid references public.brokerage_customers(id) on delete set null |
| `department_id` | uuid not null references public.departments(id) |
| `invoice_number` | text not null unique |
| `amount` | numeric(12,2) not null default 0 |
| `amount_paid` | numeric(12,2) not null default 0 |
| `status` | public.invoice_status not null default 'DRAFT' |
| `due_date` | date |
| `issued_at` | timestamptz |
| `paid_at` | timestamptz |
| `created_by` | uuid not null references public.profiles(id) |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `record_comments`

Created in `20261013_005_brokerage_finance_collaboration.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `entity_type` | text not null check (entity_type in ('LEAD', 'CUSTOMER', 'QUOTE', 'SHIPMENT', 'INVOICE')) |
| `entity_id` | uuid not null |
| `author_id` | uuid not null references public.profiles(id) |
| `body` | text not null check (char_length(trim(body)) between 1 and 3000) |
| `created_at` | timestamptz not null default now() |

### `notifications`

Created in `20261013_005_brokerage_finance_collaboration.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `recipient_id` | uuid not null references public.profiles(id) on delete cascade |
| `kind` | text not null |
| `title` | text not null |
| `body` | text |
| `entity_type` | text |
| `entity_id` | uuid |
| `read_at` | timestamptz |
| `created_at` | timestamptz not null default now() |

### `user_permissions`

Created in `20261013_006_brokerage_access_lifecycle.sql`.

| Column | Definition |
|---|---|
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `department_id` | uuid not null references public.departments(id) on delete cascade |
| `permission_key` | text not null |
| `granted_by` | uuid not null references public.profiles(id) |
| `created_at` | timestamptz not null default now() |

### `quote_attachments`

Created in `20261013_007_brokerage_completion.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `quote_id` | uuid not null references public.sales_quotes(id) on delete cascade |
| `uploaded_by` | uuid not null references public.profiles(id) |
| `file_name` | text not null |
| `storage_path` | text not null unique |
| `created_at` | timestamptz not null default now() |

### `quote_events`

Created in `20261013_007_brokerage_completion.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `quote_id` | uuid not null references public.sales_quotes(id) on delete cascade |
| `actor_id` | uuid not null references public.profiles(id) |
| `event_type` | text not null |
| `body` | text |
| `created_at` | timestamptz not null default now() |

### `compensation_settings`

Created in `20261017_014_payroll_compensation.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `role_key` | text check (role_key in ('BROKERAGE_SALES_AGENT', 'BROKERAGE_SALES_MANAGER', 'BROKERAGE_OPERATIONS_AGENT', 'BROKERAGE_OPERATIONS_MANAGER')) |
| `user_id` | uuid references public.profiles(id) on delete cascade |
| `base_salary` | numeric(12,2) not null default 0 check (base_salary >= 0) |
| `commission_rate` | numeric(5,2) not null default 0 check (commission_rate >= 0 and commission_rate <= 100) |
| `commission_basis` | text not null default 'APPROVED_GROSS' check (commission_basis in ('APPROVED_GROSS', 'COLLECTED')) |
| `updated_by` | uuid references public.profiles(id) |
| `updated_at` | timestamptz not null default now() |

### `payroll_runs`

Created in `20261017_014_payroll_compensation.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `period` | date not null unique check (extract(day from period) = 1) |
| `finalized_by` | uuid not null references public.profiles(id) |
| `finalized_at` | timestamptz not null default now() |
| `totals` | jsonb not null default '{}'::jsonb |
| `usd_to_pkr` | numeric(10  _(added in 20261030_024)_ |

### `payroll_lines`

Created in `20261017_014_payroll_compensation.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `run_id` | uuid not null references public.payroll_runs(id) on delete cascade |
| `user_id` | uuid not null references public.profiles(id) |
| `full_name` | text not null |
| `role_key` | text not null |
| `department_id` | uuid references public.departments(id) |
| `department_name` | text |
| `base_salary` | numeric(12,2) not null default 0 |
| `commission_basis` | text not null |
| `commission_rate` | numeric(5,2) not null default 0 |
| `basis_amount` | numeric(14,2) not null default 0 |
| `commission_amount` | numeric(14,2) not null default 0 |
| `total` | numeric(14,2) not null default 0 |
| `configured` | boolean not null default true |
| `items` | jsonb not null default '[]'::jsonb |
| `detail` | jsonb  _(added in 20261030_024)_ |

### `dispatch_carriers`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `department_id` | uuid not null references public.departments(id) |
| `owner_id` | uuid not null references public.profiles(id) |
| `team_id` | uuid references public.teams(id) on delete set null |
| `company_name` | text not null check (char_length(trim(company_name)) between 2 and 180) |
| `mc_number` | text check (mc_number is null or char_length(trim(mc_number)) between 3 and 20) |
| `dot_number` | text check (dot_number is null or char_length(trim(dot_number)) between 3 and 20) |
| `contact_name` | text |
| `phone` | text |
| `email` | text |
| `operating_pattern` | text |
| `charge_percent` | numeric(5,2) check (charge_percent is null or (charge_percent >= 0 and charge_percent <= 100)) |
| `payment_method` | text check (payment_method is null or payment_method in ('ACH', 'CHECK', 'ZELLE', 'WIRE', 'FACTORING', 'OTHER')) |
| `review_status` | text not null default 'DOCS_PENDING' check (review_status in ('DOCS_PENDING', 'PENDING_REVIEW', 'RETURNED', 'APPROVED', 'DISCARDED')) |
| `review_note` | text |
| `submitted_at` | timestamptz |
| `reviewed_by` | uuid references public.profiles(id) |
| `reviewed_at` | timestamptz |
| `dispatch_department_id` | uuid references public.departments(id) |
| `handed_off_at` | timestamptz |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `dispatch_trucks`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `carrier_id` | uuid not null references public.dispatch_carriers(id) on delete cascade |
| `unit_number` | text not null check (char_length(trim(unit_number)) between 1 and 40) |
| `truck_type` | text not null check (truck_type in ('DRY_VAN', 'REEFER', 'FLATBED', 'STEP_DECK', 'POWER_ONLY', 'BOX_TRUCK', 'HOTSHOT', 'OTHER')) |
| `equipment_notes` | text |
| `status` | text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'ONBOARDED', 'RUNNING', 'INACTIVE', 'DNC', 'DISCARDED')) |
| `dispatch_department_id` | uuid references public.departments(id) |
| `assigned_to` | uuid references public.profiles(id) |
| `team_id` | uuid references public.teams(id) on delete set null |
| `dnc_reason` | text |
| `activated_at` | timestamptz |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `dispatch_carrier_documents`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `carrier_id` | uuid not null references public.dispatch_carriers(id) on delete cascade |
| `document_type` | text not null check (document_type in ('MC_AUTHORITY', 'W9', 'COI', 'PACKET', 'OTHER')) |
| `file_name` | text not null |
| `storage_path` | text not null |
| `uploaded_by` | uuid not null references public.profiles(id) |
| `created_at` | timestamptz not null default now() |

### `dispatch_activities`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `carrier_id` | uuid not null references public.dispatch_carriers(id) on delete cascade |
| `activity_type` | text not null check (activity_type in ('CALL', 'CALLBACK', 'APPOINTMENT', 'FOLLOW_UP', 'EMAIL', 'NOTE')) |
| `body` | text not null check (char_length(trim(body)) between 1 and 3000) |
| `due_at` | timestamptz |
| `completed_at` | timestamptz |
| `created_by` | uuid not null references public.profiles(id) |
| `created_at` | timestamptz not null default now() |

### `dispatch_loads`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `truck_id` | uuid not null references public.dispatch_trucks(id) on delete cascade |
| `dispatcher_id` | uuid not null references public.profiles(id) |
| `load_number` | text |
| `broker_name` | text |
| `pickup_city` | text |
| `pickup_zip` | text |
| `pickup_date` | date not null |
| `delivery_city` | text |
| `delivery_zip` | text |
| `delivery_date` | date |
| `rate` | numeric(12,2) not null check (rate >= 0) |
| `miles` | integer check (miles is null or miles >= 0) |
| `status` | text not null default 'BOOKED' check (status in ('BOOKED', 'DELIVERED', 'CANCELLED')) |
| `notes` | text |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |
| `invoice_id` | uuid references public.dispatch_invoices(id) on delete set null  _(added in 20261103_026)_ |

### `dispatch_invoices`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `invoice_number` | text not null unique |
| `truck_id` | uuid not null references public.dispatch_trucks(id) |
| `carrier_id` | uuid not null references public.dispatch_carriers(id) |
| `dispatcher_id` | uuid not null references public.profiles(id) |
| `dispatch_department_id` | uuid not null references public.departments(id) |
| `sales_department_id` | uuid not null references public.departments(id) |
| `sales_agent_id` | uuid references public.profiles(id) |
| `week_start` | date not null |
| `week_end` | date not null |
| `gross_amount` | numeric(12,2) not null default 0 |
| `charge_percent` | numeric(5,2) not null default 0 |
| `amount` | numeric(12,2) not null default 0 |
| `amount_paid` | numeric(12,2) not null default 0 |
| `status` | text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'FORWARDED', 'PAID', 'CANCELLED')) |
| `review_note` | text |
| `due_date` | date |
| `submitted_at` | timestamptz |
| `forwarded_at` | timestamptz |
| `forwarded_by` | uuid references public.profiles(id) |
| `paid_at` | timestamptz |
| `signed_off_at` | timestamptz |
| `signed_off_by` | uuid references public.profiles(id) |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `dispatch_targets`

Created in `20261021_015_dispatch_module.sql`.

| Column | Definition |
|---|---|
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `period_type` | text not null check (period_type in ('WEEKLY', 'MONTHLY')) |
| `amount` | numeric(12,2) not null check (amount >= 0) |
| `set_by` | uuid not null references public.profiles(id) |
| `updated_at` | timestamptz not null default now() |

### `chat_conversations`

Created in `20261027_016_chat_and_fronters.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `kind` | text not null check (kind in ('DIRECT', 'GROUP')) |
| `team_id` | uuid unique references public.teams(id) on delete set null |
| `name` | text check (name is null or char_length(trim(name)) between 2 and 80) |
| `photo_url` | text |
| `direct_key` | text unique |
| `created_by` | uuid references public.profiles(id) on delete set null |
| `created_at` | timestamptz not null default now() |
| `last_message_at` | timestamptz |
| `channel_key` | text unique check (channel_key is null or channel_key in ('QUOTES'  _(added in 20261028_023)_ |

### `chat_members`

Created in `20261027_016_chat_and_fronters.sql`.

| Column | Definition |
|---|---|
| `conversation_id` | uuid not null references public.chat_conversations(id) on delete cascade |
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `role` | text not null default 'MEMBER' check (role in ('ADMIN', 'MEMBER')) |
| `last_read_at` | timestamptz not null default now() |
| `joined_at` | timestamptz not null default now() |

### `chat_messages`

Created in `20261027_016_chat_and_fronters.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `conversation_id` | uuid not null references public.chat_conversations(id) on delete cascade |
| `sender_id` | uuid not null references public.profiles(id) |
| `body` | text not null check (char_length(trim(body)) between 1 and 4000) |
| `created_at` | timestamptz not null default now() |
| `kind` | text not null default 'USER' check (kind in ('USER'  _(added in 20261028_023)_ |

### `fronter_prospects`

Created in `20261027_016_chat_and_fronters.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `department_id` | uuid not null references public.departments(id) |
| `created_by` | uuid not null references public.profiles(id) |
| `team_id` | uuid references public.teams(id) on delete set null |
| `company_name` | text not null check (char_length(trim(company_name)) between 1 and 180) |
| `operator_name` | text |
| `operator_number` | text |
| `shipping_contact` | text |
| `phone` | text |
| `email` | text |
| `truck_type` | text |
| `load_type` | text check (load_type is null or load_type in ('FTL', 'LTL', 'BOTH')) |
| `shipping_volume` | text |
| `commodity` | text |
| `lanes` | text |
| `physical_address` | text |
| `other_locations` | text |
| `billing_address` | text |
| `billing_contact` | text |
| `billing_phone` | text |
| `billing_email` | text |
| `payment_terms` | text |
| `w9_received` | boolean not null default false |
| `ein` | text |
| `source` | text |
| `website` | text |
| `notes` | text |
| `status` | text not null default 'NEW' check (status in ('NEW', 'CONTACTED', 'NOT_QUALIFIED', 'NOT_INTERESTED', 'QUALIFIED')) |
| `assigned_to` | uuid references public.profiles(id) |
| `lead_id` | uuid references public.sales_leads(id) on delete set null |
| `qualified_by` | uuid references public.profiles(id) |
| `qualified_at` | timestamptz |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `fronter_commodities`

Created in `20261027_016_chat_and_fronters.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `department_id` | uuid not null references public.departments(id) |
| `created_by` | uuid not null references public.profiles(id) |
| `commodity` | text not null check (char_length(trim(commodity)) between 1 and 160) |
| `trucks_used` | text |
| `best_states` | text |
| `notes` | text |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `hr_settings`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `id` | boolean primary key default true check (id) |
| `rules` | jsonb not null |
| `updated_by` | uuid references public.profiles(id) on delete set null |
| `updated_at` | timestamptz not null default now() |

### `employee_records`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `user_id` | uuid primary key references public.profiles(id) on delete cascade |
| `base_salary_pkr` | numeric(12,2) not null default 0 check (base_salary_pkr >= 0) |
| `joined_on` | date |
| `last_working_day` | date |
| `exit_type` | text check (exit_type is null or exit_type in ('NOTICE_SERVED', 'NO_NOTICE', 'FIRED')) |
| `updated_by` | uuid references public.profiles(id) on delete set null |
| `updated_at` | timestamptz not null default now() |
| `manager_id` | uuid references public.profiles(id) on delete set null  _(added in 20261031_025)_ |

### `attendance_records`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `user_id` | uuid not null references public.profiles(id) on delete cascade |
| `work_date` | date not null check (extract(isodow from work_date) between 1 and 5) |
| `status` | text not null check (status in ('LEAVE', 'ABSENT')) |
| `recorded_by` | uuid references public.profiles(id) on delete set null |
| `updated_at` | timestamptz not null default now() |

### `payroll_months`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `period` | date primary key check (extract(day from period) = 1) |
| `usd_to_pkr` | numeric(10,4) not null check (usd_to_pkr > 0) |
| `updated_by` | uuid references public.profiles(id) on delete set null |
| `updated_at` | timestamptz not null default now() |

### `department_costs`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `period` | date not null check (extract(day from period) = 1) |
| `name` | text not null check (char_length(trim(name)) between 1 and 120) |
| `amount` | numeric(14,2) not null check (amount >= 0) |
| `currency` | text not null default 'USD' check (currency in ('USD', 'PKR')) |
| `cost_type` | text not null check (cost_type in ('COMPANY_SHARED', 'ONE_DEPARTMENT', 'TWO_DEPARTMENTS', 'COMPANY_ONLY')) |
| `department_ids` | uuid[] not null default '{}' |
| `created_by` | uuid references public.profiles(id) on delete set null |
| `created_at` | timestamptz not null default now() |
| `updated_at` | timestamptz not null default now() |

### `ownership_transfers`

Created in `20261030_024_hr_payroll.sql`.

| Column | Definition |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `customer_id` | uuid not null references public.brokerage_customers(id) on delete cascade |
| `from_user` | uuid not null references public.profiles(id) |
| `to_user` | uuid not null references public.profiles(id) |
| `transferred_at` | timestamptz not null default now() |
