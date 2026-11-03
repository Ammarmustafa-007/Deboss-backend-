# 5. Brokerage

Brokerage moves a customer's freight with an outside carrier. **Sales** (Brokerage Sales departments) finds and wins customers and agrees each load's rate. **Operations** (Brokerage Operations departments) books the carrier, moves the load and bills it. Code: `src/server.ts`. Client source documents: "Brokerage Flow and Scenarios" v2.

## 5.1 Records

| Record | Table | Notes |
|---|---|---|
| Lead | `sales_leads` | A prospect company. Owned by a Sales agent (`owner_id`), in a Sales department, optionally in a team. Carries the company details also used by Fronter prospects (`leadDetailKeys`) |
| Activity | `lead_activities` | Call, callback, appointment, follow-up, email or note, with an optional due time and `completed_at` |
| Customer | `brokerage_customers` | Created once per lead when it becomes Qualified (`ensureCustomer`). Holds the customer's **Operations department** and **Operations agent**, chosen once |
| Load | `brokerage_shipments` | One shipment. Sales fields (lane, equipment, `amount_quoted`, `amount_agreed`, `carrier_rate`, `sales_status`) and Operations fields (`status`, carrier, driver, truck, dates, documents, exception, `assigned_to`, `team_id`) |
| Quote | `sales_quotes` | One per load. Its `stage` is the approval state. `quote_events` is its history; `quote_attachments` its files |
| Load history | `shipment_events` | Status changes, assignments, exceptions |
| Load documents | `shipment_documents` | BOL, POD, rate confirmation, invoice, other. Verified or returned by Operations |
| Invoice | `brokerage_invoices` | One per load |
| Comments | `record_comments` | On leads, customers, quotes, loads, invoices |

## 5.2 Lead statuses

`LEAD → QUALIFIED → QUOTING → CUSTOMER`, or closed as `NOT_QUALIFIED` / `NOT_INTERESTED`.

- Agents set **Lead**, **Qualified**, **Not qualified** and **Not interested** themselves.
- **Quoting** and **Customer** follow the lead's loads (`advanceLead()`): adding a load without an agreed rate moves the lead to Quoting, and entering an **agreed rate** on a load moves it to Customer. A lead only ever moves forward, and never out of a closed status.
- Once a lead has quotes, its status can no longer be set by hand (`422: This lead has quotes, so its status now follows its loads.`).
- Becoming **Qualified** creates the customer profile automatically. So does qualifying a Fronter prospect (see [06-fronters.md](06-fronters.md)).
- The **Customers list** (`GET /customers`) shows a customer only once its lead reaches **Quoting** or **Customer**; until then the lead lives in Sales only (client request).
- A lead's **notes** field is the agent's free-text sticky note on the lead page (up to 10,000 characters). The lead page no longer shows Source or Forecast.

## 5.3 The approval runs once per customer

This is the core rule of flow v2 (`routeLockedRate()`).

### The customer's first load

```
Sales agent enters the agreed rate
  → quote SUBMITTED, Sales Manager notified, "💰 Rate locked" posted in the Quotes channel
Sales Manager reviews  (POST /quotes/:id/review)
  ├─ returns for rework with a note → quote REJECTED → agent fixes and it is resubmitted
  └─ approves and picks the customer's Operations department (only this once)
       → quote OPS_REVIEW, load.ops_review = PENDING, Operations Manager notified
Operations Manager reviews  (POST /shipments/:id/ops-review)
  ├─ approves and assigns the customer's Operations agent
  │     → customer.operations_agent_id set, load assigned and BOOKED, quote HANDED_OFF
  └─ rejects with a reason → quote OPS_REJECTED, back to the Sales Manager
Sales Manager decides after a rejection  (POST /quotes/:id/ops-rejection)
  ├─ send back to the agent to fix and resubmit
  └─ close out that load (the customer's other loads are untouched)
```

### Every later load of that customer

As soon as the agreed rate is in, the load goes **straight to the customer's Operations agent** (`handToCustomerAgent()`): it is assigned, set to Booked, its quote becomes HANDED_OFF, the agent is notified, and "📦 New load … went straight to …" is posted in Updates. There is no review.

The Operations Manager can change a customer's agent at any time (`PATCH /customers/:id/operations-agent`), and the customer's open loads move to the new agent. Existing customers from before flow v2 kept the agent of their latest load (migration 022).

`sales_quotes.reviewed_at` records when a load was committed.

## 5.4 Quote stages

| Stage | Meaning |
|---|---|
| `DRAFT` | Being prepared by the Sales agent |
| `SUBMITTED` | Waiting for the Sales Manager |
| `REJECTED` | Returned to the agent for rework (with `rejection_note`) |
| `APPROVED` | Approved by the Sales Manager (older flow; flow v2 goes to `OPS_REVIEW` for first loads) |
| `OPS_REVIEW` | Waiting for the Operations Manager (first load of a customer) |
| `OPS_REJECTED` | Rejected by Operations, waiting for the Sales Manager's decision |
| `HANDED_OFF` | With Operations |

A quote can be edited only in `DRAFT` or `REJECTED`. A cancelled load's quote can't move forward.

## 5.5 Load lifecycle (Operations)

