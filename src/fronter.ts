import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Fronters (Brokerage lead mining). Fronters work raw prospects in a spreadsheet: add, paste, import, edit and set
 * a status. When a prospect is marked Qualified it becomes a normal Brokerage Sales lead for the agent chosen in
 * "Assign to", and it locks for the Fronter. Only Sales converts leads to customers. Reports credit each Fronter
 * with what they mined, qualified and what became a customer.
 */

type Actor = { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null };
type Scope = { teamIds: string[]; leadTeamIds: string[]; memberIds: string[]; permissions: Set<string> };
type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
type Req = Request & { actor?: Actor };
type Deps = {
  adminClient: () => SupabaseClient;
  requireUser: Handler;
  writeAudit: (supabase: SupabaseClient, actorId: string, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => Promise<void>;
  teamScope: (actor: Actor) => Promise<Scope>;
};

const uuid = z.string().uuid();
const text = (max: number) => z.preprocess((value) => value === "" || value === undefined ? null : typeof value === "number" ? String(value) : value, z.string().trim().max(max).nullable()).optional();
/** Company details shared by a mined prospect and the Sales lead it becomes (see migration 018). */
export const leadDetailKeys = ["operator_name", "operator_number", "truck_type", "load_type", "shipping_volume", "commodity", "lanes", "physical_address", "other_locations", "billing_address", "billing_contact", "billing_phone", "billing_email", "payment_terms", "w9_received", "ein", "website"] as const;

export const prospectStatuses = ["NEW", "CONTACTED", "NOT_QUALIFIED", "NOT_INTERESTED", "QUALIFIED"] as const;
const prospectFields = {
  company_name: z.string().trim().min(1).max(180),
  operator_name: text(160), operator_number: text(60), shipping_contact: text(160), phone: text(40),
  email: z.preprocess((value) => value === "" || value === undefined ? null : value, z.string().trim().email("Enter a valid email").max(180).nullable()).optional(),
  truck_type: text(80), load_type: z.preprocess((value) => value === "" || value === undefined ? null : typeof value === "string" ? value.toUpperCase() : value, z.enum(["FTL", "LTL", "BOTH"]).nullable()).optional(),
  shipping_volume: text(120), commodity: text(160), lanes: text(500),
  physical_address: text(300), other_locations: text(500), billing_address: text(300),
  billing_contact: text(160), billing_phone: text(40), billing_email: z.preprocess((value) => value === "" || value === undefined ? null : value, z.string().trim().email("Enter a valid billing email").max(180).nullable()).optional(),
  payment_terms: text(80), w9_received: z.preprocess((value) => typeof value === "string" ? ["y", "yes", "true", "1"].includes(value.trim().toLowerCase()) : value, z.boolean()).optional(),
  ein: text(20), source: text(120), website: text(240), notes: text(3000),
};
const prospectSchema = z.object(prospectFields);
const prospectUpdateSchema = z.object({ ...prospectFields, company_name: prospectFields.company_name.optional(), status: z.enum(prospectStatuses).optional(), assigned_to: uuid.nullable().optional() }).strict();
const commoditySchema = z.object({ commodity: z.string().trim().min(1).max(160), trucks_used: text(300), best_states: text(300), notes: text(1000) });

export function registerFronterRoutes(app: Express, deps: Deps) {
  const { adminClient, requireUser, writeAudit, teamScope } = deps;
  const isSuper = (actor: Actor) => actor.role === "SUPER_ADMIN";
  const isManager = (actor: Actor) => actor.role === "MANAGER";
  const isFronter = (actor: Actor) => actor.department?.business_unit === "BROKERAGE" && actor.department?.function === "FRONTER";
  const inTeam = (scope: Scope, teamId?: string | null, personId?: string | null) => Boolean((teamId && scope.leadTeamIds.includes(teamId)) || (personId && scope.memberIds.includes(personId)));
  const lead = (scope: Scope, permission: string, row: any) => scope.leadTeamIds.length > 0 && scope.permissions.has(permission) && inTeam(scope, row.team_id, row.created_by);

  function fronterOnly(request: Req, response: Response, next: NextFunction) {
    const actor = request.actor!;
    if (isSuper(actor) || isFronter(actor)) return next();
    return response.status(403).json({ error: "This area is for the Fronters department." });
  }
  const guard = [requireUser, fronterOnly] as Handler[];
  const canView = (actor: Actor, scope: Scope, row: any) => isSuper(actor) || (isManager(actor) && row.department_id === actor.department_id) || row.created_by === actor.id || lead(scope, "fronter.prospects.view_team", row);
  const canEdit = (actor: Actor, scope: Scope, row: any) => row.status !== "QUALIFIED" && (isSuper(actor) || (isManager(actor) && row.department_id === actor.department_id) || row.created_by === actor.id || lead(scope, "fronter.prospects.edit_team", row));

  async function salesAgents(supabase: SupabaseClient) {
    const { data } = await supabase.from("profiles").select("id, full_name, department_id, departments!profiles_department_id_fkey(id, name, business_unit, function, is_active)").eq("role", "AGENT").eq("is_active", true).order("full_name");
    return (data ?? []).map((row: any) => ({ ...row, department: Array.isArray(row.departments) ? row.departments[0] : row.departments }))
      .filter((row: any) => row.department?.business_unit === "BROKERAGE" && row.department?.function === "SALES" && row.department?.is_active)
      .map((row: any) => ({ id: row.id, full_name: row.full_name, department_id: row.department_id, department: row.department.name }));
  }
  async function names(supabase: SupabaseClient, ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    if (!unique.length) return new Map<string, string>();
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", unique);
    return new Map((data ?? []).map((row: any) => [row.id as string, row.full_name as string]));
  }

  /** Brokerage Sales agents for the "Assign to" dropdown. */
  app.get("/api/v1/fronter/sales-agents", ...guard, async (_request: Req, response, next) => {
    try { response.json({ agents: await salesAgents(adminClient()) }); } catch (error) { next(error); }
  });

  app.get("/api/v1/fronter/prospects", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      let query = supabase.from("fronter_prospects").select("*").order("created_at", { ascending: false }).limit(5000);
      if (!isSuper(actor)) query = query.eq("department_id", actor.department_id!);
      const { data, error } = await query; if (error) throw error;
      const rows = (data ?? []).filter((row: any) => canView(actor, scope, row));
      const people = await names(supabase, rows.flatMap((row: any) => [row.created_by, row.assigned_to]));
      const leadIds = rows.map((row: any) => row.lead_id).filter(Boolean);
      const { data: leads } = leadIds.length ? await supabase.from("sales_leads").select("id, stage").in("id", leadIds) : { data: [] as any[] };
      const stageOf = new Map((leads ?? []).map((row: any) => [row.id, row.stage]));
      response.json({ prospects: rows.map((row: any) => ({ ...row, created_by_name: people.get(row.created_by) ?? null, assigned_name: row.assigned_to ? people.get(row.assigned_to) ?? null : null, lead_stage: row.lead_id ? stageOf.get(row.lead_id) ?? null : null, editable: canEdit(actor, scope, row) })) });
    } catch (error) { next(error); }
  });

  /** One row or many (paste / CSV import). Rows without a company name are skipped and reported. */
  app.post("/api/v1/fronter/prospects", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient();
      if (!isFronter(actor) || !actor.department_id) return response.status(403).json({ error: "Prospects are added by the Fronters department." });
      const body = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000) }).parse(request.body);
      const valid: any[] = []; const skipped: { row: number; error: string }[] = [];
      body.rows.forEach((row, index) => {
        const parsed = prospectSchema.safeParse(row);
        if (parsed.success) valid.push({ ...parsed.data, department_id: actor.department_id, created_by: actor.id });
        else skipped.push({ row: index + 1, error: parsed.error.issues[0]?.message ?? "Invalid row" });
      });
      if (!valid.length) return response.status(422).json({ error: "No rows could be added. Each row needs a company name.", skipped });
      const { data, error } = await supabase.from("fronter_prospects").insert(valid).select(); if (error) throw error;
      await writeAudit(supabase, actor.id, "PROSPECTS_ADDED", "fronter_prospect", data[0].id, { count: data.length });
      response.status(201).json({ prospects: data, added: data.length, skipped });
    } catch (error) { next(error); }
  });

  /** A cell edit, a status change or the assignee. Qualified turns the row into a Sales lead and locks it. */
  app.patch("/api/v1/fronter/prospects/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = prospectUpdateSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: row } = await supabase.from("fronter_prospects").select("*").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!row) return response.status(404).json({ error: "Prospect not found." });
      if (row.status === "QUALIFIED") return response.status(422).json({ error: "This prospect is qualified and now belongs to Brokerage Sales." });
      if (!canEdit(actor, scope, row)) return response.status(403).json({ error: "You can't edit this prospect." });
      const { status, assigned_to, ...fields } = input;
      if (assigned_to) { const agents = await salesAgents(supabase); if (!agents.some((agent) => agent.id === assigned_to)) return response.status(422).json({ error: "Assign to an active Brokerage Sales agent." }); }
      const next_ = { ...row, ...fields, ...(assigned_to !== undefined ? { assigned_to } : {}) };

      if (status === "QUALIFIED") {
        const qualifier = isSuper(actor) || isManager(actor) || row.created_by === actor.id || lead(scope, "fronter.prospects.qualify", row);
        if (!qualifier) return response.status(403).json({ error: "You can't qualify this prospect." });
        if (!next_.assigned_to) return response.status(422).json({ error: "Choose a Sales agent in “Assign to” before qualifying." });
        const { data: owner } = await supabase.from("profiles").select("id, department_id").eq("id", next_.assigned_to).single();
        // The lead takes over everything the Fronter collected, so Sales sees and edits it on the lead itself.
        const { data: membership } = await supabase.from("team_members").select("team_id").eq("user_id", next_.assigned_to).limit(1).maybeSingle();
        const { data: created, error: leadError } = await supabase.from("sales_leads").insert({
          department_id: owner!.department_id, owner_id: next_.assigned_to, team_id: membership?.team_id ?? null, company_name: next_.company_name,
          contact_name: next_.shipping_contact || next_.operator_name || null, contact_email: next_.email || null, contact_phone: next_.phone || null,
          stage: "QUALIFIED", source: `Fronter${next_.source ? ` · ${next_.source}` : ""}`, notes: next_.notes || null, fronter_prospect_id: row.id,
          ...Object.fromEntries(leadDetailKeys.map((key) => [key, (next_ as any)[key] ?? (key === "w9_received" ? false : null)])),
        }).select("id").single();
        if (leadError) throw leadError;
        // A Qualified lead gets its customer profile straight away (client flow v2).
        await supabase.from("brokerage_customers").upsert({ lead_id: created.id, sales_department_id: owner!.department_id, owner_id: next_.assigned_to, company_name: next_.company_name, contact_name: next_.shipping_contact || next_.operator_name || null, contact_email: next_.email || null, contact_phone: next_.phone || null }, { onConflict: "lead_id" });
        const { data, error } = await supabase.from("fronter_prospects").update({ ...fields, assigned_to: next_.assigned_to, status: "QUALIFIED", lead_id: created.id, qualified_by: actor.id, qualified_at: new Date().toISOString() }).eq("id", row.id).select().single(); if (error) throw error;
        const { data: managers } = await supabase.from("profiles").select("id").eq("department_id", owner!.department_id).eq("role", "MANAGER").eq("is_active", true);
        const recipients = [...new Set([next_.assigned_to, ...(managers ?? []).map((manager: any) => manager.id)])].filter((id) => id !== actor.id);
        if (recipients.length) await supabase.from("notifications").insert(recipients.map((recipient_id) => ({ recipient_id, kind: "LEAD_ASSIGNED", title: recipient_id === next_.assigned_to ? "New qualified lead for you" : "New qualified lead from Fronters", body: next_.company_name, entity_type: "LEAD", entity_id: created.id })));
        await writeAudit(supabase, actor.id, "PROSPECT_QUALIFIED", "fronter_prospect", row.id, { from_status: row.status, to_status: "QUALIFIED", lead_id: created.id, assigned_to: next_.assigned_to });
        return response.json({ prospect: data, lead_id: created.id });
      }

      const update = { ...fields, ...(assigned_to !== undefined ? { assigned_to } : {}), ...(status ? { status } : {}) };
      if (!Object.keys(update).length) return response.status(422).json({ error: "Nothing to update." });
      const { data, error } = await supabase.from("fronter_prospects").update(update).eq("id", row.id).select().single(); if (error) throw error;
      if (status && status !== row.status) await writeAudit(supabase, actor.id, "PROSPECT_STATUS_CHANGED", "fronter_prospect", row.id, { from_status: row.status, to_status: status });
      response.json({ prospect: data });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/fronter/prospects/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: row } = await supabase.from("fronter_prospects").select("*").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!row) return response.status(404).json({ error: "Prospect not found." });
      if (!canEdit(actor, scope, row)) return response.status(403).json({ error: row.status === "QUALIFIED" ? "Qualified prospects can't be deleted." : "You can't delete this prospect." });
      const { error } = await supabase.from("fronter_prospects").delete().eq("id", row.id); if (error) throw error;
      await writeAudit(supabase, actor.id, "PROSPECT_DELETED", "fronter_prospect", row.id, { company_name: row.company_name });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Commodities sheet ----------------------------------------------------------------------------------------
  app.get("/api/v1/fronter/commodities", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient();
      let query = supabase.from("fronter_commodities").select("*").order("commodity");
      if (!isSuper(actor)) query = query.eq("department_id", actor.department_id!);
      const { data, error } = await query; if (error) throw error;
      const people = await names(supabase, (data ?? []).map((row: any) => row.created_by));
      response.json({ commodities: (data ?? []).map((row: any) => ({ ...row, created_by_name: people.get(row.created_by) ?? null, editable: isSuper(actor) || isManager(actor) || row.created_by === actor.id })) });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/fronter/commodities", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = commoditySchema.parse(request.body); const supabase = adminClient();
      if (!isFronter(actor) || !actor.department_id) return response.status(403).json({ error: "Commodities are added by the Fronters department." });
      const { data, error } = await supabase.from("fronter_commodities").insert({ ...input, department_id: actor.department_id, created_by: actor.id }).select().single(); if (error) throw error;
      response.status(201).json({ commodity: data });
    } catch (error) { next(error); }
  });
  app.patch("/api/v1/fronter/commodities/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = commoditySchema.partial().strict().parse(request.body); const supabase = adminClient();
      const { data: row } = await supabase.from("fronter_commodities").select("*").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!row) return response.status(404).json({ error: "Commodity not found." });
      if (!(isSuper(actor) || (isManager(actor) && row.department_id === actor.department_id) || row.created_by === actor.id)) return response.status(403).json({ error: "You can't edit this row." });
      const { data, error } = await supabase.from("fronter_commodities").update(input).eq("id", row.id).select().single(); if (error) throw error;
      response.json({ commodity: data });
    } catch (error) { next(error); }
  });
  app.delete("/api/v1/fronter/commodities/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient();
      const { data: row } = await supabase.from("fronter_commodities").select("*").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!row) return response.status(404).json({ error: "Commodity not found." });
      if (!(isSuper(actor) || (isManager(actor) && row.department_id === actor.department_id) || row.created_by === actor.id)) return response.status(403).json({ error: "You can't delete this row." });
      const { error } = await supabase.from("fronter_commodities").delete().eq("id", row.id); if (error) throw error;
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Reports: credit per Fronter ------------------------------------------------------------------------------
  app.get("/api/v1/fronter/reports", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const range = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), agent_id: uuid.optional() }).parse(request.query);
      let query = supabase.from("fronter_prospects").select("id, created_by, team_id, department_id, status, lead_id, created_at, qualified_at").limit(20000);
      if (!isSuper(actor)) query = query.eq("department_id", actor.department_id!);
      if (range.from) query = query.gte("created_at", `${range.from}T00:00:00.000Z`);
      if (range.to) query = query.lte("created_at", `${range.to}T23:59:59.999Z`);
      const { data, error } = await query; if (error) throw error;
      const teamView = isSuper(actor) || isManager(actor) || (scope.leadTeamIds.length > 0 && scope.permissions.has("fronter.reports.view_team"));
      let rows = (data ?? []).filter((row: any) => teamView ? canView(actor, scope, row) : row.created_by === actor.id);
      if (range.agent_id) rows = rows.filter((row: any) => row.created_by === range.agent_id);
      const leadIds = rows.map((row: any) => row.lead_id).filter(Boolean);
      const [{ data: leads }, { data: customers }] = leadIds.length ? await Promise.all([
        supabase.from("sales_leads").select("id, stage").in("id", leadIds),
        supabase.from("brokerage_customers").select("id, lead_id").in("lead_id", leadIds),
      ]) : [{ data: [] as any[] }, { data: [] as any[] }];
      const customerIds = (customers ?? []).map((row: any) => row.id);
      const { data: shipments } = customerIds.length ? await supabase.from("brokerage_shipments").select("customer_id, sales_status, amount_agreed, amount_quoted, sales_quotes(stage)").in("customer_id", customerIds) : { data: [] as any[] };
      const customerOfLead = new Map((customers ?? []).map((row: any) => [row.lead_id, row.id]));
      const grossOfCustomer = new Map<string, number>();
      // Same rule as payroll: a load counts once a Sales Manager has approved its rate (or it has moved on from there).
      (shipments ?? []).forEach((row: any) => { const quote = Array.isArray(row.sales_quotes) ? row.sales_quotes[0] : row.sales_quotes; if (row.sales_status !== "CANCELLED" && (["APPROVED", "HANDED_OFF"].includes(quote?.stage) || ["BOOKED", "DELIVERED", "PAID"].includes(row.sales_status))) grossOfCustomer.set(row.customer_id, (grossOfCustomer.get(row.customer_id) ?? 0) + Number(row.amount_agreed ?? row.amount_quoted ?? 0)); });
      const stageOf = new Map((leads ?? []).map((row: any) => [row.id, row.stage]));
      const people = await names(supabase, rows.map((row: any) => row.created_by));
      const round = (value: number) => Math.round(value * 100) / 100;
      const personIds = [...new Set(rows.map((row: any) => row.created_by))] as string[];
      const byPerson = personIds.map((id) => {
        const mine = rows.filter((row: any) => row.created_by === id);
        const qualified = mine.filter((row: any) => row.status === "QUALIFIED");
        // "Became a customer" is the Customer status (an agreed rate), not just having a profile: Qualified leads get one at once.
        const won = qualified.filter((row: any) => row.lead_id && stageOf.get(row.lead_id) === "CUSTOMER");
        return {
          id, name: people.get(id) ?? "Unknown", prospects: mine.length,
          ...Object.fromEntries(prospectStatuses.map((status) => [status.toLowerCase(), mine.filter((row: any) => row.status === status).length])),
          customers: won.length, conversion: qualified.length ? Math.round((won.length / qualified.length) * 100) : 0,
          gross: round(won.reduce((sum: number, row: any) => sum + (grossOfCustomer.get(customerOfLead.get(row.lead_id)) ?? 0), 0)),
        };
      }).sort((left: any, right: any) => right.qualified - left.qualified);
      const total = (key: string) => byPerson.reduce((sum: number, row: any) => sum + Number(row[key] ?? 0), 0);
      response.json({ team_view: teamView, totals: { prospects: rows.length, qualified: total("qualified"), customers: total("customers"), gross: round(total("gross")), not_qualified: total("not_qualified"), not_interested: total("not_interested") }, people: byPerson, agents: byPerson.map((row: any) => ({ id: row.id, full_name: row.name })) });
    } catch (error) { next(error); }
  });
}
