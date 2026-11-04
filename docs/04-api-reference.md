# 4. API reference

Base URL: the backend origin (for example `http://localhost:4000`). Every endpoint except `/health` needs `Authorization: Bearer <Supabase access token>`. Bodies are JSON. Errors are `{ "error": "message" }` (see [01-architecture.md](01-architecture.md)).

**Access** is the guard. **Rules** are the refusals the endpoint itself checks, quoted from the code (status: message). A refusal message containing `${…}` is filled in at run time.


## Users, Brokerage, teams (`src/server.ts`)

| Method | Path | Access | Purpose | Rules |
|---|---|---|---|---|
| GET | `/health` | Public | Liveness check: `{ status: "ok", service, timestamp }`. | |
| GET | `/api/v1/users` | Super Admin | All users with their department (Super Admin's Users page). Includes `sales_agent_id` for Fronters. |  |
| POST | `/api/v1/users` | Super Admin | Create a login and profile: name, email, temporary password, role, department, and a Fronter's Sales agent. | 422:A departmental role requires a department. |
| PATCH | `/api/v1/users/:id` | Super Admin | Change name, role, department, Fronter's Sales agent, password, or active state. |  |
| DELETE | `/api/v1/users/:id` | Super Admin | Delete a user with no work in the CRM (see 10-users-audit-finance.md). | 422:You can't delete your own account. // 404:User not found. // 422:This is the only active Super Admin. // 404:User not found. // 409:${person.full_name} has ${work[table] ??  |
| GET | `/api/v1/brokerage/workspace` | Any active user | Who the caller is, their teams, permissions and capabilities. For Brokerage users also their leads, quotes and loads (up to 100 each), customers and Operations departments. | 403:Brokerage access is required. |
| POST | `/api/v1/brokerage/leads` | Any active user | Create a Sales lead (owned by the caller). | 403:Only Brokerage Sales users can create leads. |
| POST | `/api/v1/brokerage/quotes` | Any active user | Create a quote on a lead. | 403:Only Brokerage Sales users can create quotes. // 403:You cannot create a quote for this lead. |
| POST | `/api/v1/brokerage/teams` | Any active user | Manager: create a team with members, Team Lead and delegated permissions. Creates the team's chat group. | 403:Only a Department Manager can create teams. // 422:Team members and Team Leads must be active Agents in your department. |
| GET | `/api/v1/brokerage/team-directory` | Any active user | People and teams of the caller's department, for team management (all Brokerage, Fronter and Dispatch departments use it). | 403:Only a Department Manager can manage teams. // 403:Only a Department Manager or Team Lead can view the team directory. |
| PATCH | `/api/v1/brokerage/teams/:id` | Any active user | Manager: rename a team, change members, Team Lead, permissions, or deactivate it. Re-syncs the chat group. | 403:Only a Department Manager can edit teams. // 404:Team not found. // 422:Team members must belong to your department. |
| PATCH | `/api/v1/brokerage/leads/:id` | Any active user | Edit a lead's details, status, owner or team. Status can't be set by hand once the lead has quotes (it then follows its loads). | 404:Lead not found. // 403:You do not have permission to edit this lead. // 422:This lead has quotes, so its status now follows its loads. // 403:Lead assignment permission is required. // 403:You can assign leads only to members of your team. // 403:You can move leads only between your own teams. // 422:The lead owner must be an active Sales Agent in this department. |
| POST | `/api/v1/brokerage/leads/:id/activities` | Any active user | Log a call, callback, appointment, follow-up, email or note on a lead. | 404:Lead not found. // 403:You do not have permission to add activity to this lead. |
| PATCH | `/api/v1/brokerage/activities/:id` | Any active user | Edit an activity or mark it done / not done. | 404:Activity not found. // 404:Lead not found. // 403:You do not have permission to update this activity. |
| DELETE | `/api/v1/brokerage/activities/:id` | Any active user | Delete an activity. | 404:Activity not found. // 404:Lead not found. // 403:You do not have permission to delete this activity. |
| GET | `/api/v1/brokerage/leads/:id/detail` | Any active user | A lead with activities, comments, quotes, customer and loads. | 404:Lead not found. // 403:Lead is outside your work scope. |
| POST | `/api/v1/brokerage/leads/:id/comments` | Any active user | Comment on a lead. | 404:Lead not found. // 403:Lead is outside your work scope. |
| DELETE | `/api/v1/brokerage/comments/:id` | Any active user | Delete a comment (its author or the responsible manager). | 404:Comment not found. // 403:Only the comment author or the responsible manager can delete this comment. |
| POST | `/api/v1/brokerage/leads/:id/convert` | Any active user | Create the customer profile for a lead. | 404:Lead not found. // 403:You do not have permission to convert this lead. |
| GET | `/api/v1/brokerage/customers/:id/profile` | Any active user | A customer with its loads, Operations progress and comments. | 404:Customer not found. // 403:Customer is outside your work scope. |
| POST | `/api/v1/brokerage/customers/:id/comments` | Any active user | Comment on a customer. | 404:Customer not found. // 403:Customer is outside your work scope. |
| GET | `/api/v1/brokerage/customers` | Any active user | The caller's customers (Sales). | 403:Brokerage Sales access is required. |
| PATCH | `/api/v1/brokerage/customers/:id` | Any active user | Edit a customer's details. | 403:Brokerage Sales access is required. // 422:At least one customer field is required. // 404:Customer not found. // 403:Customer update permission is required. |
| POST | `/api/v1/brokerage/customers/:id/shipments` | Any active user | Sales: add a load to a customer (lane, equipment, rates, dates). Creates its quote. Entering an agreed rate routes it (see 05-brokerage.md). | 403:Brokerage Sales access is required. // 404:Customer not found. // 403:Customer shipment creation permission is required. // 422:This customer is not linked to a Sales lead. |
| PATCH | `/api/v1/brokerage/sales-shipments/:id` | Any active user | Sales: edit a load's commercial side (rates, dates, commercial status, cancel with a reason). | 403:Brokerage Sales access is required. // 422:At least one shipment field is required. // 404:Shipment not found. // 422:This shipment is not linked to a customer profile. // 403:Customer shipment update permission is required. // 422:This load was cancelled and can no longer be changed. // 422:This load is with Operations; ask them to cancel it. |
| GET | `/api/v1/brokerage/notifications` | Any active user | The caller's notifications (bell). |  |
| PATCH | `/api/v1/brokerage/notifications/:id/read` | Any active user | Mark a notification read. | 404:Notification not found. |
| PATCH | `/api/v1/brokerage/quotes/:id` | Any active user | Edit a quote while it is a draft or returned for rework. | 404:Quote not found. // 403:This quote cannot be edited in its current stage. |
| POST | `/api/v1/brokerage/quotes/:id/submit` | Any active user | Send a quote to the Sales Manager for review. With the Sales Manager step off: hand the load to Operations (body: optional `operations_department_id`); returns `routed: "OPERATIONS"` or `"AGENT"`. | 404:Quote not found. // 422:This load was cancelled, so its quote can't move forward. // 403:Quote submission permission is required. // 422:Only a draft or reworked quote can be submitted. // 422:Enter the agreed rate before handing this load to Operations. // 422:Choose the Operations department for this customer. |
| GET | `/api/v1/brokerage/quotes/:id/detail` | Any active user | A quote with events, attachments and comments. | 404:Quote not found. // 403:Quote is outside your work scope. |
| POST | `/api/v1/brokerage/quotes/:id/upload-url` | Any active user | Signed upload URL for a quote attachment (PDF, JPG, PNG, max 10 MB). | 404:Quote not found. // 403:Quote update permission is required. // 422:Only PDF, JPG, JPEG, and PNG files are allowed. |
| POST | `/api/v1/brokerage/quotes/:id/attachments` | Any active user | Record an uploaded quote attachment. | 403:Quote update permission is required. |
| GET | `/api/v1/brokerage/quote-attachments/:id/download-url` | Any active user | Signed download URL for a quote attachment. | 404:Quote attachment not found. // 403:Quote attachment is outside your work scope. |
| POST | `/api/v1/brokerage/quotes/:id/comments` | Any active user | Comment on a quote. | 403:Quote is outside your work scope. |
| POST | `/api/v1/brokerage/quotes/:id/review` | Any active user | Sales Manager: approve (and, for a customer's first load, choose the Operations department) or return for rework with a note. | 404:Quote not found. // 422:This load was cancelled, so its quote can't move forward. // 403:Quote review permission is required. // 422:Only a submitted quote can be reviewed. // 422:Choose the Operations department for this customer. // 422:Choose an active Brokerage Operations department. |
| POST | `/api/v1/brokerage/quotes/:id/handoff` | Any active user | Hand an approved load to an Operations department. | 404:Quote not found. // 403:Operations handoff permission is required. // 422:Only an approved quote can be handed to Operations. // 422:Choose a Brokerage Operations department. // 422:This load was cancelled, so it cannot be handed to Operations. |
| POST | `/api/v1/brokerage/shipments/:id/ops-review` | Any active user | Operations Manager: approve a new customer's first load and assign the customer's Operations agent, or reject it with a reason. | 404:Load not found. // 403:Only the Operations Manager of this department can review it. // 422:This load isn't waiting for an Operations review. // 422:The agent must be active in this Operations department. |
| POST | `/api/v1/brokerage/quotes/:id/ops-rejection` | Any active user | Sales Manager, after an Operations rejection: send the load back to the agent to fix, or close it out. | 404:Quote not found. // 403:Only the Sales Manager decides after an Operations rejection. // 422:This quote wasn't rejected by Operations. // 422:This load was closed out, so it can't be sent back. |
| PATCH | `/api/v1/brokerage/customers/:id/operations-agent` | Any active user | Operations Manager: change a customer's Operations agent. Its open loads move to the new agent. | 404:Customer not found. // 403:Only this customer's Operations Manager can change its agent. // 422:The agent must be active in this Operations department. |
| GET | `/api/v1/brokerage/carriers` | Any active user | Brokerage Operations: approved carriers from the Dispatch module, to fill a load's carrier details. | 403:Only Brokerage Operations can use the carrier list. |
| GET | `/api/v1/brokerage/operations-directory` | Any active user | Agents and teams of an Operations department, for assignment. | 403:Only Brokerage Operations can view this directory. // 403:Only a Brokerage Operations Manager or Team Lead can view this directory. |
| PATCH | `/api/v1/brokerage/shipments/:id` | Any active user | Operations: update a load (status, carrier, driver, documents flags, exception, assignment, team, finance fields). | 404:Shipment not found. // 403:Shipment is outside your work scope. // 403:Shipment assignment permission is required. // 403:You can assign shipments only to members of your team. // 403:You can move shipments only between your own teams. // 422:Use the Sales commercial lifecycle or invoice ledger for this status. // 403:Shipment update permission is required. |
| POST | `/api/v1/brokerage/shipments/:id/invoice` | Any active user | Generate (or update) the load's invoice. Only after delivery. | 404:Shipment not found. // 403:Only the Operations Manager or a Team Lead with billing access can generate an invoice. // 422:A shipment must be delivered before invoicing. |
| PATCH | `/api/v1/brokerage/invoices/:id` | Any active user | Update an invoice: amount, paid amount, status, due date. Paid in full completes the load. | 404:Invoice not found. // 403:Only the Operations Manager or a Team Lead with billing access can update an invoice. // 422:Paid needs the full amount collected. Use Pending for a partial payment. |
| GET | `/api/v1/brokerage/invoices` | Any active user | Operations invoices (marks overdue ones first). | 403:Operations access is required. |
| POST | `/api/v1/brokerage/shipments/:id/documents` | Any active user | Record an uploaded load document (BOL, POD, rate confirmation, invoice, other). | 404:Shipment not found. // 403:Shipment update permission is required. |
| PATCH | `/api/v1/brokerage/documents/:id/review` | Any active user | Verify or return a load document. | 404:Document not found. // 403:Document review permission is required. |
| GET | `/api/v1/brokerage/documents/:id/download-url` | Any active user | Signed download URL for a load document. | 404:Document not found. // 403:Document is outside your work scope. |
| GET | `/api/v1/brokerage/reports` | Any active user | Brokerage reports for a date range and optionally one person (own, team or department). | 403:You can open individual reports only for your team's members. |
| GET | `/api/v1/brokerage/overview` | Super Admin | Super Admin: company-wide Brokerage overview. |  |
| GET | `/api/v1/brokerage/shipments/:id/detail` | Any active user | A load with events, documents, invoice and comments (carrier identity hidden from Sales). | 404:Shipment not found. // 403:Shipment is outside your work scope. |
| POST | `/api/v1/brokerage/shipments/:id/upload-url` | Any active user | Signed upload URL for a load document. | 404:Shipment not found. // 403:Shipment is outside your update scope. // 422:Only PDF, JPG, JPEG, and PNG files are allowed. |
| POST | `/api/v1/brokerage/shipments/:id/comments` | Any active user | Comment on a load. | 404:Shipment not found. // 403:Shipment is outside your work scope. |
| POST | `/api/v1/brokerage/department-users` | Any active user | Manager: create an agent login in their own department (name, email, temporary password). Role is always Agent. Used by the Agent access page. | 403:Manager access is required. |
| GET | `/api/v1/brokerage/department-users` | Any active user | Manager: the department's people and their granted permissions. Used by the Agent access page. | 403:Manager access is required. |
| PATCH | `/api/v1/brokerage/department-users/:id` | Any active user | Manager: activate or deactivate an agent of their department. Used by the Agent access page. | 403:Manager access is required. // 404:Agent not found in your department. // 404:Route not found. // 400:${custom}. |

## Fronters (`src/fronter.ts`)

| Method | Path | Access | Purpose | Rules |
|---|---|---|---|---|
| GET | `/api/v1/fronter/sales-agents` | Fronters, Super Admin | Active Brokerage Sales agents. No longer used by the front end (qualifying now goes to the Fronter's linked agent). |  |
| GET | `/api/v1/fronter/prospects` | Fronters, Brokerage Sales, Super Admin | Fronter: own / team / department prospects. Brokerage Sales: rows of the Fronters linked to them, with `fields_locked`. |  |
| POST | `/api/v1/fronter/prospects` | Fronters, Super Admin | Add one or many prospects (typing or pasting rows). Rows without a company name are skipped and reported. | 403:Prospects are added by the Fronters department. // 422:No rows could be added. Each row needs a company name. |
| PATCH | `/api/v1/fronter/prospects/:id` | Fronters, Brokerage Sales, Super Admin | Edit a cell or the status. Qualified creates the Sales lead and customer for the Fronter's Sales agent and locks the row. Sales may change the status only. | 404:Prospect not found. // 422:This prospect is qualified and now belongs to Brokerage Sales. // 403:This prospect belongs to a Fronter who doesn't work for you. // 403:Sales can change the status only. The Fronter fills in the details. // 403:You can't edit this prospect. // 422:Assign to an active Brokerage Sales agent. // 403:You can't qualify this prospect. |
| DELETE | `/api/v1/fronter/prospects/:id` | Fronters, Super Admin | Delete a prospect (not once qualified). | 404:Prospect not found. |
| GET | `/api/v1/fronter/commodities` | Fronters, Super Admin | The Commodities sheet. |  |
| POST | `/api/v1/fronter/commodities` | Fronters, Super Admin | Add a commodity row. | 403:Commodities are added by the Fronters department. |
| PATCH | `/api/v1/fronter/commodities/:id` | Fronters, Super Admin | Edit a commodity row. | 404:Commodity not found. // 403:You can't edit this row. |
| DELETE | `/api/v1/fronter/commodities/:id` | Fronters, Super Admin | Delete a commodity row. | 404:Commodity not found. // 403:You can't delete this row. |
| GET | `/api/v1/fronter/reports` | Fronters, Super Admin | Fronter results per person for a date range. Used by the Fronter dashboard cards. |  |

## Dispatch (`src/dispatch.ts`)

| Method | Path | Access | Purpose | Rules |
|---|---|---|---|---|
| GET | `/api/v1/dispatch/directory` | Dispatch, Super Admin | Agents, managers and teams the caller may assign to, and the Dispatch Operations departments. |  |
| GET | `/api/v1/dispatch/duplicates` | Dispatch, Super Admin | Carriers with the same MC or DOT number, while typing. |  |
| GET | `/api/v1/dispatch/carriers` | Dispatch, Super Admin | Carriers in the caller's scope, with their trucks. |  |
| POST | `/api/v1/dispatch/carriers` | Dispatch, Super Admin | Dispatch Sales (agent or manager): add a carrier with its trucks. The caller owns it. | 403:Carriers are created by the Dispatch Sales department. |
| GET | `/api/v1/dispatch/carriers/:id/detail` | Dispatch, Super Admin | A carrier with trucks (each with `sale_active_since`), documents, activities, comments, invoices (hidden from Sales Agents), duplicates, rights, and a `summary` (trucks running, paid gross this week and month, miles, invoices received). | 404:Carrier not found. // 403:This carrier is outside your work scope. |
| PATCH | `/api/v1/dispatch/carriers/:id` | Dispatch, Super Admin | Edit profile, terms (charge %, payment method), owner (agent or manager of the department) or team. | 404:Carrier not found. // 403:You cannot edit this carrier. // 403:You cannot change this carrier's terms. // 422:A discarded carrier cannot be edited. // 403:Carrier assignment permission is required. // 422:The owner must be an active agent or manager in this Dispatch Sales department. // 403:You can assign carriers only to members of your team. |
| POST | `/api/v1/dispatch/carriers/:id/trucks` | Dispatch, Super Admin | Add a truck. On an approved carrier it goes straight to Dispatch Operations. | 404:Carrier not found. // 403:You cannot add trucks to this carrier. |
| DELETE | `/api/v1/dispatch/trucks/:id` | Dispatch, Super Admin | Remove a truck that isn't approved yet. | 404:Truck not found. // 422:Only trucks not yet approved can be removed. |
| POST | `/api/v1/dispatch/carriers/:id/upload-url` | Dispatch, Super Admin | Signed upload URL for a carrier document. | 404:Carrier not found. // 403:You cannot add documents to this carrier. // 422:Only PDF, JPG, JPEG, and PNG files are allowed. |
| POST | `/api/v1/dispatch/carriers/:id/documents` | Dispatch, Super Admin | Record an uploaded carrier document. | 404:Carrier not found. // 403:You cannot add documents to this carrier. // 422:The upload does not belong to this carrier. |
| GET | `/api/v1/dispatch/documents/:id/download-url` | Dispatch, Super Admin | Signed download URL for a carrier document. | 404:Document not found. // 403:This document is outside your work scope. |
| DELETE | `/api/v1/dispatch/documents/:id` | Dispatch, Super Admin | Remove a document before the carrier is submitted. | 404:Document not found. // 422:Documents can be removed only before the carrier is submitted. |
| POST | `/api/v1/dispatch/carriers/:id/activities` | Dispatch, Super Admin | Log a call, callback, appointment, follow-up, email or note on a carrier. | 404:Carrier not found. // 403:You cannot log activity on this carrier. |
| PATCH | `/api/v1/dispatch/activities/:id` | Dispatch, Super Admin | Edit an activity or mark it done. | 404:Activity not found. // 403:You cannot update this activity. |
| DELETE | `/api/v1/dispatch/activities/:id` | Dispatch, Super Admin | Delete an activity (author only). | 404:Activity not found. // 403:Only the author can delete this activity. |
| POST | `/api/v1/dispatch/carriers/:id/submit` | Dispatch, Super Admin | Submit a carrier for review. Needs at least one truck and the MC authority, W-9 and COI. | 404:Carrier not found. // 403:You cannot submit this carrier. // 422:This carrier is not waiting to be submitted. // 422:Add at least one truck before submitting. // 422:Upload the missing documents first: ${missing.map((type) => type ===  |
| POST | `/api/v1/dispatch/carriers/:id/review` | Dispatch, Super Admin | Dispatch Sales Manager: approve (choosing the Dispatch Operations department), return with a note, or discard with a note. | 404:Carrier not found. // 403:Only the Dispatch Sales Manager can review this carrier. // 422:This carrier is not waiting for review. // 422:Choose an active Dispatch Operations department. |
| GET | `/api/v1/dispatch/trucks` | Dispatch, Super Admin | Trucks in scope with this week's paid gross, loads and miles, all-time paid invoices, last load date and `sale_active_since`. Money fields are null for Sales Agents. |  |
| GET | `/api/v1/dispatch/trucks/:id/detail` | Dispatch, Super Admin | A truck with loads, invoices, comments, targets and rights. Loads, invoices and targets are empty for Sales Agents. | 404:Truck not found. // 403:This truck is outside your work scope. |
| PATCH | `/api/v1/dispatch/trucks/:id` | Dispatch, Super Admin | Edit the truck, assign a Dispatcher (an agent or a manager of the department) and team, or change status. | 404:Truck not found. // 403:You cannot edit this truck. // 422:This truck has not been handed to Dispatch Operations yet. // 403:Only the Dispatch Manager can assign trucks. // 422:The Dispatcher must be an active agent or manager in this Dispatch Operations department. // 403:You can assign trucks only to members of your team. // 403:You can move trucks only between your own teams. |
| GET | `/api/v1/dispatch/dnc` | Dispatch, Super Admin | The Do-Not-Call list (every truck marked DNC). |  |
| GET | `/api/v1/dispatch/loads` | Dispatch, Super Admin | Search loads by zip, city, lane, broker, load number, dates, status, truck or Dispatcher. |  |
| POST | `/api/v1/dispatch/trucks/:id/loads` | Dispatch, Super Admin | Log a load on a truck. The first load of an Onboarded or Inactive truck makes it Running. | 404:Truck not found. // 403:Only the truck's Dispatcher or the Dispatch Manager can log loads. // 422:Loads can be logged once the truck is assigned to a Dispatcher. // 422:Delivery date can't be before pickup. |
| PATCH | `/api/v1/dispatch/loads/:id` | Dispatch, Super Admin | Edit a load. Locked for the Dispatcher once its invoice is submitted; the manager can still edit. Its invoice is recalculated. | 404:Load not found. // 403:You cannot edit this load. // 422:Delivery date can't be before pickup. |
| DELETE | `/api/v1/dispatch/loads/:id` | Dispatch, Super Admin | Delete a load (same lock). Its invoice is recalculated. | 404:Load not found. // 403:You cannot delete this load. |
| GET | `/api/v1/dispatch/invoices` | Dispatch, Super Admin | Invoices in scope (none for Sales Agents). |  |
| POST | `/api/v1/dispatch/trucks/:id/invoices` | Dispatch, Super Admin | Create an invoice from chosen loads (`load_ids`) of any week. Several per truck and week are allowed. | 404:Truck not found. // 403:Only the truck's Dispatcher can create its invoice. // 422:Set the carrier's charge % first. // 422:Some of those loads are not on this truck. // 422:Cancelled loads can't be invoiced. // 422:Some of those loads are already on another invoice. |
| PATCH | `/api/v1/dispatch/invoices/:id` | Dispatch, Super Admin | Add or remove loads, or correct gross, charge %, amount, amount paid. Dispatcher on a Draft; Dispatch Manager at any stage. | 404:Invoice not found. // 422:A cancelled invoice can't be edited. // 422:Payment can be corrected once the invoice is forwarded. // 422:Only free, active loads of this truck can be added. // 422:An invoice needs at least one load. Delete it instead. |
| DELETE | `/api/v1/dispatch/invoices/:id` | Dispatch, Super Admin | Delete an invoice and free its loads. Dispatcher on a Draft; Dispatch Manager at any stage. | 404:Invoice not found. // 403:Only the Dispatch Manager can delete an invoice after it is submitted. |
| POST | `/api/v1/dispatch/invoices/:id/actions` | Dispatch, Super Admin | Workflow: `SUBMIT`, `RECALL`, `RETURN`, `FORWARD`, `PAY`, `CANCEL`, `SIGN_OFF`, `RECALCULATE` (see 07-dispatch.md). | 404:Invoice not found. // 422:This invoice is ${invoice.status.toLowerCase()}, so it can't be ${input.action ===  // 422:Add a note explaining what to fix. // 422:This invoice is already signed off. |
| GET | `/api/v1/dispatch/invoices/:id/detail` | Dispatch, Super Admin | An invoice with its loads, free loads that can be added, comments, history and rights. | 404:Invoice not found. // 403:This invoice is outside your work scope. |
| POST | `/api/v1/dispatch/comments` | Dispatch, Super Admin | Comment on a carrier, truck or invoice. | 403:This carrier is outside your work scope. // 403:This truck is outside your work scope. // 404:Invoice not found. // 403:This invoice is outside your work scope. |
| GET | `/api/v1/dispatch/targets` | Dispatch, Super Admin | Targets of the department's agents, and the unit (`SALES` count or `GROSS` dollars). |  |
| PUT | `/api/v1/dispatch/targets/:userId` | Dispatch, Super Admin | Manager: set a weekly or monthly target. | 403:Only a Dispatch manager can set targets. // 422:Targets can be set only for agents in your department. // 422:A sales target is a whole number of sales. |
| GET | `/api/v1/dispatch/reports` | Dispatch, Super Admin | Dispatch reports for a date range (people, carriers, trucks, statuses). Money removed for Sales Agents. | 403:You can open individual reports only for your team's members. |

## Chat (`src/chat.ts`)

| Method | Path | Access | Purpose | Rules |
|---|---|---|---|---|
| GET | `/api/v1/chat/inbox` | Managers, agents, Super Admin | The caller's conversations, unread counts and who they may message. Syncs channel membership first. |  |
| POST | `/api/v1/chat/direct` | Managers, agents, Super Admin | Open or create a direct conversation with someone the caller may message. | 403:The Super Admin uses Company announcements, not direct messages. // 422:Choose someone else. |
| GET | `/api/v1/chat/conversations/:id/messages` | Managers, agents, Super Admin | Message history of a conversation the caller belongs to. | 403:You're not in this conversation. |
| PATCH | `/api/v1/chat/groups/:id` | Managers, agents, Super Admin | Group admin: rename a team group or change its photo. | 403:Only the group admin can change the group. |
| POST | `/api/v1/chat/photo-upload-url` | Managers, agents, Super Admin | Signed upload URL for a group photo. | 403:Only managers set group photos. |
| GET | `/api/v1/admin/communication` | Super Admin | Super Admin: every team group with its members and counts. |  |

## HR, payroll, performance, finance (`src/payroll.ts`)

| Method | Path | Access | Purpose | Rules |
|---|---|---|---|---|
| GET | `/api/v1/admin/brokerage-settings` | Super Admin | `{ sales_manager_approval }` (true when the table doesn't exist yet). |  |
| PUT | `/api/v1/admin/brokerage-settings` | Super Admin | Turn the Brokerage Sales Manager step on or off; turning it off moves waiting loads on (`moved`). | 503:Run migration 20261105_029_brokerage_settings.sql in Supabase first. |
| GET | `/api/v1/admin/hr/rules` | Super Admin | The commission rules (amounts, rates, targets, shares). |  |
| PUT | `/api/v1/admin/hr/rules` | Super Admin | Replace the commission rules. Logged with before and after. |  |
| GET | `/api/v1/admin/hr/employees` | Super Admin | Every agent and manager with base salary (PKR), joining date, manager, exit. |  |
| PUT | `/api/v1/admin/hr/employees/:id` | Super Admin | Set base salary, joining date and (in two-manager departments) manager. | 404:Staff member not found. // 422:Choose a manager in the same department. |
| POST | `/api/v1/admin/hr/employees/:id/exit` | Super Admin | Record an exit: last working day, reason, and optionally hand all work to a colleague. | 404:Staff member not found. // 422:Choose an active colleague in the same department. |
| DELETE | `/api/v1/admin/hr/employees/:id/exit` | Super Admin | Cancel a recorded exit. |  |
| GET | `/api/v1/attendance` | Any active user | The month's attendance grid (managers: their department except themselves; Super Admin: everyone). | 403:Only managers record attendance. |
| PUT | `/api/v1/attendance` | Any active user | Mark one day Present, Leave or Absent. | 403:You can't record attendance for this person. // 422:Attendance is recorded for Monday to Friday only. |
| GET | `/api/v1/admin/costs` | Super Admin | The month's costs and the department P&L. |  |
| POST | `/api/v1/admin/costs` | Super Admin | Add a cost (amount, USD or PKR, cost type, departments). |  |
| PUT | `/api/v1/admin/costs/:id` | Super Admin | Edit a cost. | 404:Cost not found. |
| DELETE | `/api/v1/admin/costs/:id` | Super Admin | Remove a cost. | 404:Cost not found. |
| GET | `/api/v1/admin/payroll` | Super Admin | The month's payroll: live draft, or the frozen lines once finalized. |  |
| PUT | `/api/v1/admin/payroll/:period/rate` | Super Admin | Set the month's USD to PKR rate. |  |
| POST | `/api/v1/admin/payroll/:period/finalize` | Super Admin | Freeze the month: payroll lines, totals and department P&L are stored. | 422:A future month can't be finalized. // 409:This month is already finalized. // 422:Enter the month's USD to PKR rate first. |
| POST | `/api/v1/admin/payroll/:period/reopen` | Super Admin | Discard the frozen month so it is a live draft again. | 404:This month is not finalized. |
| GET | `/api/v1/admin/finance` | Super Admin | Super Admin finance overview: invoiced, collected, outstanding, payroll in USD, profit, six-month trend, per department. |  |
| GET | `/api/v1/me/performance` | Any active user | The caller's own progress (no pay figures; no gross for Dispatch Sales Agents). |  |
| GET | `/api/v1/performance/team` | Any active user | Managers: their team's progress. Super Admin: everyone. | 403:Only managers see team performance. |
