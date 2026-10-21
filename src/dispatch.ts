import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Dispatch module (client spec 3.4 Dispatch Sales DS-1..DS-13, 3.5 Dispatch operations DP-1..DP-11, 8.2 states).
 *
 * Flow (with the client's answers):
 *  Dispatch Sales agent creates a carrier (MC/DOT), its trucks, documents and activities, then submits it.
 *  Dispatch Sales Manager approves (hands the carrier to Dispatch Operations), returns it for rework, or discards it.
 *  Dispatch Manager assigns each truck to a Dispatcher. The Dispatcher runs the truck, logs every load and creates a
 *  weekly invoice per truck (gross x charge %). The Dispatch Manager reviews and forwards it to accounting; once paid,
 *  the Dispatch Sales Manager signs it off, and signed-off revenue is what payroll counts (PY-5).
 *
 * Access (AC-3, AC-4): agents and dispatchers see their own records, managers their department, Team Leads their
 * team (records tagged with the team or owned/assigned to a member), the Director everything.
 */

type Actor = { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null };
type Scope = { teamIds: string[]; leadTeamIds: string[]; memberIds: string[]; permissions: Set<string> };
type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
type Deps = {
  adminClient: () => SupabaseClient;
  requireUser: Handler;
  writeAudit: (supabase: SupabaseClient, actorId: string, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => Promise<void>;
  teamScope: (actor: Actor) => Promise<Scope>;
  withAuthorDetails: (supabase: SupabaseClient, rows: any[], actorId: string, canManage?: boolean) => Promise<any[]>;
};
type Req = Request & { actor?: Actor };

export const truckTypes = ["DRY_VAN", "REEFER", "FLATBED", "STEP_DECK", "POWER_ONLY", "BOX_TRUCK", "HOTSHOT", "OTHER"] as const;
export const requiredDocuments = ["MC_AUTHORITY", "W9", "COI"] as const;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const uuid = z.string().uuid();
const optionalText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).nullable().optional());
const money = z.number().nonnegative().max(10_000_000);

const carrierSchema = z.object({
  company_name: z.string().trim().min(2).max(180),
  mc_number: optionalText(20), dot_number: optionalText(20),
  contact_name: optionalText(160), phone: optionalText(40), email: z.preprocess((value) => value === "" ? null : value, z.string().trim().email().max(180).nullable().optional()),
  operating_pattern: optionalText(3000),
  charge_percent: z.number().min(0).max(100).nullable().optional(),
  payment_method: z.enum(["ACH", "CHECK", "ZELLE", "WIRE", "FACTORING", "OTHER"]).nullable().optional(),
  trucks: z.array(z.object({ unit_number: z.string().trim().min(1).max(40), truck_type: z.enum(truckTypes), equipment_notes: optionalText(500) })).max(50).optional(),
}).refine((value) => value.mc_number || value.dot_number, { message: "Enter an MC or DOT number", path: ["mc_number"] });
const carrierUpdateSchema = z.object({
  company_name: z.string().trim().min(2).max(180).optional(),
  mc_number: optionalText(20), dot_number: optionalText(20),
  contact_name: optionalText(160), phone: optionalText(40), email: z.preprocess((value) => value === "" ? null : value, z.string().trim().email().max(180).nullable().optional()),
  operating_pattern: optionalText(3000),
  charge_percent: z.number().min(0).max(100).nullable().optional(),
  payment_method: z.enum(["ACH", "CHECK", "ZELLE", "WIRE", "FACTORING", "OTHER"]).nullable().optional(),
  owner_id: uuid.optional(), team_id: uuid.nullable().optional(),
}).strict();
const truckSchema = z.object({ unit_number: z.string().trim().min(1).max(40), truck_type: z.enum(truckTypes), equipment_notes: optionalText(500) });
const truckUpdateSchema = z.object({
  unit_number: z.string().trim().min(1).max(40).optional(), truck_type: z.enum(truckTypes).optional(), equipment_notes: optionalText(500),
  status: z.enum(["RUNNING", "INACTIVE", "DNC", "DISCARDED"]).optional(), dnc_reason: optionalText(500),
  assigned_to: uuid.nullable().optional(), team_id: uuid.nullable().optional(),
}).strict();
const activitySchema = z.object({ activity_type: z.enum(["CALL", "CALLBACK", "APPOINTMENT", "FOLLOW_UP", "EMAIL", "NOTE"]), body: z.string().trim().min(1).max(3000), due_at: z.string().datetime().nullable().optional() });
const fileSchema = z.object({ file_name: z.string().trim().min(1).max(180), content_type: z.enum(["application/pdf", "image/jpeg", "image/png"], { message: "Only PDF, JPG, JPEG, and PNG files are allowed" }), file_size: z.number().int().positive().max(MAX_DOCUMENT_BYTES, { message: "File is larger than 10 MB" }).optional() });
const documentSchema = z.object({ document_type: z.enum(["MC_AUTHORITY", "W9", "COI", "PACKET", "OTHER"]), file_name: z.string().trim().min(1).max(180), storage_path: z.string().trim().min(3).max(500) });
const reviewSchema = z.object({ action: z.enum(["APPROVE", "RETURN", "DISCARD"]), note: z.string().trim().max(1000).optional(), dispatch_department_id: uuid.optional() })
  .superRefine((value, context) => {
    if (value.action !== "APPROVE" && !value.note) context.addIssue({ code: "custom", path: ["note"], message: "Add a comment for the agent" });
    if (value.action === "APPROVE" && !value.dispatch_department_id) context.addIssue({ code: "custom", path: ["dispatch_department_id"], message: "Choose the Dispatch Operations department" });
  });
const loadSchema = z.object({
  load_number: optionalText(60), broker_name: optionalText(160),
  pickup_city: optionalText(120), pickup_zip: optionalText(10), pickup_date: z.string().date(),
  delivery_city: optionalText(120), delivery_zip: optionalText(10), delivery_date: z.preprocess((value) => value === "" ? null : value, z.string().date().nullable().optional()),
  rate: money, miles: z.number().int().nonnegative().max(20_000).nullable().optional(),
  status: z.enum(["BOOKED", "DELIVERED", "CANCELLED"]).optional(), notes: optionalText(1000),
});
const invoiceActionSchema = z.object({ action: z.enum(["SUBMIT", "RETURN", "FORWARD", "PAY", "CANCEL", "SIGN_OFF", "RECALCULATE"]), note: z.string().trim().max(1000).optional(), amount_paid: money.optional() });
const targetSchema = z.object({ period_type: z.enum(["WEEKLY", "MONTHLY"]), amount: money });
const commentSchema = z.object({ entity_type: z.enum(["CARRIER", "TRUCK", "DISPATCH_INVOICE"]), entity_id: uuid, body: z.string().trim().min(1).max(3000) });

