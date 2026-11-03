# 9. HR and payroll

Every pay figure is computed from the month's records by one function, `monthFigures(supabase, period)` in `src/payroll.ts`. The pure arithmetic is in `src/hr-rules.ts` and is unit tested against the client document "DEBOSS HR and Compensation Rules". Migrations 024 and 025.

## 9.1 Settings and inputs

| What | Table | Who sets it |
|---|---|---|
| Commission rules (every amount, rate, target, share) | `hr_settings.rules` (one row, JSON) | Super Admin, Compensation → Commission rules |
| Base salary (PKR), joining date, manager | `employee_records` | Super Admin, Compensation → Employees |
| Exit: last working day, reason | `employee_records.last_working_day`, `exit_type` | Super Admin |
| Attendance (Leave or Absent; no row = Present) | `attendance_records` | Managers (own department, not themselves), Super Admin |
| USD → PKR rate for the month | `payroll_months.usd_to_pkr` | Super Admin, Payroll page |
| Costs | `department_costs` | Super Admin, Costs and P&L |
| Frozen month | `payroll_runs` + `payroll_lines` | Super Admin, Finalize |

Every change to any of these is written to `audit_events` with who, what, when, and before / after values.

### Default rules (`hr_settings.rules`)

```json
{
  "dispatch_sales":       { "min_active_sales": 2, "rate": 5 },
  "dispatcher":           { "tiers": [{ "from": 1500, "rate": 8 }, { "from": 2500, "rate": 10 }, { "from": 3500, "rate": 12 }] },
  "brokerage_sales":      { "tiers": [{ "from": 2500, "rate": 8 }, { "from": 3500, "rate": 10 }, { "from": 4500, "rate": 12 }] },
  "brokerage_operations": { "tiers": [{ "from": 4000, "rate": 8 }, { "from": 5000, "rate": 10 }, { "from": 7000, "rate": 12 }] },
  "fronter_per_lead_pkr": 1000,
  "manager_share": { "DISPATCH_SALES_MANAGER": 25, "DISPATCH_MANAGER": 40, "BROKERAGE_SALES_MANAGER": 10, "BROKERAGE_OPERATIONS_MANAGER": 10 },
  "paid_leaves_per_month": 1
}
```

`compensation_settings` (migration 014) belongs to the first payroll version and is no longer read.

## 9.2 Currencies

- Base salaries and the Fronter amount are in **PKR**.
- Income, gross, targets, costs in USD, commission and profit share are in **USD**.
- The month's rate converts between them: `toPkr(usd) = usd × rate`, `toUsd(pkr) = pkr ÷ rate`. Without a rate, converted amounts are 0 and the month **can't be finalized**.
- Money is rounded to 2 decimals (`round`).

## 9.3 Who is on a month's payroll

Every profile with role Agent or Manager and a payroll role key ([02-roles-and-access.md](02-roles-and-access.md#21-the-building-blocks)) where:

- joined on or before the month's last day (`joined_on`, or the profile's creation date if none is set), and
- not left before the month's first day, and
- active, or inactive with a recorded exit (an inactive person without an exit is left out).

## 9.4 Base pay

`basePay()`:

```
working days     = Monday–Friday of the month
employed days    = working days from the joining date to the last working day (inclusive)
per day          = base ÷ working days
base earned      = per day × employed days
absences         = days marked Absent within employment
leave            = days marked Leave within employment (always paid)
paid leave used  = min(absences, paid_leaves_per_month)
unpaid absences  = absences − paid leave used
leave deduction  = per day × unpaid absences   (never more than base earned)
base net         = base earned − leave deduction
days worked      = employed days − leave − absences
```

So the first absence each month is the paid leave, further ones are deducted, and a manager turning an absence into **Leave** removes its deduction. The paid leave doesn't carry over. No hours or lateness are tracked.

*Example:* base PKR 110,000, 22 working days → PKR 5,000 a day. Two absences: one is the paid leave, the other costs PKR 5,000 (net 105,000). Changing the second to Leave: net 110,000. Joining on the 16th of a 22-day month with 11 working days left: PKR 55,000.

## 9.5 Commission

Only money **received** counts. Each role's gross:

| Role | Gross for the month | Commission |
|---|---|---|
| Dispatch Sales Agent | `amount_paid` of Dispatch invoices **paid** in the month where they are the invoice's Sales agent | If they have at least `min_active_sales` **active sales** in the month: `rate`% of that whole gross. Otherwise 0 |
| Dispatcher | `amount_paid` of Dispatch invoices paid in the month where they are the Dispatcher | Tiered (`dispatcher`) |
| Brokerage Sales Agent | Margin of loads whose invoice was **paid** in the month, for customers they owned when it was paid | Tiered (`brokerage_sales`) |
| Brokerage Operations Agent | Margin of paid loads they are assigned to | Tiered (`brokerage_operations`) |
| Fronter | Number of prospects they mined that were **qualified** in the month | `fronter_per_lead_pkr` × count, in PKR, even if the lead never becomes a customer |
| Fronter Manager | As a Brokerage Sales Agent: margin of their own customers' paid loads | Tiered (`brokerage_sales`). No profit share |
| Other managers | Their department's (or team's) net profit | Profit share (9.7) |

- **Active sale:** a truck whose **first ever** paid invoice was paid in this month.
- **Brokerage margin:** customer's agreed rate − carrier rate. A load missing either rate counts as 0. Cancelled loads don't count.
- **Owner when paid:** when a customer is handed to a colleague (an exit), `ownership_transfers` remembers the previous owner, so commission already earned stays with them (`ownerAt()`).

