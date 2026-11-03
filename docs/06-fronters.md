# 6. Fronters (lead mining)

Fronters are a Brokerage department (`function = FRONTER`) that mine prospect companies in a spreadsheet and qualify the good ones for Sales. Code: `src/fronter.ts`.

## 6.1 Records

| Record | Table | Notes |
|---|---|---|
| Prospect | `fronter_prospects` | One company row. `created_by` is the Fronter who mined it (they keep the credit), `department_id` their Fronter department, `team_id` optional, `assigned_to` the Sales agent, `status`, and once qualified `lead_id`, `qualified_by`, `qualified_at`. Carries the same company detail columns as a Sales lead |
| Commodity | `fronter_commodities` | A shared reference sheet: commodity, trucks used, best states, notes |

Prospect fields: company name (required), operator name and number, shipping contact, phone, email, truck type, load type (FTL, LTL, Both), shipping volume, commodity, lanes, physical address, other locations, billing address, contact, phone and email, payment terms, W-9 received, EIN, source, website, notes.

## 6.2 Statuses

`NEW`, `CONTACTED`, `NOT_QUALIFIED`, `NOT_INTERESTED`, `QUALIFIED`.

## 6.3 Who works on what

| Actor | Sees | Can change |
|---|---|---|
| Fronter | Own rows (+ team's as a Team Lead with `fronter.prospects.view_team`) | Every field and the status of own rows (+ team's with `edit_team`) |
| Fronter Manager | The department's rows | Everything in the department |
| Linked Sales agent | Rows of every Fronter whose `sales_agent_id` is them | Every field and the status (not add or delete) |
| Sales Manager | Rows of Fronters linked to any agent of their department | Every field and the status (not add or delete) |
| Super Admin | All | All |

The Sales view is the "Fronter mining sheet". Sales can edit any field and the status of their Fronters' rows, but can't add, paste or delete rows (those endpoints stay Fronter-only). Qualified rows are locked for everyone: they have become Sales leads and are edited on the lead page. There are no export buttons in the Fronter module (client request).

## 6.4 Adding rows

`POST /api/v1/fronter/prospects` takes `{ rows: [...] }`, up to 1,000 at a time. Each row is validated separately; rows without a company name (or with an invalid email) are skipped and reported back as `{ row, error }`, and the rest are added. This serves both typing a single company and pasting a block of rows copied from Excel.

## 6.5 Qualifying a prospect

Setting `status: "QUALIFIED"` (`PATCH /api/v1/fronter/prospects/:id`) is the hand-over to Sales. Who may qualify: the Fronter who mined it, a Fronter Manager, a Team Lead with `fronter.prospects.qualify`, the linked Sales agent or their Sales Manager, or the Super Admin.

1. **Which Sales agent gets it:** the `sales_agent_id` of the Fronter who mined the row. If that Fronter has no active linked agent, the request is refused: "This Fronter has no active Sales agent linked. Ask the Super Admin to set one on their user." (An explicit `assigned_to` is still accepted for older callers.)
2. A **Sales lead** is created for that agent, in their Sales department and team, at status Qualified, with every detail the Fronter collected, `source: "Fronter · <source>"` and `fronter_prospect_id` pointing back.
3. The **customer profile** is created at once (flow v2).
4. The prospect is set to Qualified and **locked**: nobody can edit or delete it any more.
5. The agent and their Sales Managers are notified ("New qualified lead for you"). Audit `PROSPECT_QUALIFIED`.

## 6.6 Linking a Fronter to a Sales agent

`profiles.sales_agent_id`, set by the Super Admin when creating or editing a user in a Fronter department. See [02-roles-and-access.md](02-roles-and-access.md#27-fronter--sales-agent-link).

## 6.7 Pay

A Fronter earns a flat PKR amount per lead **qualified in the month** (default PKR 1,000), whether or not it becomes a customer. A Fronter Manager is paid as a Brokerage Sales Agent. See [09-hr-payroll.md](09-hr-payroll.md).

## 6.8 Reports

`GET /api/v1/fronter/reports` gives per-Fronter counts for a period (prospects, by status, qualified, customers, conversion, customer gross). The Fronter **dashboard** uses it for its "Prospects this month", "Qualified" and "Became customers" cards. The Reports page itself was removed from the Fronter menu (client request).