/** Monday (UTC) of the week containing the date, as YYYY-MM-DD. */
export function weekStart(value: string | Date) {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}
const addDays = (day: string, days: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const round = (value: number) => Math.round(value * 100) / 100;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

export function registerDispatchRoutes(app: Express, deps: Deps) {
  const { adminClient, requireUser, writeAudit, teamScope, withAuthorDetails } = deps;

  // ---- Who is who --------------------------------------------------------------------------------------------
  const isSuper = (actor: Actor) => actor.role === "SUPER_ADMIN";
  const isManager = (actor: Actor) => actor.role === "MANAGER";
  const isDispatchSales = (actor: Actor) => actor.department?.business_unit === "DISPATCH" && actor.department?.function === "SALES";
  const isDispatchOps = (actor: Actor) => actor.department?.business_unit === "DISPATCH" && actor.department?.function === "OPERATIONS";
  const inTeam = (scope: Scope, teamId?: string | null, personId?: string | null) => Boolean((teamId && scope.leadTeamIds.includes(teamId)) || (personId && scope.memberIds.includes(personId)));
  const lead = (scope: Scope, permission: string, teamId?: string | null, personId?: string | null) => scope.leadTeamIds.length > 0 && scope.permissions.has(permission) && inTeam(scope, teamId, personId);

  function dispatchOnly(request: Req, response: Response, next: NextFunction) {
    const actor = request.actor!;
    if (isSuper(actor) || actor.department?.business_unit === "DISPATCH") return next();
    return response.status(403).json({ error: "Dispatch access is required." });
  }
  const guard = [requireUser, dispatchOnly] as Handler[];

  // Carrier rights (Dispatch Sales side) ------------------------------------------------------------------------
  const carrierSalesView = (actor: Actor, scope: Scope, carrier: any) => isSuper(actor)
    || (isDispatchSales(actor) && isManager(actor) && actor.department_id === carrier.department_id)
    || carrier.owner_id === actor.id
    || lead(scope, "dispatch_sales.carriers.view_team", carrier.team_id, carrier.owner_id);
  const carrierSalesEdit = (actor: Actor, scope: Scope, carrier: any) => isSuper(actor)
    || (isDispatchSales(actor) && isManager(actor) && actor.department_id === carrier.department_id)
    || carrier.owner_id === actor.id
    || lead(scope, "dispatch_sales.carriers.edit_team", carrier.team_id, carrier.owner_id);
  const carrierReview = (actor: Actor, scope: Scope, carrier: any) => isSuper(actor)
    || (isDispatchSales(actor) && isManager(actor) && actor.department_id === carrier.department_id)
    || lead(scope, "dispatch_sales.carriers.review", carrier.team_id, carrier.owner_id);
  const carrierAssign = (actor: Actor, scope: Scope, carrier: any) => isSuper(actor)
    || (isDispatchSales(actor) && isManager(actor) && actor.department_id === carrier.department_id)
    || lead(scope, "dispatch_sales.carriers.assign", carrier.team_id, carrier.owner_id);

  // Truck rights (Dispatch Operations side) ---------------------------------------------------------------------
  const truckOpsView = (actor: Actor, scope: Scope, truck: any) => isSuper(actor)
    || (isDispatchOps(actor) && isManager(actor) && !!truck.dispatch_department_id && actor.department_id === truck.dispatch_department_id)
    || truck.assigned_to === actor.id
    || lead(scope, "dispatch.trucks.view_team", truck.team_id, truck.assigned_to);
  const truckOpsUpdate = (actor: Actor, scope: Scope, truck: any) => isSuper(actor)
    || (isDispatchOps(actor) && isManager(actor) && !!truck.dispatch_department_id && actor.department_id === truck.dispatch_department_id)
    || truck.assigned_to === actor.id
    || lead(scope, "dispatch.trucks.update_team", truck.team_id, truck.assigned_to);
  const truckAssign = (actor: Actor, scope: Scope, truck: any) => isSuper(actor)
    || (isDispatchOps(actor) && isManager(actor) && !!truck.dispatch_department_id && actor.department_id === truck.dispatch_department_id)
    || lead(scope, "dispatch.trucks.assign", truck.team_id, truck.assigned_to);
  const invoiceReview = (actor: Actor, scope: Scope, invoice: any, truck: any) => isSuper(actor)
    || (isDispatchOps(actor) && isManager(actor) && actor.department_id === invoice.dispatch_department_id)
    || lead(scope, "dispatch.invoices.review", truck?.team_id, invoice.dispatcher_id);
  const invoiceSignOff = (actor: Actor, scope: Scope, invoice: any, carrier: any) => isSuper(actor)
    || (isDispatchSales(actor) && isManager(actor) && actor.department_id === invoice.sales_department_id)
    || lead(scope, "dispatch_sales.invoices.signoff", carrier?.team_id, carrier?.owner_id);

  /** A carrier is visible from the Sales side, or from Operations through any of its trucks. */
  const carrierVisible = (actor: Actor, scope: Scope, carrier: any, trucks: any[]) => carrierSalesView(actor, scope, carrier) || trucks.some((truck) => truckOpsView(actor, scope, truck));
  const truckVisible = (actor: Actor, scope: Scope, truck: any, carrier: any) => truckOpsView(actor, scope, truck) || carrierSalesView(actor, scope, carrier);

  async function notify(supabase: SupabaseClient, recipients: (string | null | undefined)[], actorId: string, kind: string, title: string, body: string, entityType: string, entityId: string) {
    const rows = [...new Set(recipients.filter((id): id is string => Boolean(id) && id !== actorId))].map((recipient_id) => ({ recipient_id, kind, title, body: body.slice(0, 140), entity_type: entityType, entity_id: entityId }));
    if (rows.length) await supabase.from("notifications").insert(rows);
  }
  async function managersOf(supabase: SupabaseClient, departmentId: string | null | undefined) {
    if (!departmentId) return [] as string[];
    const { data } = await supabase.from("profiles").select("id").eq("department_id", departmentId).eq("role", "MANAGER").eq("is_active", true);
    return (data ?? []).map((row: any) => row.id as string);
  }
  async function names(supabase: SupabaseClient, ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    if (!unique.length) return new Map<string, string>();
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", unique);
    return new Map((data ?? []).map((row: any) => [row.id as string, row.full_name as string]));
  }
  async function teamNames(supabase: SupabaseClient, ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    if (!unique.length) return new Map<string, string>();
    const { data } = await supabase.from("teams").select("id, name").in("id", unique);
    return new Map((data ?? []).map((row: any) => [row.id as string, row.name as string]));
  }
  async function departmentPeople(supabase: SupabaseClient, departmentId: string, ids: string[]) {
    if (!ids.length) return true;
    const { data } = await supabase.from("profiles").select("id").eq("department_id", departmentId).eq("is_active", true).eq("role", "AGENT").in("id", ids);
    return (data ?? []).length === new Set(ids).size;
  }
  /** Duplicate MC/DOT (DS-4): other carriers with the same number, with the agent who owns them. */
  async function duplicates(supabase: SupabaseClient, mc?: string | null, dot?: string | null, excludeId?: string) {
    const filters = [mc ? `mc_number.ilike.${mc.replace(/[,()]/g, "")}` : "", dot ? `dot_number.ilike.${dot.replace(/[,()]/g, "")}` : ""].filter(Boolean);
    if (!filters.length) return [];
    let query = supabase.from("dispatch_carriers").select("id, company_name, mc_number, dot_number, owner_id, review_status").or(filters.join(",")).limit(10);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query;
    const owners = await names(supabase, (data ?? []).map((row: any) => row.owner_id));
    const { data: dnc } = (data ?? []).length ? await supabase.from("dispatch_trucks").select("carrier_id").in("carrier_id", (data ?? []).map((row: any) => row.id)).eq("status", "DNC") : { data: [] as any[] };
    const dncCarriers = new Set((dnc ?? []).map((row: any) => row.carrier_id));
    return (data ?? []).map((row: any) => ({ ...row, owner_name: owners.get(row.owner_id) ?? "Another agent", dnc: dncCarriers.has(row.id) }));
  }
  /** Weekly gross per truck from its loads (answer 3): every non-cancelled load counts in the week it is picked up. */
  async function grossByTruckWeek(supabase: SupabaseClient, truckIds: string[], from?: string, to?: string) {
    if (!truckIds.length) return [] as any[];
    let query = supabase.from("dispatch_loads").select("id, truck_id, dispatcher_id, pickup_date, rate, status").in("truck_id", truckIds).neq("status", "CANCELLED");
    if (from) query = query.gte("pickup_date", from);
    if (to) query = query.lte("pickup_date", to);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  // ---- Workspace-level data ----------------------------------------------------------------------------------

  /** People and teams the actor may assign to; Dispatch Operations departments for hand-off. */
  app.get("/api/v1/dispatch/directory", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const departmentId = actor.department_id;
      let users: any[] = []; let teams: any[] = [];
      if (departmentId && (isManager(actor) || scope.leadTeamIds.length)) {
        let userQuery = supabase.from("profiles").select("id, full_name, email, role").eq("department_id", departmentId).eq("is_active", true).eq("role", "AGENT").order("full_name");
        let teamQuery = supabase.from("teams").select("id, name, team_lead_id").eq("department_id", departmentId).eq("is_active", true).order("name");
        if (!isManager(actor)) { userQuery = userQuery.in("id", scope.memberIds.length ? scope.memberIds : [actor.id]); teamQuery = teamQuery.in("id", scope.leadTeamIds); }
        const [{ data: people }, { data: teamRows }] = await Promise.all([userQuery, teamQuery]);
        users = people ?? []; teams = teamRows ?? [];
      }
      const { data: operations } = await supabase.from("departments").select("id, name").eq("business_unit", "DISPATCH").eq("function", "OPERATIONS").eq("is_active", true).order("name");
      response.json({ users, teams, operations_departments: operations ?? [] });
    } catch (error) { next(error); }
  });

  /** Real-time duplicate check while typing (DS-4). */
  app.get("/api/v1/dispatch/duplicates", ...guard, async (request: Req, response, next) => {
    try {
      const query = z.object({ mc: z.string().trim().max(20).optional(), dot: z.string().trim().max(20).optional(), exclude: uuid.optional() }).parse(request.query);
      response.json({ matches: await duplicates(adminClient(), query.mc || null, query.dot || null, query.exclude) });
    } catch (error) { next(error); }
  });

  // ---- Carriers (Dispatch Sales) -----------------------------------------------------------------------------

  app.get("/api/v1/dispatch/carriers", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      let query = supabase.from("dispatch_carriers").select("*, dispatch_trucks(id, unit_number, truck_type, status, assigned_to, team_id, dispatch_department_id)").order("updated_at", { ascending: false }).limit(500);
      if (!isSuper(actor)) query = isDispatchSales(actor) ? query.eq("department_id", actor.department_id!) : query.eq("dispatch_department_id", actor.department_id!);
      const { data, error } = await query; if (error) throw error;
      const rows = (data ?? []).filter((carrier: any) => carrierVisible(actor, scope, carrier, carrier.dispatch_trucks ?? []));
      const owners = await names(supabase, rows.map((row: any) => row.owner_id));
      response.json({ carriers: rows.map((row: any) => ({ ...row, trucks: row.dispatch_trucks ?? [], dispatch_trucks: undefined, owner_name: owners.get(row.owner_id) ?? null })) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/dispatch/carriers", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = carrierSchema.parse(request.body); const supabase = adminClient();
      if (!isDispatchSales(actor) || !actor.department_id) return response.status(403).json({ error: "Carriers are created by the Dispatch Sales department." });
      const { trucks, ...fields } = input;
      const { data: carrier, error } = await supabase.from("dispatch_carriers").insert({ ...fields, department_id: actor.department_id, owner_id: actor.id }).select().single();
      if (error || !carrier) throw error;
      if (trucks?.length) { const { error: truckError } = await supabase.from("dispatch_trucks").insert(trucks.map((truck) => ({ ...truck, carrier_id: carrier.id }))); if (truckError) throw truckError; }
      await writeAudit(supabase, actor.id, "CARRIER_CREATED", "dispatch_carrier", carrier.id, { trucks: trucks?.length ?? 0 });
      response.status(201).json({ carrier, duplicates: await duplicates(supabase, carrier.mc_number, carrier.dot_number, carrier.id) });
    } catch (error) { next(error); }
  });

  async function loadCarrier(supabase: SupabaseClient, id: string) {
    const [{ data: carrier }, { data: trucks }] = await Promise.all([
      supabase.from("dispatch_carriers").select("*").eq("id", id).maybeSingle(),
      supabase.from("dispatch_trucks").select("*").eq("carrier_id", id).order("created_at"),
    ]);
    if (!carrier) return null;
    return { carrier, trucks: trucks ?? [] };
  }

  app.get("/api/v1/dispatch/carriers/:id/detail", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id));
      if (!found) return response.status(404).json({ error: "Carrier not found." });
      const { carrier, trucks } = found;
      if (!carrierVisible(actor, scope, carrier, trucks)) return response.status(403).json({ error: "This carrier is outside your work scope." });
      const salesSide = carrierSalesView(actor, scope, carrier);
      // Operations people only see the trucks they handle.
      const visibleTrucks = salesSide ? trucks : trucks.filter((truck: any) => truckOpsView(actor, scope, truck));
      const [{ data: documents }, { data: activities }, { data: comments }, { data: invoices }] = await Promise.all([
        supabase.from("dispatch_carrier_documents").select("id, document_type, file_name, uploaded_by, created_at").eq("carrier_id", carrier.id).order("created_at", { ascending: false }),
        supabase.from("dispatch_activities").select("*").eq("carrier_id", carrier.id).order("created_at", { ascending: false }),
        supabase.from("record_comments").select("*").eq("entity_type", "CARRIER").eq("entity_id", carrier.id).order("created_at", { ascending: false }),
        supabase.from("dispatch_invoices").select("id, invoice_number, truck_id, week_start, gross_amount, amount, amount_paid, status, signed_off_at").eq("carrier_id", carrier.id).order("week_start", { ascending: false }).limit(50),
      ]);
      const people = await names(supabase, [carrier.owner_id, carrier.reviewed_by, ...visibleTrucks.map((truck: any) => truck.assigned_to), ...(documents ?? []).map((row: any) => row.uploaded_by), ...(activities ?? []).map((row: any) => row.created_by)]);
      const teamsById = await teamNames(supabase, [carrier.team_id, ...visibleTrucks.map((truck: any) => truck.team_id)]);
      const { data: department } = carrier.dispatch_department_id ? await supabase.from("departments").select("name").eq("id", carrier.dispatch_department_id).maybeSingle() : { data: null };
      const missing = requiredDocuments.filter((type) => !(documents ?? []).some((row: any) => row.document_type === type));
      response.json({
        carrier: { ...carrier, owner_name: people.get(carrier.owner_id) ?? null, reviewed_by_name: carrier.reviewed_by ? people.get(carrier.reviewed_by) ?? null : null, team_name: carrier.team_id ? teamsById.get(carrier.team_id) ?? null : null, dispatch_department_name: department?.name ?? null },
        trucks: visibleTrucks.map((truck: any) => ({ ...truck, assigned_name: truck.assigned_to ? people.get(truck.assigned_to) ?? null : null, team_name: truck.team_id ? teamsById.get(truck.team_id) ?? null : null })),
        documents: (documents ?? []).map((row: any) => ({ ...row, uploaded_by_name: people.get(row.uploaded_by) ?? null })),
        activities: (activities ?? []).map((row: any) => ({ ...row, author_id: row.created_by, author_name: people.get(row.created_by) ?? null })),
        comments: await withAuthorDetails(supabase, comments ?? [], actor.id, isManager(actor) || isSuper(actor)),
        invoices: (invoices ?? []).filter((row: any) => visibleTrucks.some((truck: any) => truck.id === row.truck_id)),
        missing_documents: missing,
        duplicates: await duplicates(supabase, carrier.mc_number, carrier.dot_number, carrier.id),
        rights: {
          edit: carrierSalesEdit(actor, scope, carrier) && !["DISCARDED"].includes(carrier.review_status),
          submit: (carrier.owner_id === actor.id || carrierSalesEdit(actor, scope, carrier)) && ["DOCS_PENDING", "RETURNED"].includes(carrier.review_status),
          review: carrierReview(actor, scope, carrier) && carrier.review_status === "PENDING_REVIEW",
          assign: carrierAssign(actor, scope, carrier),
          terms: carrierSalesEdit(actor, scope, carrier) || visibleTrucks.some((truck: any) => truckOpsUpdate(actor, scope, truck)),
          sales_side: salesSide,
        },
      });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/dispatch/carriers/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = carrierUpdateSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id));
      if (!found) return response.status(404).json({ error: "Carrier not found." });
      const { carrier, trucks } = found;
      const { owner_id, team_id, charge_percent, payment_method, ...profile } = input;
      const profileChange = Object.keys(profile).length > 0;
      const termsChange = charge_percent !== undefined || payment_method !== undefined;
      // Carrier terms (DP-3) belong to whoever runs the trucks, or the Sales side before hand-off.
      const canTerms = carrierSalesEdit(actor, scope, carrier) || trucks.some((truck: any) => truckOpsUpdate(actor, scope, truck));
      if (profileChange && !carrierSalesEdit(actor, scope, carrier)) return response.status(403).json({ error: "You cannot edit this carrier." });
      if (termsChange && !canTerms) return response.status(403).json({ error: "You cannot change this carrier's terms." });
      if (carrier.review_status === "DISCARDED" && profileChange) return response.status(422).json({ error: "A discarded carrier cannot be edited." });
      if (owner_id !== undefined || team_id !== undefined) {
        if (!carrierAssign(actor, scope, carrier)) return response.status(403).json({ error: "Carrier assignment permission is required." });
        if (owner_id && !await departmentPeople(supabase, carrier.department_id, [owner_id])) return response.status(422).json({ error: "The owner must be an active agent in this Dispatch Sales department." });
        if (!isSuper(actor) && !isManager(actor)) {
          if (owner_id && !scope.memberIds.includes(owner_id)) return response.status(403).json({ error: "You can assign carriers only to members of your team." });
          if (team_id !== undefined && (!team_id || !scope.leadTeamIds.includes(team_id))) return response.status(403).json({ error: "You can move carriers only between your own teams." });
        }
        if (team_id) { const { data: team } = await supabase.from("teams").select("id").eq("id", team_id).eq("department_id", carrier.department_id).eq("is_active", true).maybeSingle(); if (!team) return response.status(422).json({ error: "The team must be active in this department." }); }
      }
      const update = { ...profile, ...(owner_id !== undefined ? { owner_id } : {}), ...(team_id !== undefined ? { team_id } : {}), ...(charge_percent !== undefined ? { charge_percent } : {}), ...(payment_method !== undefined ? { payment_method } : {}) };
      const next_ = { ...carrier, ...update };
      if (!next_.mc_number && !next_.dot_number) return response.status(422).json({ error: "Keep an MC or DOT number on the carrier." });
      const { data, error } = await supabase.from("dispatch_carriers").update(update).eq("id", carrier.id).select().single(); if (error) throw error;
      if (owner_id && owner_id !== carrier.owner_id) await notify(supabase, [owner_id], actor.id, "CARRIER_ASSIGNED", "Carrier assigned to you", data.company_name, "CARRIER", carrier.id);
      await writeAudit(supabase, actor.id, termsChange && !profileChange ? "CARRIER_TERMS_UPDATED" : "CARRIER_UPDATED", "dispatch_carrier", carrier.id, { fields: Object.keys(update) });
      response.json({ carrier: data, duplicates: await duplicates(supabase, data.mc_number, data.dot_number, data.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/dispatch/carriers/:id/trucks", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = truckSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      const { carrier } = found;
      if (!carrierSalesEdit(actor, scope, carrier) || carrier.review_status === "DISCARDED") return response.status(403).json({ error: "You cannot add trucks to this carrier." });
      // A truck added after approval joins the carrier's Dispatch department straight away, waiting for a Dispatcher.
      const approved = carrier.review_status === "APPROVED";
      const { data, error } = await supabase.from("dispatch_trucks").insert({ ...input, carrier_id: carrier.id, status: approved ? "ACTIVE" : "PENDING", dispatch_department_id: approved ? carrier.dispatch_department_id : null }).select().single(); if (error) throw error;
      if (approved) await notify(supabase, await managersOf(supabase, carrier.dispatch_department_id), actor.id, "TRUCK_HANDED_OFF", "New truck to assign", `${carrier.company_name} · ${data.unit_number}`, "TRUCK", data.id);
      await writeAudit(supabase, actor.id, "TRUCK_ADDED", "dispatch_truck", data.id, { carrier_id: carrier.id });
      response.status(201).json({ truck: data });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/dispatch/trucks/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!truck) return response.status(404).json({ error: "Truck not found." });
      const carrier = one((truck as any).dispatch_carriers);
      if (!carrierSalesEdit(actor, scope, carrier) || truck.status !== "PENDING") return response.status(422).json({ error: "Only trucks not yet approved can be removed." });
      const { error } = await supabase.from("dispatch_trucks").delete().eq("id", truck.id); if (error) throw error;
      await writeAudit(supabase, actor.id, "TRUCK_REMOVED", "dispatch_truck", truck.id, { carrier_id: carrier.id });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Documents (DS-3) ------------------------------------------------------------------------------------------
  app.post("/api/v1/dispatch/carriers/:id/upload-url", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = fileSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      if (!carrierSalesEdit(actor, scope, found.carrier)) return response.status(403).json({ error: "You cannot add documents to this carrier." });
      const extension = input.file_name.split(".").pop()?.toLowerCase();
      if (!extension || !["pdf", "jpg", "jpeg", "png"].includes(extension)) return response.status(422).json({ error: "Only PDF, JPG, JPEG, and PNG files are allowed." });
      const path = `${found.carrier.id}/${crypto.randomUUID()}.${extension}`;
      const { data, error } = await supabase.storage.from("dispatch-documents").createSignedUploadUrl(path); if (error) throw error;
      response.json({ path, token: data.token, signed_url: data.signedUrl });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/dispatch/carriers/:id/documents", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = documentSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      if (!carrierSalesEdit(actor, scope, found.carrier)) return response.status(403).json({ error: "You cannot add documents to this carrier." });
      if (!input.storage_path.startsWith(`${found.carrier.id}/`)) return response.status(422).json({ error: "The upload does not belong to this carrier." });
      const { data, error } = await supabase.from("dispatch_carrier_documents").insert({ ...input, carrier_id: found.carrier.id, uploaded_by: actor.id }).select("id, document_type, file_name, created_at").single(); if (error) throw error;
      await writeAudit(supabase, actor.id, "CARRIER_DOCUMENT_ADDED", "dispatch_carrier", found.carrier.id, { document_type: input.document_type });
      response.status(201).json({ document: data });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/dispatch/documents/:id/download-url", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: document } = await supabase.from("dispatch_carrier_documents").select("id, carrier_id, storage_path").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!document) return response.status(404).json({ error: "Document not found." });
      const found = await loadCarrier(supabase, document.carrier_id);
      if (!found || !carrierVisible(actor, scope, found.carrier, found.trucks)) return response.status(403).json({ error: "This document is outside your work scope." });
      const { data, error } = await supabase.storage.from("dispatch-documents").createSignedUrl(document.storage_path, 60); if (error) throw error;
      response.json({ signed_url: data.signedUrl });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/dispatch/documents/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: document } = await supabase.from("dispatch_carrier_documents").select("id, carrier_id, storage_path, document_type").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!document) return response.status(404).json({ error: "Document not found." });
      const found = await loadCarrier(supabase, document.carrier_id);
      if (!found || !carrierSalesEdit(actor, scope, found.carrier) || !["DOCS_PENDING", "RETURNED"].includes(found.carrier.review_status)) return response.status(422).json({ error: "Documents can be removed only before the carrier is submitted." });
      await supabase.storage.from("dispatch-documents").remove([document.storage_path]);
      const { error } = await supabase.from("dispatch_carrier_documents").delete().eq("id", document.id); if (error) throw error;
      await writeAudit(supabase, actor.id, "CARRIER_DOCUMENT_REMOVED", "dispatch_carrier", found.carrier.id, { document_type: document.document_type });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Activities (DS-2) -----------------------------------------------------------------------------------------
  app.post("/api/v1/dispatch/carriers/:id/activities", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = activitySchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      if (!carrierSalesEdit(actor, scope, found.carrier)) return response.status(403).json({ error: "You cannot log activity on this carrier." });
      const { data, error } = await supabase.from("dispatch_activities").insert({ ...input, carrier_id: found.carrier.id, created_by: actor.id }).select().single(); if (error) throw error;
      await writeAudit(supabase, actor.id, "CARRIER_ACTIVITY_ADDED", "dispatch_carrier", found.carrier.id, { activity_type: input.activity_type });
      response.status(201).json({ activity: data });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/dispatch/activities/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = z.object({ completed: z.boolean() }).parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: activity } = await supabase.from("dispatch_activities").select("id, carrier_id").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!activity) return response.status(404).json({ error: "Activity not found." });
      const found = await loadCarrier(supabase, activity.carrier_id);
      if (!found || !carrierSalesEdit(actor, scope, found.carrier)) return response.status(403).json({ error: "You cannot update this activity." });
      const { data, error } = await supabase.from("dispatch_activities").update({ completed_at: input.completed ? new Date().toISOString() : null }).eq("id", activity.id).select().single(); if (error) throw error;
      response.json({ activity: data });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/dispatch/activities/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient();
      const { data: activity } = await supabase.from("dispatch_activities").select("id, created_by, carrier_id").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!activity) return response.status(404).json({ error: "Activity not found." });
      if (activity.created_by !== actor.id && !isSuper(actor)) return response.status(403).json({ error: "Only the author can delete this activity." });
      const { error } = await supabase.from("dispatch_activities").delete().eq("id", activity.id); if (error) throw error;
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Submit, review, hand-off (DS-5..DS-7, answer 1) ----------------------------------------------------------------
  app.post("/api/v1/dispatch/carriers/:id/submit", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      const { carrier, trucks } = found;
      if (!carrierSalesEdit(actor, scope, carrier)) return response.status(403).json({ error: "You cannot submit this carrier." });
      if (!["DOCS_PENDING", "RETURNED"].includes(carrier.review_status)) return response.status(422).json({ error: "This carrier is not waiting to be submitted." });
      if (!trucks.length) return response.status(422).json({ error: "Add at least one truck before submitting." });
      const { data: documents } = await supabase.from("dispatch_carrier_documents").select("document_type").eq("carrier_id", carrier.id);
      const missing = requiredDocuments.filter((type) => !(documents ?? []).some((row: any) => row.document_type === type));
      if (missing.length) return response.status(422).json({ error: `Upload the missing documents first: ${missing.map((type) => type === "MC_AUTHORITY" ? "MC/DOT authority" : type).join(", ")}.` });
      const { data, error } = await supabase.from("dispatch_carriers").update({ review_status: "PENDING_REVIEW", submitted_at: new Date().toISOString(), review_note: null }).eq("id", carrier.id).select().single(); if (error) throw error;
      await notify(supabase, await managersOf(supabase, carrier.department_id), actor.id, "CARRIER_SUBMITTED", "Carrier waiting for review", carrier.company_name, "CARRIER", carrier.id);
      await writeAudit(supabase, actor.id, "CARRIER_SUBMITTED", "dispatch_carrier", carrier.id, { from_status: carrier.review_status, to_status: "PENDING_REVIEW" });
      response.json({ carrier: data });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/dispatch/carriers/:id/review", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = reviewSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const found = await loadCarrier(supabase, uuid.parse(request.params.id)); if (!found) return response.status(404).json({ error: "Carrier not found." });
      const { carrier, trucks } = found;
      if (!carrierReview(actor, scope, carrier)) return response.status(403).json({ error: "Only the Dispatch Sales Manager can review this carrier." });
      if (carrier.review_status !== "PENDING_REVIEW") return response.status(422).json({ error: "This carrier is not waiting for review." });
      const now = new Date().toISOString();
      if (input.action === "APPROVE") {
        const { data: department } = await supabase.from("departments").select("id, name").eq("id", input.dispatch_department_id!).eq("business_unit", "DISPATCH").eq("function", "OPERATIONS").eq("is_active", true).maybeSingle();
        if (!department) return response.status(422).json({ error: "Choose an active Dispatch Operations department." });
        const [{ data, error }, { error: truckError }, opsManagers] = await Promise.all([
          supabase.from("dispatch_carriers").update({ review_status: "APPROVED", review_note: input.note || null, reviewed_by: actor.id, reviewed_at: now, dispatch_department_id: department.id, handed_off_at: now }).eq("id", carrier.id).select().single(),
          supabase.from("dispatch_trucks").update({ status: "ACTIVE", dispatch_department_id: department.id, activated_at: now }).eq("carrier_id", carrier.id).eq("status", "PENDING"),
          managersOf(supabase, department.id),
        ]);
        if (error) throw error; if (truckError) throw truckError;
        // Side effects are independent of each other, so they run together.
        await Promise.all([
          notify(supabase, [carrier.owner_id], actor.id, "CARRIER_APPROVED", "Carrier approved", `${carrier.company_name} was handed to ${department.name}.`, "CARRIER", carrier.id),
          notify(supabase, opsManagers, actor.id, "CARRIER_HANDED_OFF", "New trucks to assign", `${carrier.company_name} · ${trucks.length} truck${trucks.length === 1 ? "" : "s"}`, "CARRIER", carrier.id),
          input.note ? supabase.from("record_comments").insert({ entity_type: "CARRIER", entity_id: carrier.id, author_id: actor.id, body: input.note }) : null,
          writeAudit(supabase, actor.id, "CARRIER_APPROVED", "dispatch_carrier", carrier.id, { from_status: "PENDING_REVIEW", to_status: "APPROVED", dispatch_department_id: department.id }),
        ]);
        return response.json({ carrier: data });
      }
      const status = input.action === "RETURN" ? "RETURNED" : "DISCARDED";
      const { data, error } = await supabase.from("dispatch_carriers").update({ review_status: status, review_note: input.note, reviewed_by: actor.id, reviewed_at: now }).eq("id", carrier.id).select().single(); if (error) throw error;
      await Promise.all([
        status === "DISCARDED" ? supabase.from("dispatch_trucks").update({ status: "DISCARDED" }).eq("carrier_id", carrier.id) : null,
        supabase.from("record_comments").insert({ entity_type: "CARRIER", entity_id: carrier.id, author_id: actor.id, body: input.note! }),
        notify(supabase, [carrier.owner_id], actor.id, status === "RETURNED" ? "CARRIER_RETURNED" : "CARRIER_DISCARDED", status === "RETURNED" ? "Carrier returned for rework" : "Carrier discarded", input.note!, "CARRIER", carrier.id),
        writeAudit(supabase, actor.id, status === "RETURNED" ? "CARRIER_RETURNED" : "CARRIER_DISCARDED", "dispatch_carrier", carrier.id, { from_status: "PENDING_REVIEW", to_status: status }),
      ]);
      response.json({ carrier: data });
    } catch (error) { next(error); }
  });

  // ---- Trucks (Dispatch Operations) ----------------------------------------------------------------------------

  app.get("/api/v1/dispatch/trucks", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      let query = supabase.from("dispatch_trucks").select("*, dispatch_carriers(id, company_name, mc_number, dot_number, owner_id, team_id, department_id, charge_percent, payment_method, review_status)").neq("status", "PENDING").order("updated_at", { ascending: false }).limit(1000);
      if (!isSuper(actor) && isDispatchOps(actor)) query = query.eq("dispatch_department_id", actor.department_id!);
      const { data, error } = await query; if (error) throw error;
      const rows = (data ?? []).filter((truck: any) => truckVisible(actor, scope, truck, one(truck.dispatch_carriers)));
      const thisWeek = weekStart(new Date());
      const loads = await grossByTruckWeek(supabase, rows.map((row: any) => row.id), addDays(thisWeek, -28));
      const people = await names(supabase, rows.map((row: any) => row.assigned_to));
      const teamsById = await teamNames(supabase, rows.map((row: any) => row.team_id));
      response.json({ week_start: thisWeek, trucks: rows.map((truck: any) => {
        const mine = loads.filter((load: any) => load.truck_id === truck.id);
        const week = mine.filter((load: any) => weekStart(load.pickup_date) === thisWeek);
        return { ...truck, carrier: one(truck.dispatch_carriers), dispatch_carriers: undefined, assigned_name: truck.assigned_to ? people.get(truck.assigned_to) ?? null : null, team_name: truck.team_id ? teamsById.get(truck.team_id) ?? null : null, week_gross: round(week.reduce((sum: number, load: any) => sum + Number(load.rate), 0)), week_loads: week.length, last_load_date: mine.map((load: any) => load.pickup_date).sort().pop() ?? null };
      }) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/dispatch/trucks/:id/detail", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!truck) return response.status(404).json({ error: "Truck not found." });
      const carrier = one((truck as any).dispatch_carriers);
      if (!truckVisible(actor, scope, truck, carrier)) return response.status(403).json({ error: "This truck is outside your work scope." });
      const [{ data: loads }, { data: invoices }, { data: comments }] = await Promise.all([
        supabase.from("dispatch_loads").select("*").eq("truck_id", truck.id).order("pickup_date", { ascending: false }).limit(500),
        supabase.from("dispatch_invoices").select("*").eq("truck_id", truck.id).order("week_start", { ascending: false }),
        supabase.from("record_comments").select("*").eq("entity_type", "TRUCK").eq("entity_id", truck.id).order("created_at", { ascending: false }),
      ]);
      const people = await names(supabase, [truck.assigned_to, carrier.owner_id, ...(loads ?? []).map((row: any) => row.dispatcher_id)]);
      const { data: target } = truck.assigned_to ? await supabase.from("dispatch_targets").select("period_type, amount").eq("user_id", truck.assigned_to) : { data: [] as any[] };
      response.json({
        truck: { ...truck, dispatch_carriers: undefined, assigned_name: truck.assigned_to ? people.get(truck.assigned_to) ?? null : null },
        carrier: { ...carrier, owner_name: people.get(carrier.owner_id) ?? null },
        loads: (loads ?? []).map((row: any) => ({ ...row, dispatcher_name: people.get(row.dispatcher_id) ?? null, week_start: weekStart(row.pickup_date) })),
        invoices: invoices ?? [],
        comments: await withAuthorDetails(supabase, comments ?? [], actor.id, isManager(actor) || isSuper(actor)),
        targets: target ?? [],
        rights: { update: truckOpsUpdate(actor, scope, truck), assign: truckAssign(actor, scope, truck), terms: truckOpsUpdate(actor, scope, truck) || carrierSalesEdit(actor, scope, carrier), sales_side: carrierSalesView(actor, scope, carrier) && !truckOpsView(actor, scope, truck) },
      });
    } catch (error) { next(error); }
  });

  /** Truck lifecycle (Figure 5, DP-2) and assignment (answer 1). */
  app.patch("/api/v1/dispatch/trucks/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = truckUpdateSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!truck) return response.status(404).json({ error: "Truck not found." });
      const carrier = one((truck as any).dispatch_carriers);
      const update: Record<string, unknown> = {};
      if (input.unit_number !== undefined || input.truck_type !== undefined || input.equipment_notes !== undefined) {
        if (!carrierSalesEdit(actor, scope, carrier) && !truckOpsUpdate(actor, scope, truck)) return response.status(403).json({ error: "You cannot edit this truck." });
        Object.assign(update, Object.fromEntries(Object.entries({ unit_number: input.unit_number, truck_type: input.truck_type, equipment_notes: input.equipment_notes }).filter(([, value]) => value !== undefined)));
      }
      if (input.assigned_to !== undefined || input.team_id !== undefined) {
        if (!truck.dispatch_department_id) return response.status(422).json({ error: "This truck has not been handed to Dispatch Operations yet." });
        if (!truckAssign(actor, scope, truck)) return response.status(403).json({ error: "Only the Dispatch Manager can assign trucks." });
        if (input.assigned_to && !await departmentPeople(supabase, truck.dispatch_department_id, [input.assigned_to])) return response.status(422).json({ error: "The Dispatcher must be active in this Dispatch Operations department." });
        if (!isSuper(actor) && !isManager(actor)) {
          if (input.assigned_to && !scope.memberIds.includes(input.assigned_to)) return response.status(403).json({ error: "You can assign trucks only to members of your team." });
          if (input.team_id !== undefined && (!input.team_id || !scope.leadTeamIds.includes(input.team_id))) return response.status(403).json({ error: "You can move trucks only between your own teams." });
        }
        if (input.team_id) { const { data: team } = await supabase.from("teams").select("id").eq("id", input.team_id).eq("department_id", truck.dispatch_department_id).eq("is_active", true).maybeSingle(); if (!team) return response.status(422).json({ error: "The team must be active in this department." }); }
        if (input.assigned_to !== undefined) {
          update.assigned_to = input.assigned_to;
          // Assigning a Dispatcher onboards the truck (Figure 5: Active -> Onboarded).
          if (input.assigned_to && truck.status === "ACTIVE") update.status = "ONBOARDED";
          if (!input.assigned_to && truck.status === "ONBOARDED") update.status = "ACTIVE";
        }
        if (input.team_id !== undefined) update.team_id = input.team_id;
      }
      if (input.status && input.status !== truck.status) {
        if (!truckOpsUpdate(actor, scope, truck)) return response.status(403).json({ error: "Only the truck's Dispatcher or the Dispatch Manager can change its status." });
        const allowed: Record<string, string[]> = { ACTIVE: ["DISCARDED"], ONBOARDED: ["RUNNING", "INACTIVE", "DNC", "DISCARDED"], RUNNING: ["INACTIVE", "DNC"], INACTIVE: ["RUNNING", "DNC"], DNC: [], DISCARDED: [] };
        if (!(allowed[truck.status] ?? []).includes(input.status)) return response.status(422).json({ error: `A truck can't move from ${truck.status.toLowerCase()} to ${input.status.toLowerCase()}.` });
        if (input.status === "DNC" && !input.dnc_reason) return response.status(422).json({ error: "Add a reason for marking the truck Do-Not-Call." });
        if (input.status === "RUNNING" && !truck.assigned_to && !update.assigned_to) return response.status(422).json({ error: "Assign a Dispatcher before the truck can run." });
        update.status = input.status;
        if (input.status === "DNC") update.dnc_reason = input.dnc_reason;
      }
      if (!Object.keys(update).length) return response.status(422).json({ error: "Nothing to update." });
      const { data, error } = await supabase.from("dispatch_trucks").update(update).eq("id", truck.id).select().single(); if (error) throw error;
      if (update.assigned_to) await notify(supabase, [update.assigned_to as string], actor.id, "TRUCK_ASSIGNED", "New truck assigned", `${carrier.company_name} · ${truck.unit_number}`, "TRUCK", truck.id);
      if (update.status && update.status !== truck.status) await writeAudit(supabase, actor.id, "TRUCK_STATUS_CHANGED", "dispatch_truck", truck.id, { from_status: truck.status, to_status: update.status });
      else await writeAudit(supabase, actor.id, "TRUCK_UPDATED", "dispatch_truck", truck.id, { fields: Object.keys(update) });
      response.json({ truck: data });
    } catch (error) { next(error); }
  });

  /** Do-Not-Call list (Figure 5 note): kept separately, never deleted. Visible to everyone in Dispatch. */
  app.get("/api/v1/dispatch/dnc", ...guard, async (_request: Req, response, next) => {
    try {
      const supabase = adminClient();
      const { data, error } = await supabase.from("dispatch_trucks").select("id, unit_number, truck_type, dnc_reason, updated_at, dispatch_carriers(id, company_name, mc_number, dot_number, phone, owner_id)").eq("status", "DNC").order("updated_at", { ascending: false }).limit(1000);
      if (error) throw error;
      response.json({ entries: (data ?? []).map((row: any) => ({ ...row, carrier: one(row.dispatch_carriers), dispatch_carriers: undefined })) });
    } catch (error) { next(error); }
  });

  // ---- Loads (DP-4, DP-5, answer 3) ---------------------------------------------------------------------------

  app.get("/api/v1/dispatch/loads", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const query = z.object({ zip: z.string().trim().max(10).optional(), lane: z.string().trim().max(120).optional(), truck_id: uuid.optional(), dispatcher_id: uuid.optional(), from: z.string().date().optional(), to: z.string().date().optional(), status: z.enum(["BOOKED", "DELIVERED", "CANCELLED"]).optional() }).parse(request.query);
      let loadQuery = supabase.from("dispatch_loads").select("*, dispatch_trucks(id, unit_number, truck_type, assigned_to, team_id, dispatch_department_id, dispatch_carriers(id, company_name, owner_id, team_id, department_id))").order("pickup_date", { ascending: false }).limit(1000);
      if (query.zip) loadQuery = loadQuery.or(`pickup_zip.ilike.${query.zip.replace(/[,()%]/g, "")}%,delivery_zip.ilike.${query.zip.replace(/[,()%]/g, "")}%`);
      if (query.lane) { const term = query.lane.replace(/[,()%]/g, ""); loadQuery = loadQuery.or(`pickup_city.ilike.%${term}%,delivery_city.ilike.%${term}%,broker_name.ilike.%${term}%,load_number.ilike.%${term}%`); }
      if (query.truck_id) loadQuery = loadQuery.eq("truck_id", query.truck_id);
      if (query.dispatcher_id) loadQuery = loadQuery.eq("dispatcher_id", query.dispatcher_id);
      if (query.from) loadQuery = loadQuery.gte("pickup_date", query.from);
      if (query.to) loadQuery = loadQuery.lte("pickup_date", query.to);
      if (query.status) loadQuery = loadQuery.eq("status", query.status);
      const { data, error } = await loadQuery; if (error) throw error;
      const rows = (data ?? []).filter((load: any) => { const truck = one(load.dispatch_trucks); return truck && truckVisible(actor, scope, truck, one(truck.dispatch_carriers)); });
      const people = await names(supabase, rows.map((row: any) => row.dispatcher_id));
      response.json({ loads: rows.map((load: any) => { const truck = one(load.dispatch_trucks); return { ...load, dispatch_trucks: undefined, truck: { id: truck.id, unit_number: truck.unit_number, truck_type: truck.truck_type }, carrier: { id: one(truck.dispatch_carriers)?.id, company_name: one(truck.dispatch_carriers)?.company_name }, dispatcher_name: people.get(load.dispatcher_id) ?? null, week_start: weekStart(load.pickup_date) }; }) });
    } catch (error) { next(error); }
  });

  /** A load's week is locked once that week's invoice has left Draft, so invoices never drift from their loads. */
  async function weekLocked(supabase: SupabaseClient, truckId: string, pickupDate: string) {
    const { data } = await supabase.from("dispatch_invoices").select("id, status").eq("truck_id", truckId).eq("week_start", weekStart(pickupDate)).maybeSingle();
    return data && !["DRAFT", "CANCELLED"].includes(data.status) ? data : null;
  }
  async function refreshDraftInvoice(supabase: SupabaseClient, truckId: string, pickupDate: string) {
    const week = weekStart(pickupDate);
    const { data: invoice } = await supabase.from("dispatch_invoices").select("id, status, charge_percent").eq("truck_id", truckId).eq("week_start", week).maybeSingle();
    if (!invoice || invoice.status !== "DRAFT") return;
    const loads = await grossByTruckWeek(supabase, [truckId], week, addDays(week, 6));
    const gross = round(loads.reduce((sum: number, load: any) => sum + Number(load.rate), 0));
    await supabase.from("dispatch_invoices").update({ gross_amount: gross, amount: round(gross * Number(invoice.charge_percent) / 100) }).eq("id", invoice.id);
  }

  app.post("/api/v1/dispatch/trucks/:id/loads", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = loadSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(company_name)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!truck) return response.status(404).json({ error: "Truck not found." });
      if (!truckOpsUpdate(actor, scope, truck)) return response.status(403).json({ error: "Only the truck's Dispatcher or the Dispatch Manager can log loads." });
      if (!["ONBOARDED", "RUNNING", "INACTIVE"].includes(truck.status) || !truck.assigned_to) return response.status(422).json({ error: "Loads can be logged once the truck is assigned to a Dispatcher." });
      if (input.delivery_date && input.delivery_date < input.pickup_date) return response.status(422).json({ error: "Delivery date can't be before pickup." });
      if (await weekLocked(supabase, truck.id, input.pickup_date)) return response.status(422).json({ error: "That week's invoice has already been submitted. Ask the Dispatch Manager to return it first." });
      const { data, error } = await supabase.from("dispatch_loads").insert({ ...input, truck_id: truck.id, dispatcher_id: truck.assigned_to }).select().single(); if (error) throw error;
      // Weekly loads being booked puts the truck in Running (Figure 5).
      if (["ONBOARDED", "INACTIVE"].includes(truck.status) && data.status !== "CANCELLED") {
        await supabase.from("dispatch_trucks").update({ status: "RUNNING" }).eq("id", truck.id);
        await writeAudit(supabase, actor.id, "TRUCK_STATUS_CHANGED", "dispatch_truck", truck.id, { from_status: truck.status, to_status: "RUNNING", reason: "Load booked" });
      }
      await refreshDraftInvoice(supabase, truck.id, input.pickup_date);
      await writeAudit(supabase, actor.id, "LOAD_ADDED", "dispatch_load", data.id, { truck_id: truck.id, rate: input.rate });
      response.status(201).json({ load: data });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/dispatch/loads/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = loadSchema.partial().parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: load } = await supabase.from("dispatch_loads").select("*, dispatch_trucks(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!load) return response.status(404).json({ error: "Load not found." });
      const truck = one((load as any).dispatch_trucks);
      if (!truckOpsUpdate(actor, scope, truck)) return response.status(403).json({ error: "You cannot edit this load." });
      if (await weekLocked(supabase, truck.id, load.pickup_date) || (input.pickup_date && await weekLocked(supabase, truck.id, input.pickup_date))) return response.status(422).json({ error: "That week's invoice has already been submitted. Ask the Dispatch Manager to return it first." });
      const nextPickup = input.pickup_date ?? load.pickup_date; const nextDelivery = input.delivery_date === undefined ? load.delivery_date : input.delivery_date;
      if (nextDelivery && nextDelivery < nextPickup) return response.status(422).json({ error: "Delivery date can't be before pickup." });
      const { data, error } = await supabase.from("dispatch_loads").update(input).eq("id", load.id).select().single(); if (error) throw error;
      await refreshDraftInvoice(supabase, truck.id, load.pickup_date);
      if (input.pickup_date && weekStart(input.pickup_date) !== weekStart(load.pickup_date)) await refreshDraftInvoice(supabase, truck.id, input.pickup_date);
      await writeAudit(supabase, actor.id, "LOAD_UPDATED", "dispatch_load", load.id, { fields: Object.keys(input) });
      response.json({ load: data });
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/dispatch/loads/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: load } = await supabase.from("dispatch_loads").select("*, dispatch_trucks(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!load) return response.status(404).json({ error: "Load not found." });
      const truck = one((load as any).dispatch_trucks);
      if (!truckOpsUpdate(actor, scope, truck)) return response.status(403).json({ error: "You cannot delete this load." });
      if (await weekLocked(supabase, truck.id, load.pickup_date)) return response.status(422).json({ error: "That week's invoice has already been submitted." });
      const { error } = await supabase.from("dispatch_loads").delete().eq("id", load.id); if (error) throw error;
      await refreshDraftInvoice(supabase, truck.id, load.pickup_date);
      await writeAudit(supabase, actor.id, "LOAD_DELETED", "dispatch_load", load.id, { truck_id: truck.id });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // ---- Weekly invoices (DP-8, DP-9, DS-12, IN-1..IN-6, answer 2) ------------------------------------------------

  async function invoiceRows(supabase: SupabaseClient, filter: (query: any) => any) {
    const { data, error } = await filter(supabase.from("dispatch_invoices").select("*, dispatch_trucks(id, unit_number, truck_type, assigned_to, team_id, dispatch_department_id), dispatch_carriers(id, company_name, owner_id, team_id, department_id)").order("week_start", { ascending: false }).limit(1000));
    if (error) throw error;
    return data ?? [];
  }
  const decorate = (invoice: any, people: Map<string, string>) => {
    const today = new Date().toISOString().slice(0, 10);
    const outstanding = invoice.status === "CANCELLED" ? 0 : Math.max(0, Number(invoice.amount) - Number(invoice.amount_paid));
    return { ...invoice, truck: one(invoice.dispatch_trucks), carrier: one(invoice.dispatch_carriers), dispatch_trucks: undefined, dispatch_carriers: undefined, dispatcher_name: people.get(invoice.dispatcher_id) ?? null, sales_agent_name: invoice.sales_agent_id ? people.get(invoice.sales_agent_id) ?? null : null, outstanding: round(outstanding), overdue: Boolean(invoice.due_date && invoice.due_date < today && outstanding > 0 && ["FORWARDED", "SUBMITTED"].includes(invoice.status)) };
  };

  app.get("/api/v1/dispatch/invoices", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const rows = await invoiceRows(supabase, (query) => isSuper(actor) ? query : isDispatchSales(actor) ? query.eq("sales_department_id", actor.department_id) : query.eq("dispatch_department_id", actor.department_id));
      const visible = rows.filter((invoice: any) => {
        const truck = one(invoice.dispatch_trucks); const carrier = one(invoice.dispatch_carriers);
        return truckOpsView(actor, scope, truck) || carrierSalesView(actor, scope, carrier) || invoiceReview(actor, scope, invoice, truck) || invoiceSignOff(actor, scope, invoice, carrier);
      });
      const people = await names(supabase, visible.flatMap((row: any) => [row.dispatcher_id, row.sales_agent_id]));
      response.json({ invoices: visible.map((row: any) => decorate(row, people)) });
    } catch (error) { next(error); }
  });

  /** The Dispatcher creates a truck's weekly invoice from that week's loads (gross x charge %). */
  app.post("/api/v1/dispatch/trucks/:id/invoices", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = z.object({ week_start: z.string().date() }).parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(*)").eq("id", uuid.parse(request.params.id)).maybeSingle();
      if (!truck) return response.status(404).json({ error: "Truck not found." });
      const carrier = one((truck as any).dispatch_carriers);
      if (!truckOpsUpdate(actor, scope, truck) || !truck.assigned_to) return response.status(403).json({ error: "Only the truck's Dispatcher can create its invoice." });
      if (carrier.charge_percent == null) return response.status(422).json({ error: "Set the carrier's charge % first." });
      const week = weekStart(input.week_start);
      if (week > weekStart(new Date())) return response.status(422).json({ error: "You can't invoice a future week." });
      const { data: existing } = await supabase.from("dispatch_invoices").select("id, status").eq("truck_id", truck.id).eq("week_start", week).maybeSingle();
      if (existing && existing.status !== "CANCELLED") return response.status(422).json({ error: "This week already has an invoice for this truck." });
      const loads = await grossByTruckWeek(supabase, [truck.id], week, addDays(week, 6));
      if (!loads.length) return response.status(422).json({ error: "There are no loads in that week to invoice." });
      const gross = round(loads.reduce((sum: number, load: any) => sum + Number(load.rate), 0));
      const fields = { truck_id: truck.id, carrier_id: carrier.id, dispatcher_id: truck.assigned_to, dispatch_department_id: truck.dispatch_department_id, sales_department_id: carrier.department_id, sales_agent_id: carrier.owner_id, week_start: week, week_end: addDays(week, 6), gross_amount: gross, charge_percent: carrier.charge_percent, amount: round(gross * Number(carrier.charge_percent) / 100), amount_paid: 0, status: "DRAFT", due_date: addDays(week, 13), review_note: null, submitted_at: null, forwarded_at: null, forwarded_by: null, paid_at: null, signed_off_at: null, signed_off_by: null };
      const number = `DSP-${week.replaceAll("-", "")}-${truck.unit_number.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "TRUCK"}-${truck.id.slice(0, 4).toUpperCase()}`;
      const { data, error } = existing
        ? await supabase.from("dispatch_invoices").update(fields).eq("id", existing.id).select().single()
        : await supabase.from("dispatch_invoices").insert({ ...fields, invoice_number: number }).select().single();
      if (error) throw error;
      await writeAudit(supabase, actor.id, "DISPATCH_INVOICE_CREATED", "dispatch_invoice", data.id, { to_status: "DRAFT", week_start: week, gross, amount: data.amount });
      response.status(201).json({ invoice: data });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/dispatch/invoices/:id/actions", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = invoiceActionSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      const [invoice] = await invoiceRows(supabase, (query) => query.eq("id", uuid.parse(request.params.id)));
      if (!invoice) return response.status(404).json({ error: "Invoice not found." });
      const truck = one(invoice.dispatch_trucks); const carrier = one(invoice.dispatch_carriers);
      const dispatcher = truckOpsUpdate(actor, scope, truck);
      const reviewer = invoiceReview(actor, scope, invoice, truck);
      const now = new Date().toISOString();
      const flow: Record<string, { from: string[]; to: string; allowed: boolean; denied: string }> = {
        RECALCULATE: { from: ["DRAFT"], to: "DRAFT", allowed: dispatcher, denied: "Only the Dispatcher can update this invoice." },
        SUBMIT: { from: ["DRAFT"], to: "SUBMITTED", allowed: dispatcher, denied: "Only the Dispatcher can submit this invoice." },
        RETURN: { from: ["SUBMITTED", "FORWARDED"], to: "DRAFT", allowed: reviewer, denied: "Only the Dispatch Manager can return this invoice." },
        FORWARD: { from: ["SUBMITTED"], to: "FORWARDED", allowed: reviewer, denied: "Only the Dispatch Manager can forward this invoice." },
        PAY: { from: ["FORWARDED"], to: "PAID", allowed: dispatcher || reviewer, denied: "Only the Dispatcher or Dispatch Manager can record payment." },
        CANCEL: { from: ["DRAFT", "SUBMITTED"], to: "CANCELLED", allowed: reviewer || (dispatcher && invoice.status === "DRAFT"), denied: "You cannot cancel this invoice." },
        SIGN_OFF: { from: ["PAID"], to: "PAID", allowed: invoiceSignOff(actor, scope, invoice, carrier), denied: "Only the Dispatch Sales Manager can sign this off." },
      };
      const step = flow[input.action];
      if (!step.allowed) return response.status(403).json({ error: step.denied });
      if (!step.from.includes(invoice.status)) return response.status(422).json({ error: `This invoice is ${invoice.status.toLowerCase()}, so it can't be ${input.action === "SIGN_OFF" ? "signed off" : input.action.toLowerCase().replace("_", " ") + "ed"} now.` });
      if (input.action === "RETURN" && !input.note) return response.status(422).json({ error: "Add a note explaining what to fix." });
      if (input.action === "SIGN_OFF" && invoice.signed_off_at) return response.status(422).json({ error: "This invoice is already signed off." });
      const update: Record<string, unknown> = { status: step.to };
      if (input.action === "RECALCULATE") {
        const loads = await grossByTruckWeek(supabase, [invoice.truck_id], invoice.week_start, invoice.week_end);
        const gross = round(loads.reduce((sum: number, load: any) => sum + Number(load.rate), 0));
        const percent = carrier.charge_percent ?? invoice.charge_percent;
        Object.assign(update, { gross_amount: gross, charge_percent: percent, amount: round(gross * Number(percent) / 100) });
      }
      if (input.action === "SUBMIT") Object.assign(update, { submitted_at: now, review_note: null });
      if (input.action === "RETURN") Object.assign(update, { review_note: input.note, submitted_at: null, forwarded_at: null, forwarded_by: null });
      if (input.action === "FORWARD") Object.assign(update, { forwarded_at: now, forwarded_by: actor.id, review_note: input.note || null });
      if (input.action === "PAY") {
        const paid = input.amount_paid ?? Number(invoice.amount);
        if (paid < Number(invoice.amount)) { Object.assign(update, { status: "FORWARDED", amount_paid: paid }); }
        else Object.assign(update, { amount_paid: paid, paid_at: now });
      }
      if (input.action === "SIGN_OFF") Object.assign(update, { signed_off_at: now, signed_off_by: actor.id });
      const { data, error } = await supabase.from("dispatch_invoices").update(update).eq("id", invoice.id).select().single(); if (error) throw error;
      const label = `${invoice.invoice_number} · ${carrier.company_name} ${truck.unit_number}`;
      const alert = async () => {
        if (input.action === "SUBMIT") return notify(supabase, await managersOf(supabase, invoice.dispatch_department_id), actor.id, "DISPATCH_INVOICE_SUBMITTED", "Weekly invoice to review", label, "DISPATCH_INVOICE", invoice.id);
        if (input.action === "RETURN") return notify(supabase, [invoice.dispatcher_id], actor.id, "DISPATCH_INVOICE_RETURNED", "Invoice returned", input.note!, "DISPATCH_INVOICE", invoice.id);
        if (input.action === "FORWARD") return notify(supabase, [invoice.dispatcher_id, ...await managersOf(supabase, invoice.sales_department_id)], actor.id, "DISPATCH_INVOICE_FORWARDED", "Invoice forwarded to accounting", label, "DISPATCH_INVOICE", invoice.id);
        if (input.action === "PAY" && data.status === "PAID") return notify(supabase, [invoice.dispatcher_id, invoice.sales_agent_id, ...await managersOf(supabase, invoice.sales_department_id)], actor.id, "DISPATCH_INVOICE_PAID", "Invoice paid", label, "DISPATCH_INVOICE", invoice.id);
        if (input.action === "SIGN_OFF") return notify(supabase, [invoice.sales_agent_id, invoice.dispatcher_id], actor.id, "DISPATCH_INVOICE_SIGNED_OFF", "Sale signed off", label, "DISPATCH_INVOICE", invoice.id);
      };
      await Promise.all([
        input.note && ["RETURN", "FORWARD"].includes(input.action) ? supabase.from("record_comments").insert({ entity_type: "DISPATCH_INVOICE", entity_id: invoice.id, author_id: actor.id, body: input.note }) : null,
        alert(),
        writeAudit(supabase, actor.id, `DISPATCH_INVOICE_${input.action}`, "dispatch_invoice", invoice.id, { from_status: invoice.status, to_status: data.status, amount_paid: data.amount_paid }),
      ]);
      response.json({ invoice: data });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/dispatch/invoices/:id/detail", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const [invoice] = await invoiceRows(supabase, (query) => query.eq("id", uuid.parse(request.params.id)));
      if (!invoice) return response.status(404).json({ error: "Invoice not found." });
      const truck = one(invoice.dispatch_trucks); const carrier = one(invoice.dispatch_carriers);
      if (!(truckOpsView(actor, scope, truck) || carrierSalesView(actor, scope, carrier) || invoiceReview(actor, scope, invoice, truck) || invoiceSignOff(actor, scope, invoice, carrier))) return response.status(403).json({ error: "This invoice is outside your work scope." });
      const [{ data: loads }, { data: comments }, { data: history }] = await Promise.all([
        supabase.from("dispatch_loads").select("*").eq("truck_id", invoice.truck_id).gte("pickup_date", invoice.week_start).lte("pickup_date", invoice.week_end).order("pickup_date"),
        supabase.from("record_comments").select("*").eq("entity_type", "DISPATCH_INVOICE").eq("entity_id", invoice.id).order("created_at", { ascending: false }),
        supabase.from("audit_events").select("id, actor_id, action, detail, created_at").eq("entity_type", "dispatch_invoice").eq("entity_id", invoice.id).order("created_at", { ascending: false }),
      ]);
      const people = await names(supabase, [invoice.dispatcher_id, invoice.sales_agent_id, ...(history ?? []).map((row: any) => row.actor_id)]);
      response.json({
        invoice: decorate(invoice, people), loads: loads ?? [],
        comments: await withAuthorDetails(supabase, comments ?? [], actor.id, isManager(actor) || isSuper(actor)),
        history: (history ?? []).map((row: any) => ({ ...row, actor_name: people.get(row.actor_id) ?? null })),
        rights: { dispatcher: truckOpsUpdate(actor, scope, truck), reviewer: invoiceReview(actor, scope, invoice, truck), sign_off: invoiceSignOff(actor, scope, invoice, carrier) },
      });
    } catch (error) { next(error); }
  });

  // ---- Comments (DS-8, DP-7) ----------------------------------------------------------------------------------
  app.post("/api/v1/dispatch/comments", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = commentSchema.parse(request.body); const supabase = adminClient(); const scope = await teamScope(actor);
      let recipients: (string | null)[] = []; let label = "";
      if (input.entity_type === "CARRIER") {
        const found = await loadCarrier(supabase, input.entity_id); if (!found || !carrierVisible(actor, scope, found.carrier, found.trucks)) return response.status(403).json({ error: "This carrier is outside your work scope." });
        recipients = [found.carrier.owner_id, ...(isManager(actor) ? [] : await managersOf(supabase, found.carrier.department_id))]; label = found.carrier.company_name;
      } else if (input.entity_type === "TRUCK") {
        const { data: truck } = await supabase.from("dispatch_trucks").select("*, dispatch_carriers(*)").eq("id", input.entity_id).maybeSingle();
        const carrier = one((truck as any)?.dispatch_carriers);
        if (!truck || !truckVisible(actor, scope, truck, carrier)) return response.status(403).json({ error: "This truck is outside your work scope." });
        recipients = [truck.assigned_to, ...(isManager(actor) ? [] : await managersOf(supabase, truck.dispatch_department_id))]; label = `${carrier.company_name} · ${truck.unit_number}`;
      } else {
        const [invoice] = await invoiceRows(supabase, (query) => query.eq("id", input.entity_id));
        if (!invoice) return response.status(404).json({ error: "Invoice not found." });
        const truck = one(invoice.dispatch_trucks); const carrier = one(invoice.dispatch_carriers);
        if (!(truckOpsView(actor, scope, truck) || carrierSalesView(actor, scope, carrier) || invoiceReview(actor, scope, invoice, truck))) return response.status(403).json({ error: "This invoice is outside your work scope." });
        recipients = [invoice.dispatcher_id, ...(isManager(actor) ? [] : await managersOf(supabase, invoice.dispatch_department_id))]; label = invoice.invoice_number;
      }
      const { data, error } = await supabase.from("record_comments").insert({ entity_type: input.entity_type, entity_id: input.entity_id, author_id: actor.id, body: input.body }).select().single(); if (error) throw error;
      await notify(supabase, recipients, actor.id, "DISPATCH_COMMENT", `New comment · ${label}`, input.body, input.entity_type, input.entity_id);
      await writeAudit(supabase, actor.id, "COMMENT_ADDED", input.entity_type.toLowerCase(), input.entity_id);
      response.status(201).json({ comment: data });
    } catch (error) { next(error); }
  });

  // ---- Targets (DS-11, DP-5) ----------------------------------------------------------------------------------
  app.get("/api/v1/dispatch/targets", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      if (!actor.department_id && !isSuper(actor)) return response.json({ people: [] });
      let peopleQuery = supabase.from("profiles").select("id, full_name").eq("is_active", true).eq("role", "AGENT").order("full_name");
      peopleQuery = isManager(actor) ? peopleQuery.eq("department_id", actor.department_id!) : peopleQuery.in("id", [...new Set([actor.id, ...scope.memberIds])]);
      const { data: people } = await peopleQuery;
      const ids = (people ?? []).map((row: any) => row.id);
      const { data: targets } = ids.length ? await supabase.from("dispatch_targets").select("*").in("user_id", ids) : { data: [] as any[] };
      response.json({ can_edit: isManager(actor) || isSuper(actor), people: (people ?? []).map((person: any) => ({ ...person, weekly: targets?.find((row: any) => row.user_id === person.id && row.period_type === "WEEKLY")?.amount ?? null, monthly: targets?.find((row: any) => row.user_id === person.id && row.period_type === "MONTHLY")?.amount ?? null })) });
    } catch (error) { next(error); }
  });

  app.put("/api/v1/dispatch/targets/:userId", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const input = targetSchema.parse(request.body); const supabase = adminClient(); const userId = uuid.parse(request.params.userId);
      if (!isSuper(actor) && !isManager(actor)) return response.status(403).json({ error: "Only a Dispatch manager can set targets." });
      if (!isSuper(actor) && !await departmentPeople(supabase, actor.department_id!, [userId])) return response.status(422).json({ error: "Targets can be set only for agents in your department." });
      const { data, error } = await supabase.from("dispatch_targets").upsert({ user_id: userId, period_type: input.period_type, amount: input.amount, set_by: actor.id, updated_at: new Date().toISOString() }).select().single(); if (error) throw error;
      await writeAudit(supabase, actor.id, "DISPATCH_TARGET_SET", "profile", userId, { period_type: input.period_type, amount: input.amount });
      response.json({ target: data });
    } catch (error) { next(error); }
  });

  // ---- Reports (DS-9, DS-13, DP-5, DP-6, IN-6, RP-2, RP-3) ------------------------------------------------------
  app.get("/api/v1/dispatch/reports", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient(); const scope = await teamScope(actor);
      const range = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), agent_id: uuid.optional() }).parse(request.query);
      const today = new Date().toISOString().slice(0, 10);
      const thisWeek = weekStart(today); const thisMonth = monthStart(today);
      const sales = isDispatchSales(actor) || (isSuper(actor) && request.query.side !== "operations");
      const teamView = isSuper(actor) || isManager(actor) || (scope.leadTeamIds.length > 0 && scope.permissions.has(sales ? "dispatch_sales.reports.view_team" : "dispatch.reports.view_team"));
      if (range.agent_id && !isSuper(actor) && !isManager(actor) && range.agent_id !== actor.id && !scope.memberIds.includes(range.agent_id)) return response.status(403).json({ error: "You can open individual reports only for your team's members." });

      // Carriers and trucks in scope.
      let carrierQuery = supabase.from("dispatch_carriers").select("id, company_name, mc_number, dot_number, owner_id, team_id, department_id, review_status, created_at, charge_percent, dispatch_department_id, dispatch_trucks(id, unit_number, truck_type, status, assigned_to, team_id, dispatch_department_id, created_at)").limit(2000);
      if (!isSuper(actor)) carrierQuery = sales ? carrierQuery.eq("department_id", actor.department_id!) : carrierQuery.eq("dispatch_department_id", actor.department_id!);
      const { data: carrierData, error: carrierError } = await carrierQuery; if (carrierError) throw carrierError;
      const carriers = (carrierData ?? []).filter((carrier: any) => sales ? (teamView ? carrierSalesView(actor, scope, carrier) : carrier.owner_id === actor.id) : true);
      let trucks = carriers.flatMap((carrier: any) => (carrier.dispatch_trucks ?? []).map((truck: any) => ({ ...truck, carrier })));
      if (!sales) trucks = trucks.filter((truck: any) => truck.dispatch_department_id && (teamView ? truckOpsView(actor, scope, truck) : truck.assigned_to === actor.id));
      const personOf = (truck: any) => sales ? truck.carrier.owner_id : truck.assigned_to;
      if (range.agent_id) trucks = trucks.filter((truck: any) => personOf(truck) === range.agent_id);
      const scopedCarriers = sales ? carriers.filter((carrier: any) => !range.agent_id || carrier.owner_id === range.agent_id) : carriers.filter((carrier: any) => trucks.some((truck: any) => truck.carrier.id === carrier.id));

      // Loads and invoices for those trucks.
      const truckIds = trucks.map((truck: any) => truck.id);
      const periodFrom = [range.from, thisMonth, thisWeek].filter(Boolean).sort()[0]!;
      const loads = await grossByTruckWeek(supabase, truckIds, range.from && range.from < periodFrom ? range.from : periodFrom);
      const { data: invoiceData } = truckIds.length ? await supabase.from("dispatch_invoices").select("*").in("truck_id", truckIds) : { data: [] as any[] };
      const invoices = (invoiceData ?? []).filter((invoice: any) => (!range.from || invoice.week_start >= range.from) && (!range.to || invoice.week_start <= range.to));
      const inRange = (day: string) => (!range.from || day >= range.from) && (!range.to || day <= range.to);
      const truckOf = new Map(trucks.map((truck: any) => [truck.id, truck]));
      const owed = (invoice: any) => invoice.status === "CANCELLED" ? 0 : Math.max(0, Number(invoice.amount) - Number(invoice.amount_paid));

      // People rows: agents (sales) or dispatchers (operations).
      const peopleIds = [...new Set([...trucks.map(personOf), ...scopedCarriers.map((carrier: any) => sales ? carrier.owner_id : null)].filter(Boolean))] as string[];
      const { data: targetRows } = peopleIds.length ? await supabase.from("dispatch_targets").select("*").in("user_id", peopleIds) : { data: [] as any[] };
      const people = await names(supabase, peopleIds);
      const byPerson = peopleIds.map((id) => {
        const mine = trucks.filter((truck: any) => personOf(truck) === id);
        const mineIds = new Set(mine.map((truck: any) => truck.id));
        const myLoads = loads.filter((load: any) => mineIds.has(load.truck_id));
        const weekGross = myLoads.filter((load: any) => load.pickup_date >= thisWeek).reduce((sum: number, load: any) => sum + Number(load.rate), 0);
        const monthGross = myLoads.filter((load: any) => load.pickup_date >= thisMonth).reduce((sum: number, load: any) => sum + Number(load.rate), 0);
        const periodGross = myLoads.filter((load: any) => inRange(load.pickup_date)).reduce((sum: number, load: any) => sum + Number(load.rate), 0);
        const myInvoices = invoices.filter((invoice: any) => mineIds.has(invoice.truck_id));
        const myCarriers = sales ? scopedCarriers.filter((carrier: any) => carrier.owner_id === id) : [];
        const weeklyTarget = Number(targetRows?.find((row: any) => row.user_id === id && row.period_type === "WEEKLY")?.amount ?? 0);
        const monthlyTarget = Number(targetRows?.find((row: any) => row.user_id === id && row.period_type === "MONTHLY")?.amount ?? 0);
        return {
          id, name: people.get(id) ?? "Unknown",
          carriers: myCarriers.length, pending: myCarriers.filter((carrier: any) => ["DOCS_PENDING", "PENDING_REVIEW", "RETURNED"].includes(carrier.review_status)).length,
          discarded: myCarriers.filter((carrier: any) => carrier.review_status === "DISCARDED").length + mine.filter((truck: any) => ["DISCARDED", "DNC"].includes(truck.status)).length,
          trucks: mine.length, active: mine.filter((truck: any) => truck.status === "RUNNING").length, onboarded: mine.filter((truck: any) => ["ACTIVE", "ONBOARDED", "RUNNING", "INACTIVE"].includes(truck.status)).length,
          loads: myLoads.filter((load: any) => inRange(load.pickup_date)).length,
          week_gross: round(weekGross), month_gross: round(monthGross), period_gross: round(periodGross),
          weekly_target: weeklyTarget, monthly_target: monthlyTarget,
          revenue: round(myInvoices.reduce((sum: number, invoice: any) => sum + (invoice.status === "CANCELLED" ? 0 : Number(invoice.amount)), 0)),
          collected: round(myInvoices.reduce((sum: number, invoice: any) => sum + Number(invoice.amount_paid), 0)),
          outstanding: round(myInvoices.reduce((sum: number, invoice: any) => sum + owed(invoice), 0)),
        };
      }).sort((left, right) => right.period_gross - left.period_gross);

      const byCarrier = scopedCarriers.map((carrier: any) => {
        const mine = trucks.filter((truck: any) => truck.carrier.id === carrier.id); const ids = new Set(mine.map((truck: any) => truck.id));
        const carrierInvoices = invoices.filter((invoice: any) => ids.has(invoice.truck_id));
        return {
          id: carrier.id, company_name: carrier.company_name, mc_number: carrier.mc_number, dot_number: carrier.dot_number, owner: people.get(carrier.owner_id) ?? null, review_status: carrier.review_status, charge_percent: carrier.charge_percent,
          trucks: mine.length, running: mine.filter((truck: any) => truck.status === "RUNNING").length,
          gross: round(loads.filter((load: any) => ids.has(load.truck_id) && inRange(load.pickup_date)).reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          revenue: round(carrierInvoices.reduce((sum: number, invoice: any) => sum + (invoice.status === "CANCELLED" ? 0 : Number(invoice.amount)), 0)),
          collected: round(carrierInvoices.reduce((sum: number, invoice: any) => sum + Number(invoice.amount_paid), 0)),
          outstanding: round(carrierInvoices.reduce((sum: number, invoice: any) => sum + owed(invoice), 0)),
        };
      }).sort((left: any, right: any) => right.gross - left.gross);

      const truckPeople = await names(supabase, trucks.map((truck: any) => truck.assigned_to));
      const byTruck = trucks.map((truck: any) => {
        const truckLoads = loads.filter((load: any) => load.truck_id === truck.id);
        const truckInvoices = invoices.filter((invoice: any) => invoice.truck_id === truck.id);
        return {
          id: truck.id, unit_number: truck.unit_number, truck_type: truck.truck_type, status: truck.status, carrier: truck.carrier.company_name, dispatcher: truck.assigned_to ? truckPeople.get(truck.assigned_to) ?? null : null,
          loads: truckLoads.filter((load: any) => inRange(load.pickup_date)).length,
          week_gross: round(truckLoads.filter((load: any) => load.pickup_date >= thisWeek).reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          gross: round(truckLoads.filter((load: any) => inRange(load.pickup_date)).reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          revenue: round(truckInvoices.reduce((sum: number, invoice: any) => sum + (invoice.status === "CANCELLED" ? 0 : Number(invoice.amount)), 0)),
          outstanding: round(truckInvoices.reduce((sum: number, invoice: any) => sum + owed(invoice), 0)),
        };
      }).sort((left: any, right: any) => right.gross - left.gross);

      const tally = (rows: any[], key: string) => rows.reduce((totals: Record<string, number>, row: any) => { totals[row[key]] = (totals[row[key]] ?? 0) + 1; return totals; }, {});
      const periodLoads = loads.filter((load: any) => inRange(load.pickup_date));
      response.json({
        side: sales ? "SALES" : "OPERATIONS", team_view: teamView, week_start: thisWeek, month_start: thisMonth,
        totals: {
          carriers: scopedCarriers.length, trucks: trucks.length,
          running: trucks.filter((truck: any) => truck.status === "RUNNING").length,
          onboarded: trucks.filter((truck: any) => ["ACTIVE", "ONBOARDED", "RUNNING", "INACTIVE"].includes(truck.status)).length,
          pending: scopedCarriers.filter((carrier: any) => ["DOCS_PENDING", "PENDING_REVIEW", "RETURNED"].includes(carrier.review_status)).length,
          loads: periodLoads.length,
          gross: round(periodLoads.reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          week_gross: round(loads.filter((load: any) => load.pickup_date >= thisWeek).reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          month_gross: round(loads.filter((load: any) => load.pickup_date >= thisMonth).reduce((sum: number, load: any) => sum + Number(load.rate), 0)),
          revenue: round(invoices.reduce((sum: number, invoice: any) => sum + (invoice.status === "CANCELLED" ? 0 : Number(invoice.amount)), 0)),
          collected: round(invoices.reduce((sum: number, invoice: any) => sum + Number(invoice.amount_paid), 0)),
          outstanding: round(invoices.reduce((sum: number, invoice: any) => sum + owed(invoice), 0)),
          signed_off: round(invoices.filter((invoice: any) => invoice.signed_off_at).reduce((sum: number, invoice: any) => sum + Number(invoice.amount), 0)),
        },
        people: byPerson, carriers: byCarrier, trucks: byTruck,
        carrier_statuses: tally(scopedCarriers, "review_status"), truck_statuses: tally(trucks, "status"), invoice_statuses: tally(invoices, "status"),
        agents: peopleIds.map((id) => ({ id, full_name: people.get(id) ?? "Unknown" })).sort((left, right) => left.full_name.localeCompare(right.full_name)),
        load_rows: periodLoads.slice(0, 2000).map((load: any) => ({ ...load, truck: truckOf.get(load.truck_id)?.unit_number ?? null, carrier: truckOf.get(load.truck_id)?.carrier.company_name ?? null })),
      });
    } catch (error) { next(error); }
  });
}
