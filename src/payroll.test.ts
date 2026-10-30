import assert from "node:assert/strict";
import { test } from "node:test";
import { monthFigures } from "./payroll.js";

/** A small in-memory stand-in for the Supabase query builder: enough for monthFigures, which only reads. */
function fakeSupabase(tables: Record<string, any[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const builder: any = {
      select: () => builder,
      eq: (key: string, value: unknown) => { rows = rows.filter((row) => row[key] === value); return builder; },
      in: (key: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[key])); return builder; },
      gte: (key: string, value: string) => { rows = rows.filter((row) => row[key] != null && row[key] >= value); return builder; },
      lt: (key: string, value: string) => { rows = rows.filter((row) => row[key] != null && row[key] < value); return builder; },
      lte: (key: string, value: string) => { rows = rows.filter((row) => row[key] != null && row[key] <= value); return builder; },
      not: (key: string) => { rows = rows.filter((row) => row[key] != null); return builder; },
      order: () => builder,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
    };
    return builder;
  };
  return { from } as never;
}

const rules = {
  dispatch_sales: { min_active_sales: 2, rate: 5 },
  dispatcher: { tiers: [{ from: 1500, rate: 8 }, { from: 2500, rate: 10 }, { from: 3500, rate: 12 }] },
  brokerage_sales: { tiers: [{ from: 2500, rate: 8 }, { from: 3500, rate: 10 }, { from: 4500, rate: 12 }] },
  brokerage_operations: { tiers: [{ from: 4000, rate: 8 }, { from: 5000, rate: 10 }, { from: 7000, rate: 12 }] },
  fronter_per_lead_pkr: 1000,
  manager_share: { DISPATCH_SALES_MANAGER: 25, DISPATCH_MANAGER: 40, BROKERAGE_SALES_MANAGER: 10, BROKERAGE_OPERATIONS_MANAGER: 10 },
  paid_leaves_per_month: 1,
};
const department = (id: string, business_unit: string, fn: string) => ({ id, name: id, business_unit, function: fn });
const departments = [department("d-sales", "DISPATCH", "SALES"), department("d-ops", "DISPATCH", "OPERATIONS"), department("b-sales", "BROKERAGE", "SALES"), department("b-ops", "BROKERAGE", "OPERATIONS"), department("fronters", "BROKERAGE", "FRONTER")];
const person = (id: string, role: string, dept: string) => ({ id, full_name: id, role, department_id: dept, is_active: true, created_at: "2025-01-01T00:00:00Z", departments: departments.find((row) => row.id === dept) });
const inv = (id: string, truck: string, paid: number, paid_at: string) => ({ id, invoice_number: id, truck_id: truck, amount_paid: paid, paid_at, status: "PAID", sales_agent_id: "dsa", dispatcher_id: "dispatcher", sales_department_id: "d-sales", dispatch_department_id: "d-ops", dispatch_carriers: { company_name: "Carrier" } });
const load = (id: string, customer: string, agreed: number | null, carrier: number | null, status = "COMPLETED") => ({ id, reference_number: id, customer_name: customer, customer_id: customer, sales_department_id: "b-sales", operations_department_id: "b-ops", assigned_to: "bops", amount_agreed: agreed, carrier_rate: carrier, status, sales_status: status });
const paidInvoice = (id: string, shipment: string, paid_at = "2026-10-15T10:00:00Z") => ({ id, shipment_id: shipment, department_id: "b-ops", status: "PAID", paid_at });

