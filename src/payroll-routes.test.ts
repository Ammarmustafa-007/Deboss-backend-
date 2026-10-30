import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { registerPayrollRoutes } from "./payroll.js";

/** In-memory stand-in for Supabase with writes, so the real routes run without a database. */
function fakeSupabase(tables: Record<string, any[]>) {
  const keys: Record<string, string[]> = { employee_records: ["user_id"], attendance_records: ["user_id", "work_date"], payroll_months: ["period"] };
  const from = (table: string) => {
    const filters: ((row: any) => boolean)[] = [];
    let action: { kind: string; value?: any } = { kind: "select" };
    const rows = () => (tables[table] ??= []);
    const run = () => {
      const matching = rows().filter((row) => filters.every((check) => check(row)));
      if (action.kind === "update") matching.forEach((row) => Object.assign(row, action.value));
      if (action.kind === "delete") tables[table] = rows().filter((row) => !matching.includes(row));
      if (action.kind === "insert") { const added = [action.value].flat().map((row, index) => ({ id: `${table}-${rows().length + index}`, ...row })); rows().push(...added); return added; }
      if (action.kind === "upsert") {
        const key = keys[table]; const found = rows().find((row) => key.every((name) => row[name] === action.value[name]));
        if (found) Object.assign(found, action.value); else rows().push({ ...action.value });
        return [action.value];
      }
      return matching;
    };
    const builder: any = {
      select: () => builder, order: () => builder, limit: () => builder,
      insert: (value: any) => { action = { kind: "insert", value }; return builder; },
      update: (value: any) => { action = { kind: "update", value }; return builder; },
      upsert: (value: any) => { action = { kind: "upsert", value }; return builder; },
      delete: () => { action = { kind: "delete" }; return builder; },
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return builder; },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
      gte: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] >= value); return builder; },
      lt: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] < value); return builder; },
      lte: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] <= value); return builder; },
      not: (key: string, op: string, value: string) => { filters.push((row) => op === "in" ? !value.slice(1, -1).split(",").includes(row[key]) : row[key] != null); return builder; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: run(), error: null }),
    };
    return builder;
  };
  return { from } as never;
}

