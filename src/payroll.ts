import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { allocateCost, basePay, dispatchSalesCommission, earnsVariablePay, profitShare, round, tieredCommission, tierFor, workingDays, type CostType, type ExitType, type HrRules, type Tier } from "./hr-rules.js";

/**
 * Payroll, attendance, department P&L and the Director's finance overview (client HR and Compensation Rules).
 *
 * Commission counts money received in the month only:
 *  - Dispatch: dispatch fees on weekly invoices paid in the month.
 *  - Brokerage: customer rate minus carrier rate, on loads whose invoice was paid in the month.
 *  - Fronter: a flat PKR amount per lead qualified in the month.
 * Managers earn a share of their department's net profit. Salaries are in PKR, income and targets in USD; the
 * Super Admin enters the month's rate. Payslips and salaries are visible to the Super Admin only.
 */

type Actor = { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null };
type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
type Deps = {
  adminClient: () => SupabaseClient;
  requireSuperAdmin: Handler;
  requireBrokerageUser: Handler;
  clearAccessCache: (userId?: string) => void;
  writeAudit: (supabase: SupabaseClient, actorId: string, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => Promise<void>;
};

export const roleKeys = ["BROKERAGE_SALES_AGENT", "BROKERAGE_SALES_MANAGER", "BROKERAGE_OPERATIONS_AGENT", "BROKERAGE_OPERATIONS_MANAGER", "DISPATCH_SALES_AGENT", "DISPATCH_SALES_MANAGER", "DISPATCHER", "DISPATCH_MANAGER", "BROKERAGE_FRONTER_AGENT", "BROKERAGE_FRONTER_MANAGER"] as const;
type RoleKey = (typeof roleKeys)[number];
type Item = { reference: string; customer: string | null; amount: number; date: string | null };
type LineDetail = {
  usd_to_pkr: number | null; joined_on: string; last_working_day: string | null; exit_type: ExitType | null; on_probation: boolean;
  working_days: number; employed_days: number; days_worked: number; leave_days: number; absent_days: number; paid_leave_used: number; unpaid_absences: number;
  base_earned: number; leave_deduction: number; gross: number; active_sales: number | null; qualified_leads: number | null;
  commission_usd: number; commission_pkr: number; profit_share_percent: number; profit_share_usd: number; profit_share_pkr: number; net_pay_pkr: number; net_pay_usd: number | null;
};
export type PayrollLine = {
  user_id: string; full_name: string; role_key: RoleKey; department_id: string | null; department_name: string | null;
  base_salary: number; commission_basis: "HR_RULES"; commission_rate: number; basis_amount: number; commission_amount: number; total: number;
  configured: boolean; items: Item[]; detail: LineDetail;
};
type DepartmentPl = {
  department_id: string; manager_id: string | null; unassigned: boolean; name: string; business_unit: string; function: string; people: number; income: number; salaries: number; commissions: number;
  costs: { name: string; amount: number }[]; other_costs: number; total_costs: number; net_profit: number; manager_share_percent: number; manager_share: number;
};

const tiers = z.array(z.object({ from: z.number().nonnegative(), rate: z.number().min(0).max(100) }).strict()).min(1).max(10);
const percent = z.number().min(0).max(100);
const rulesSchema = z.object({
  dispatch_sales: z.object({ min_active_sales: z.number().int().nonnegative(), rate: percent }).strict(),
  dispatcher: z.object({ tiers }).strict(),
  brokerage_sales: z.object({ tiers }).strict(),
  brokerage_operations: z.object({ tiers }).strict(),
  fronter_per_lead_pkr: z.number().nonnegative(),
  manager_share: z.object({ DISPATCH_SALES_MANAGER: percent, DISPATCH_MANAGER: percent, BROKERAGE_SALES_MANAGER: percent, BROKERAGE_OPERATIONS_MANAGER: percent }).strict(),
  paid_leaves_per_month: z.number().int().nonnegative(),
}).strict();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format.");
const employeeSchema = z.object({ base_salary_pkr: z.number().nonnegative().max(100_000_000), joined_on: dateSchema, manager_id: z.string().uuid().nullable().optional() }).strict();
const exitSchema = z.object({ last_working_day: dateSchema, exit_type: z.enum(["NOTICE_SERVED", "NO_NOTICE", "FIRED"]), reassign_to: z.string().uuid().nullable().optional() }).strict();
const attendanceSchema = z.object({ user_id: z.string().uuid(), date: dateSchema, status: z.enum(["PRESENT", "LEAVE", "ABSENT"]) }).strict();
const costSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), name: z.string().trim().min(1).max(120), amount: z.number().nonnegative().max(1_000_000_000), currency: z.enum(["USD", "PKR"]),
  cost_type: z.enum(["COMPANY_SHARED", "ONE_DEPARTMENT", "TWO_DEPARTMENTS", "COMPANY_ONLY"]), department_ids: z.array(z.string().uuid()).max(2),
}).strict().superRefine((cost, context) => {
  const needed = cost.cost_type === "ONE_DEPARTMENT" ? 1 : cost.cost_type === "TWO_DEPARTMENTS" ? 2 : 0;
  if (new Set(cost.department_ids).size !== needed) context.addIssue({ code: "custom", path: ["department_ids"], message: needed ? `Choose ${needed} department${needed === 1 ? "" : "s"}.` : "This cost type has no departments." });
});
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the YYYY-MM format.");

const num = (value: unknown) => Number(value ?? 0) || 0;
const today = () => new Date().toISOString().slice(0, 10);
const currentPeriod = () => new Date().toISOString().slice(0, 7);
const dayOf = (value: string | null | undefined) => (value ?? "").slice(0, 10);
const bounds = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(year, month - 1, 1)).toISOString(), end: new Date(Date.UTC(year, month, 1)).toISOString() };
};
const shiftPeriod = (period: string, months: number) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 7);
};
const oneOf = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

function roleKeyFor(role: string, department?: { business_unit?: string; function?: string } | null): RoleKey | null {
  if (!["AGENT", "MANAGER"].includes(role)) return null;
  if (department?.business_unit === "DISPATCH") return (department.function === "SALES" ? `DISPATCH_SALES_${role}` : role === "AGENT" ? "DISPATCHER" : "DISPATCH_MANAGER") as RoleKey;
  if (department?.business_unit !== "BROKERAGE") return null;
  if (department.function === "FRONTER") return `BROKERAGE_FRONTER_${role}` as RoleKey;
  return `BROKERAGE_${department.function === "SALES" ? "SALES" : "OPERATIONS"}_${role}` as RoleKey;
}

