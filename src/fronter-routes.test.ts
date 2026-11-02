import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { registerFronterRoutes } from "./fronter.js";
import { fakeSupabase } from "./fake-supabase.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fronterDept = { id: id(1), name: "Fronters", business_unit: "BROKERAGE", function: "FRONTER", is_active: true };
const salesDept = { id: id(2), name: "Sales", business_unit: "BROKERAGE", function: "SALES", is_active: true };
const profile = (n: number, role: string, department: any, extra = {}) => ({ id: id(n), full_name: `Person ${n}`, role, department_id: department.id, departments: department, is_active: true, ...extra });
const agent = profile(20, "AGENT", salesDept);
const otherAgent = profile(21, "AGENT", salesDept);
const tables: Record<string, any[]> = {
  profiles: [profile(10, "AGENT", fronterDept, { sales_agent_id: agent.id }), profile(11, "AGENT", fronterDept), agent, otherAgent],
  fronter_prospects: [
    { id: id(30), company_name: "Linked", status: "CONTACTED", created_by: id(10), department_id: fronterDept.id, assigned_to: null },
    { id: id(31), company_name: "Unlinked", status: "CONTACTED", created_by: id(11), department_id: fronterDept.id, assigned_to: null },
    { id: id(32), company_name: "For Sales", status: "NEW", created_by: id(10), department_id: fronterDept.id, assigned_to: null },
  ],
  sales_leads: [], brokerage_customers: [], team_members: [], notifications: [], audit_events: [],
};
let server: Server; let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  const requireUser = (request: any, _response: any, next: any) => { const person = tables.profiles.find((row) => row.id === request.header("x-actor")); request.actor = { id: person.id, role: person.role, department_id: person.department_id, department: person.departments }; next(); };
  registerFronterRoutes(app as never, { adminClient: () => fakeSupabase(tables), requireUser: requireUser as never, writeAudit: (async () => {}) as never, teamScope: async () => ({ teamIds: [], leadTeamIds: [], memberIds: [], permissions: new Set<string>() }) });
  app.use((error: any, _request: any, response: any, _next: any) => { response.status(500).json({ error: String(error?.message ?? error) }); });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const call = async (actor: string, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "x-actor": actor, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
const qualify = (actor: string, prospect: string) => call(actor, `/api/v1/fronter/prospects/${prospect}`, "PATCH", { status: "QUALIFIED" });

test("a qualified lead goes to the Sales agent the Fronter works for, without choosing one", async () => {
  const done = await qualify(id(10), id(30));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(tables.sales_leads[0].owner_id, agent.id);
  assert.equal(tables.fronter_prospects[0].status, "QUALIFIED");
});

test("a Fronter with no linked Sales agent is told to ask the Super Admin", async () => {
  const refused = await qualify(id(11), id(31));
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /Super Admin/);
  assert.equal(tables.fronter_prospects[1].status, "CONTACTED");
});

test("a Sales agent sees only their own Fronters' rows, read-only except the status", async () => {
  const mine = await call(agent.id, "/api/v1/fronter/prospects");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.prospects.map((row: any) => row.company_name).sort(), ["For Sales", "Linked"]);
  assert.ok(mine.body.prospects.every((row: any) => row.fields_locked));
  assert.deepEqual((await call(otherAgent.id, "/api/v1/fronter/prospects")).body.prospects, []);
  assert.equal((await call(agent.id, `/api/v1/fronter/prospects/${id(32)}`, "PATCH", { commodity: "Steel" })).status, 403);
  assert.equal((await call(otherAgent.id, `/api/v1/fronter/prospects/${id(32)}`, "PATCH", { status: "CONTACTED" })).status, 403);
  assert.equal((await call(agent.id, `/api/v1/fronter/prospects/${id(32)}`, "PATCH", { status: "CONTACTED" })).status, 200);
});

test("a Sales agent qualifying a Fronter's row takes it as their own lead", async () => {
  const done = await qualify(agent.id, id(32));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(tables.sales_leads.at(-1).owner_id, agent.id);
  assert.equal(tables.sales_leads.at(-1).company_name, "For Sales");
});