const ids = Object.fromEntries(["boss", "m1", "m2", "a1", "a2", "a3", "opsm", "opsa", "gone", "stays"].map((name, index) => [name, `00000000-0000-4000-8000-00000000000${index}`]));
const rules = {
  dispatch_sales: { min_active_sales: 2, rate: 5 },
  dispatcher: { tiers: [{ from: 1500, rate: 8 }] }, brokerage_sales: { tiers: [{ from: 2500, rate: 8 }] }, brokerage_operations: { tiers: [{ from: 4000, rate: 8 }] },
  fronter_per_lead_pkr: 1000, manager_share: { DISPATCH_SALES_MANAGER: 25, DISPATCH_MANAGER: 40, BROKERAGE_SALES_MANAGER: 10, BROKERAGE_OPERATIONS_MANAGER: 10 }, paid_leaves_per_month: 1,
};
const sales = { id: "sales", name: "Sales", business_unit: "BROKERAGE", function: "SALES" };
const ops = { id: "ops", name: "Ops", business_unit: "BROKERAGE", function: "OPERATIONS" };
const person = (id: string, role: string, department: any) => ({ id, full_name: id, email: `${id}@x`, role, department_id: department?.id ?? null, is_active: true, created_at: "2025-01-01T00:00:00Z", departments: department });
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const tables: Record<string, any[]> = {
  hr_settings: [{ rules }], departments: [sales, ops], payroll_runs: [{ id: "run", period: "2020-01-01" }], payroll_lines: [],
  profiles: [person(ids.boss, "SUPER_ADMIN", null), person(ids.m1, "MANAGER", sales), person(ids.m2, "MANAGER", sales), person(ids.a1, "AGENT", sales), person(ids.a2, "AGENT", sales), person(ids.a3, "AGENT", sales), person(ids.opsm, "MANAGER", ops), person(ids.opsa, "AGENT", ops), person(ids.gone, "AGENT", ops), person(ids.stays, "AGENT", ops)],
  employee_records: [
    { user_id: ids.a1, base_salary_pkr: 123456, joined_on: "2025-01-01", last_working_day: null, exit_type: null, manager_id: ids.m1 },
    { user_id: ids.a2, base_salary_pkr: 123456, joined_on: "2025-01-01", last_working_day: null, exit_type: null, manager_id: ids.m2 },
    { user_id: ids.gone, base_salary_pkr: 1, joined_on: "2025-01-01", last_working_day: yesterday, exit_type: "NOTICE_SERVED" },
    { user_id: ids.stays, base_salary_pkr: 1, joined_on: "2025-01-01", last_working_day: today, exit_type: "NOTICE_SERVED" },
  ],
  attendance_records: [], payroll_months: [], department_costs: [], ownership_transfers: [], brokerage_invoices: [], dispatch_invoices: [], fronter_prospects: [],
  brokerage_customers: [{ id: "c1", owner_id: ids.a3, operations_agent_id: null }, { id: "c2", owner_id: ids.a1, operations_agent_id: null }],
  sales_leads: [{ id: "l1", owner_id: ids.a3 }],
  brokerage_shipments: [{ id: "s1", assigned_to: ids.opsa, status: "BOOKED" }, { id: "s2", assigned_to: ids.opsa, status: "COMPLETED" }],
  dispatch_carriers: [], dispatch_trucks: [],
};
const cleared: (string | undefined)[] = [];
const audits: string[] = [];
let server: Server; let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  const auth = (request: any) => { const profile = tables.profiles.find((row) => row.id === request.header("x-actor")); request.actor = { id: profile.id, role: profile.role, department_id: profile.department_id, department: profile.departments }; return profile; };
  registerPayrollRoutes(app as never, {
    adminClient: () => fakeSupabase(tables),
    requireSuperAdmin: ((request: any, response: any, next: any) => auth(request).role === "SUPER_ADMIN" ? next() : response.status(403).json({ error: "no" })) as never,
    requireBrokerageUser: ((request: any, _response: any, next: any) => { auth(request); next(); }) as never,
    clearAccessCache: (id) => { cleared.push(id); },
    writeAudit: (async (_s: unknown, _a: unknown, action: string) => { audits.push(action); }) as never,
  });
  app.use((error: any, _request: any, response: any, _next: any) => { console.error(error); response.status(500).json({ error: String(error) }); });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const call = async (actor: string, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(base + path, { method, headers: { "x-actor": actor, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, text: await response.text() };
};
const payWords = /salary|commission|net_pay|profit_share|123456|"total"/;
const day = "2026-10-05";

test("the startup sweep removes a login only after the last working day", () => {
  assert.equal(tables.profiles.find((row) => row.id === ids.gone).is_active, false);
  assert.equal(tables.profiles.find((row) => row.id === ids.stays).is_active, true);
  assert.ok(cleared.includes(ids.gone));
});

test("an agent can't touch attendance or see team figures, and their own progress has no pay", async () => {
  assert.equal((await call(ids.a1, "/api/v1/attendance?period=2026-10")).status, 403);
  assert.equal((await call(ids.a1, "/api/v1/attendance", "PUT", { user_id: ids.a1, date: day, status: "LEAVE" })).status, 403);
  assert.equal((await call(ids.a1, "/api/v1/performance/team?period=2026-10")).status, 403);
  const mine = await call(ids.a1, "/api/v1/me/performance?period=2026-10");
  assert.equal(mine.status, 200);
  assert.ok(JSON.parse(mine.text).progress);
  assert.doesNotMatch(mine.text, payWords);
});

test("an agent is refused every pay screen", async () => {
  for (const path of ["/api/v1/admin/payroll?period=2026-10", "/api/v1/admin/hr/employees", "/api/v1/admin/hr/rules", "/api/v1/admin/costs?period=2026-10", "/api/v1/admin/finance"]) assert.equal((await call(ids.a1, path)).status, 403, path);
  assert.equal((await call(ids.m1, "/api/v1/admin/payroll?period=2026-10")).status, 403);
  assert.equal((await call(ids.a1, "/api/v1/me/earnings")).status, 404);
});

test("a manager records their own department only, and never themselves", async () => {
  const list = JSON.parse((await call(ids.m1, "/api/v1/attendance?period=2026-10")).text);
  const seen = list.people.map((row: any) => row.id);
  assert.ok(seen.includes(ids.a1) && seen.includes(ids.m2));
  assert.ok(!seen.includes(ids.m1) && !seen.includes(ids.opsa));
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.a1, date: day, status: "ABSENT" })).status, 200);
  assert.equal(tables.attendance_records.length, 1);
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.opsa, date: day, status: "ABSENT" })).status, 403);
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.m1, date: day, status: "LEAVE" })).status, 403);
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.a1, date: "2026-10-03", status: "ABSENT" })).status, 422);
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.a1, date: day, status: "PRESENT" })).status, 200);
  assert.equal(tables.attendance_records.length, 0);
  assert.ok(audits.includes("ATTENDANCE_UPDATED"));
});