/** Dispatch tables arrive with migration 015; until a database has them, payroll and finance simply see no Dispatch rows. */
async function optional<T>(query: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const { data, error } = await query;
  if (error && !["PGRST205", "42P01"].includes(error.code)) throw error;
  return (data ?? []) as T;
}

async function must<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T;
}

const loadRules = async (supabase: SupabaseClient) => (await must<{ rules: HrRules }[]>(supabase.from("hr_settings").select("rules")))[0].rules;
const monthRate = async (supabase: SupabaseClient, period: string) => {
  const { data } = await supabase.from("payroll_months").select("usd_to_pkr").eq("period", `${period}-01`).maybeSingle();
  return data ? num(data.usd_to_pkr) : null;
};
const isFinalized = async (supabase: SupabaseClient, period: string) => {
  const { data } = await supabase.from("payroll_runs").select("id").eq("period", `${period}-01`).maybeSingle();
  return Boolean(data);
};

/** Everything money-related for one month, from the month's records. Reads only; a finalized month's frozen copy lives in payroll_lines. */
export async function monthFigures(supabase: SupabaseClient, period: string) {
  const { start, end } = bounds(period);
  const days = workingDays(period);
  const firstDay = `${period}-01`;
  const lastDay = dayOf(new Date(new Date(end).getTime() - 86_400_000).toISOString());
  const [rules, rate, peopleRows, records, attendance, costs, departments, paidInvoices, dispatchPaid, qualified] = await Promise.all([
    loadRules(supabase), monthRate(supabase, period),
    must<any[]>(supabase.from("profiles").select("id, full_name, role, department_id, is_active, created_at, departments!profiles_department_id_fkey(id, name, business_unit, function)").in("role", ["AGENT", "MANAGER"])),
    must<any[]>(supabase.from("employee_records").select("*")),
    must<any[]>(supabase.from("attendance_records").select("user_id, work_date, status").gte("work_date", firstDay).lte("work_date", lastDay)),
    must<any[]>(supabase.from("department_costs").select("*").eq("period", firstDay)),
    must<any[]>(supabase.from("departments").select("id, name, business_unit, function")),
    must<any[]>(supabase.from("brokerage_invoices").select("id, shipment_id, department_id, paid_at").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
    optional<any[]>(supabase.from("dispatch_invoices").select("id, invoice_number, truck_id, amount_paid, paid_at, sales_agent_id, sales_department_id, dispatcher_id, dispatch_department_id, dispatch_carriers(company_name)").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
    optional<any[]>(supabase.from("fronter_prospects").select("id, company_name, created_by, department_id, qualified_at").not("qualified_at", "is", null).gte("qualified_at", start).lt("qualified_at", end)),
  ]);

  // Brokerage: the margin on each load paid in the month. A load without both rates counts as 0 until they are entered.
  const shipmentIds = [...new Set(paidInvoices.map((invoice) => invoice.shipment_id))];
  const shipments = shipmentIds.length ? await must<any[]>(supabase.from("brokerage_shipments").select("id, reference_number, customer_name, customer_id, sales_department_id, operations_department_id, assigned_to, amount_agreed, carrier_rate, status, sales_status").in("id", shipmentIds)) : [];
  const shipmentById = new Map(shipments.map((shipment) => [shipment.id, shipment]));
  const customerIds = [...new Set(shipments.map((shipment) => shipment.customer_id).filter(Boolean))];
  const [customers, transfers] = customerIds.length ? await Promise.all([
    must<any[]>(supabase.from("brokerage_customers").select("id, owner_id").in("id", customerIds)),
    must<any[]>(supabase.from("ownership_transfers").select("customer_id, from_user, transferred_at").in("customer_id", customerIds).order("transferred_at")),
  ]) : [[], []];
  const ownerNow = new Map(customers.map((customer) => [customer.id, customer.owner_id as string]));
  /** Who owned the customer when it paid: reassigning a leaver's customers must not move commission they already earned. */
  const ownerAt = (customerId: string, when: string) => transfers.find((row) => row.customer_id === customerId && row.transferred_at > when)?.from_user ?? ownerNow.get(customerId);
  const margins = paidInvoices.flatMap((invoice) => {
    const shipment = shipmentById.get(invoice.shipment_id);
    if (!shipment || shipment.status === "CANCELLED" || shipment.sales_status === "CANCELLED") return [];
    const priced = shipment.amount_agreed != null && shipment.carrier_rate != null;
    return [{ invoice, shipment, margin: priced ? round(num(shipment.amount_agreed) - num(shipment.carrier_rate)) : 0 }];
  });

  // Active sale: a truck that paid its first invoice in the month.
  const truckIds = [...new Set(dispatchPaid.map((invoice) => invoice.truck_id))];
  const earlier = truckIds.length ? await optional<any[]>(supabase.from("dispatch_invoices").select("truck_id").eq("status", "PAID").lt("paid_at", start).in("truck_id", truckIds)) : [];
  const paidBefore = new Set(earlier.map((invoice) => invoice.truck_id));
  const firstPaid = new Map<string, any>();
  for (const invoice of [...dispatchPaid].sort((a, b) => a.paid_at.localeCompare(b.paid_at))) if (!paidBefore.has(invoice.truck_id) && !firstPaid.has(invoice.truck_id)) firstPaid.set(invoice.truck_id, invoice);

  const recordOf = new Map(records.map((record) => [record.user_id, record]));
  const daysOff = (userId: string, status: string) => attendance.filter((row) => row.user_id === userId && row.status === status).map((row) => row.work_date as string);
  const toUsd = (pkr: number) => rate ? round(pkr / rate) : 0;
  const toPkr = (usd: number) => rate ? round(usd * rate) : 0;
  const lines: PayrollLine[] = [];

  for (const person of peopleRows) {
    const record = recordOf.get(person.id);
    const leaving = record?.last_working_day as string | null ?? null;
    const joinedOn: string = record?.joined_on ?? dayOf(person.created_at);
    if (joinedOn > lastDay || (leaving && leaving < firstDay)) continue;
    if (!person.is_active && !leaving) continue;
    const department = oneOf<any>(person.departments);
    const roleKey = roleKeyFor(person.role, department);
    if (!roleKey) continue;
    const exitType = (record?.exit_type ?? null) as ExitType | null;
    const variable = earnsVariablePay(exitType);
    const counts = (date: string | null) => !leaving || dayOf(date) <= leaving;
    const pay = basePay({ base: num(record?.base_salary_pkr), period, joinedOn, lastWorkingDay: leaving, leaveDays: daysOff(person.id, "LEAVE"), absentDays: daysOff(person.id, "ABSENT"), paidLeaves: rules.paid_leaves_per_month });

    let items: Item[] = [];
    let activeSales: number | null = null;
    let qualifiedLeads: number | null = null;
    const dispatchItem = (invoice: any): Item => ({ reference: invoice.invoice_number, customer: oneOf<any>(invoice.dispatch_carriers)?.company_name ?? null, amount: num(invoice.amount_paid), date: invoice.paid_at });
    const brokerageItem = (row: (typeof margins)[number]): Item => ({ reference: row.shipment.reference_number, customer: row.shipment.customer_name, amount: row.margin, date: row.invoice.paid_at });
    if (roleKey === "DISPATCH_SALES_AGENT") {
      items = dispatchPaid.filter((invoice) => invoice.sales_agent_id === person.id && counts(invoice.paid_at)).map(dispatchItem);
      activeSales = [...firstPaid.values()].filter((invoice) => invoice.sales_agent_id === person.id && counts(invoice.paid_at)).length;
    } else if (roleKey === "DISPATCHER") {
      items = dispatchPaid.filter((invoice) => invoice.dispatcher_id === person.id && counts(invoice.paid_at)).map(dispatchItem);
    } else if (roleKey === "BROKERAGE_SALES_AGENT" || roleKey === "BROKERAGE_FRONTER_MANAGER") {
      // Client decision: Fronter Managers are paid as Brokerage Sales Agents, on their own customers' loads.
      items = margins.filter((row) => ownerAt(row.shipment.customer_id, row.invoice.paid_at) === person.id && counts(row.invoice.paid_at)).map(brokerageItem);
    } else if (roleKey === "BROKERAGE_OPERATIONS_AGENT") {
      items = margins.filter((row) => row.shipment.assigned_to === person.id && counts(row.invoice.paid_at)).map(brokerageItem);
    } else if (roleKey === "BROKERAGE_FRONTER_AGENT") {
      items = qualified.filter((prospect) => prospect.created_by === person.id && counts(prospect.qualified_at)).map((prospect) => ({ reference: prospect.company_name ?? "Lead", customer: null, amount: rules.fronter_per_lead_pkr, date: prospect.qualified_at }));
      qualifiedLeads = items.length;
    }
    const gross = round(items.reduce((sum, item) => sum + item.amount, 0));
    const earned = !variable ? { rate: 0, commissionable: 0, commission: 0 }
      : roleKey === "DISPATCH_SALES_AGENT" ? dispatchSalesCommission(gross, activeSales ?? 0, rules.dispatch_sales)
      : roleKey === "DISPATCHER" ? tieredCommission(gross, rules.dispatcher.tiers)
      : roleKey === "BROKERAGE_SALES_AGENT" || roleKey === "BROKERAGE_FRONTER_MANAGER" ? tieredCommission(gross, rules.brokerage_sales.tiers)
      : roleKey === "BROKERAGE_OPERATIONS_AGENT" ? tieredCommission(gross, rules.brokerage_operations.tiers)
      : { rate: 0, commissionable: 0, commission: 0 };
    const fronterPkr = roleKey === "BROKERAGE_FRONTER_AGENT" && variable ? gross : 0;
    const commissionUsd = fronterPkr ? toUsd(fronterPkr) : earned.commission;
    const commissionPkr = fronterPkr || toPkr(earned.commission);
    const probationEnds = dayOf(new Date(Date.UTC(+joinedOn.slice(0, 4), +joinedOn.slice(5, 7), +joinedOn.slice(8, 10))).toISOString());
    lines.push({
      user_id: person.id, full_name: person.full_name, role_key: roleKey, department_id: person.department_id, department_name: department?.name ?? null,
      base_salary: num(record?.base_salary_pkr), commission_basis: "HR_RULES", commission_rate: earned.rate, basis_amount: earned.commissionable, commission_amount: commissionUsd,
      total: 0, configured: num(record?.base_salary_pkr) > 0, items,
      detail: {
        usd_to_pkr: rate, joined_on: joinedOn, last_working_day: leaving, exit_type: exitType, on_probation: today() < probationEnds,
        working_days: pay.working_days, employed_days: pay.employed_days, days_worked: pay.days_worked, leave_days: pay.leave_days, absent_days: pay.absent_days, paid_leave_used: pay.paid_leave_used, unpaid_absences: pay.unpaid_absences,
        base_earned: pay.base_earned, leave_deduction: pay.leave_deduction, gross, active_sales: activeSales, qualified_leads: qualifiedLeads,
        commission_usd: commissionUsd, commission_pkr: commissionPkr, profit_share_percent: 0, profit_share_usd: 0, profit_share_pkr: 0, net_pay_pkr: 0, net_pay_usd: null,
      },
    });
  }

  // Department P&L. Dispatch and Brokerage income is counted for both the Sales and the Operations department it passed through.
  const earnings: { department_id: string; person: string | null; amount: number }[] = [];
  const add = (departmentId: string | null | undefined, person: string | null | undefined, amount: number) => { if (departmentId) earnings.push({ department_id: departmentId, person: person ?? null, amount }); };
  for (const invoice of dispatchPaid) { add(invoice.sales_department_id, invoice.sales_agent_id, num(invoice.amount_paid)); add(invoice.dispatch_department_id, invoice.dispatcher_id, num(invoice.amount_paid)); }
  for (const { invoice, shipment, margin } of margins) { add(shipment.sales_department_id, ownerAt(shipment.customer_id, invoice.paid_at), margin); add(invoice.department_id ?? shipment.operations_department_id, shipment.assigned_to, margin); }
  const headcount = new Map<string, number>();
  for (const line of lines) if (line.department_id) headcount.set(line.department_id, (headcount.get(line.department_id) ?? 0) + 1);
  const costShares = costs.map((cost) => ({ name: cost.name as string, shares: allocateCost({ amount: cost.currency === "PKR" ? toUsd(num(cost.amount)) : num(cost.amount), cost_type: cost.cost_type as CostType, department_ids: cost.department_ids }, headcount) }));

  // With two managers in a department, each manager and their team has a P&L of their own.
  const managersIn = (departmentId: string) => lines.filter((line) => line.department_id === departmentId && line.role_key in rules.manager_share);
  const teamKey = (departmentId: string, person: string | null) => {
    const managers = managersIn(departmentId);
    if (managers.length < 2) return "department";
    if (managers.some((manager) => manager.user_id === person)) return person!;
    const chosen = recordOf.get(person ?? "")?.manager_id;
    return managers.some((manager) => manager.user_id === chosen) ? chosen as string : "unassigned";
  };
  const departmentPl: DepartmentPl[] = departments.filter((department) => headcount.has(department.id) || earnings.some((row) => row.department_id === department.id)).flatMap((department) => {
    const managers = managersIn(department.id);
    const teams = managers.length < 2 ? ["department"] : [...managers.map((manager) => manager.user_id), "unassigned"];
    return teams.flatMap((team) => {
      const staff = lines.filter((line) => line.department_id === department.id && teamKey(department.id, line.user_id) === team);
      const teamIncome = round(earnings.filter((row) => row.department_id === department.id && teamKey(department.id, row.person) === team).reduce((sum, row) => sum + row.amount, 0));
      if (team === "unassigned" && !staff.length && !teamIncome) return [];
      const weight = team === "department" ? 1 : staff.length / (headcount.get(department.id) ?? 1);
      const salaries = toUsd(staff.reduce((sum, line) => sum + line.detail.base_earned - line.detail.leave_deduction, 0));
      const commissions = round(staff.reduce((sum, line) => sum + line.detail.commission_usd, 0));
      const charged = costShares.flatMap((cost) => cost.shares.has(department.id) && weight ? [{ name: cost.name, amount: round(cost.shares.get(department.id)! * weight) }] : []);
      const otherCosts = round(charged.reduce((sum, cost) => sum + cost.amount, 0));
      const totalCosts = round(salaries + commissions + otherCosts);
      const manager = managers.find((row) => row.user_id === team);
      const name = team === "department" ? department.name : `${department.name} · ${manager?.full_name ?? "No manager set"}`;
      return [{ department_id: department.id, manager_id: manager?.user_id ?? null, unassigned: team === "unassigned", name, business_unit: department.business_unit, function: department.function, people: staff.length, income: teamIncome, salaries, commissions, costs: charged, other_costs: otherCosts, total_costs: totalCosts, net_profit: round(teamIncome - totalCosts), manager_share_percent: 0, manager_share: 0 }];
    });
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Profit share, then each person's net pay.
  for (const pl of departmentPl) {
    if (pl.unassigned) continue;
    const manager = managersIn(pl.department_id).find((line) => (!pl.manager_id || line.user_id === pl.manager_id) && earnsVariablePay(line.detail.exit_type));
    if (!manager) continue;
    const share = rules.manager_share[manager.role_key as keyof HrRules["manager_share"]];
    const amount = profitShare(pl.net_profit, share);
    pl.manager_share_percent = share; pl.manager_share = amount;
    manager.detail.profit_share_percent = share; manager.detail.profit_share_usd = amount; manager.detail.profit_share_pkr = toPkr(amount);
  }
  for (const line of lines) {
    const { detail } = line;
    detail.net_pay_pkr = round(detail.base_earned - detail.leave_deduction + detail.commission_pkr + detail.profit_share_pkr);
    detail.net_pay_usd = rate ? toUsd(detail.net_pay_pkr) : null;
    line.total = detail.net_pay_pkr;
  }
  lines.sort((a, b) => (a.department_name ?? "").localeCompare(b.department_name ?? "") || b.total - a.total);
  const departmentIncome = (line: PayrollLine) => departmentPl.find((row) => row.manager_id === line.user_id)?.income ?? round(earnings.filter((row) => row.department_id === line.department_id).reduce((sum, row) => sum + row.amount, 0));
  return { rules, rate, lines, departments: departmentPl, departmentIncome, teamKey };
}

type SummaryLine = Pick<PayrollLine, "department_id" | "department_name" | "base_salary" | "commission_amount" | "total"> & { detail?: LineDetail | null };
function summarize(lines: SummaryLine[]) {
  const departments = new Map<string, { department_id: string | null; name: string; people: number; base: number; commission: number; total: number; total_usd: number }>();
  for (const line of lines) {
    const key = line.department_id ?? "none";
    const row = departments.get(key) ?? { department_id: line.department_id, name: line.department_name ?? "No department", people: 0, base: 0, commission: 0, total: 0, total_usd: 0 };
    const { detail } = line;
    // A month finalized before these rules has no detail: its lines are a plain base + commission.
    row.people += 1;
    row.base = round(row.base + (detail ? detail.base_earned - detail.leave_deduction : num(line.base_salary)));
    row.commission = round(row.commission + (detail ? detail.commission_pkr + detail.profit_share_pkr : num(line.commission_amount)));
    row.total = round(row.total + num(line.total));
    row.total_usd = round(row.total_usd + (detail ? detail.net_pay_usd ?? 0 : num(line.total)));
    departments.set(key, row);
  }
  const all = [...departments.values()];
  const sum = (key: "base" | "commission" | "total" | "total_usd") => round(all.reduce((total, row) => total + row[key], 0));
  return { totals: { people: lines.length, base: sum("base"), commission: sum("commission"), total: sum("total"), total_usd: sum("total_usd") }, departments: all.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Finalized lines when the month is closed, otherwise the live draft. */
async function payrollFor(supabase: SupabaseClient, period: string) {
  const { data: run } = await supabase.from("payroll_runs").select("id, finalized_at, finalized_by, totals, usd_to_pkr").eq("period", `${period}-01`).maybeSingle();
  if (run) {
    const lines = await must<any[]>(supabase.from("payroll_lines").select("*").eq("run_id", run.id).order("department_name").order("total", { ascending: false }));
    const { data: finalizer } = await supabase.from("profiles").select("full_name").eq("id", run.finalized_by).maybeSingle();
    return { status: "FINALIZED" as const, finalized_at: run.finalized_at, finalized_by_name: finalizer?.full_name ?? null, usd_to_pkr: run.usd_to_pkr == null ? null : num(run.usd_to_pkr), department_pl: ((run.totals as any)?.department_pl ?? []) as DepartmentPl[], lines: lines.map((line) => ({ ...line, base_salary: num(line.base_salary), commission_rate: num(line.commission_rate), basis_amount: num(line.basis_amount), commission_amount: num(line.commission_amount), total: num(line.total) })) as PayrollLine[] };
  }
  const figures = await monthFigures(supabase, period);
  return { status: "DRAFT" as const, finalized_at: null, finalized_by_name: null, usd_to_pkr: figures.rate, department_pl: figures.departments, lines: figures.lines };
}

/** The figures an employee or manager may see: progress, never salary, commission or profit-share amounts. */
function progressOf(line: PayrollLine, rules: HrRules, departmentIncome: number) {
  const tierList: Tier[] | null = line.role_key === "DISPATCHER" ? rules.dispatcher.tiers : line.role_key === "BROKERAGE_SALES_AGENT" || line.role_key === "BROKERAGE_FRONTER_MANAGER" ? rules.brokerage_sales.tiers : line.role_key === "BROKERAGE_OPERATIONS_AGENT" ? rules.brokerage_operations.tiers : null;
  const base = { user_id: line.user_id, full_name: line.full_name, role_key: line.role_key, department_name: line.department_name, gross: line.detail.gross, active_sales: line.detail.active_sales, qualified_leads: line.detail.qualified_leads };
  if (tierList) {
    const tier = tierFor(line.detail.gross, tierList);
    return { ...base, target: tier.target, rate: tier.rate, reached: tier.reached, next_level: tier.next?.from ?? null, next_rate: tier.next?.rate ?? null, to_next: tier.next ? round(tier.next.from - line.detail.gross) : null };
  }
  if (line.role_key === "DISPATCH_SALES_AGENT") {
    const target = rules.dispatch_sales.min_active_sales;
    const met = (line.detail.active_sales ?? 0) >= target;
    return { ...base, target: null, active_sales_target: target, rate: met ? rules.dispatch_sales.rate : 0, reached: met, next_level: null, next_rate: met ? null : rules.dispatch_sales.rate, to_next: null, sales_to_target: Math.max(0, target - (line.detail.active_sales ?? 0)) };
  }
  if (line.role_key.endsWith("MANAGER")) return { ...base, gross: departmentIncome, target: null, rate: null, reached: true, next_level: null, next_rate: null, to_next: null };
  return { ...base, target: null, rate: null, reached: true, next_level: null, next_rate: null, to_next: null };
}

/** Moves everything a leaver looks after to a colleague. Nothing is deleted; finished loads stay on their records. */
async function reassignWork(supabase: SupabaseClient, from: string, to: string) {
  const customers = await must<any[]>(supabase.from("brokerage_customers").select("id").eq("owner_id", from));
  if (customers.length) await must(supabase.from("ownership_transfers").insert(customers.map((customer) => ({ customer_id: customer.id, from_user: from, to_user: to }))));
  await Promise.all([
    must(supabase.from("sales_leads").update({ owner_id: to }).eq("owner_id", from)),
    must(supabase.from("brokerage_customers").update({ owner_id: to }).eq("owner_id", from)),
    must(supabase.from("brokerage_customers").update({ operations_agent_id: to }).eq("operations_agent_id", from)),
    must(supabase.from("brokerage_shipments").update({ assigned_to: to }).eq("assigned_to", from).not("status", "in", "(COMPLETED,CANCELLED)")),
    optional(supabase.from("fronter_prospects").update({ assigned_to: to }).eq("assigned_to", from)),
    optional(supabase.from("dispatch_carriers").update({ owner_id: to }).eq("owner_id", from)),
    optional(supabase.from("dispatch_trucks").update({ assigned_to: to }).eq("assigned_to", from)),
  ]);
}

/** Removes the login once someone's last working day has passed. */
async function removeLeaverLogins(supabase: SupabaseClient, clearAccessCache: Deps["clearAccessCache"]) {
  const gone = await must<any[]>(supabase.from("employee_records").select("user_id").lt("last_working_day", today()));
  if (!gone.length) return;
  const ids = gone.map((row) => row.user_id);
  const active = await must<any[]>(supabase.from("profiles").select("id").in("id", ids).eq("is_active", true));
  if (!active.length) return;
  await must(supabase.from("profiles").update({ is_active: false }).in("id", active.map((row) => row.id)));
  for (const row of active) clearAccessCache(row.id);
}

async function financeFor(supabase: SupabaseClient, period: string) {
  const { start, end } = bounds(period);
  const [issued, paid, approvedQuotes, payroll, dispatchIssued, dispatchPaid] = await Promise.all([
    must<any[]>(supabase.from("brokerage_invoices").select("amount, department_id").gte("issued_at", start).lt("issued_at", end)),
    must<any[]>(supabase.from("brokerage_invoices").select("amount_paid, department_id").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
    must<any[]>(supabase.from("sales_quotes").select("id").in("stage", ["APPROVED", "HANDED_OFF"]).gte("reviewed_at", start).lt("reviewed_at", end)),
    payrollFor(supabase, period),
    // Dispatch weekly invoices count when forwarded to accounting, collections when paid.
    optional<any[]>(supabase.from("dispatch_invoices").select("amount, sales_department_id, dispatch_department_id").neq("status", "CANCELLED").not("forwarded_at", "is", null).gte("forwarded_at", start).lt("forwarded_at", end)),
    optional<any[]>(supabase.from("dispatch_invoices").select("amount_paid, sales_department_id, dispatch_department_id").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
  ]);
  const approved = approvedQuotes.length ? (await must<any[]>(supabase.from("brokerage_shipments").select("amount_agreed, amount_quoted, sales_department_id, status, sales_status").in("quote_id", approvedQuotes.map((quote) => quote.id)))).filter((row) => row.status !== "CANCELLED" && row.sales_status !== "CANCELLED") : [];
  const summary = summarize(payroll.lines);
  return {
    period,
    invoiced: round(issued.reduce((s, i) => s + num(i.amount), 0) + dispatchIssued.reduce((s, i) => s + num(i.amount), 0)),
    collected: round(paid.reduce((s, i) => s + num(i.amount_paid), 0) + dispatchPaid.reduce((s, i) => s + num(i.amount_paid), 0)),
    dispatch_invoiced: round(dispatchIssued.reduce((s, i) => s + num(i.amount), 0)),
    dispatch_collected: round(dispatchPaid.reduce((s, i) => s + num(i.amount_paid), 0)),
    dispatchIssued, dispatchPaid,
    approved_gross: round(approved.reduce((s, x) => s + num(x.amount_agreed ?? x.amount_quoted), 0)),
    payroll: summary.totals.total_usd,
    payroll_status: payroll.status,
    issued, paid, approved, summary,
  };
}

export function registerPayrollRoutes(app: Express, { adminClient, requireSuperAdmin, requireBrokerageUser, clearAccessCache, writeAudit }: Deps) {
  const actorId = (request: Request) => (request as Request & { actor?: { id: string } }).actor!.id;
  const lockedMessage = "This month is finalized. Reopen payroll to change it.";

  const sweep = () => removeLeaverLogins(adminClient(), clearAccessCache).catch((error) => console.error("Leaver login sweep failed", error));
  void sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();

  // ---- Commission rules: every amount, percentage and target ----
  app.get("/api/v1/admin/hr/rules", requireSuperAdmin, async (_request, response, next) => {
    try { response.json({ rules: await loadRules(adminClient()) }); } catch (error) { next(error); }
  });

  app.put("/api/v1/admin/hr/rules", requireSuperAdmin, async (request, response, next) => {
    try {
      const rules = rulesSchema.parse(request.body);
      const supabase = adminClient();
      const before = await loadRules(supabase);
      await must(supabase.from("hr_settings").update({ rules, updated_by: actorId(request), updated_at: new Date().toISOString() }).eq("id", true));
      await writeAudit(supabase, actorId(request), "HR_RULES_UPDATED", "hr_settings", actorId(request), { before, after: rules });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Employees: base salary, joining date, exit ----
  app.get("/api/v1/admin/hr/employees", requireSuperAdmin, async (_request, response, next) => {
    try {
      const supabase = adminClient();
      const [people, records] = await Promise.all([
        must<any[]>(supabase.from("profiles").select("id, full_name, email, role, is_active, created_at, department_id, departments!profiles_department_id_fkey(name, business_unit, function)").in("role", ["AGENT", "MANAGER"]).order("full_name")),
        must<any[]>(supabase.from("employee_records").select("*")),
      ]);
      const recordOf = new Map(records.map((record) => [record.user_id, record]));
      const employees = people.flatMap((person) => {
        const department = oneOf<any>(person.departments);
        const roleKey = roleKeyFor(person.role, department);
        if (!roleKey) return [];
        const record = recordOf.get(person.id);
        return [{ id: person.id, full_name: person.full_name, email: person.email, is_active: person.is_active, department_id: person.department_id, department_name: department?.name ?? null, role_key: roleKey, base_salary_pkr: num(record?.base_salary_pkr), configured: num(record?.base_salary_pkr) > 0, joined_on: record?.joined_on ?? dayOf(person.created_at), manager_id: record?.manager_id ?? null, last_working_day: record?.last_working_day ?? null, exit_type: record?.exit_type ?? null }];
      });
      response.json({ employees });
    } catch (error) { next(error); }
  });

  const staffMember = async (supabase: SupabaseClient, userId: string) => {
    const { data } = await supabase.from("profiles").select("id, role, department_id").eq("id", userId).maybeSingle();
    return data && ["AGENT", "MANAGER"].includes(data.role) ? data : null;
  };

  app.put("/api/v1/admin/hr/employees/:id", requireSuperAdmin, async (request, response, next) => {
    try {
      const userId = z.string().uuid().parse(request.params.id);
      const input = employeeSchema.parse(request.body);
      const supabase = adminClient();
      const person = await staffMember(supabase, userId);
      if (!person) return response.status(404).json({ error: "Staff member not found." });
      if (input.manager_id) {
        const { data: manager } = await supabase.from("profiles").select("id").eq("id", input.manager_id).eq("role", "MANAGER").eq("department_id", person.department_id).maybeSingle();
        if (!manager) return response.status(422).json({ error: "Choose a manager in the same department." });
      }
      const { data: before } = await supabase.from("employee_records").select("base_salary_pkr, joined_on, manager_id").eq("user_id", userId).maybeSingle();
      await must(supabase.from("employee_records").upsert({ user_id: userId, ...input, updated_by: actorId(request), updated_at: new Date().toISOString() }));
      await writeAudit(supabase, actorId(request), "EMPLOYEE_PAY_UPDATED", "profile", userId, { before, after: input });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/admin/hr/employees/:id/exit", requireSuperAdmin, async (request, response, next) => {
    try {
      const userId = z.string().uuid().parse(request.params.id);
      const input = exitSchema.parse(request.body);
      const supabase = adminClient();
      const person = await staffMember(supabase, userId);
      if (!person) return response.status(404).json({ error: "Staff member not found." });
      if (await isFinalized(supabase, input.last_working_day.slice(0, 7))) return response.status(409).json({ error: lockedMessage });
      if (input.reassign_to) {
        const { data: colleague } = await supabase.from("profiles").select("id").eq("id", input.reassign_to).eq("department_id", person.department_id).eq("is_active", true).neq("id", userId).maybeSingle();
        if (!colleague) return response.status(422).json({ error: "Choose an active colleague in the same department." });
      }
      await must(supabase.from("employee_records").upsert({ user_id: userId, last_working_day: input.last_working_day, exit_type: input.exit_type, updated_by: actorId(request), updated_at: new Date().toISOString() }));
      if (input.reassign_to) await reassignWork(supabase, userId, input.reassign_to);
      await writeAudit(supabase, actorId(request), "EMPLOYEE_EXIT_RECORDED", "profile", userId, input);
      await sweep();
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/admin/hr/employees/:id/exit", requireSuperAdmin, async (request, response, next) => {
    try {
      const userId = z.string().uuid().parse(request.params.id);
      const supabase = adminClient();
      await must(supabase.from("employee_records").update({ last_working_day: null, exit_type: null, updated_by: actorId(request), updated_at: new Date().toISOString() }).eq("user_id", userId));
      await writeAudit(supabase, actorId(request), "EMPLOYEE_EXIT_CANCELLED", "profile", userId);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  // ---- Attendance: managers record their own department, the Super Admin everyone. No row means Present. ----
  app.get("/api/v1/attendance", requireBrokerageUser, async (request, response, next) => {
    try {
      const actor = (request as Request & { actor?: Actor }).actor!;
      if (!["MANAGER", "SUPER_ADMIN"].includes(actor.role)) return response.status(403).json({ error: "Only managers record attendance." });
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const supabase = adminClient();
      const days = workingDays(period);
      let query = supabase.from("profiles").select("id, full_name, role, department_id, is_active, created_at, departments!profiles_department_id_fkey(name, business_unit, function)").in("role", ["AGENT", "MANAGER"]).order("full_name");
      if (actor.role === "MANAGER") query = query.eq("department_id", actor.department_id!).neq("id", actor.id);
      const [people, employeeRecords, records, rules, locked] = await Promise.all([
        must<any[]>(query),
        must<any[]>(supabase.from("employee_records").select("user_id, joined_on, last_working_day")),
        must<any[]>(supabase.from("attendance_records").select("user_id, work_date, status").gte("work_date", days[0]).lte("work_date", days[days.length - 1])),
        loadRules(supabase), isFinalized(supabase, period),
      ]);
      const recordOf = new Map(employeeRecords.map((record) => [record.user_id, record]));
      const staff = people.flatMap((person) => {
        const department = oneOf<any>(person.departments);
        if (!roleKeyFor(person.role, department)) return [];
        const record = recordOf.get(person.id);
        const joinedOn: string = record?.joined_on ?? dayOf(person.created_at);
        const lastDay: string | null = record?.last_working_day ?? null;
        if (joinedOn > days[days.length - 1] || (lastDay && lastDay < days[0]) || (!person.is_active && !lastDay)) return [];
        return [{ id: person.id, full_name: person.full_name, department_name: department?.name ?? null, joined_on: joinedOn, last_working_day: lastDay }];
      });
      const ids = new Set(staff.map((person) => person.id));
      response.json({ period, days, people: staff, records: records.filter((row) => ids.has(row.user_id)), locked, paid_leaves: rules.paid_leaves_per_month });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/attendance", requireBrokerageUser, async (request, response, next) => {
    try {
      const actor = (request as Request & { actor?: Actor }).actor!;
      const input = attendanceSchema.parse(request.body);
      const supabase = adminClient();
      const { data: target } = await supabase.from("profiles").select("id, department_id").eq("id", input.user_id).maybeSingle();
      const allowed = actor.role === "SUPER_ADMIN" || (actor.role === "MANAGER" && target?.department_id === actor.department_id && target?.id !== actor.id);
      if (!target || !allowed) return response.status(403).json({ error: "You can't record attendance for this person." });
      if (!workingDays(input.date.slice(0, 7)).includes(input.date)) return response.status(422).json({ error: "Attendance is recorded for Monday to Friday only." });
      if (await isFinalized(supabase, input.date.slice(0, 7))) return response.status(409).json({ error: lockedMessage });
      const { data: before } = await supabase.from("attendance_records").select("status").eq("user_id", input.user_id).eq("work_date", input.date).maybeSingle();
      if (input.status === "PRESENT") await must(supabase.from("attendance_records").delete().eq("user_id", input.user_id).eq("work_date", input.date));
      else await must(supabase.from("attendance_records").upsert({ user_id: input.user_id, work_date: input.date, status: input.status, recorded_by: actor.id, updated_at: new Date().toISOString() }));
      await writeAudit(supabase, actor.id, "ATTENDANCE_UPDATED", "profile", input.user_id, { date: input.date, from: before?.status ?? "PRESENT", to: input.status });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Monthly costs and the department P&L ----
  app.get("/api/v1/admin/costs", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const supabase = adminClient();
      const [costs, departments, payroll] = await Promise.all([
        must<any[]>(supabase.from("department_costs").select("*").eq("period", `${period}-01`).order("created_at")),
        must<any[]>(supabase.from("departments").select("id, name").eq("is_active", true).order("name")),
        payrollFor(supabase, period),
      ]);
      response.json({ period, locked: payroll.status === "FINALIZED", usd_to_pkr: payroll.usd_to_pkr, costs: costs.map((cost) => ({ ...cost, amount: num(cost.amount) })), departments, department_pl: payroll.department_pl });
    } catch (error) { next(error); }
  });

  const costRow = (input: z.infer<typeof costSchema>) => ({ ...input, period: `${input.period}-01` });

  app.post("/api/v1/admin/costs", requireSuperAdmin, async (request, response, next) => {
    try {
      const input = costSchema.parse(request.body);
      const supabase = adminClient();
      if (await isFinalized(supabase, input.period)) return response.status(409).json({ error: lockedMessage });
      const { data, error } = await supabase.from("department_costs").insert({ ...costRow(input), created_by: actorId(request) }).select("id").single();
      if (error) throw error;
      await writeAudit(supabase, actorId(request), "COST_ADDED", "department_cost", data.id, input);
      response.status(201).json({ ok: true });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/admin/costs/:id", requireSuperAdmin, async (request, response, next) => {
    try {
      const costId = z.string().uuid().parse(request.params.id);
      const input = costSchema.parse(request.body);
      const supabase = adminClient();
      const { data: before } = await supabase.from("department_costs").select("*").eq("id", costId).maybeSingle();
      if (!before) return response.status(404).json({ error: "Cost not found." });
      if (await isFinalized(supabase, before.period.slice(0, 7)) || await isFinalized(supabase, input.period)) return response.status(409).json({ error: lockedMessage });
      await must(supabase.from("department_costs").update({ ...costRow(input), updated_at: new Date().toISOString() }).eq("id", costId));
      await writeAudit(supabase, actorId(request), "COST_UPDATED", "department_cost", costId, { before, after: input });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/admin/costs/:id", requireSuperAdmin, async (request, response, next) => {
    try {
      const costId = z.string().uuid().parse(request.params.id);
      const supabase = adminClient();
      const { data: before } = await supabase.from("department_costs").select("*").eq("id", costId).maybeSingle();
      if (!before) return response.status(404).json({ error: "Cost not found." });
      if (await isFinalized(supabase, before.period.slice(0, 7))) return response.status(409).json({ error: lockedMessage });
      await must(supabase.from("department_costs").delete().eq("id", costId));
      await writeAudit(supabase, actorId(request), "COST_REMOVED", "department_cost", costId, { before });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  // ---- Monthly payroll ----
  app.get("/api/v1/admin/payroll", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const payroll = await payrollFor(adminClient(), period);
      response.json({ period, ...payroll, ...summarize(payroll.lines) });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/admin/payroll/:period/rate", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.params.period);
      const { usd_to_pkr } = z.object({ usd_to_pkr: z.number().positive().max(100_000) }).strict().parse(request.body);
      const supabase = adminClient();
      if (await isFinalized(supabase, period)) return response.status(409).json({ error: lockedMessage });
      const before = await monthRate(supabase, period);
      await must(supabase.from("payroll_months").upsert({ period: `${period}-01`, usd_to_pkr, updated_by: actorId(request), updated_at: new Date().toISOString() }));
      await writeAudit(supabase, actorId(request), "PAYROLL_RATE_UPDATED", "payroll", actorId(request), { period, from: before, to: usd_to_pkr });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/admin/payroll/:period/finalize", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.params.period);
      if (period > currentPeriod()) return response.status(422).json({ error: "A future month can't be finalized." });
      const supabase = adminClient();
      if (await isFinalized(supabase, period)) return response.status(409).json({ error: "This month is already finalized." });
      const figures = await monthFigures(supabase, period);
      if (!figures.rate) return response.status(422).json({ error: "Enter the month's USD to PKR rate first." });
      const { lines } = figures;
      const { totals } = summarize(lines);
      const { data: run, error } = await supabase.from("payroll_runs").insert({ period: `${period}-01`, finalized_by: actorId(request), totals: { ...totals, department_pl: figures.departments }, usd_to_pkr: figures.rate }).select("id").single();
      if (error || !run) throw error;
      if (lines.length) {
        const { error: linesError } = await supabase.from("payroll_lines").insert(lines.map((line) => ({ ...line, run_id: run.id })));
        if (linesError) { await supabase.from("payroll_runs").delete().eq("id", run.id); throw linesError; }
      }
      await writeAudit(supabase, actorId(request), "PAYROLL_FINALIZED", "payroll", run.id, { period, ...totals });
      response.status(201).json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/admin/payroll/:period/reopen", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.params.period);
      const supabase = adminClient();
      const { data: run } = await supabase.from("payroll_runs").select("id").eq("period", `${period}-01`).maybeSingle();
      if (!run) return response.status(404).json({ error: "This month is not finalized." });
      const { error } = await supabase.from("payroll_runs").delete().eq("id", run.id);
      if (error) throw error;
      await writeAudit(supabase, actorId(request), "PAYROLL_REOPENED", "payroll", run.id, { period });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Director finance overview (RP-1) ----
  app.get("/api/v1/admin/finance", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const supabase = adminClient();
      const months = Array.from({ length: 6 }, (_, index) => shiftPeriod(period, index - 5));
      const [current, ...history] = await Promise.all([financeFor(supabase, period), ...months.slice(0, 5).map((month) => financeFor(supabase, month))]);
      const [openInvoices, departments] = await Promise.all([
        must<any[]>(supabase.from("brokerage_invoices").select("amount, amount_paid").not("status", "in", "(PAID,CANCELLED)")),
        must<any[]>(supabase.from("departments").select("id, name, business_unit, function").eq("is_active", true).order("business_unit").order("name")),
      ]);
      const openDispatch = await optional<any[]>(supabase.from("dispatch_invoices").select("amount, amount_paid").in("status", ["SUBMITTED", "FORWARDED"]));
      const byDepartment = departments.map((department) => {
        const sales = department.function === "SALES";
        const payroll = current.summary.departments.find((row) => row.department_id === department.id);
        if (department.business_unit === "DISPATCH") {
          const key = sales ? "sales_department_id" : "dispatch_department_id";
          return {
            id: department.id, name: department.name, function: department.function, business_unit: department.business_unit,
            revenue: round(current.dispatchIssued.filter((i) => i[key] === department.id).reduce((s, i) => s + num(i.amount), 0)),
            collected: round(current.dispatchPaid.filter((i) => i[key] === department.id).reduce((s, i) => s + num(i.amount_paid), 0)),
            payroll: payroll?.total_usd ?? 0, people: payroll?.people ?? 0,
          };
        }
        return { business_unit: department.business_unit,
          id: department.id, name: department.name, function: department.function,
          revenue: sales ? round(current.approved.filter((x) => x.sales_department_id === department.id).reduce((s, x) => s + num(x.amount_agreed ?? x.amount_quoted), 0)) : round(current.issued.filter((i) => i.department_id === department.id).reduce((s, i) => s + num(i.amount), 0)),
          collected: sales ? null : round(current.paid.filter((i) => i.department_id === department.id).reduce((s, i) => s + num(i.amount_paid), 0)),
          payroll: payroll?.total_usd ?? 0, people: payroll?.people ?? 0,
        };
      });
      const point = (f: Awaited<ReturnType<typeof financeFor>>) => ({ period: f.period, invoiced: f.invoiced, collected: f.collected, approved_gross: f.approved_gross, payroll: f.payroll, profit: round(f.collected - f.payroll) });
      response.json({
        period,
        invoiced: current.invoiced, collected: current.collected, approved_gross: current.approved_gross,
        outstanding: round([...openInvoices, ...openDispatch].reduce((s, i) => s + Math.max(0, num(i.amount) - num(i.amount_paid)), 0)),
        dispatch_invoiced: current.dispatch_invoiced, dispatch_collected: current.dispatch_collected,
        payroll: current.payroll, payroll_status: current.payroll_status,
        operating_profit: round(current.collected - current.payroll),
        departments: byDepartment,
        trend: [...history, current].map(point),
      });
    } catch (error) { next(error); }
  });

  // ---- Performance: progress only. Salaries, commission and profit-share amounts never leave the Super Admin's screens. ----
  app.get("/api/v1/me/performance", requireBrokerageUser, async (request, response, next) => {
    try {
      const actor = (request as Request & { actor?: Actor }).actor!;
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const figures = await monthFigures(adminClient(), period);
      const line = figures.lines.find((row) => row.user_id === actor.id);
      response.json({ period, progress: line ? progressOf(line, figures.rules, figures.departmentIncome(line)) : null });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/performance/team", requireBrokerageUser, async (request, response, next) => {
    try {
      const actor = (request as Request & { actor?: Actor }).actor!;
      if (!["MANAGER", "SUPER_ADMIN"].includes(actor.role)) return response.status(403).json({ error: "Only managers see team performance." });
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const figures = await monthFigures(adminClient(), period);
      const lines = figures.lines.filter((line) => actor.role === "SUPER_ADMIN" ? true : line.department_id === actor.department_id && !line.role_key.endsWith("MANAGER") && ["department", actor.id].includes(figures.teamKey(actor.department_id!, line.user_id)));
      response.json({ period, people: lines.map((line) => progressOf(line, figures.rules, figures.departmentIncome(line))) });
    } catch (error) { next(error); }
  });
}