```
BOOKED → PICKED_UP → DELIVERED → COMPLETED (set automatically when the invoice is paid)
BOOKED → MISSED_PICKUP → BOOKED (re-booked) or CANCELLED
BOOKED / MISSED_PICKUP → CANCELLED (needs a reason)
```

Rules in `PATCH /shipments/:id`:

- Loads move **one step at a time** through Booked, Picked up, Delivered. A delivered load can't move back.
- **Picked up** needs a carrier. Picked up and Delivered fill today's date if none is set.
- **Missed pickup** is only from Booked and needs a reason. Afterwards the load is re-booked or cancelled.
- **Cancelled** is only before pickup and needs a reason. It also sets the Sales status to Cancelled.
- **Completed** can't be set by hand. It is set when the invoice is paid.
- An **exception** is a flag on the load, not a status: a note, an owner (`exception_owner_id`), and a resolution. The load keeps its status.
- A load waiting for the Operations review can't change status or assignment until it is approved.
- Picked up, delivered, booked and completed are posted in the Updates channel.

Sales follows the same load through `sales_status`: `QUOTED`, `BOOKED`, `DELIVERED`, `PAID`, `CANCELLED`. Sales edits the commercial side with `PATCH /sales-shipments/:id`. Once a load is with Operations, Sales can no longer cancel it ("ask them to cancel it").

### Carrier identity is hidden from Sales

Sales sees a load's carrier **rate** and the **profit**, never who the carrier is. `withoutCarrier()` removes `carrier_name`, `carrier_mc`, dispatcher, driver, truck and trailer fields from everything Sales receives. Operations fills those fields, optionally from approved Dispatch carriers (`GET /brokerage/carriers`).

### Profit

`profitOf(load)`: **profit = agreed rate − carrier rate**, and **profit % = profit ÷ agreed rate × 100** (one decimal). Both are null until both rates are known.

## 5.6 Invoices

- Created automatically when a load is marked **Delivered** (`ensureInvoice()`), or by hand (`POST /shipments/:id/invoice`, only after delivery).
- Number: `INV-<year>-<load reference>-<first 6 of the load id>`.
- Amount: the invoiced amount, else the agreed rate, else the quoted rate.
- Due date: **30 days** after it is issued.
- Status flow (`INVOICE_FLOW`):

| From | Can move to |
|---|---|
| `DRAFT` | `SENT`, `CANCELLED` |
| `SENT` | `PENDING` (partly paid), `PAID`, `CANCELLED` |
| `PENDING` | `PAID`, `CANCELLED` |
| `OVERDUE` | `PENDING`, `PAID`, `CANCELLED` |
| `PAID`, `CANCELLED` | final |

- **Overdue** is set by the system: a Sent or Pending invoice past its due date (`markOverdueInvoices()`, run whenever invoices are listed). The creator and the department's managers are notified.
- **Paid** means fully collected. A missing paid amount is filled with the full amount; a smaller one is refused ("Use Pending for a partial payment").
- Paying a delivered load's invoice sets the load to **Completed**, the Sales status to Paid, and posts "🎉 … is completed" in Updates.
- Who can generate or update invoices: the department's Operations Manager, a Team Lead with `operations.billing.mark_invoice_ready`, or the Super Admin.

## 5.7 Documents

Load documents (`shipment_documents`) and quote attachments are PDFs or images up to 10 MB, uploaded straight to Storage with a signed URL (see [03-data-model.md](03-data-model.md)). Operations Managers and leads with `operations.documents.review` verify or return them (`PATCH /documents/:id/review`).

## 5.8 Notifications and channel posts

| Event | Notified | Channel post |
|---|---|---|
| Rate locked on a first load | Sales Managers | Quotes: 💰 Rate locked |
| Sales approves | Operations Managers of the chosen department | Quotes: ✅ Sales approved |
| Operations approves | The assigned agent | Quotes: 🚚 Operations approved |
| Operations rejects | Sales Managers | Quotes: ⛔ Operations rejected |
| Sent back / closed out | The agent | Quotes: ↩️ / 🛑 |
| Later load goes straight to the agent | The agent | Updates: 📦 New load |
| Status change | | Updates: 🚛 picked up, 📍 delivered |
| Cancelled | | Updates: ❌ cancelled |
| Invoice paid | | Updates: 🎉 completed |
| Invoice overdue | Creator and managers | |

## 5.9 Reports

`GET /api/v1/brokerage/reports` with `from`, `to` and an optional person. An agent sees their own figures, a Team Lead with `*.reports.view_team` sees their team, a manager the department. Super Admin also has `GET /api/v1/brokerage/overview`.

Sales totals include `leads` (created in the period), `customers`, `shipments`, `quoted_value`, `agreed_value`, `gross_generated`, `pipeline_value`, and:

- `onboarded_customers`: customers in scope (lead at Quoting or Customer) whose **first load** was added in the period
- `shipping_customers`: customers in scope with a load under way now (Booked, Picked up or Missed pickup, not cancelled)

Agents (not managers) always get the current month on screen, with no date range and no export. A Sales Agent sees leads this month, customers onboarded, customers currently shipping, and their loads without the quoted and agreed rates.

## 5.10 Pay

How Brokerage work turns into commission and profit share is in [09-hr-payroll.md](09-hr-payroll.md). In short: **gross = agreed rate − carrier rate**, counted when the customer's invoice is paid, credited to the customer's Sales owner at that time and to the load's Operations agent.
