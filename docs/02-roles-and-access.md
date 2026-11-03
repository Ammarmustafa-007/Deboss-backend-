# 2. Roles, hierarchy and access

Everything about "who can see or do what" comes from four facts stored on each user, plus team membership.

## 2.1 The building blocks

| Fact | Where | Values |
|---|---|---|
| Role | `profiles.role` (enum `user_role`) | `SUPER_ADMIN`, `MANAGER`, `AGENT` (`STAFF` exists in the enum from the first migration and is unused) |
| Department | `profiles.department_id` → `departments` | Any number of departments. A Super Admin has none |
| Business unit | `departments.business_unit` (enum) | `BROKERAGE`, `DISPATCH` |
| Function | `departments.function` (enum `department_function`) | `SALES`, `OPERATIONS`, `FRONTER` (Fronter is Brokerage only) |
| Active | `profiles.is_active` | An inactive user is refused by every guard |

So a person's place in the company is **role + department (business unit + function)**. Examples:

| Person | role | business_unit | function |
|---|---|---|---|
| Brokerage Sales Agent | AGENT | BROKERAGE | SALES |
| Brokerage Sales Manager | MANAGER | BROKERAGE | SALES |
| Brokerage Operations Agent | AGENT | BROKERAGE | OPERATIONS |
| Brokerage Operations Manager | MANAGER | BROKERAGE | OPERATIONS |
| Fronter | AGENT | BROKERAGE | FRONTER |
| Fronter Manager | MANAGER | BROKERAGE | FRONTER |
| Dispatch Sales Agent | AGENT | DISPATCH | SALES |
| Dispatch Sales Manager | MANAGER | DISPATCH | SALES |
| Dispatcher (Dispatch Operations Agent) | AGENT | DISPATCH | OPERATIONS |
| Dispatch (Operations) Manager | MANAGER | DISPATCH | OPERATIONS |
| Super Admin | SUPER_ADMIN | none | none |

Payroll uses the same combination as a **role key** (`roleKeyFor()` in `payroll.ts`): `BROKERAGE_SALES_AGENT`, `BROKERAGE_SALES_MANAGER`, `BROKERAGE_OPERATIONS_AGENT`, `BROKERAGE_OPERATIONS_MANAGER`, `BROKERAGE_FRONTER_AGENT`, `BROKERAGE_FRONTER_MANAGER`, `DISPATCH_SALES_AGENT`, `DISPATCH_SALES_MANAGER`, `DISPATCHER`, `DISPATCH_MANAGER`.

## 2.2 Hierarchy

```
Super Admin (whole company, no department)
├── Brokerage
│   ├── Sales departments         Manager → Team Leads → Sales Agents
│   ├── Operations departments    Manager → Team Leads → Operations Agents
│   └── Fronter departments       Manager → Team Leads → Fronters   (each Fronter is linked to one Sales Agent)
└── Dispatch
    ├── Dispatch Sales departments       Manager → Team Leads → Sales Agents
    └── Dispatch Operations departments  Manager → Team Leads → Dispatchers
```

- **Super Admin:** sees and does everything, creates departments and users, runs HR and payroll. Has no department, takes no part in team work, and in Chat only posts Company announcements.
- **Manager:** full control of **their own department**: every record in it, approvals, assignments, teams, targets, attendance. A manager can also do agent-level work personally (a Dispatch manager can hold trucks, a Dispatch Sales manager can own carriers); that work is recorded under the manager's own name and is not credited to any agent.
- **Team Lead:** an **agent** chosen as a team's lead. Gets extra rights over their team's work only, through the permissions the manager grants (2.4).
- **Agent:** their own work only (records they own or are assigned to).

A department can have several managers. HR payroll then tracks each manager's team separately (see [09-hr-payroll.md](09-hr-payroll.md)), using `employee_records.manager_id` to say which manager each agent reports to.

## 2.3 Teams

Tables `teams`, `team_members`, `team_lead_permissions` (migration 003).

- A team belongs to one department and is created by that department's manager (`POST /api/v1/brokerage/teams`). Members and the Team Lead must be active agents of the department.
- A team has at most one Team Lead (`teams.team_lead_id`, who must also be a member).
- Every team gets a chat group automatically, kept in sync with its members (`syncTeamGroup`, see [08-chat.md](08-chat.md)).
- **A team's work** is any record tagged with the team (`team_id`) **or** owned/assigned to one of its members. `inTeam(scope, teamId, personId)` is that test, and `teamFilter()` is the same rule as a database filter.