const base = () => ({
  hr_settings: [{ rules }],
  payroll_months: [{ period: "2026-10-01", usd_to_pkr: 280 }],
  profiles: [person("dsa", "AGENT", "d-sales"), person("dispatcher", "AGENT", "d-ops"), person("dsm", "MANAGER", "d-sales"), person("bsa", "AGENT", "b-sales"), person("bops", "AGENT", "b-ops"), person("bsm", "MANAGER", "b-sales"), person("fronter", "AGENT", "fronters"), person("frm", "MANAGER", "fronters")],
  employee_records: ["dsa", "dispatcher", "dsm", "bsa", "bops", "bsm", "fronter", "frm"].map((user_id) => ({ user_id, base_salary_pkr: 110000, joined_on: "2025-01-01", last_working_day: null, exit_type: null })),
  attendance_records: [] as any[],
  department_costs: [] as any[],
  departments,
  brokerage_invoices: [paidInvoice("i1", "s1"), paidInvoice("i2", "s2"), paidInvoice("i3", "s3"), paidInvoice("i4", "s4")],
  brokerage_shipments: [load("s1", "c1", 10000, 6000), load("s2", "c1", 3000, 1000), load("s3", "c1", 9000, null), load("s4", "c1", 50000, 1000, "CANCELLED")],
  brokerage_customers: [{ id: "c1", owner_id: "bsa" }],
  ownership_transfers: [] as any[],
  dispatch_invoices: [inv("x1", "t1", 1000, "2026-10-05T10:00:00Z"), inv("x2", "t2", 1400, "2026-10-09T10:00:00Z"), inv("x3", "t1", 600, "2026-10-12T10:00:00Z"), inv("old", "t3", 100, "2026-09-01T10:00:00Z"), inv("x4", "t3", 0, "2026-10-20T10:00:00Z")],
  fronter_prospects: [{ id: "p1", company_name: "Lead one", created_by: "fronter", department_id: "fronters", qualified_at: "2026-10-03T10:00:00Z" }, { id: "p2", company_name: "Lead two", created_by: "fronter", department_id: "fronters", qualified_at: "2026-10-04T10:00:00Z" }, { id: "p3", company_name: "Last month", created_by: "fronter", department_id: "fronters", qualified_at: "2026-09-04T10:00:00Z" }],
});
const line = (figures: Awaited<ReturnType<typeof monthFigures>>, id: string) => figures.lines.find((row) => row.user_id === id)!;

test("each role's month comes out as the document describes", async () => {
  const figures = await monthFigures(fakeSupabase(base()), "2026-10");
  // Two trucks paid their first invoice this month; a truck that first paid earlier is not an active sale.
  assert.equal(line(figures, "dsa").detail.active_sales, 2);
  assert.equal(line(figures, "dsa").detail.gross, 3000);
  assert.equal(line(figures, "dsa").detail.commission_usd, 150);
  assert.equal(line(figures, "dispatcher").detail.commission_usd, 150);
  // Margin 4,000 + 2,000; the unpriced load counts 0 and the cancelled one not at all.
  assert.equal(line(figures, "bsa").detail.gross, 6000);
  assert.equal(line(figures, "bsa").detail.commission_usd, 420);
  assert.equal(line(figures, "bops").detail.commission_usd, 200);
  assert.equal(line(figures, "fronter").detail.qualified_leads, 2);
  assert.equal(line(figures, "fronter").detail.commission_pkr, 2000);
  assert.equal(line(figures, "dsa").total, 110000 + 150 * 280);
});

test("department P&L and profit share, including all four cost types", async () => {
  const tables = base();
  tables.department_costs = [
    { name: "Load board", amount: 280, currency: "PKR", cost_type: "ONE_DEPARTMENT", department_ids: ["d-sales"] },
    { name: "Dialer", amount: 100, currency: "USD", cost_type: "TWO_DEPARTMENTS", department_ids: ["d-sales", "b-sales"] },
    { name: "Rent", amount: 800, currency: "USD", cost_type: "COMPANY_SHARED", department_ids: [] },
    { name: "This CRM", amount: 9999, currency: "USD", cost_type: "COMPANY_ONLY", department_ids: [] },
  ].map((cost) => ({ ...cost, period: "2026-10-01" }));
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  const pl = figures.departments.find((row) => row.department_id === "d-sales")!;
  const salaries = Math.round(220000 / 280 * 100) / 100;
  assert.equal(pl.income, 3000);
  assert.equal(pl.salaries, salaries);
  assert.equal(pl.commissions, 150);
  // 2 of 8 employees for rent, 2 of 4 for the dialer, and the load board in full.
  assert.equal(pl.other_costs, 1 + 50 + 200);
  assert.equal(pl.net_profit, Math.round((3000 - salaries - 150 - 251) * 100) / 100);
  assert.equal(line(figures, "dsm").detail.profit_share_usd, Math.round(pl.net_profit * 25) / 100);
  assert.equal(figures.departments.find((row) => row.department_id === "fronters")!.income, 0);
  assert.equal(line(figures, "frm").detail.profit_share_usd, 0);
});

test("a loss month pays no profit share but keeps the base", async () => {
  const tables = base();
  tables.department_costs = [{ period: "2026-10-01", name: "Big", amount: 999999, currency: "USD", cost_type: "ONE_DEPARTMENT", department_ids: ["b-sales"] }];
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  assert.equal(line(figures, "bsm").detail.profit_share_usd, 0);
  assert.equal(line(figures, "bsm").total, 110000);
});

