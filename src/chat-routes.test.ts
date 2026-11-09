import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { registerChatRoutes } from "./chat.js";
import { fakeSupabase } from "./fake-supabase.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const opsDept = { id: id(1), name: "Brokerage Operations", business_unit: "BROKERAGE", function: "OPERATIONS", is_active: true };
const salesDept = { id: id(2), name: "Brokerage Sales", business_unit: "BROKERAGE", function: "SALES", is_active: true };
const dispatchDept = { id: id(3), name: "Dispatch Sales", business_unit: "DISPATCH", function: "SALES", is_active: true };
const profile = (n: number, role: string, department: any) => ({ id: id(n), full_name: `Person ${n}`, role, department_id: department.id, departments: department, is_active: true });
const opsManager = profile(10, "MANAGER", opsDept);
const salesAgent = profile(20, "AGENT", salesDept);
const opsAgent = profile(21, "AGENT", opsDept);
const dispatchAgent = profile(30, "AGENT", dispatchDept);
const tables: Record<string, any[]> = { profiles: [opsManager, salesAgent, opsAgent, dispatchAgent], chat_conversations: [], chat_members: [], chat_messages: [], audit_events: [] };
let server: Server; let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  const requireUser = (request: any, _response: any, next: any) => { const person = tables.profiles.find((row) => row.id === request.header("x-actor")); request.actor = { id: person.id, role: person.role, department_id: person.department_id, department: person.departments }; next(); };
  registerChatRoutes(app as never, { adminClient: () => fakeSupabase(tables), requireUser: requireUser as never, requireSuperAdmin: requireUser as never, writeAudit: (async () => {}) as never });
  app.use((error: any, _request: any, response: any, _next: any) => { response.status(500).json({ error: String(error?.message ?? error) }); });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const call = async (actor: string, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "x-actor": actor, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new Error(`${response.status} ${text.slice(0, 300)}`); }
};

test("a Brokerage manager messages Brokerage agents of other departments, never Dispatch agents; agents still can't message agents", async () => {
  assert.equal((await call(opsManager.id, "/api/v1/chat/direct", "POST", { user_id: salesAgent.id })).status, 201);
  assert.equal((await call(opsManager.id, "/api/v1/chat/direct", "POST", { user_id: dispatchAgent.id })).status, 403);
  assert.equal((await call(salesAgent.id, "/api/v1/chat/direct", "POST", { user_id: opsAgent.id })).status, 403);
});

test("managers create their own group, manage its members, and agents can't create groups", async () => {
  assert.equal((await call(salesAgent.id, "/api/v1/chat/groups", "POST", { name: "Agents", member_ids: [opsAgent.id] })).status, 403);
  assert.equal((await call(opsManager.id, "/api/v1/chat/groups", "POST", { name: "Mixed", member_ids: [dispatchAgent.id] })).status, 422);
  const created = await call(opsManager.id, "/api/v1/chat/groups", "POST", { name: "Load desk", member_ids: [salesAgent.id] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const group = created.body.conversation_id;
  const members = () => tables.chat_members.filter((row) => row.conversation_id === group).map((row) => `${row.user_id}:${row.role}`).sort();
  assert.deepEqual(members(), [`${opsManager.id}:ADMIN`, `${salesAgent.id}:MEMBER`].sort());

  assert.equal((await call(opsManager.id, `/api/v1/chat/groups/${group}`, "PATCH", { add_members: [opsAgent.id] })).status, 200);
  assert.ok(members().includes(`${opsAgent.id}:MEMBER`));
  assert.equal((await call(salesAgent.id, `/api/v1/chat/groups/${group}`, "PATCH", { remove_members: [opsAgent.id] })).status, 403, "only the admin");
  assert.equal((await call(opsManager.id, `/api/v1/chat/groups/${group}`, "PATCH", { remove_members: [salesAgent.id] })).status, 200);
  assert.ok(!members().some((row) => row.startsWith(salesAgent.id)));
  assert.equal((await call(opsManager.id, `/api/v1/chat/groups/${group}`, "PATCH", { remove_members: [opsManager.id] })).status, 422, "the admin stays");
});

test("an agent messages only the managers of their own business unit", async () => {
  const dispatchManager = profile(40, "MANAGER", dispatchDept);
  tables.profiles.push(dispatchManager);
  assert.ok([200, 201].includes((await call(salesAgent.id, "/api/v1/chat/direct", "POST", { user_id: opsManager.id })).status), "allowed (already open from the first test)");
  assert.equal((await call(salesAgent.id, "/api/v1/chat/direct", "POST", { user_id: dispatchManager.id })).status, 403);
  assert.equal((await call(dispatchAgent.id, "/api/v1/chat/direct", "POST", { user_id: dispatchManager.id })).status, 201);
  assert.equal((await call(dispatchAgent.id, "/api/v1/chat/direct", "POST", { user_id: opsManager.id })).status, 403);
  assert.equal((await call(opsManager.id, "/api/v1/chat/direct", "POST", { user_id: dispatchManager.id })).status, 201, "managers still talk across the company");
  const inbox = await call(salesAgent.id, "/api/v1/chat/inbox"); assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  const contacts = inbox.body.contacts.map((person: any) => person.id);
  assert.ok(contacts.includes(opsManager.id) && !contacts.includes(dispatchManager.id));
});
