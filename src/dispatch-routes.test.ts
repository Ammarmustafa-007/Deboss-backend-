import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { registerDispatchRoutes } from "./dispatch.js";
import { fakeSupabase } from "./fake-supabase.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const salesDept = { id: id(1), business_unit: "DISPATCH", function: "SALES" };
const opsDept = { id: id(2), business_unit: "DISPATCH", function: "OPERATIONS" };
const people = {
  agent: { id: id(10), role: "AGENT", department: salesDept },
  salesManager: { id: id(11), role: "MANAGER", department: salesDept },
  dispatcher: { id: id(12), role: "AGENT", department: opsDept },
  manager: { id: id(13), role: "MANAGER", department: opsDept },
};
const carrier = { id: id(20), company_name: "Carrier", owner_id: people.agent.id, department_id: salesDept.id, dispatch_department_id: opsDept.id, team_id: null, charge_percent: 10, review_status: "APPROVED" };
const truck = { id: id(30), carrier_id: carrier.id, unit_number: "T1", truck_type: "DRY_VAN", status: "RUNNING", assigned_to: people.dispatcher.id, team_id: null, dispatch_department_id: opsDept.id };
const load = (n: number, pickup: string, rate: number) => ({ id: id(40 + n), truck_id: truck.id, dispatcher_id: people.dispatcher.id, pickup_date: pickup, rate, status: "DELIVERED", invoice_id: null as string | null });
// Three loads in the same week: the case the client could not invoice.
const tables: Record<string, any[]> = {
  dispatch_carriers: [carrier], dispatch_trucks: [truck], profiles: Object.values(people).map((person) => ({ id: person.id, full_name: person.role, role: person.role, department_id: person.department.id, is_active: true })),
  dispatch_loads: [load(1, "2026-10-26", 1000), load(2, "2026-10-27", 500), load(3, "2026-10-28", 250), { ...load(4, "2026-10-29", 999), status: "CANCELLED" }],
  dispatch_invoices: [], record_comments: [], notifications: [], audit_events: [], dispatch_targets: [], dispatch_carrier_documents: [], dispatch_activities: [], teams: [], departments: [],
};
const audits: string[] = [];
let server: Server; let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  const requireUser = (request: any, _response: any, next: any) => { const person = Object.values(people).find((row) => row.id === request.header("x-actor"))!; request.actor = { id: person.id, role: person.role, department_id: person.department.id, department: person.department }; next(); };
  registerDispatchRoutes(app as never, {
    adminClient: () => fakeSupabase(tables), requireUser: requireUser as never,
    writeAudit: (async (_s: unknown, _a: unknown, action: string) => { audits.push(action); }) as never,
    teamScope: async () => ({ teamIds: [], leadTeamIds: [], memberIds: [], permissions: new Set<string>() }),
    withAuthorDetails: async (_s: unknown, rows: any[]) => rows,
  } as never);
  app.use((error: any, _request: any, response: any, _next: any) => { response.status(error?.name === "ZodError" ? 422 : 500).json({ error: String(error?.message ?? error) }); });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const call = async (actor: { id: string }, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(base + path, { method, headers: { "x-actor": actor.id, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const loadsOf = (invoiceId: string) => tables.dispatch_loads.filter((row) => row.invoice_id === invoiceId).map((row) => row.id);
const invoice = (invoiceId: string) => tables.dispatch_invoices.find((row) => row.id === invoiceId)!;
let first = ""; let second = "";

test("the Dispatcher picks loads, and a second invoice in the same week works", async () => {
  const one = await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [id(41)] });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  first = one.body.invoice.id;
  assert.equal(Number(one.body.invoice.gross_amount), 1000);
  assert.equal(Number(one.body.invoice.amount), 100);
  const two = await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [id(42), id(43)] });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  second = two.body.invoice.id;
  assert.equal(Number(two.body.invoice.gross_amount), 750);
  assert.notEqual(invoice(first).invoice_number, invoice(second).invoice_number);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [id(41)] })).status, 422);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [id(44)] })).status, 422);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [] })).status, 422);
});

