import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Compensation, payroll and the Director's finance overview (client spec PY-1..PY-5, RP-1).
 *
 * Commission only counts approved or paid records (PY-5):
 *  - APPROVED_GROSS: Sales — gross of shipments whose quote a manager approved in the month;
 *                    Operations — invoices issued in the month (generated on delivery).
 *  - COLLECTED:      payments received in the month (invoices marked Paid).
 * Agents earn on their own records; managers on their whole department.
 */

type Actor = { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null };
type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
type Deps = {
  adminClient: () => SupabaseClient;
  requireSuperAdmin: Handler;
  requireBrokerageUser: Handler;
  writeAudit: (supabase: SupabaseClient, actorId: string, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => Promise<void>;
};

export const roleKeys = ["BROKERAGE_SALES_AGENT", "BROKERAGE_SALES_MANAGER", "BROKERAGE_OPERATIONS_AGENT", "BROKERAGE_OPERATIONS_MANAGER"] as const;
type RoleKey = (typeof roleKeys)[number];
type Basis = "APPROVED_GROSS" | "COLLECTED";
type Setting = { base_salary: number; commission_rate: number; commission_basis: Basis };
type Item = { reference: string; customer: string | null; amount: number; date: string | null };
export type PayrollLine = {
  user_id: string; full_name: string; role_key: RoleKey; department_id: string | null; department_name: string | null;
  base_salary: number; commission_basis: Basis; commission_rate: number; basis_amount: number; commission_amount: number; total: number;
  configured: boolean; items: Item[];
};

const settingSchema = z.object({
  base_salary: z.number().nonnegative().max(10_000_000),
  commission_rate: z.number().min(0).max(100),
  commission_basis: z.enum(["APPROVED_GROSS", "COLLECTED"]),
}).strict();
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the YYYY-MM format.");

const round = (value: number) => Math.round(value * 100) / 100;
const num = (value: unknown) => Number(value ?? 0) || 0;
const currentPeriod = () => new Date().toISOString().slice(0, 7);
const bounds = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(year, month - 1, 1)).toISOString(), end: new Date(Date.UTC(year, month, 1)).toISOString() };
};
const shiftPeriod = (period: string, months: number) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 7);
};

function roleKeyFor(role: string, department?: { business_unit?: string; function?: string } | null): RoleKey | null {
  if (department?.business_unit !== "BROKERAGE" || !["AGENT", "MANAGER"].includes(role)) return null;
  return `BROKERAGE_${department.function === "SALES" ? "SALES" : "OPERATIONS"}_${role}` as RoleKey;
}

async function must<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T;
}