### Tiered commission

`tieredCommission(gross, tiers)`: find the **highest level reached** (gross ≥ its `from`), then pay that rate on **everything above the first target**. Below the first target nothing is paid. Exactly on a level earns that level's rate.

```
commission = (gross − first target) × rate reached ÷ 100
```

Worked examples (from the client document, all in the tests):

| Role | Gross | Calculation | Commission |
|---|---|---|---|
| Dispatcher | $3,000 | 10% × (3,000 − 1,500) | $150 |
| Brokerage Sales Agent | $4,000 | 10% × (4,000 − 2,500) | $150 |
| Brokerage Operations Agent | $6,000 | 10% × (6,000 − 4,000) | $200 |
| Dispatch Sales Agent | $2,400 paid, 2 active sales | 5% × 2,400 | $120 |

## 9.6 Leavers

| `exit_type` | Pay |
|---|---|
| `NOTICE_SERVED` | Normal base and commission **up to the last working day**. Records dated after it don't count |
| `NO_NOTICE`, `FIRED` | Base for days worked only. No commission, no profit share |

The login is removed **the day after** the last working day (hourly sweep). Recording an exit can hand the person's work to an active colleague of the same department (`reassignWork()`): their leads and customers (with an `ownership_transfers` row per customer), customers' Operations agent, open Brokerage loads (not Completed or Cancelled), Fronter prospects' assignee, Dispatch carriers and trucks. Nothing is deleted. Final pay is on the 10th like everyone else.

## 9.7 Department P&L and manager profit share

### Income

Each department's income for the month:

- Dispatch: paid Dispatch invoices (`amount_paid`), credited to **both** the invoice's Dispatch Sales department and its Dispatch Operations department.
- Brokerage: the margin of loads paid in the month, credited to **both** the load's Sales department and its Operations department.
- Fronter departments have no income.

### Costs

```
salaries    = Σ (base earned − leave deduction) of the department's people, in USD
commissions = Σ commission (USD) of the department's people
other costs = the department's share of the month's costs
total costs = salaries + commissions + other costs
net profit  = income − total costs
```

Each cost has a type (`allocateCost()`), converted to USD first if entered in PKR:

| Type | Charged to |
|---|---|
| `COMPANY_SHARED` (rent, meals) | Every department, split by number of employees on payroll |
| `ONE_DEPARTMENT` (load boards) | That department in full |
| `TWO_DEPARTMENTS` (dialers) | Those two, split by their number of employees (evenly if both have nobody) |
| `COMPANY_ONLY` (this CRM, equipment, legal) | Nobody |

### Profit share

```
profit share = max(0, net profit) × manager's percentage ÷ 100
```

Zero in a loss month; base salary is still paid. Percentages: Dispatch Sales Manager 25%, Dispatch (Operations) Manager 40%, Brokerage Sales Manager 10%, Brokerage Operations Manager 10%.

### Departments with two or more managers

Each manager and their team gets a **separate P&L** (migration 025):

- An agent belongs to the manager in their `employee_records.manager_id`. A manager's own work is in their own team. Agents with no manager set go to a "No manager set" row, which pays no share.
- A team's income is what its own people earned (by the same rules as above).
- Shared costs reach the department as usual, then split across its teams by headcount.
- Each manager gets their **full** percentage of their own team's net profit (not split).

## 9.8 Net pay

```
net pay (PKR) = base net + commission (PKR) + profit share (PKR)
```

Fronter commission is already in PKR; USD commission and profit share are converted with the month's rate.

## 9.9 The monthly routine

1. During the month: managers keep attendance.
2. Super Admin enters the month's costs and the USD → PKR rate.
3. Payroll page shows a **draft**, recalculated on every load from the live records.
4. **Finalize** (`POST /admin/payroll/:period/finalize`): refused for a future month or without a rate. Stores `payroll_runs` (totals, the department P&L, the rate) and one `payroll_lines` row per person with every figure in `detail`. A finalized month **locks** its attendance, costs and rate (409 on change). Rules changes don't affect it.
5. **Reopen** discards the frozen month and returns it to a live draft.
6. Payslips (printed or saved as PDF by the Super Admin) show the employee, base salary, working days and days worked, leave deductions, commission or profit share, and net pay. Pay date: the 10th of the next month.

`payroll_lines.detail` fields: `usd_to_pkr`, `joined_on`, `last_working_day`, `exit_type`, `on_probation` (first month), `working_days`, `employed_days`, `days_worked`, `leave_days`, `absent_days`, `paid_leave_used`, `unpaid_absences`, `base_earned`, `leave_deduction`, `gross`, `active_sales`, `qualified_leads`, `commission_usd`, `commission_pkr`, `profit_share_percent`, `profit_share_usd`, `profit_share_pkr`, `net_pay_pkr`, `net_pay_usd`.

## 9.10 Performance (what staff may see)

Employees never see pay. `GET /me/performance` returns their **progress** (`progressOf()`): gross, active sales or qualified leads, the current rate, and how far the next level is. A Dispatch Sales Agent gets no gross, only active sales. Managers see their department income. `GET /performance/team` gives a manager their agents' progress (their own team only in two-manager departments), and the Super Admin everyone.

## 9.11 Rules in plain numbers

| Rule | Value |
|---|---|
| Pay period | Calendar month |
| Pay date | 10th of the next month (final pay too) |
| Working days | Monday to Friday |
| Paid leave | 1 a month, no carry-over |
| Probation | 1 month, same pay |
| Notice | 1 month |
| Targets | Same for everyone, including mid-month joiners. Reset monthly |
