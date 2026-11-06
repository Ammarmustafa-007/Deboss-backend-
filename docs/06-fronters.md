# 6. Fronters (lead mining)

Fronters are a Brokerage department (`function = FRONTER`) that mine prospect companies in a spreadsheet and qualify the good ones for Sales. Code: `src/fronter.ts`.

## 6.1 Records

| Record | Table | Notes |
|---|---|---|
| Prospect | `fronter_prospects` | One company row. `created_by` is the Fronter who mined it (they keep the credit), `department_id` their Fronter department, `team_id` optional, `assigned_to` the Sales agent, `status`, and once qualified `lead_id`, `qualified_by`, `qualified_at`. Carries the same company detail columns as a Sales lead |
| Commodity | `fronter_commodities` | One reference sheet shared by the Fronters and Brokerage Sales: commodity, trucks used, best states, notes. Everyone sees every row and edits their own (managers: their department's) |

Prospect fields: company name (required), operator name and number, shipping contact, phone, email, truck type, load type (FTL, LTL, Both), shipping volume, commodity, lanes, physical address, other locations, billing address, contact, phone and email, payment terms, W-9 received, EIN, source, website, notes.

## 6.2 Statuses

`NEW`, `CONTACTED`, `NOT_QUALIFIED`, `NOT_INTERESTED`, `QUALIFIED`.

## 6.3 Who works on what

| Actor | Sees | Can change |
|---|---|---|
| Fronter | Own rows (+ team's as a Team Lead with `fronter.prospects.view_team`) | Every field and the status of own rows (+ team's with `edit_team`) |
| Fronter Manager | The department's rows | Everything in the department |
| Sales agent | Their own rows, and the rows of every Fronter whose `sales_agent_id` is them | Adds and pastes rows; every field and the status of all of them; deletes only their own (not Qualified) rows |
| Sales Manager | Rows of their department's Sales people, and of Fronters linked to them | The same, deleting rows their department's Sales people added |
| Super Admin | All | All |

The Sales view is the "Fronter mining sheet". Sales work on it like a Fronter (client request): they add and paste companies (`POST /prospects`, stored with their Sales `department_id` and themselves as `created_by`), edit any field and the status of their own and their Fronters' rows, and delete the rows they added (`deletable` in the list response). Qualifying a row a Sales person added makes it **their own lead**; a Fronter's row goes to the Fronter's linked agent as before. Rows Sales add never count towards Fronter pay or Fronter reports (those count Fronters only). A **Qualified** row is locked for Fronters (it has become a Sales lead), but Sales keeps editing its details: each change also updates the lead (company, contact name, email, phone and the company detail fields) and the customer profile's company and contact. Its status stays Qualified and it can't be deleted (`422: This prospect is now a Sales lead, so its status and agent can't change here.`). Edits made later on the lead page are not copied back to the sheet. There are no export buttons in the Fronter module (client request).

## 6.4 Adding rows

`POST /api/v1/fronter/prospects` takes `{ rows: [...] }`, up to 1,000 at a time. Each row is validated separately; rows without a company name (or with an invalid email) are skipped and reported back as `{ row, error }`, and the rest are added. This serves both typing a single company and pasting a block of rows copied from Excel.

## 6.5 Qualifying a prospect

Setting `status: "QUALIFIED"` (`PATCH /api/v1/fronter/prospects/:id`) is the hand-over to Sales. Who may qualify: the Fronter who mined it, a Fronter Manager, a Team Lead with `fronter.prospects.qualify`, the linked Sales agent or their Sales Manager, or the Super Admin.

1. **Which Sales agent gets it:** the `sales_agent_id` of the Fronter who mined the row. If that Fronter has no active linked agent, the request is refused: "This Fronter has no active Sales agent linked. Ask the Super Admin to set one on their user." (An explicit `assigned_to` is still accepted for older callers.)
2. A **Sales lead** is created for that agent, in their Sales department and team, at status Qualified, with every detail the Fronter collected, `source: "Fronter · <source>"` and `fronter_prospect_id` pointing back.
3. The **customer profile** is created at once (flow v2).
4. The prospect is set to Qualified and **locked for Fronters**: only Sales can still edit its details (the lead follows), and nobody can delete it or change its status.
5. The agent and their Sales Managers are notified ("New qualified lead for you"). Audit `PROSPECT_QUALIFIED`.

## 6.6 Linking a Fronter to a Sales agent

`profiles.sales_agent_id`, set by the Super Admin when creating or editing a user in a Fronter department. See [02-roles-and-access.md](02-roles-and-access.md#27-fronter--sales-agent-link).

## 6.7 Pay

A Fronter earns a flat PKR amount per lead **qualified in the month** (default PKR 1,000), whether or not it becomes a customer. A Fronter Manager is paid as a Brokerage Sales Agent. See [09-hr-payroll.md](09-hr-payroll.md).

## 6.8 Reports

`GET /api/v1/fronter/reports` gives per-Fronter counts for a period (prospects, by status, qualified, customers, conversion, customer gross). The Fronter **dashboard** uses it for its "Prospects this month", "Qualified" and "Became customers" cards. The Reports page itself was removed from the Fronter menu (client request).