### `teamScope(actor)`

Computed per request (cached 30 s) in `server.ts`:

| Field | Meaning |
|---|---|
| `teamIds` | Teams the actor is a member of |
| `leadTeamIds` | Active teams where the actor is the selected Team Lead |
| `memberIds` | Everyone in the teams the actor leads |
| `permissions` | The permission keys granted to the actor **for the teams they lead** (`team_lead_permissions`). Empty for non-leads |

A permission therefore only ever applies to the lead's own teams, and only while they are the lead.

## 2.4 Delegated permissions (Team Leads)

The manager picks **Partial** or **Full managerial** access for the Team Lead on the team form; each maps to a fixed list of keys (front end `teams-screens.tsx`, `accessPresets`).

| Department | Partial | Full adds |
|---|---|---|
| Brokerage Sales | `sales.leads.view_team`, `sales.leads.edit_team`, `sales.activities.view_team`, `sales.reports.view_team` | `sales.leads.assign`, `sales.activities.assign`, `sales.quotes.review`, `sales.quotes.handoff` |
| Brokerage Operations | `operations.shipments.view_team`, `operations.shipments.update_team`, `operations.reports.view_team` | `operations.shipments.assign`, `operations.documents.review`, `operations.exceptions.resolve`, `operations.billing.mark_invoice_ready` |
| Fronters | `fronter.prospects.view_team`, `fronter.prospects.edit_team`, `fronter.reports.view_team` | `fronter.prospects.qualify` |
| Dispatch Sales | `dispatch_sales.carriers.view_team`, `dispatch_sales.carriers.edit_team`, `dispatch_sales.reports.view_team` | `dispatch_sales.carriers.assign`, `dispatch_sales.carriers.review`, `dispatch_sales.invoices.signoff` |
| Dispatch Operations | `dispatch.trucks.view_team`, `dispatch.trucks.update_team`, `dispatch.reports.view_team` | `dispatch.trucks.assign`, `dispatch.invoices.review` |

What each key allows, for the lead's team only:

| Key | Allows |
|---|---|
| `*.view_team` | See the team's records |
| `*.edit_team` / `*.update_team` | Edit the team's records |
| `*.reports.view_team` | Team rows in Reports |
| `sales.leads.assign`, `sales.activities.assign` | Reassign leads and activities within the team |
| `sales.quotes.review` | Approve or return the team's quotes |
| `sales.quotes.handoff` | Hand approved loads to Operations |
| `operations.shipments.assign` | Assign the team's loads to agents |
| `operations.documents.review` | Verify or return load documents |
| `operations.exceptions.resolve` | Resolve exceptions and set their owner |
| `operations.billing.mark_invoice_ready` | Generate and update invoices |
| `fronter.prospects.qualify` | Qualify the team's prospects |
| `dispatch_sales.carriers.assign` / `.review` | Reassign carriers / approve, return, discard carriers |
| `dispatch_sales.invoices.signoff` | Sign off paid Dispatch invoices (also lifts the "no gross" view for that person) |
| `dispatch.trucks.assign` | Assign trucks to Dispatchers |
| `dispatch.invoices.review` | Review, forward, edit and delete Dispatch invoices |

The database's list of allowed keys also contains `sales.quotes.view_team`. No preset grants it and no code checks it: quotes are visible through the lead (`sales.leads.view_team`).

A Team Lead never approves their **own** work: the review checks exclude records the lead owns (for example `carrier.owner_id !== actor.id`, `invoice.dispatcher_id !== actor.id`).

The front end treats a lead with any approval-level key as **"Team lead · Full access"** (`fullLead` in `brokerage-context.tsx`).

## 2.5 Workspace capabilities

`GET /api/v1/brokerage/workspace` returns, for the signed-in user, which part of the app they belong to (`unit`: Brokerage, `FRONTER`, `DISPATCH`) and a `capabilities` object the front end uses to build menus and buttons. The API still re-checks every action; capabilities only shape the screen.