/** Live payroll for one month. Reads only approved/paid records. */
export async function computePayroll(supabase: SupabaseClient, period: string, onlyUserId?: string): Promise<PayrollLine[]> {
  const { start, end } = bounds(period);
  let peopleQuery = supabase.from("profiles").select("id, full_name, role, department_id, is_active, departments!profiles_department_id_fkey(id, name, business_unit, function)").in("role", ["AGENT", "MANAGER"]).eq("is_active", true);
  if (onlyUserId) peopleQuery = peopleQuery.eq("id", onlyUserId);
  const [people, settings, approvedQuotes, issued, paid] = await Promise.all([
    must<any[]>(peopleQuery),
    must<any[]>(supabase.from("compensation_settings").select("role_key, user_id, base_salary, commission_rate, commission_basis")),
    must<any[]>(supabase.from("sales_quotes").select("id, reviewed_at").in("stage", ["APPROVED", "HANDED_OFF"]).gte("reviewed_at", start).lt("reviewed_at", end)),
    must<any[]>(supabase.from("brokerage_invoices").select("id, shipment_id, department_id, amount, issued_at, created_at").gte("issued_at", start).lt("issued_at", end)),
    must<any[]>(supabase.from("brokerage_invoices").select("id, shipment_id, department_id, amount_paid, paid_at").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
  ]);

  const quoteDate = new Map(approvedQuotes.map((quote) => [quote.id, quote.reviewed_at as string]));
  const approvedShipments = quoteDate.size ? await must<any[]>(supabase.from("brokerage_shipments").select("id, quote_id, reference_number, customer_name, customer_id, sales_department_id, amount_agreed, amount_quoted").in("quote_id", [...quoteDate.keys()])) : [];
  const invoiceShipmentIds = [...new Set([...issued, ...paid].map((invoice) => invoice.shipment_id))];
  const invoiceShipments = invoiceShipmentIds.length ? await must<any[]>(supabase.from("brokerage_shipments").select("id, reference_number, customer_name, customer_id, sales_department_id, operations_department_id, assigned_to").in("id", invoiceShipmentIds)) : [];
  const shipmentById = new Map(invoiceShipments.map((shipment) => [shipment.id, shipment]));
  const customerIds = [...new Set([...approvedShipments, ...invoiceShipments].map((shipment) => shipment.customer_id).filter(Boolean))];
  const customers = customerIds.length ? await must<any[]>(supabase.from("brokerage_customers").select("id, owner_id").in("id", customerIds)) : [];
  const ownerOf = new Map(customers.map((customer) => [customer.id, customer.owner_id as string]));

  const roleDefaults = new Map(settings.filter((setting) => setting.role_key).map((setting) => [setting.role_key, setting]));
  const personal = new Map(settings.filter((setting) => setting.user_id).map((setting) => [setting.user_id, setting]));

  const lines: PayrollLine[] = [];
  for (const person of people) {
    const department = Array.isArray(person.departments) ? person.departments[0] : person.departments;
    const roleKey = roleKeyFor(person.role, department);
    if (!roleKey) continue;
    const raw = personal.get(person.id) ?? roleDefaults.get(roleKey);
    const setting: Setting = { base_salary: num(raw?.base_salary), commission_rate: num(raw?.commission_rate), commission_basis: (raw?.commission_basis ?? "APPROVED_GROSS") as Basis };
    const sales = roleKey.startsWith("BROKERAGE_SALES");
    const manager = roleKey.endsWith("MANAGER");
    const items: Item[] = [];

    if (setting.commission_basis === "APPROVED_GROSS" && sales) {
      for (const shipment of approvedShipments) {
        const mine = manager ? shipment.sales_department_id === person.department_id : ownerOf.get(shipment.customer_id) === person.id;
        if (mine) items.push({ reference: shipment.reference_number, customer: shipment.customer_name, amount: num(shipment.amount_agreed ?? shipment.amount_quoted), date: quoteDate.get(shipment.quote_id) ?? null });
      }
    } else {
      const invoices = setting.commission_basis === "APPROVED_GROSS" ? issued : paid;
      for (const invoice of invoices) {
        const shipment = shipmentById.get(invoice.shipment_id);
        if (!shipment) continue;
        const mine = sales
          ? (manager ? shipment.sales_department_id === person.department_id : ownerOf.get(shipment.customer_id) === person.id)
          : (manager ? (invoice.department_id ?? shipment.operations_department_id) === person.department_id : shipment.assigned_to === person.id);
        if (mine) items.push({ reference: shipment.reference_number, customer: shipment.customer_name, amount: num(setting.commission_basis === "APPROVED_GROSS" ? invoice.amount : invoice.amount_paid), date: invoice.issued_at ?? invoice.paid_at ?? invoice.created_at ?? null });
      }
    }

    const basis = round(items.reduce((sum, item) => sum + item.amount, 0));
    const commission = round(basis * setting.commission_rate / 100);
    lines.push({
      user_id: person.id, full_name: person.full_name, role_key: roleKey, department_id: person.department_id, department_name: department?.name ?? null,
      base_salary: round(setting.base_salary), commission_basis: setting.commission_basis, commission_rate: setting.commission_rate,
      basis_amount: basis, commission_amount: commission, total: round(setting.base_salary + commission), configured: Boolean(raw), items,
    });
  }
  return lines.sort((a, b) => (a.department_name ?? "").localeCompare(b.department_name ?? "") || b.total - a.total);
}

function summarize(lines: Pick<PayrollLine, "department_id" | "department_name" | "base_salary" | "commission_amount" | "total">[]) {
  const departments = new Map<string, { department_id: string | null; name: string; people: number; base: number; commission: number; total: number }>();
  for (const line of lines) {
    const key = line.department_id ?? "none";
    const row = departments.get(key) ?? { department_id: line.department_id, name: line.department_name ?? "No department", people: 0, base: 0, commission: 0, total: 0 };
    row.people += 1; row.base = round(row.base + num(line.base_salary)); row.commission = round(row.commission + num(line.commission_amount)); row.total = round(row.total + num(line.total));
    departments.set(key, row);
  }
  const all = [...departments.values()];
  return { totals: { people: lines.length, base: round(all.reduce((s, d) => s + d.base, 0)), commission: round(all.reduce((s, d) => s + d.commission, 0)), total: round(all.reduce((s, d) => s + d.total, 0)) }, departments: all };
}

/** Finalized lines when the month is closed, otherwise the live draft. */
async function payrollFor(supabase: SupabaseClient, period: string) {
  const { data: run } = await supabase.from("payroll_runs").select("id, finalized_at, finalized_by, totals").eq("period", `${period}-01`).maybeSingle();
  if (run) {
    const lines = await must<any[]>(supabase.from("payroll_lines").select("*").eq("run_id", run.id).order("department_name").order("total", { ascending: false }));
    const { data: finalizer } = await supabase.from("profiles").select("full_name").eq("id", run.finalized_by).maybeSingle();
    return { status: "FINALIZED" as const, finalized_at: run.finalized_at, finalized_by_name: finalizer?.full_name ?? null, lines: lines.map((line) => ({ ...line, base_salary: num(line.base_salary), commission_rate: num(line.commission_rate), basis_amount: num(line.basis_amount), commission_amount: num(line.commission_amount), total: num(line.total) })) as PayrollLine[] };
  }
  return { status: "DRAFT" as const, finalized_at: null, finalized_by_name: null, lines: await computePayroll(supabase, period) };
}

async function financeFor(supabase: SupabaseClient, period: string) {
  const { start, end } = bounds(period);
  const [issued, paid, approvedQuotes, payroll] = await Promise.all([
    must<any[]>(supabase.from("brokerage_invoices").select("amount, department_id").gte("issued_at", start).lt("issued_at", end)),
    must<any[]>(supabase.from("brokerage_invoices").select("amount_paid, department_id").eq("status", "PAID").gte("paid_at", start).lt("paid_at", end)),
    must<any[]>(supabase.from("sales_quotes").select("id").in("stage", ["APPROVED", "HANDED_OFF"]).gte("reviewed_at", start).lt("reviewed_at", end)),
    payrollFor(supabase, period),
  ]);
  const approved = approvedQuotes.length ? await must<any[]>(supabase.from("brokerage_shipments").select("amount_agreed, amount_quoted, sales_department_id").in("quote_id", approvedQuotes.map((quote) => quote.id))) : [];
  const summary = summarize(payroll.lines);
  return {
    period,
    invoiced: round(issued.reduce((s, i) => s + num(i.amount), 0)),
    collected: round(paid.reduce((s, i) => s + num(i.amount_paid), 0)),
    approved_gross: round(approved.reduce((s, x) => s + num(x.amount_agreed ?? x.amount_quoted), 0)),
    payroll: summary.totals.total,
    payroll_status: payroll.status,
    issued, paid, approved, summary,
  };
}

export function registerPayrollRoutes(app: Express, { adminClient, requireSuperAdmin, requireBrokerageUser, writeAudit }: Deps) {
  const actorId = (request: Request) => (request as Request & { actor?: { id: string } }).actor!.id;

  // ---- Compensation settings (PY-2) ----
  app.get("/api/v1/admin/compensation", requireSuperAdmin, async (_request, response, next) => {
    try {
      const supabase = adminClient();
      const [settings, people] = await Promise.all([
        must<any[]>(supabase.from("compensation_settings").select("role_key, user_id, base_salary, commission_rate, commission_basis, updated_at")),
        must<any[]>(supabase.from("profiles").select("id, full_name, email, role, is_active, department_id, departments!profiles_department_id_fkey(name, business_unit, function)").in("role", ["AGENT", "MANAGER"]).order("full_name")),
      ]);
      const staff = people.map((person) => {
        const department = Array.isArray(person.departments) ? person.departments[0] : person.departments;
        return { id: person.id, full_name: person.full_name, email: person.email, is_active: person.is_active, department_name: department?.name ?? null, role_key: roleKeyFor(person.role, department) };
      }).filter((person) => person.role_key);
      const value = (setting: any) => setting ? { base_salary: num(setting.base_salary), commission_rate: num(setting.commission_rate), commission_basis: setting.commission_basis, updated_at: setting.updated_at } : null;
      response.json({
        roles: roleKeys.map((key) => ({ role_key: key, people: staff.filter((person) => person.role_key === key && person.is_active).length, setting: value(settings.find((setting) => setting.role_key === key)) })),
        overrides: settings.filter((setting) => setting.user_id).map((setting) => ({ user_id: setting.user_id, ...value(setting) })),
        people: staff,
      });
    } catch (error) { next(error); }
  });

  const saveSetting = async (supabase: SupabaseClient, match: { column: "role_key" | "user_id"; value: string }, input: Setting, updatedBy: string) => {
    const { data: existing } = await supabase.from("compensation_settings").select("id").eq(match.column, match.value).maybeSingle();
    const row = { ...input, updated_by: updatedBy, updated_at: new Date().toISOString() };
    const { error } = existing
      ? await supabase.from("compensation_settings").update(row).eq("id", existing.id)
      : await supabase.from("compensation_settings").insert({ ...row, [match.column]: match.value });
    if (error) throw error;
  };

  app.put("/api/v1/admin/compensation/roles/:roleKey", requireSuperAdmin, async (request, response, next) => {
    try {
      const roleKey = z.enum(roleKeys).parse(request.params.roleKey);
      const input = settingSchema.parse(request.body);
      const supabase = adminClient();
      await saveSetting(supabase, { column: "role_key", value: roleKey }, input, actorId(request));
      await writeAudit(supabase, actorId(request), "COMPENSATION_ROLE_UPDATED", "compensation", roleKey, input);
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/admin/compensation/users/:userId", requireSuperAdmin, async (request, response, next) => {
    try {
      const userId = z.string().uuid().parse(request.params.userId);
      const input = settingSchema.parse(request.body);
      const supabase = adminClient();
      const { data: person } = await supabase.from("profiles").select("id, role").eq("id", userId).maybeSingle();
      if (!person || !["AGENT", "MANAGER"].includes(person.role)) return response.status(404).json({ error: "Staff member not found." });
      await saveSetting(supabase, { column: "user_id", value: userId }, input, actorId(request));
      await writeAudit(supabase, actorId(request), "COMPENSATION_OVERRIDE_UPDATED", "profile", userId, input);
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/admin/compensation/users/:userId", requireSuperAdmin, async (request, response, next) => {
    try {
      const userId = z.string().uuid().parse(request.params.userId);
      const supabase = adminClient();
      const { error } = await supabase.from("compensation_settings").delete().eq("user_id", userId);
      if (error) throw error;
      await writeAudit(supabase, actorId(request), "COMPENSATION_OVERRIDE_REMOVED", "profile", userId);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  // ---- Monthly payroll (PY-1, PY-3, PY-5) ----
  app.get("/api/v1/admin/payroll", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const payroll = await payrollFor(adminClient(), period);
      response.json({ period, ...payroll, ...summarize(payroll.lines) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/admin/payroll/:period/finalize", requireSuperAdmin, async (request, response, next) => {
    try {
      const period = periodSchema.parse(request.params.period);
      if (period > currentPeriod()) return response.status(422).json({ error: "A future month can't be finalized." });
      const supabase = adminClient();
      const { data: existing } = await supabase.from("payroll_runs").select("id").eq("period", `${period}-01`).maybeSingle();
      if (existing) return response.status(409).json({ error: "This month is already finalized." });
      const lines = await computePayroll(supabase, period);
      const { totals } = summarize(lines);
      const { data: run, error } = await supabase.from("payroll_runs").insert({ period: `${period}-01`, finalized_by: actorId(request), totals }).select("id").single();
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
        must<any[]>(supabase.from("departments").select("id, name, business_unit, function").eq("business_unit", "BROKERAGE").eq("is_active", true).order("name")),
      ]);
      const byDepartment = departments.map((department) => {
        const sales = department.function === "SALES";
        const payroll = current.summary.departments.find((row) => row.department_id === department.id);
        return {
          id: department.id, name: department.name, function: department.function,
          revenue: sales ? round(current.approved.filter((x) => x.sales_department_id === department.id).reduce((s, x) => s + num(x.amount_agreed ?? x.amount_quoted), 0)) : round(current.issued.filter((i) => i.department_id === department.id).reduce((s, i) => s + num(i.amount), 0)),
          collected: sales ? null : round(current.paid.filter((i) => i.department_id === department.id).reduce((s, i) => s + num(i.amount_paid), 0)),
          payroll: payroll?.total ?? 0, people: payroll?.people ?? 0,
        };
      });
      const point = (f: Awaited<ReturnType<typeof financeFor>>) => ({ period: f.period, invoiced: f.invoiced, collected: f.collected, approved_gross: f.approved_gross, payroll: f.payroll, profit: round(f.collected - f.payroll) });
      response.json({
        period,
        invoiced: current.invoiced, collected: current.collected, approved_gross: current.approved_gross,
        outstanding: round(openInvoices.reduce((s, i) => s + Math.max(0, num(i.amount) - num(i.amount_paid)), 0)),
        payroll: current.payroll, payroll_status: current.payroll_status,
        operating_profit: round(current.collected - current.payroll),
        departments: byDepartment,
        trend: [...history, current].map(point),
      });
    } catch (error) { next(error); }
  });

  // ---- My earnings (PY-4): only the signed-in person's own figures ----
  app.get("/api/v1/me/earnings", requireBrokerageUser, async (request, response, next) => {
    try {
      const actor = (request as Request & { actor?: Actor }).actor!;
      const period = periodSchema.parse(request.query.period ?? currentPeriod());
      const supabase = adminClient();
      const { data: run } = await supabase.from("payroll_runs").select("id").eq("period", `${period}-01`).maybeSingle();
      if (run) {
        const { data: line } = await supabase.from("payroll_lines").select("*").eq("run_id", run.id).eq("user_id", actor.id).maybeSingle();
        return response.json({ period, status: "FINALIZED", line: line ? { ...line, base_salary: num(line.base_salary), commission_rate: num(line.commission_rate), basis_amount: num(line.basis_amount), commission_amount: num(line.commission_amount), total: num(line.total) } : null });
      }
      const [line] = await computePayroll(supabase, period, actor.id);
      response.json({ period, status: "ESTIMATE", line: line ?? null });
    } catch (error) { next(error); }
  });
}