test("with two managers each sees only their own team's progress, with no pay", async () => {
  const one = await call(ids.m1, "/api/v1/performance/team?period=2026-10");
  assert.deepEqual(JSON.parse(one.text).people.map((row: any) => row.user_id), [ids.a1]);
  assert.doesNotMatch(one.text, payWords);
  assert.deepEqual(JSON.parse((await call(ids.m2, "/api/v1/performance/team?period=2026-10")).text).people.map((row: any) => row.user_id), [ids.a2]);
  assert.equal(JSON.parse((await call(ids.boss, "/api/v1/performance/team?period=2026-10")).text).people.length >= 7, true);
});

test("a manager must belong to the employee's department", async () => {
  assert.equal((await call(ids.boss, `/api/v1/admin/hr/employees/${ids.a1}`, "PUT", { base_salary_pkr: 1000, joined_on: "2025-01-01", manager_id: ids.opsm })).status, 422);
  assert.equal((await call(ids.boss, `/api/v1/admin/hr/employees/${ids.a1}`, "PUT", { base_salary_pkr: 123456, joined_on: "2025-01-01", manager_id: ids.m2 })).status, 200);
  assert.equal(tables.employee_records.find((row) => row.user_id === ids.a1).manager_id, ids.m2);
  await call(ids.boss, `/api/v1/admin/hr/employees/${ids.a1}`, "PUT", { base_salary_pkr: 123456, joined_on: "2025-01-01", manager_id: ids.m1 });
});

test("a leaver's work moves to a colleague in the same department, and nothing is deleted", async () => {
  assert.equal((await call(ids.boss, `/api/v1/admin/hr/employees/${ids.a3}/exit`, "POST", { last_working_day: "2030-01-31", exit_type: "NOTICE_SERVED", reassign_to: ids.opsa })).status, 422);
  assert.equal(tables.brokerage_customers[0].owner_id, ids.a3);
  const done = await call(ids.boss, `/api/v1/admin/hr/employees/${ids.a3}/exit`, "POST", { last_working_day: "2030-01-31", exit_type: "NOTICE_SERVED", reassign_to: ids.a2 });
  assert.equal(done.status, 200);
  assert.equal(tables.brokerage_customers.length, 2);
  assert.equal(tables.brokerage_customers[0].owner_id, ids.a2);
  assert.equal(tables.brokerage_customers[1].owner_id, ids.a1);
  assert.equal(tables.sales_leads[0].owner_id, ids.a2);
  assert.equal(tables.ownership_transfers[0].from_user, ids.a3);
  assert.equal(tables.profiles.find((row) => row.id === ids.a3).is_active, true);

  await call(ids.boss, `/api/v1/admin/hr/employees/${ids.opsa}/exit`, "POST", { last_working_day: "2030-01-31", exit_type: "FIRED", reassign_to: ids.stays });
  assert.equal(tables.brokerage_shipments[0].assigned_to, ids.stays);
  assert.equal(tables.brokerage_shipments[1].assigned_to, ids.opsa);
});

test("a finalized month refuses changes", async () => {
  assert.equal((await call(ids.m1, "/api/v1/attendance", "PUT", { user_id: ids.a1, date: "2020-01-06", status: "ABSENT" })).status, 409);
  assert.equal((await call(ids.boss, "/api/v1/admin/costs", "POST", { period: "2020-01", name: "x", amount: 1, currency: "USD", cost_type: "COMPANY_ONLY", department_ids: [] })).status, 409);
  assert.equal((await call(ids.boss, "/api/v1/admin/payroll/2020-01/rate", "PUT", { usd_to_pkr: 280 })).status, 409);
});