| Unit | Capabilities |
|---|---|
| Brokerage | `sales`, `departmentManager`, `teamLead`, `canCreateLead`, `canCreateQuote`, `canManageCustomerShipments`, `canUpdateShipments`, `canRecordShipmentFinance`, `canRaiseException`, `canAssignLeads`, `canReviewQuotes`, `canHandoffQuotes`, `canAssignShipments`, `canReviewDocuments`, `canResolveExceptions`, `canMarkInvoiceReady` |
| Fronter | `fronter`, `departmentManager`, `teamLead`, `teamReports`, `canQualifyTeam` |
| Dispatch | `dispatch`, `sales`, `departmentManager`, `teamLead`, `canCreateCarrier`, `canReviewCarriers`, `canAssignCarriers`, `canSignOffInvoices`, `canAssignTrucks`, `canReviewInvoices`, `canSetTargets`, `teamReports` |

## 2.6 Who sees what, by module

### Brokerage

| | Agent | Team Lead | Manager | Super Admin |
|---|---|---|---|---|
| Leads, customers | Own | + team's (with `sales.leads.view_team`) | Whole department | All |
| Loads (Operations) | Assigned to them | + team's (with `operations.shipments.view_team`) | Whole department | All |
| Carrier identity on a load | Operations only. Sales never sees who the carrier is (`withoutCarrier()`), only the carrier rate and profit | | | |
| Invoices (view) | Their loads' invoices | + team's | Department | All |
| Invoices (generate, update) | No | With `operations.billing.mark_invoice_ready` | Yes | Yes |

### Fronters

| | Fronter | Team Lead | Fronter Manager | Linked Sales Agent | Sales Manager | Super Admin |
|---|---|---|---|---|---|---|
| Prospects | Own | + team's | Department | Rows of Fronters linked to them (edit, no add or delete) | Rows of Fronters linked to the department's agents (edit, no add or delete) | All |

### Dispatch

| | Sales Agent | Sales Manager | Dispatcher | Dispatch Manager | Super Admin |
|---|---|---|---|---|---|
| Carriers | Own | Department | Through their trucks | Through their trucks | All |
| Trucks, loads | Their carriers' trucks, **no loads** | Department | Assigned to them | Department | All |
| Invoices and gross | **None**, only active sales | All of the department's carriers | Their trucks | Department | All |

A Dispatch Sales Agent's "money hidden" rule is `moneyHidden()` in `dispatch.ts`: Dispatch Sales, not a manager, not Super Admin, and without `dispatch_sales.invoices.signoff`.

### HR and payroll

| | Employee | Manager | Super Admin |
|---|---|---|---|
| Payslips and salaries | No | No | Yes |
| Own performance progress | Yes | Yes | Yes |
| Agents' progress | No | Own team (or department) | Everyone |
| Department P&L and costs | No | No | Yes |
| Attendance | No | Own department, not themselves | Everyone |

### Chat

See [08-chat.md](08-chat.md) for the exact message rules.

## 2.7 Fronter ↔ Sales Agent link

`profiles.sales_agent_id` (migration 027) links a Fronter to the Brokerage Sales Agent they work for. It is required when the Super Admin creates or edits a user in a Fronter department, must point at an active Brokerage Sales Agent, and must be empty for anyone else (`salesAgentProblem()` in `server.ts`). It drives two things:

1. When a Fronter's prospect is marked Qualified, the new Sales lead is owned by that agent.
2. The agent (and their Sales Manager) see that Fronter's rows in the **Fronter mining sheet**.

## 2.8 User lifecycle

| Action | Who | Endpoint | Effect |
|---|---|---|---|
| Create | Super Admin | `POST /api/v1/users` | Creates the Supabase login (email confirmed) and the profile |
| Create an agent | A manager, in their own department | `POST /api/v1/brokerage/department-users` | Same, with role Agent and the manager's department. Agent access page |
| Edit role, department, Fronter's agent, password | Super Admin | `PATCH /api/v1/users/:id` | Clears access caches. Audit `USER_UPDATED` |
| Deactivate / restore | Super Admin (Users page), or a manager for their own agents (Agent access page) | `PATCH /api/v1/users/:id`, `PATCH /api/v1/brokerage/department-users/:id` | Login blocked at once. Audit `ACCESS_REVOKED` / `ACCESS_RESTORED` |
| Exit (HR) | Super Admin | `POST /api/v1/admin/hr/employees/:id/exit` | Last working day and reason; work optionally handed to a colleague; login removed after the last day |
| Delete | Super Admin | `DELETE /api/v1/users/:id` | Only for users with no work in the CRM (see [10-users-audit-finance.md](10-users-audit-finance.md)) |
