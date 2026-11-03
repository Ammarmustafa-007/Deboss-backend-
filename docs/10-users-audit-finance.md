# 10. Users, audit log, notifications, finance overview

## 10.1 Users

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/users` | All users (Super Admin) |
| `POST /api/v1/users` | Create a login + profile. Body: `full_name`, `email`, `password` (8+), `role`, `department_id` (required unless Super Admin), `sales_agent_id` (required for a Fronter department, refused otherwise) |
| `PATCH /api/v1/users/:id` | Change `full_name`, `role`, `department_id`, `sales_agent_id`, `is_active`, `password` |
| `DELETE /api/v1/users/:id` | Delete (below) |

Creating calls `auth.admin.createUser` with the email already confirmed, then fills the profile that the `handle_new_user` trigger created. If filling the profile fails, the login is deleted again. Making someone Super Admin clears their department and Sales agent.

### Deleting a user

Deletion must never leave records pointing at a missing person, so it is allowed **only for a user with no work in the CRM**.

1. Refused for yourself, and for the last active Super Admin.
2. `delete_unused_user(id)` (migration 028) deletes the login from `auth.users` inside one database transaction. The profile and everything that belongs only to it (chat seats, team seats, permissions, notifications, pay setup) go with it through `on delete cascade` / `set null`.
3. If any work record still references the person (leads, customers, loads, chat messages, comments, carriers, Dispatch loads or invoices, mined prospects, payroll lines, or activity history), Postgres refuses with a foreign-key violation; the function catches it and returns `IN_USE`, nothing is deleted, and the API answers `409`, for example: "Mohid has leads in the CRM, so deleting would break those records. Deactivate the user instead."
4. Success writes `USER_DELETED` to the audit log with the name, email and role.

For anyone with history: **deactivate** (blocks the login) or record an HR **exit** (blocks the login after the last day and can hand their work to a colleague).

## 10.2 Audit log

`audit_events`: `actor_id`, `action`, `entity_type`, `entity_id`, `detail` (JSON), `created_at`. `writeAudit()` is called on every change. Examples of actions:

| Area | Actions |
|---|---|
| Users | `USER_CREATED`, `USER_UPDATED`, `ACCESS_REVOKED`, `ACCESS_RESTORED`, `USER_DELETED` |
| Brokerage | `LEAD_*`, `LEAD_STAGE_AUTO`, `QUOTE_*`, `SHIPMENT_*`, `INVOICE_GENERATED`, `INVOICE_UPDATED`, `CUSTOMER_*` |
| Fronters | `PROSPECTS_ADDED`, `PROSPECT_STATUS_CHANGED`, `PROSPECT_QUALIFIED`, `PROSPECT_DELETED` |
| Dispatch | `CARRIER_*`, `TRUCK_STATUS_CHANGED`, `TRUCK_UPDATED`, `LOAD_ADDED`, `LOAD_UPDATED`, `LOAD_DELETED`, `DISPATCH_INVOICE_<action>`, `DISPATCH_INVOICE_CREATED`, `DISPATCH_INVOICE_EDITED`, `DISPATCH_INVOICE_DELETED`, `DISPATCH_TARGET_SET` |
| HR, payroll | `HR_RULES_UPDATED`, `EMPLOYEE_PAY_UPDATED`, `EMPLOYEE_EXIT_RECORDED`, `EMPLOYEE_EXIT_CANCELLED`, `ATTENDANCE_UPDATED`, `COST_ADDED`, `COST_UPDATED`, `COST_REMOVED`, `PAYROLL_RATE_UPDATED`, `PAYROLL_FINALIZED`, `PAYROLL_REOPENED` |

Record pages show their own history from this table (for example a Dispatch invoice's History). There is no screen listing the whole log.

## 10.3 Notifications

`notifications`: `recipient_id`, `kind`, `title`, `body` (≤ 140 characters), `entity_type`, `entity_id`, `read_at`. Created by the API next to the change that causes them (assignments, reviews, returns, approvals, payments, overdue invoices, qualified leads). Read with `GET /brokerage/notifications`, marked with `PATCH /brokerage/notifications/:id/read`. The actor is never notified about their own action. There are no emails and no notifications for pay (client rule).

## 10.4 Finance overview (Super Admin)

`GET /api/v1/admin/finance?period=YYYY-MM` (`financeFor()` in `payroll.ts`):

| Figure | Calculation |
|---|---|
| Invoiced | Brokerage invoices issued in the month + Dispatch invoices forwarded in the month (`amount`) |
| Collected | Brokerage invoices paid in the month + Dispatch invoices paid in the month (`amount_paid`) |
| Outstanding | All open invoices (Brokerage not Paid / Cancelled, Dispatch Submitted / Forwarded): amount − paid |
| Approved sales gross | Agreed rates of Brokerage loads committed in the month (not cancelled) |
| Payroll | The month's total net pay converted to USD |
| Operating profit | Collected − payroll |
| Trend | The same for the last six months |
| By department | Revenue, collected and payroll per department |
