# 7. Dispatch

Dispatch provides trucking companies (carriers) with a dispatcher who finds them loads, for a fee: a percentage of the loads' value. **Dispatch Sales** signs carriers up. **Dispatch Operations** (Dispatchers) runs their trucks, logs loads and bills the fee every week or as they choose. Code: `src/dispatch.ts`. Client spec sections 3.4, 3.5 and 8.2, plus the "Dispatch v1" feedback.

## 7.1 Records

| Record | Table | Notes |
|---|---|---|
| Carrier | `dispatch_carriers` | Company with MC / DOT numbers, contact, operating pattern, **charge %**, payment method (ACH, check, Zelle, wire, factoring, other). Owned by a Dispatch Sales agent or manager (`owner_id`), in a Dispatch Sales department, optionally a team. `dispatch_department_id` is the Operations department it was handed to |
| Truck | `dispatch_trucks` | Unit number, type (dry van, reefer, flatbed, step deck, power only, box truck, hotshot, other), notes, `status`, `assigned_to` (its Dispatcher: an agent **or a manager** of the Operations department), team |
| Carrier document | `dispatch_carrier_documents` | MC authority, W-9, COI, packet, other |
| Activity | `dispatch_activities` | Call, callback, appointment, follow-up, email, note on a carrier |
| Load | `dispatch_loads` | One load a truck runs: number, broker, pickup and delivery city / zip / date, **rate**, miles, status (booked, delivered, cancelled), notes, `invoice_id` |
| Invoice | `dispatch_invoices` | A bill for the fee on chosen loads: `gross_amount` (the loads' total), `charge_percent`, `amount` (the fee), `amount_paid`, `status`, and the Dispatcher, Sales agent and both departments at the time it was created |
| Target | `dispatch_targets` | Weekly and monthly target per person (see 7.8) |

## 7.2 Carrier lifecycle (Dispatch Sales)

```
DOCS_PENDING ──submit──→ PENDING_REVIEW ──approve──→ APPROVED (trucks handed to Dispatch Operations)
     ↑                        ├──return (note)──→ RETURNED ──submit──→ PENDING_REVIEW
     └── upload documents     └──discard (note)──→ DISCARDED
```

- A Dispatch Sales **agent or manager** creates the carrier with its trucks and owns it.
- **Submit** needs at least one truck and the three required documents: MC authority, W-9 and COI (`requiredDocuments`).
- **Review** is by the Dispatch Sales Manager (or a Team Lead with `dispatch_sales.carriers.review`, never on their own carrier). Approving needs an active Dispatch Operations department: every Pending truck becomes **Active** in that department.
- A duplicate MC / DOT number is flagged while typing and on the carrier page (`GET /dispatch/duplicates`).
- The owner can be changed to another agent **or manager** of the department (`PATCH /carriers/:id`, needs assign rights).
- Documents can only be removed before submitting. A truck can only be removed before approval.

## 7.3 Truck lifecycle (Dispatch Operations)

| Status | Meaning | Moves to |
|---|---|---|
| `PENDING` | On a carrier not approved yet | `ACTIVE` when the carrier is approved |
| `ACTIVE` | Handed to Operations, no Dispatcher yet ("Needs a dispatcher") | `ONBOARDED` (assigning a Dispatcher), `DISCARDED` |
| `ONBOARDED` | Has a Dispatcher | `RUNNING`, `INACTIVE`, `DNC`, `DISCARDED`; back to `ACTIVE` if unassigned |
| `RUNNING` | Running loads (set automatically by its first load) | `INACTIVE`, `DNC` |
| `INACTIVE` | Not running for now | `RUNNING`, `DNC` |
| `DNC` | Do not call, with a reason. Kept forever on the Do-Not-Call list | final |
| `DISCARDED` | Dropped | final |

- Assigning a Dispatcher is for the Dispatch Manager (or a Team Lead with `dispatch.trucks.assign`). **A manager can assign a truck to themselves** and then work it exactly like a Dispatcher; that truck and its invoices are recorded under the manager, not any agent.
- Running needs a Dispatcher.

## 7.4 Loads

- Logged on a truck by its Dispatcher or the Dispatch Manager, once the truck has a Dispatcher.
- Delivery can't be before pickup.
- A load belongs to at most one invoice (`invoice_id`). Deleting or cancelling the invoice frees it.
- **Locked** for the Dispatcher once its invoice has left Draft; the Dispatch Manager can still edit it. Editing or deleting a load recalculates its invoice.
- `GET /dispatch/loads` searches every load in scope by zip, city, lane, broker, number, dates and status.

## 7.5 Invoices

### Creating

`POST /trucks/:id/invoices` with `{ load_ids }`: the Dispatcher **chooses which loads** to bill, from **any week**. Loads must belong to the truck, not be cancelled and not already be on an invoice. A truck can have **several invoices in the same week**.

- **Gross** = sum of the chosen (non-cancelled) loads' rates.
- **Amount** (the fee) = gross × the carrier's charge % ÷ 100.
- `week_start` = Monday of the earliest load, `week_end` = the latest load's pickup date, **due date** = week start + 13 days.
- Number: a plain running number, **01, 02, 03…** (client request; `nextInvoiceNumber()` takes the highest so far plus one and retries on a clash). Screens and notifications show it as "Invoice #01". Migration 033 renumbered the invoices issued before, oldest first.
- **PDF:** the invoice drawer's Download PDF builds the invoice in the browser (`lib/invoice-pdf.ts`, jsPDF) under the **Backend Solutions** brand (logo, yellow and purple), not DEBOSS GLOBAL: bill-to with the carrier's MC, DOT, contact and payment method; invoice details; the loads table; totals and balance due.
- **Name on invoices:** a dispatcher can have a **pseudo name** (`profiles.pseudo_name`), the name carriers know them by. The invoice drawer and the PDF show it instead of their real name. The invoice's Dispatcher or reviewer sets it from the drawer (`PATCH /dispatch/invoices/:id/dispatcher-name`); it applies to all of that dispatcher's invoices.
- The carrier's charge % must be set first.

`recomputeInvoice()` recalculates gross, amount and the week dates from the invoice's loads whenever loads are added, removed or edited.

### Editing and deleting

| Who | Draft | After submit (Submitted, Forwarded, Paid) |
|---|---|---|
| Dispatcher | Add / remove loads, change figures, delete | No (recall first) |
| Dispatch Manager, Team Lead with `dispatch.invoices.review`, Super Admin | Yes | Yes, at any stage, including Paid |

`PATCH /invoices/:id` accepts `add_load_ids`, `remove_load_ids`, `gross_amount` (recalculates the amount), `charge_percent`, `amount` (a typed amount overrides the calculation) and `amount_paid` (only once Forwarded or Paid). An invoice needs at least one load. Every edit is audited with the figures before and after (`DISPATCH_INVOICE_EDITED`). `DELETE /invoices/:id` removes it, frees its loads, and deletes its comments and notifications (`DISPATCH_INVOICE_DELETED` keeps the figures).

### Workflow

`POST /invoices/:id/actions` with `{ action, note?, amount_paid? }`:

| Action | From | To | Who |
|---|---|---|---|
| `SUBMIT` | Draft | Submitted | Dispatcher. Managers are notified |
| `RECALL` | Submitted | Draft | Dispatcher, to change and resend it (until the manager forwards it) |
| `RETURN` | Submitted, Forwarded | Draft | Reviewer, **with a note**. The Dispatcher is notified |
| `FORWARD` | Submitted | Forwarded | Reviewer (sent to accounting) |
| `PAY` | Forwarded | Paid | Dispatcher or reviewer. A smaller `amount_paid` keeps it Forwarded as a partial payment |
| `CANCEL` | Draft (Dispatcher) or Draft / Submitted (reviewer) | Cancelled | Frees its loads |
| `SIGN_OFF` | Paid | Paid, signed off | Dispatch Sales Manager or a lead with `dispatch_sales.invoices.signoff` |
| `RECALCULATE` | Draft | Draft | Dispatcher: recompute from its loads and the carrier's current charge % |

**Reviewer** = the Dispatch Manager of the invoice's department, a Team Lead with `dispatch.invoices.review` (not on their own invoices), or the Super Admin.

## 7.6 Gross and active sales

These are the two numbers the business runs on (client feedback):

- **Gross** for Dispatchers, Dispatch Managers and Dispatch Sales Managers = **what was paid**: the `amount_paid` of invoices with status Paid, counted on the day they were paid. Load rates are the carrier's business and are shown only as "loads total".
- **Active sale** = a truck that has **paid its first invoice**. `firstPaid()` finds each truck's first paid date; the truck is an active sale from then on (`sale_active_since`).

## 7.7 What a Dispatch Sales Agent sees

`moneyHidden()`: a Dispatch Sales Agent (not a manager, no sign-off permission) gets **no invoices, gross, revenue, collections or load lists**. They see their carriers, trucks, and each truck's active-sale state and date, their active sales this week and month, and their sales targets. The API removes the money fields itself (`strip()` in Reports, nulls in the trucks list, empty lists in truck and carrier details), so nothing leaks through the network. "Invoice paid" notifications aren't sent to them either.

## 7.8 Targets

`dispatch_targets` per person, weekly and monthly, set by the department's manager (`PUT /targets/:userId`).

| Department | Target is | Measured against |
|---|---|---|
| Dispatch Sales | A **number of sales** (whole number) | Trucks that became active sales in that week or month |
| Dispatch Operations | **Gross** in dollars | Paid invoices in that week or month |

`GET /targets` returns `unit: "SALES" | "GROSS"` so the screen labels the fields.

## 7.9 Reports and the per-company view

`GET /dispatch/reports` (`from`, `to`, `agent_id`, and `side=operations` for the Super Admin) returns:

- **totals**: carriers, trucks, running, onboarded, pending, loads, gross (paid), week and month gross, revenue (invoiced), collected, outstanding, signed off, active sales (period and all-time), active sales this week and month
- **people**: per agent or Dispatcher, the same plus targets
- **carriers** and **trucks**: per row, including each truck's active-sale date
- status breakdowns and the period's loads

An agent sees only their own row, a Team Lead with the reports permission their team, a manager the department.

**Per company:** `GET /dispatch/trucks` carries, per truck, this week's paid gross, loads and miles, and the all-time count and total of paid invoices. The front end groups those by carrier for the board's "By company" view. `GET /carriers/:id/detail` returns the same as a `summary` for one carrier: trucks running of total, paid gross this week and month, miles and loads this week, invoices received and their total.

## 7.10 Pay

Dispatch Sales Agents earn 5% of everything their sales paid in the month, once they have the month's minimum of active sales. Dispatchers earn tiered commission on their paid gross. Managers earn a share of their department's net profit. See [09-hr-payroll.md](09-hr-payroll.md).