test("loads move between invoices, and the figures follow", async () => {
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${second}`, "PATCH", { remove_load_ids: [id(43)] })).status, 200);
  assert.equal(Number(invoice(second).gross_amount), 500);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "PATCH", { add_load_ids: [id(43)] })).status, 200);
  assert.deepEqual(loadsOf(first).sort(), [id(41), id(43)]);
  assert.equal(Number(invoice(first).amount), 125);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "PATCH", { remove_load_ids: [id(41), id(43)] })).status, 422);
});

test("typed figures override the calculation", async () => {
  await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "PATCH", { gross_amount: 2000 });
  assert.equal(Number(invoice(first).amount), 200);
  await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "PATCH", { amount: 180 });
  assert.equal(Number(invoice(first).amount), 180);
});

test("after submitting, only the Dispatch Manager edits, even once paid", async () => {
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}/actions`, "POST", { action: "SUBMIT" })).status, 200);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "PATCH", { amount: 1 })).status, 403);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/loads/${id(41)}`, "PATCH", { rate: 5 })).status, 422);
  assert.equal((await call(people.manager, `/api/v1/dispatch/invoices/${first}/actions`, "POST", { action: "FORWARD" })).status, 200);
  assert.equal((await call(people.manager, `/api/v1/dispatch/invoices/${first}/actions`, "POST", { action: "PAY" })).status, 200);
  assert.equal(invoice(first).status, "PAID");
  assert.equal((await call(people.manager, `/api/v1/dispatch/invoices/${first}`, "PATCH", { amount: 150, amount_paid: 150 })).status, 200);
  assert.equal(Number(invoice(first).amount_paid), 150);
  assert.equal((await call(people.manager, `/api/v1/dispatch/loads/${id(41)}`, "PATCH", { rate: 1100 })).status, 200);
  assert.equal(Number(invoice(first).gross_amount), 1350);
  assert.ok(audits.includes("DISPATCH_INVOICE_EDITED"));
});

test("deleting or cancelling an invoice frees its loads", async () => {
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${second}/actions`, "POST", { action: "CANCEL" })).status, 200);
  assert.equal(tables.dispatch_loads.find((row) => row.id === id(42)).invoice_id, null);
  const again = await call(people.dispatcher, `/api/v1/dispatch/trucks/${truck.id}/invoices`, "POST", { load_ids: [id(42)] });
  assert.equal(again.status, 201);
  assert.equal((await call(people.dispatcher, `/api/v1/dispatch/invoices/${first}`, "DELETE")).status, 403);
  assert.equal((await call(people.manager, `/api/v1/dispatch/invoices/${again.body.invoice.id}`, "DELETE")).status, 200);
  assert.equal(tables.dispatch_loads.find((row) => row.id === id(42)).invoice_id, null);
  assert.ok(audits.includes("DISPATCH_INVOICE_DELETED"));
});

test("the Sales Agent sees active sales, never invoices or gross", async () => {
  const list = await call(people.agent, "/api/v1/dispatch/invoices");
  assert.deepEqual(list.body.invoices, []);
  assert.equal((await call(people.agent, `/api/v1/dispatch/invoices/${first}/detail`)).status, 403);
  const detail = await call(people.agent, `/api/v1/dispatch/trucks/${truck.id}/detail`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.loads, []);
  assert.deepEqual(detail.body.invoices, []);
  assert.equal(detail.body.rights.money_hidden, true);
  assert.ok(detail.body.truck.sale_active_since);
  assert.deepEqual((await call(people.agent, "/api/v1/dispatch/loads")).body.loads, []);
  const manager = await call(people.salesManager, "/api/v1/dispatch/invoices");
  // The Sales Manager still sees every invoice: the paid one and the cancelled one.
  assert.equal(manager.body.invoices.length, 2);
});