test("leavers: no notice gets base for days worked only; served notice keeps commission up to the last day", async () => {
  const tables = base();
  Object.assign(tables.employee_records.find((row) => row.user_id === "dispatcher")!, { last_working_day: "2026-10-15", exit_type: "NOTICE_SERVED" });
  Object.assign(tables.employee_records.find((row) => row.user_id === "bops")!, { last_working_day: "2026-10-15", exit_type: "FIRED" });
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  // Dispatcher: x3 (12 Oct) is in, x4 (20 Oct) is after the last day.
  assert.equal(line(figures, "dispatcher").detail.gross, 3000);
  assert.equal(line(figures, "dispatcher").detail.commission_usd, 150);
  assert.equal(line(figures, "dispatcher").detail.employed_days, 11);
  assert.equal(line(figures, "bops").detail.commission_usd, 0);
  assert.equal(line(figures, "bops").total, 55000);
});

test("reassigning a customer does not move commission already earned", async () => {
  const tables = base();
  tables.profiles.push(person("newbie", "AGENT", "b-sales"));
  tables.brokerage_customers = [{ id: "c1", owner_id: "newbie" }];
  tables.ownership_transfers = [{ customer_id: "c1", from_user: "bsa", transferred_at: "2026-10-20T00:00:00Z" }];
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  assert.equal(line(figures, "bsa").detail.gross, 6000);
  assert.equal(line(figures, "newbie").detail.gross, 0);
});

test("people outside the month and those without a rate", async () => {
  const tables = base();
  tables.employee_records.find((row) => row.user_id === "dsa")!.joined_on = "2026-11-02";
  tables.payroll_months = [];
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  assert.equal(line(figures, "dsa"), undefined);
  assert.equal(figures.rate, null);
  assert.equal(line(figures, "dispatcher").total, 110000);
  assert.equal(line(figures, "dispatcher").detail.net_pay_usd, null);
});

test("two managers in a department: each manager and team has a separate P&L and share", async () => {
  const tables = base();
  tables.profiles.push(person("dsa2", "AGENT", "d-sales"), person("dsm2", "MANAGER", "d-sales"), person("dsa3", "AGENT", "d-sales"));
  for (const user_id of ["dsa2", "dsm2", "dsa3"]) tables.employee_records.push({ user_id, base_salary_pkr: 0, joined_on: "2025-01-01", last_working_day: null, exit_type: null } as any);
  const record = (id: string) => tables.employee_records.find((row) => row.user_id === id)! as any;
  record("dsa").manager_id = "dsm"; record("dsa2").manager_id = "dsm2";
  record("dsm").base_salary_pkr = 28000; record("dsm2").base_salary_pkr = 2800; record("dsa").base_salary_pkr = 0;
  tables.dispatch_invoices.push({ ...inv("y1", "t9", 2000, "2026-10-21T10:00:00Z"), sales_agent_id: "dsa2" });
  tables.department_costs = [{ period: "2026-10-01", name: "Tools", amount: 500, currency: "USD", cost_type: "ONE_DEPARTMENT", department_ids: ["d-sales"] }];
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  const teams = figures.departments.filter((row) => row.department_id === "d-sales");
  const one = teams.find((row) => row.manager_id === "dsm")!;
  const two = teams.find((row) => row.manager_id === "dsm2")!;
  const none = teams.find((row) => row.unassigned)!;
  assert.equal(teams.length, 3);
  assert.equal(one.income, 3000);
  assert.equal(two.income, 2000);
  assert.equal(none.people, 1);
  // Team one: two of five people, so 2/5 of the $500; $100 salary and the agent's 5% of $3,000.
  assert.equal(one.other_costs, 200);
  assert.equal(one.salaries, 100);
  assert.equal(one.commissions, 150);
  assert.equal(one.net_profit, 2550);
  assert.equal(line(figures, "dsm").detail.profit_share_usd, 637.5);
  // Team two: 2/5 of $500, $10 salary, one active sale so no commission. The share is the full 25%, not halved.
  assert.equal(two.net_profit, 1790);
  assert.equal(line(figures, "dsm2").detail.profit_share_usd, 447.5);
  assert.equal(none.manager_share, 0);
});

test("a Fronter Manager is paid as a Brokerage Sales Agent", async () => {
  const tables = base();
  tables.brokerage_customers = [{ id: "c1", owner_id: "frm" }];
  const figures = await monthFigures(fakeSupabase(tables), "2026-10");
  assert.equal(line(figures, "frm").detail.gross, 6000);
  assert.equal(line(figures, "frm").detail.commission_usd, 420);
  assert.equal(line(figures, "frm").detail.profit_share_usd, 0);
});
