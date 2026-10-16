import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const port = Number(process.env.PORT ?? 4000);
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:3000", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

type AuthenticatedRequest = Request & { actor?: { id: string; email?: string } };
type BrokerageRequest = Request & { actor?: { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null } };

function adminClient() {
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase Admin is not configured.");
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function requireSuperAdmin(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  try {
    if (!supabaseUrl || !publishableKey) return response.status(503).json({ error: "Authentication service is not configured." });
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return response.status(401).json({ error: "A bearer token is required." });
    const sessionClient = createClient(supabaseUrl, publishableKey);
    const { data: userData, error: userError } = await sessionClient.auth.getUser(token);
    if (userError || !userData.user) return response.status(401).json({ error: "Your session is invalid or has expired." });
    const { data: profile, error: profileError } = await adminClient().from("profiles").select("role").eq("id", userData.user.id).single();
    if (profileError || profile?.role !== "SUPER_ADMIN") return response.status(403).json({ error: "Super Admin access is required." });
    request.actor = { id: userData.user.id, email: userData.user.email };
    next();
  } catch (error) { next(error); }
}

async function requireBrokerageUser(request: BrokerageRequest, response: Response, next: NextFunction) {
  try {
    if (!supabaseUrl || !publishableKey) return response.status(503).json({ error: "Authentication service is not configured." });
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return response.status(401).json({ error: "A bearer token is required." });
    const { data: userData, error: userError } = await createClient(supabaseUrl, publishableKey).auth.getUser(token);
    if (userError || !userData.user) return response.status(401).json({ error: "Your session is invalid or has expired." });
    const { data: profile, error } = await adminClient().from("profiles").select("id, role, department_id, is_active, departments!profiles_department_id_fkey(business_unit, function)").eq("id", userData.user.id).single();
    if (error || !profile?.is_active) return response.status(403).json({ error: "Your account is inactive or incomplete." });
    request.actor = { id: profile.id, role: profile.role, department_id: profile.department_id, department: Array.isArray(profile.departments) ? profile.departments[0] : profile.departments };
    next();
  } catch (error) { next(error); }
}

const createUserSchema = z.object({ full_name: z.string().trim().min(2).max(100), email: z.string().trim().email(), password: z.string().min(8).max(128), role: z.enum(["SUPER_ADMIN", "MANAGER", "AGENT"]), department_id: z.string().uuid().nullable().optional() });
const updateUserSchema = z.object({ full_name: z.string().trim().min(2).max(100).optional(), role: z.enum(["SUPER_ADMIN", "MANAGER", "AGENT"]).optional(), department_id: z.string().uuid().nullable().optional(), is_active: z.boolean().optional(), password: z.string().min(8).max(128).optional() });
const leadSchema = z.object({ company_name: z.string().trim().min(2), contact_name: z.string().trim().optional(), contact_email: z.string().email().optional().or(z.literal("")), contact_phone: z.string().trim().optional(), estimated_monthly_value: z.number().nonnegative().optional(), next_follow_up_at: z.string().datetime().optional(), source: z.string().trim().optional(), notes: z.string().trim().optional() });
const quoteSchema = z.object({ lead_id: z.string().uuid(), pickup_location: z.string().trim().min(2), delivery_location: z.string().trim().min(2), equipment_type: z.string().trim().optional(), quoted_rate: z.number().nonnegative().optional() });
const nullableUuid = z.preprocess((value) => value === "" ? null : value, z.string().uuid().nullable().optional());
const teamSchema = z.object({ name: z.string().trim().min(2).max(80), team_lead_id: nullableUuid, member_ids: z.array(z.string().uuid()).min(1), permissions: z.array(z.string()).default([]) });
const teamUpdateSchema = teamSchema.partial().extend({ is_active: z.boolean().optional() });
const leadUpdateSchema = leadSchema.partial().extend({ stage: z.enum(["NEW", "CONTACTED", "QUALIFIED", "CUSTOMER", "LOST"]).optional(), owner_id: z.string().uuid().optional(), team_id: z.string().uuid().nullable().optional(), archived_at: z.string().datetime().nullable().optional(), estimated_monthly_value: z.number().nonnegative().nullable().optional(), next_follow_up_at: z.string().datetime().nullable().optional() });
const activitySchema = z.object({ activity_type: z.enum(["CALL", "EMAIL", "NOTE", "FOLLOW_UP", "APPOINTMENT"]), body: z.string().trim().min(1).max(3000), due_at: z.string().datetime().nullable().optional() });
const activityCompletionSchema = z.object({ completed: z.boolean() });
const quoteUpdateSchema = quoteSchema.omit({ lead_id: true }).partial();
const reviewSchema = z.object({ action: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(1000).optional() }).superRefine((value, context) => {
  if (value.action === "REJECT" && !value.note) context.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "A rejection reason is required." });
});
const handoffSchema = z.object({ operations_department_id: z.string().uuid(), reference_number: z.string().trim().min(3).max(64), customer_name: z.string().trim().min(2), team_id: z.string().uuid().nullable().optional() });
const shipmentUpdateSchema = z.object({ assigned_to: z.string().uuid().nullable().optional(), team_id: z.string().uuid().nullable().optional(), status: z.enum(["QUOTED", "BOOKED", "CARRIER_ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "PAID", "COMPLETED", "EXCEPTION"]).optional(), carrier_name: z.string().trim().max(160).nullable().optional(), exception_note: z.string().trim().max(3000).nullable().optional(), exception_owner_id: z.string().uuid().nullable().optional(), exception_resolution: z.string().trim().max(3000).nullable().optional(), invoice_ready: z.boolean().optional(), amount_quoted: z.number().nonnegative().nullable().optional(), amount_invoiced: z.number().nonnegative().nullable().optional(), amount_paid: z.number().nonnegative().nullable().optional(), payment_status: z.enum(["DRAFT", "SENT", "PENDING", "PAID", "OVERDUE", "CANCELLED"]).optional(), pickup_date: z.string().date().nullable().optional(), delivery_date: z.string().date().nullable().optional(), note: z.string().trim().max(3000).optional() });
const salesShipmentStage = z.enum(["QUOTED", "BOOKED", "DELIVERED", "PAID"]);
const customerUpdateSchema = z.object({ company_name: z.string().trim().min(2).max(180).optional(), contact_name: z.string().trim().max(160).nullable().optional(), contact_email: z.string().email().nullable().optional().or(z.literal("")), contact_phone: z.string().trim().max(80).nullable().optional() }).strict();
const salesShipmentSchema = z.object({ reference_number: z.string().trim().min(3).max(64), pickup_location: z.string().trim().min(2).max(180), delivery_location: z.string().trim().min(2).max(180), equipment_type: z.string().trim().max(120).nullable().optional(), quoted_rate: z.number().nonnegative().nullable().optional(), agreed_rate: z.number().nonnegative().nullable().optional(), pickup_date: z.string().date().nullable().optional(), delivery_date: z.string().date().nullable().optional(), status: salesShipmentStage.default("QUOTED") });
const salesShipmentUpdateSchema = salesShipmentSchema.partial();
const documentSchema = z.object({ document_type: z.enum(["BOL", "POD", "RATE_CONFIRMATION", "INVOICE", "OTHER"]), storage_path: z.string().trim().min(2).max(500) });
const documentReviewSchema = z.object({ is_verified: z.boolean(), review_note: z.string().trim().max(2000).nullable().optional() });
const commentSchema = z.object({ body: z.string().trim().min(1).max(3000) });
const invoiceSchema = z.object({ status: z.enum(["DRAFT", "SENT", "PENDING", "PAID", "OVERDUE", "CANCELLED"]).optional(), amount: z.number().nonnegative().optional(), amount_paid: z.number().nonnegative().optional(), due_date: z.string().date().nullable().optional() });
const fileSchema = z.object({ file_name: z.string().trim().min(1).max(180), content_type: z.enum(["application/pdf", "image/jpeg", "image/png"]) });

async function writeAudit(supabase: ReturnType<typeof adminClient>, actorId: string, action: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
  await supabase.from("audit_events").insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, detail });
}

async function teamScope(actor: BrokerageRequest["actor"]) {
  const supabase = adminClient();
  if (!actor) return { teamIds: [] as string[], leadTeamIds: [] as string[], permissions: new Set<string>() };
  const { data: memberships } = await supabase.from("team_members").select("team_id, teams(team_lead_id, is_active)").eq("user_id", actor.id);
  const teamIds = (memberships ?? []).map((row: any) => row.team_id);
  const leadTeamIds = (memberships ?? []).filter((row: any) => { const team = Array.isArray(row.teams) ? row.teams[0] : row.teams; return team?.is_active && team.team_lead_id === actor.id; }).map((row: any) => row.team_id);
  // Delegated Team Lead permissions only apply while the actor is the selected lead.
  const { data: grants } = leadTeamIds.length ? await supabase.from("team_lead_permissions").select("permission_key").eq("user_id", actor.id).in("team_id", leadTeamIds) : { data: [] as any[] };
  return { teamIds, leadTeamIds, permissions: new Set((grants ?? []).map((row: any) => row.permission_key)) };
}
function isManager(actor: BrokerageRequest["actor"]) { return actor?.role === "MANAGER"; }
function isSuper(actor: BrokerageRequest["actor"]) { return actor?.role === "SUPER_ADMIN"; }
function isSales(actor: BrokerageRequest["actor"]) { return actor?.department?.business_unit === "BROKERAGE" && actor.department?.function === "SALES"; }
function isOperations(actor: BrokerageRequest["actor"]) { return actor?.department?.business_unit === "BROKERAGE" && actor.department?.function === "OPERATIONS"; }
function canAccessSalesCustomer(actor: BrokerageRequest["actor"], customer: any, lead: any, scope: Awaited<ReturnType<typeof teamScope>>, edit = false) {
  if (!actor) return false;
  if (isSuper(actor)) return true;
  if (isManager(actor) && actor.department_id === customer.sales_department_id) return true;
  if (customer.owner_id === actor.id) return true;
  const permission = edit ? "sales.leads.edit_team" : "sales.leads.view_team";
  return Boolean(lead?.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has(permission));
}
async function withAuthorDetails(supabase: ReturnType<typeof adminClient>, rows: any[], actorId: string, canManage = false) {
  const authorIds = [...new Set(rows.map((row) => row.author_id).filter(Boolean))];
  if (!authorIds.length) return rows;
  const { data: authors, error } = await supabase.from("profiles").select("id, full_name").in("id", authorIds);
  if (error) throw error;
  const names = new Map((authors ?? []).map((author: any) => [author.id, author.full_name]));
  return rows.map((row) => ({ ...row, author_name: names.get(row.author_id) ?? "Unknown user", can_delete: canManage || row.author_id === actorId }));
}
async function validDepartmentPeople(departmentId: string, ids: string[]) {
  if (!ids.length) return true;
  const { data, error } = await adminClient().from("profiles").select("id, role").eq("department_id", departmentId).eq("is_active", true).in("id", ids);
  return !error && (data ?? []).length === ids.length && (data ?? []).every((person: any) => person.role === "AGENT");
}

app.get("/health", (_request, response) => response.json({ status: "ok", service: "deboss-api", timestamp: new Date().toISOString() }));

app.get("/api/v1/users", requireSuperAdmin, async (_request, response, next) => {
  try {
    const { data, error } = await adminClient().from("profiles").select("id, full_name, email, role, is_active, created_at, departments!profiles_department_id_fkey(id, name, business_unit, function)").order("created_at", { ascending: false });
    if (error) throw error;
    response.json({ users: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/users", requireSuperAdmin, async (request, response, next) => {
  try {
    const input = createUserSchema.parse(request.body);
    const supabase = adminClient();
    if (input.role !== "SUPER_ADMIN" && !input.department_id) return response.status(422).json({ error: "A departmental role requires a department." });
    const { data: created, error: createError } = await supabase.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true });
    if (createError || !created.user) return response.status(422).json({ error: createError?.message ?? "Unable to create the user." });
    const { data: profile, error: updateError } = await supabase.from("profiles").update({ full_name: input.full_name, email: input.email, role: input.role, department_id: input.role === "SUPER_ADMIN" ? null : input.department_id, is_active: true }).eq("id", created.user.id).select().single();
    if (updateError) { await supabase.auth.admin.deleteUser(created.user.id); throw updateError; }
    response.status(201).json({ user: profile });
  } catch (error) { next(error); }
});

app.patch("/api/v1/users/:id", requireSuperAdmin, async (request, response, next) => {
  try {
    const userId = z.string().uuid().parse(request.params.id);
    const input = updateUserSchema.parse(request.body);
    const supabase = adminClient();
    const { password, ...profileUpdate } = input;
    if (profileUpdate.role === "SUPER_ADMIN") profileUpdate.department_id = null;
    if (password) {
      const { error } = await supabase.auth.admin.updateUserById(userId, { password });
      if (error) return response.status(422).json({ error: error.message });
    }
    if (Object.keys(profileUpdate).length) {
      const { data, error } = await supabase.from("profiles").update(profileUpdate).eq("id", userId).select().single();
      if (error) throw error;
      return response.json({ user: data });
    }
    response.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/workspace", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (actor.role !== "SUPER_ADMIN" && actor.department?.business_unit !== "BROKERAGE") return response.status(403).json({ error: "Brokerage access is required." });
    const supabase = adminClient();
    const { data: memberships } = await supabase.from("team_members").select("team_id, teams(id, name, team_lead_id, department_id, is_active)").eq("user_id", actor.id);
    const teamIds = (memberships ?? []).map((member) => member.team_id);
    const leadTeams = (memberships ?? []).filter((member) => { const team = Array.isArray(member.teams) ? member.teams[0] : member.teams; return team?.is_active && team.team_lead_id === actor.id; }).map((member) => member.team_id);
    const { data: grants } = await supabase.from("team_lead_permissions").select("permission_key").eq("user_id", actor.id).in("team_id", leadTeams.length ? leadTeams : ["00000000-0000-0000-0000-000000000000"]);
    const permissions = new Set((grants ?? []).map((grant) => grant.permission_key));
    const departmentManager = actor.role === "MANAGER";
    const sales = actor.department?.function === "SALES";
    const teamScope = leadTeams.length && (permissions.has("sales.leads.view_team") || permissions.has("operations.shipments.view_team"));
    let leadQuery = supabase.from("sales_leads").select("*").order("updated_at", { ascending: false }).limit(100);
    if (!departmentManager && actor.role !== "SUPER_ADMIN") leadQuery = teamScope && sales ? leadQuery.in("team_id", leadTeams) : leadQuery.eq("owner_id", actor.id);
    if (actor.department_id && actor.role !== "SUPER_ADMIN") leadQuery = leadQuery.eq("department_id", actor.department_id);
    const [{ data: leads }, { data: teams }, { data: operationsDepartments }] = await Promise.all([leadQuery, supabase.from("teams").select("id, name, team_lead_id").eq("department_id", actor.department_id ?? "00000000-0000-0000-0000-000000000000"), sales ? supabase.from("departments").select("id, name").eq("business_unit", "BROKERAGE").eq("function", "OPERATIONS").eq("is_active", true).order("name") : Promise.resolve({ data: [] })]);
    const leadIds = (leads ?? []).map((lead: any) => lead.id);
    const { data: salesCustomers } = sales && leadIds.length ? await supabase.from("brokerage_customers").select("id").in("lead_id", leadIds) : { data: [] as any[] };
    let shipmentQuery = supabase.from("brokerage_shipments").select("*").order("updated_at", { ascending: false }).limit(100);
    if (sales) {
      const customerIds = (salesCustomers ?? []).map((customer: any) => customer.id);
      shipmentQuery = customerIds.length ? shipmentQuery.in("customer_id", customerIds) : shipmentQuery.eq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      if (!departmentManager && actor.role !== "SUPER_ADMIN") shipmentQuery = teamScope ? shipmentQuery.in("team_id", leadTeams) : shipmentQuery.eq("assigned_to", actor.id);
      if (actor.department_id && actor.role !== "SUPER_ADMIN") shipmentQuery = shipmentQuery.eq("operations_department_id", actor.department_id);
    }
    const [{ data: shipments }, { data: quotes }] = await Promise.all([shipmentQuery, sales && leadIds.length ? supabase.from("sales_quotes").select("*").in("lead_id", leadIds).order("updated_at", { ascending: false }) : Promise.resolve({ data: [] })]);
    const operationsAgent = isOperations(actor);
    response.json({ role: actor.role, department: actor.department, teams, operationsDepartments, permissions: [...permissions], capabilities: { sales, departmentManager, teamLead: leadTeams.length > 0, canCreateLead: sales, canCreateQuote: sales, canManageCustomerShipments: sales, canUpdateShipments: operationsAgent, canRecordShipmentFinance: operationsAgent, canRaiseException: operationsAgent, canReviewQuotes: departmentManager || permissions.has("sales.quotes.review"), canHandoffQuotes: departmentManager || permissions.has("sales.quotes.handoff"), canAssignShipments: departmentManager || permissions.has("operations.shipments.assign"), canReviewDocuments: departmentManager || permissions.has("operations.documents.review"), canResolveExceptions: departmentManager || permissions.has("operations.exceptions.resolve"), canMarkInvoiceReady: departmentManager || permissions.has("operations.billing.mark_invoice_ready") }, leads, quotes, shipments });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/leads", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = leadSchema.parse(request.body);
    if (actor.department?.business_unit !== "BROKERAGE" || actor.department?.function !== "SALES" || !actor.department_id) return response.status(403).json({ error: "Only Brokerage Sales users can create leads." });
    const { data: membership } = await adminClient().from("team_members").select("team_id").eq("user_id", actor.id).limit(1).maybeSingle();
    const { data, error } = await adminClient().from("sales_leads").insert({ ...input, contact_email: input.contact_email || null, department_id: actor.department_id, owner_id: actor.id, team_id: membership?.team_id ?? null }).select().single();
    if (error) throw error; response.status(201).json({ lead: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = quoteSchema.parse(request.body);
    if (actor.department?.function !== "SALES") return response.status(403).json({ error: "Only Brokerage Sales users can create quotes." });
    const { data: lead } = await adminClient().from("sales_leads").select("id, department_id, owner_id, team_id").eq("id", input.lead_id).maybeSingle();
    const scope = await teamScope(actor); const accessible = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.view_team")));
    if (!accessible) return response.status(403).json({ error: "You cannot create a quote for this lead." });
    const { data, error } = await adminClient().from("sales_quotes").insert({ ...input, created_by: actor.id }).select().single();
    if (error) throw error; await writeAudit(adminClient(), actor.id, "QUOTE_CREATED", "quote", data.id, { lead_id: input.lead_id }); response.status(201).json({ quote: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/teams", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = teamSchema.parse(request.body);
    if (actor.role !== "MANAGER" || actor.department?.business_unit !== "BROKERAGE" || !actor.department_id) return response.status(403).json({ error: "Only a Brokerage Department Manager can create teams." });
    const supabase = adminClient();
    const memberIds = [...new Set([...input.member_ids, ...(input.team_lead_id ? [input.team_lead_id] : [])])];
    if (!await validDepartmentPeople(actor.department_id, memberIds)) return response.status(422).json({ error: "Team members and Team Leads must be active Agents in your department." });
    const { data: team, error: teamError } = await supabase.from("teams").insert({ name: input.name, department_id: actor.department_id, manager_id: actor.id, team_lead_id: input.team_lead_id ?? null }).select().single();
    if (teamError || !team) throw teamError;
    const { error: membersError } = await supabase.from("team_members").insert(memberIds.map((user_id) => ({ team_id: team.id, user_id })));
    if (membersError) throw membersError;
    if (input.team_lead_id && input.permissions.length) {
      const { error: permissionError } = await supabase.from("team_lead_permissions").insert(input.permissions.map((permission_key) => ({ team_id: team.id, user_id: input.team_lead_id, permission_key, granted_by: actor.id })));
      if (permissionError) throw permissionError;
    }
    await writeAudit(supabase, actor.id, "TEAM_CREATED", "team", team.id, { member_count: memberIds.length, team_lead_id: input.team_lead_id ?? null });
    response.status(201).json({ team });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/team-directory", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (actor.role !== "MANAGER" || !actor.department_id) return response.status(403).json({ error: "Only a Department Manager can manage teams." });
    const supabase = adminClient();
    const [{ data: members, error: membersError }, { data: teams, error: teamsError }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email, role, is_active").eq("department_id", actor.department_id).eq("is_active", true).eq("role", "AGENT"),
      supabase.from("teams").select("id, name, team_lead_id, is_active, team_members(user_id), team_lead_permissions(user_id, permission_key)").eq("department_id", actor.department_id).order("name"),
    ]);
    if (membersError || teamsError) throw membersError ?? teamsError;
    response.json({ users: members, teams });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/teams/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const teamId = z.string().uuid().parse(request.params.id); const input = teamUpdateSchema.parse(request.body);
    if (actor.role !== "MANAGER" || !actor.department_id) return response.status(403).json({ error: "Only a Department Manager can edit teams." });
    const supabase = adminClient(); const { data: existing, error: existingError } = await supabase.from("teams").select("id, team_lead_id").eq("id", teamId).eq("department_id", actor.department_id).eq("manager_id", actor.id).single();
    if (existingError || !existing) return response.status(404).json({ error: "Team not found." });
    const { member_ids, permissions, ...teamUpdate } = input;
    if (Object.keys(teamUpdate).length) { const { error } = await supabase.from("teams").update(teamUpdate).eq("id", teamId); if (error) throw error; }
    const teamLeadId = input.team_lead_id === undefined ? existing.team_lead_id : input.team_lead_id;
    if (member_ids) { const merged = [...new Set([...member_ids, ...(teamLeadId ? [teamLeadId] : [])])]; if (!await validDepartmentPeople(actor.department_id, merged)) return response.status(422).json({ error: "Team members must belong to your department." }); await supabase.from("team_members").delete().eq("team_id", teamId); const { error } = await supabase.from("team_members").insert(merged.map((user_id) => ({ team_id: teamId, user_id }))); if (error) throw error; }
    const leadChanged = input.team_lead_id !== undefined && input.team_lead_id !== existing.team_lead_id;
    if (permissions !== undefined || leadChanged) { await supabase.from("team_lead_permissions").delete().eq("team_id", teamId); const delegatedPermissions = permissions ?? []; if (teamLeadId && delegatedPermissions.length) { const { error } = await supabase.from("team_lead_permissions").insert(delegatedPermissions.map((permission_key) => ({ team_id: teamId, user_id: teamLeadId, permission_key, granted_by: actor.id }))); if (error) throw error; } }
    await writeAudit(supabase, actor.id, "TEAM_UPDATED", "team", teamId);
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/leads/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = leadUpdateSchema.parse(request.body); const supabase = adminClient();
    const { data: lead, error: leadError } = await supabase.from("sales_leads").select("*").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (leadError || !lead) return response.status(404).json({ error: "Lead not found." });
    const scope = await teamScope(actor); const teamEditor = !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!(isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || teamEditor)) return response.status(403).json({ error: "You do not have permission to edit this lead." });
    if (input.stage === "CUSTOMER") return response.status(422).json({ error: "Customer stage is set when you convert the lead to a customer profile." });
    if ((input.owner_id || input.team_id !== undefined) && !(isSuper(actor) || isManager(actor) || scope.permissions.has("sales.leads.assign"))) return response.status(403).json({ error: "Lead assignment permission is required." });
    if (input.owner_id && !await validDepartmentPeople(lead.department_id, [input.owner_id])) return response.status(422).json({ error: "The lead owner must be an active Sales Agent in this department." });
    if (input.team_id) { const { data: team } = await supabase.from("teams").select("id").eq("id", input.team_id).eq("department_id", lead.department_id).eq("is_active", true).maybeSingle(); if (!team) return response.status(422).json({ error: "The team must be active in this Sales department." }); }
    const leadUpdate = { ...input, contact_email: input.contact_email || null };
    const { data, error } = await supabase.from("sales_leads").update(leadUpdate).eq("id", lead.id).select().single();
    if (error) throw error;
    const customerFields = ["company_name", "contact_name", "contact_email", "contact_phone"].filter((field) => input[field as keyof typeof input] !== undefined);
    if (customerFields.length) {
      const { data: customer } = await supabase.from("brokerage_customers").select("id").eq("lead_id", lead.id).maybeSingle();
      if (customer) {
        const customerUpdate: Record<string, unknown> = {};
        for (const field of customerFields) customerUpdate[field] = (leadUpdate as Record<string, unknown>)[field];
        const { error: customerError } = await supabase.from("brokerage_customers").update(customerUpdate).eq("id", customer.id);
        if (customerError) throw customerError;
      }
    }
    if (input.owner_id && input.owner_id !== lead.owner_id && input.owner_id !== actor.id) await supabase.from("notifications").insert({ recipient_id: input.owner_id, kind: "LEAD_ASSIGNED", title: "Lead assigned", body: `${lead.company_name} has been assigned to you.`, entity_type: "LEAD", entity_id: lead.id });
    await writeAudit(supabase, actor.id, "LEAD_UPDATED", "lead", lead.id, { fields: Object.keys(input) }); response.json({ lead: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/leads/:id/activities", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = activitySchema.parse(request.body); const supabase = adminClient();
    const { data: lead, error: leadError } = await supabase.from("sales_leads").select("id, owner_id, team_id, department_id").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (leadError || !lead) return response.status(404).json({ error: "Lead not found." });
    const scope = await teamScope(actor); const teamEditor = !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && (scope.permissions.has("sales.leads.edit_team") || scope.permissions.has("sales.activities.assign"));
    if (!(isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || teamEditor)) return response.status(403).json({ error: "You do not have permission to add activity to this lead." });
    const { data, error } = await supabase.from("lead_activities").insert({ ...input, lead_id: lead.id, author_id: actor.id }).select().single();
    if (error) throw error; await writeAudit(supabase, actor.id, "LEAD_ACTIVITY_ADDED", "lead", lead.id, { type: input.activity_type }); response.status(201).json({ activity: data });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/activities/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = activityCompletionSchema.parse(request.body); const supabase = adminClient();
    const { data: activity, error: activityError } = await supabase.from("lead_activities").select("id, lead_id, author_id").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (activityError || !activity) return response.status(404).json({ error: "Activity not found." });
    const { data: lead } = await supabase.from("sales_leads").select("id, owner_id, team_id, department_id").eq("id", activity.lead_id).maybeSingle();
    if (!lead) return response.status(404).json({ error: "Lead not found." });
    const scope = await teamScope(actor); const teamEditor = !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!(activity.author_id === actor.id || isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || teamEditor)) return response.status(403).json({ error: "You do not have permission to update this activity." });
    const { data, error } = await supabase.from("lead_activities").update({ completed_at: input.completed ? new Date().toISOString() : null }).eq("id", activity.id).select().single();
    if (error) throw error;
    await writeAudit(supabase, actor.id, input.completed ? "LEAD_ACTIVITY_COMPLETED" : "LEAD_ACTIVITY_REOPENED", "lead", lead.id, { activity_id: activity.id });
    response.json({ activity: data });
  } catch (error) { next(error); }
});

app.delete("/api/v1/brokerage/activities/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient();
    const { data: activity, error: activityError } = await supabase.from("lead_activities").select("id, lead_id, author_id").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (activityError || !activity) return response.status(404).json({ error: "Activity not found." });
    const { data: lead } = await supabase.from("sales_leads").select("id, team_id, department_id").eq("id", activity.lead_id).maybeSingle();
    if (!lead) return response.status(404).json({ error: "Lead not found." });
    const scope = await teamScope(actor); const teamEditor = !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!(activity.author_id === actor.id || isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || teamEditor)) return response.status(403).json({ error: "You do not have permission to delete this activity." });
    const { error } = await supabase.from("lead_activities").delete().eq("id", activity.id);
    if (error) throw error;
    await writeAudit(supabase, actor.id, "LEAD_ACTIVITY_DELETED", "lead", lead.id, { activity_id: activity.id });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/leads/:id/detail", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient(); const leadId = z.string().uuid().parse(request.params.id); const { data: lead, error } = await supabase.from("sales_leads").select("*").eq("id", leadId).single();
    if (error || !lead) return response.status(404).json({ error: "Lead not found." }); const scope = await teamScope(actor); const teamReadable = !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.view_team"); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || teamReadable;
    if (!allowed) return response.status(403).json({ error: "Lead is outside your work scope." }); const [activities, comments, customer, quotes] = await Promise.all([supabase.from("lead_activities").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false }), supabase.from("record_comments").select("*").eq("entity_type", "LEAD").eq("entity_id", lead.id).order("created_at", { ascending: false }), supabase.from("brokerage_customers").select("*").eq("lead_id", lead.id).maybeSingle(), supabase.from("sales_quotes").select("*").eq("lead_id", lead.id).order("updated_at", { ascending: false })]);
    const canManage = isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id);
    response.json({ lead, activities: await withAuthorDetails(supabase, activities.data ?? [], actor.id, canManage), comments: await withAuthorDetails(supabase, comments.data ?? [], actor.id, canManage), customer: customer.data ?? null, quotes: quotes.data ?? [] });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/leads/:id/comments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = commentSchema.parse(request.body); const supabase = adminClient(); const leadId = z.string().uuid().parse(request.params.id); const { data: lead, error } = await supabase.from("sales_leads").select("id, department_id, owner_id, team_id").eq("id", leadId).single();
    if (error || !lead) return response.status(404).json({ error: "Lead not found." }); const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team"));
    if (!allowed) return response.status(403).json({ error: "Lead is outside your work scope." }); const { data, error: insertError } = await supabase.from("record_comments").insert({ entity_type: "LEAD", entity_id: lead.id, author_id: actor.id, body: input.body }).select().single(); if (insertError) throw insertError;
    if (lead.owner_id !== actor.id) await supabase.from("notifications").insert({ recipient_id: lead.owner_id, kind: "LEAD_COMMENT", title: "New lead comment", body: input.body.slice(0, 140), entity_type: "LEAD", entity_id: lead.id }); await writeAudit(supabase, actor.id, "LEAD_COMMENT_ADDED", "lead", lead.id); response.status(201).json({ comment: data });
  } catch (error) { next(error); }
});

app.delete("/api/v1/brokerage/comments/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient();
    const { data: comment, error: commentError } = await supabase.from("record_comments").select("id, entity_type, entity_id, author_id").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (commentError || !comment) return response.status(404).json({ error: "Comment not found." });
    let departmentId: string | null = null;
    if (comment.entity_type === "LEAD") { const { data: lead } = await supabase.from("sales_leads").select("department_id").eq("id", comment.entity_id).single(); departmentId = lead?.department_id ?? null; }
    if (comment.entity_type === "CUSTOMER") { const { data: customer } = await supabase.from("brokerage_customers").select("sales_department_id").eq("id", comment.entity_id).single(); departmentId = customer?.sales_department_id ?? null; }
    if (comment.entity_type === "QUOTE") { const { data: quote } = await supabase.from("sales_quotes").select("sales_leads(department_id)").eq("id", comment.entity_id).single(); const lead = Array.isArray((quote as any)?.sales_leads) ? (quote as any).sales_leads[0] : (quote as any)?.sales_leads; departmentId = lead?.department_id ?? null; }
    if (comment.entity_type === "SHIPMENT") { const { data: shipment } = await supabase.from("brokerage_shipments").select("operations_department_id").eq("id", comment.entity_id).single(); departmentId = shipment?.operations_department_id ?? null; }
    const canManage = isSuper(actor) || (isManager(actor) && actor.department_id === departmentId);
    if (comment.author_id !== actor.id && !canManage) return response.status(403).json({ error: "Only the comment author or the responsible manager can delete this comment." });
    const { error } = await supabase.from("record_comments").delete().eq("id", comment.id);
    if (error) throw error;
    await writeAudit(supabase, actor.id, "COMMENT_DELETED", comment.entity_type.toLowerCase(), comment.entity_id, { comment_id: comment.id });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/leads/:id/convert", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient(); const { data: lead, error: leadError } = await supabase.from("sales_leads").select("*").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (leadError || !lead) return response.status(404).json({ error: "Lead not found." });
    const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team"));
    if (!allowed) return response.status(403).json({ error: "You do not have permission to convert this lead." });
    const { data: customer, error } = await supabase.from("brokerage_customers").upsert({ lead_id: lead.id, sales_department_id: lead.department_id, owner_id: lead.owner_id, company_name: lead.company_name, contact_name: lead.contact_name, contact_email: lead.contact_email, contact_phone: lead.contact_phone }, { onConflict: "lead_id" }).select().single();
    if (error) throw error; await supabase.from("sales_leads").update({ stage: "CUSTOMER" }).eq("id", lead.id); await writeAudit(supabase, actor.id, "LEAD_CONVERTED", "lead", lead.id, { customer_id: customer.id }); response.json({ customer });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/customers/:id/profile", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient(); const customerId = z.string().uuid().parse(request.params.id);
    const { data: customer, error } = await supabase.from("brokerage_customers").select("*").eq("id", customerId).single();
    if (error || !customer) return response.status(404).json({ error: "Customer not found." });
    const scope = await teamScope(actor); const { data: lead } = customer.lead_id ? await supabase.from("sales_leads").select("id, owner_id, team_id, department_id").eq("id", customer.lead_id).maybeSingle() : { data: null };
    const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === customer.sales_department_id) || customer.owner_id === actor.id || (lead && !!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.view_team"));
    if (!allowed) return response.status(403).json({ error: "Customer is outside your work scope." });
    const [activities, comments, quotes, shipments] = await Promise.all([customer.lead_id ? supabase.from("lead_activities").select("*").eq("lead_id", customer.lead_id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }), supabase.from("record_comments").select("*").eq("entity_type", "CUSTOMER").eq("entity_id", customer.id).order("created_at", { ascending: false }), customer.lead_id ? supabase.from("sales_quotes").select("id, pickup_location, delivery_location, stage, quoted_rate, created_at").eq("lead_id", customer.lead_id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }), supabase.from("brokerage_shipments").select("id, quote_id, reference_number, status, sales_status, pickup_location, delivery_location, equipment_type, amount_quoted, amount_agreed, pickup_date, delivery_date, created_at, updated_at").eq("customer_id", customer.id).order("created_at", { ascending: false })]);
    const canManage = isSuper(actor) || (isManager(actor) && actor.department_id === customer.sales_department_id);
    response.json({ customer, can_edit: canAccessSalesCustomer(actor, customer, lead, scope, true), activities: await withAuthorDetails(supabase, activities.data ?? [], actor.id, canManage), comments: await withAuthorDetails(supabase, comments.data ?? [], actor.id, canManage), quotes: quotes.data ?? [], shipments: shipments.data ?? [] });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/customers/:id/comments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const input = commentSchema.parse(request.body);
    const supabase = adminClient();
    const customerId = z.string().uuid().parse(request.params.id);
    const { data: customer, error } = await supabase.from("brokerage_customers").select("id, sales_department_id, owner_id, lead_id").eq("id", customerId).single();
    if (error || !customer) return response.status(404).json({ error: "Customer not found." });
    const { data: lead } = customer.lead_id ? await supabase.from("sales_leads").select("team_id").eq("id", customer.lead_id).maybeSingle() : { data: null };
    const scope = await teamScope(actor);
    const teamEditor = !!lead?.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!(isSuper(actor) || (isManager(actor) && actor.department_id === customer.sales_department_id) || customer.owner_id === actor.id || teamEditor)) return response.status(403).json({ error: "Customer is outside your work scope." });
    const { data, error: insertError } = await supabase.from("record_comments").insert({ entity_type: "CUSTOMER", entity_id: customer.id, author_id: actor.id, body: input.body }).select().single();
    if (insertError) throw insertError;
    if (customer.owner_id !== actor.id) await supabase.from("notifications").insert({ recipient_id: customer.owner_id, kind: "CUSTOMER_COMMENT", title: "New customer comment", body: input.body.slice(0, 140), entity_type: "CUSTOMER", entity_id: customer.id });
    response.status(201).json({ comment: data });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/customers", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (!isSuper(actor) && !isSales(actor)) return response.status(403).json({ error: "Brokerage Sales access is required." });
    const supabase = adminClient();
    let query = supabase.from("brokerage_customers").select("id, lead_id, company_name, contact_name, contact_email, contact_phone, owner_id, sales_department_id, created_at, updated_at").order("updated_at", { ascending: false }).limit(200);
    if (!isSuper(actor)) {
      if (isManager(actor)) query = query.eq("sales_department_id", actor.department_id!);
      else {
        const scope = await teamScope(actor);
        let leadQuery = supabase.from("sales_leads").select("id").eq("department_id", actor.department_id!);
        leadQuery = scope.permissions.has("sales.leads.view_team") && scope.leadTeamIds.length ? leadQuery.in("team_id", scope.leadTeamIds) : leadQuery.eq("owner_id", actor.id);
        const { data: leads, error: leadsError } = await leadQuery;
        if (leadsError) throw leadsError;
        const leadIds = (leads ?? []).map((lead) => lead.id);
        query = leadIds.length ? query.in("lead_id", leadIds) : query.eq("id", "00000000-0000-0000-0000-000000000000");
      }
    }
    const { data, error } = await query;
    if (error) throw error;
    response.json({ customers: data ?? [] });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/customers/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (!isSuper(actor) && !isSales(actor)) return response.status(403).json({ error: "Brokerage Sales access is required." });
    const input = customerUpdateSchema.parse(request.body);
    if (!Object.keys(input).length) return response.status(422).json({ error: "At least one customer field is required." });
    const supabase = adminClient();
    const customerId = z.string().uuid().parse(request.params.id);
    const { data: customer, error: customerError } = await supabase.from("brokerage_customers").select("*").eq("id", customerId).single();
    if (customerError || !customer) return response.status(404).json({ error: "Customer not found." });
    const { data: lead } = customer.lead_id ? await supabase.from("sales_leads").select("id, team_id").eq("id", customer.lead_id).maybeSingle() : { data: null };
    const scope = await teamScope(actor);
    if (!canAccessSalesCustomer(actor, customer, lead, scope, true)) return response.status(403).json({ error: "Customer update permission is required." });
    const update = { ...input, contact_email: input.contact_email === "" ? null : input.contact_email };
    const { data, error } = await supabase.from("brokerage_customers").update(update).eq("id", customer.id).select().single();
    if (error || !data) throw error;
    if (lead?.id) {
      const leadUpdate: Record<string, unknown> = {};
      if (input.company_name !== undefined) leadUpdate.company_name = input.company_name;
      if (input.contact_name !== undefined) leadUpdate.contact_name = input.contact_name;
      if (input.contact_email !== undefined) leadUpdate.contact_email = update.contact_email;
      if (input.contact_phone !== undefined) leadUpdate.contact_phone = input.contact_phone;
      if (Object.keys(leadUpdate).length) await supabase.from("sales_leads").update(leadUpdate).eq("id", lead.id);
    }
    await writeAudit(supabase, actor.id, "CUSTOMER_UPDATED", "customer", customer.id, { fields: Object.keys(input) });
    response.json({ customer: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/customers/:id/shipments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (!isSuper(actor) && !isSales(actor)) return response.status(403).json({ error: "Brokerage Sales access is required." });
    const input = salesShipmentSchema.parse(request.body);
    const supabase = adminClient();
    const customerId = z.string().uuid().parse(request.params.id);
    const { data: customer, error: customerError } = await supabase.from("brokerage_customers").select("*").eq("id", customerId).single();
    if (customerError || !customer) return response.status(404).json({ error: "Customer not found." });
    const { data: lead } = customer.lead_id ? await supabase.from("sales_leads").select("id, team_id").eq("id", customer.lead_id).maybeSingle() : { data: null };
    const scope = await teamScope(actor);
    if (!canAccessSalesCustomer(actor, customer, lead, scope, true)) return response.status(403).json({ error: "Customer shipment creation permission is required." });
    if (!lead?.id) return response.status(422).json({ error: "This customer is not linked to a Sales lead." });
    const { quoted_rate, agreed_rate, status, reference_number, pickup_date, delivery_date, ...shipmentInput } = input;
    const { data: quote, error: quoteError } = await supabase.from("sales_quotes").insert({ lead_id: lead.id, created_by: actor.id, pickup_location: shipmentInput.pickup_location, delivery_location: shipmentInput.delivery_location, equipment_type: shipmentInput.equipment_type ?? null, quoted_rate: quoted_rate ?? null }).select().single();
    if (quoteError || !quote) throw quoteError;
    const { data: shipment, error } = await supabase.from("brokerage_shipments").insert({ ...shipmentInput, quote_id: quote.id, reference_number, pickup_date: pickup_date ?? null, delivery_date: delivery_date ?? null, customer_id: customer.id, sales_department_id: customer.sales_department_id, customer_name: customer.company_name, amount_quoted: quoted_rate ?? null, amount_agreed: agreed_rate ?? null, status: "BOOKED", sales_status: status }).select().single();
    if (error || !shipment) {
      await supabase.from("sales_quotes").delete().eq("id", quote.id);
      throw error;
    }
    await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "SALES_SHIPMENT_CREATED", to_status: input.status });
    await writeAudit(supabase, actor.id, "SALES_SHIPMENT_CREATED", "shipment", shipment.id, { customer_id: customer.id, sales_status: input.status });
    response.status(201).json({ shipment });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/sales-shipments/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (!isSuper(actor) && !isSales(actor)) return response.status(403).json({ error: "Brokerage Sales access is required." });
    const input = salesShipmentUpdateSchema.parse(request.body);
    if (!Object.keys(input).length) return response.status(422).json({ error: "At least one shipment field is required." });
    const supabase = adminClient();
    const shipmentId = z.string().uuid().parse(request.params.id);
    const { data: shipment, error: shipmentError } = await supabase.from("brokerage_shipments").select("*, brokerage_customers(*)").eq("id", shipmentId).single();
    if (shipmentError || !shipment) return response.status(404).json({ error: "Shipment not found." });
    const customer: any = Array.isArray((shipment as any).brokerage_customers) ? (shipment as any).brokerage_customers[0] : (shipment as any).brokerage_customers;
    if (!customer) return response.status(422).json({ error: "This shipment is not linked to a customer profile." });
    const { data: lead } = customer.lead_id ? await supabase.from("sales_leads").select("id, team_id").eq("id", customer.lead_id).maybeSingle() : { data: null };
    const scope = await teamScope(actor);
    if (!canAccessSalesCustomer(actor, customer, lead, scope, true)) return response.status(403).json({ error: "Customer shipment update permission is required." });
    const { quoted_rate, agreed_rate, status, ...shipmentInput } = input;
    const update: Record<string, unknown> = { ...shipmentInput };
    if (quoted_rate !== undefined) update.amount_quoted = quoted_rate;
    if (agreed_rate !== undefined) update.amount_agreed = agreed_rate;
    if (status !== undefined) update.sales_status = status;
    const { data, error } = await supabase.from("brokerage_shipments").update(update).eq("id", shipment.id).select().single();
    if (error || !data) throw error;
    if (shipment.quote_id) {
      const quoteUpdate: Record<string, unknown> = {};
      if (input.pickup_location !== undefined) quoteUpdate.pickup_location = input.pickup_location;
      if (input.delivery_location !== undefined) quoteUpdate.delivery_location = input.delivery_location;
      if (input.equipment_type !== undefined) quoteUpdate.equipment_type = input.equipment_type;
      if (quoted_rate !== undefined) quoteUpdate.quoted_rate = quoted_rate;
      if (Object.keys(quoteUpdate).length) {
        const { error: quoteError } = await supabase.from("sales_quotes").update(quoteUpdate).eq("id", shipment.quote_id).in("stage", ["DRAFT", "REJECTED"]);
        if (quoteError) throw quoteError;
      }
    }
    if (status && status !== shipment.sales_status) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "SALES_STATUS_CHANGED", from_status: shipment.sales_status, to_status: status });
    await writeAudit(supabase, actor.id, "SALES_SHIPMENT_UPDATED", "shipment", shipment.id, { fields: Object.keys(input) });
    response.json({ shipment: data });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/notifications", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const { data, error } = await adminClient().from("notifications").select("*").eq("recipient_id", request.actor!.id).order("created_at", { ascending: false }).limit(50); if (error) throw error; response.json({ notifications: data ?? [] }); } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/notifications/:id/read", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const { data, error } = await adminClient().from("notifications").update({ read_at: new Date().toISOString() }).eq("id", z.string().uuid().parse(request.params.id)).eq("recipient_id", request.actor!.id).select().single(); if (error || !data) return response.status(404).json({ error: "Notification not found." }); response.json({ notification: data }); } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/quotes/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = quoteUpdateSchema.parse(request.body); const supabase = adminClient();
    const { data: quote, error: quoteError } = await supabase.from("sales_quotes").select("*, sales_leads(*)").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (quoteError || !quote) return response.status(404).json({ error: "Quote not found." }); const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads;
    const scope = await teamScope(actor); const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team")));
    if (!allowed || !["DRAFT", "REJECTED"].includes((quote as any).stage)) return response.status(403).json({ error: "This quote cannot be edited in its current stage." });
    const { data, error } = await supabase.from("sales_quotes").update(input).eq("id", quote.id).select().single(); if (error) throw error; await writeAudit(supabase, actor.id, "QUOTE_UPDATED", "quote", quote.id, { fields: Object.keys(input) }); response.json({ quote: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/submit", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const supabase = adminClient();
    const { data: quote, error } = await supabase.from("sales_quotes").select("id, lead_id, stage, created_by, sales_leads(owner_id, team_id, department_id)").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (error || !quote) return response.status(404).json({ error: "Quote not found." });
    const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads;
    const scope = await teamScope(actor);
    const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team")));
    if (!allowed) return response.status(403).json({ error: "Quote submission permission is required." });
    if (!['DRAFT', 'REJECTED'].includes((quote as any).stage)) return response.status(422).json({ error: "Only a draft or reworked quote can be submitted." });
    const { data, error: updateError } = await supabase.from("sales_quotes").update({ stage: "SUBMITTED", rejection_note: null }).eq("id", quote.id).select().single();
    if (updateError || !data) throw updateError;
    await supabase.from("quote_events").insert({ quote_id: quote.id, actor_id: actor.id, event_type: "QUOTE_SUBMITTED" });
    const { data: reviewers } = await supabase.from("profiles").select("id").eq("department_id", lead.department_id).eq("role", "MANAGER").eq("is_active", true);
    if (reviewers?.length) await supabase.from("notifications").insert(reviewers.filter((reviewer) => reviewer.id !== actor.id).map((reviewer) => ({ recipient_id: reviewer.id, kind: "QUOTE_SUBMITTED", title: "Quote awaiting review", body: "A sales quote is ready for approval.", entity_type: "QUOTE", entity_id: quote.id })));
    await writeAudit(supabase, actor.id, "QUOTE_SUBMITTED", "quote", quote.id);
    response.json({ quote: data });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/quotes/:id/detail", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient(); const quoteId = z.string().uuid().parse(request.params.id);
    const { data: quote, error } = await supabase.from("sales_quotes").select("*, sales_leads(id, owner_id, team_id, department_id)").eq("id", quoteId).single(); if (error || !quote) return response.status(404).json({ error: "Quote not found." });
    const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads; const scope = await teamScope(actor); const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.view_team")));
    if (!allowed) return response.status(403).json({ error: "Quote is outside your work scope." }); const [attachments, events, comments] = await Promise.all([supabase.from("quote_attachments").select("*").eq("quote_id", quoteId).order("created_at", { ascending: false }), supabase.from("quote_events").select("*").eq("quote_id", quoteId).order("created_at", { ascending: false }), supabase.from("record_comments").select("*").eq("entity_type", "QUOTE").eq("entity_id", quoteId).order("created_at", { ascending: false })]); const canManage = isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id); response.json({ quote, attachments: attachments.data ?? [], events: events.data ?? [], comments: await withAuthorDetails(supabase, comments.data ?? [], actor.id, canManage) });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/upload-url", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = fileSchema.parse(request.body); const supabase = adminClient(); const quoteId = z.string().uuid().parse(request.params.id); const { data: quote } = await supabase.from("sales_quotes").select("id, created_by, sales_leads(owner_id, team_id, department_id)").eq("id", quoteId).maybeSingle(); if (!quote) return response.status(404).json({ error: "Quote not found." }); const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads; const scope = await teamScope(actor); const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team"))); if (!allowed) return response.status(403).json({ error: "Quote update permission is required." }); const extension = input.file_name.split(".").pop()?.toLowerCase(); if (!extension || !["pdf", "jpg", "jpeg", "png"].includes(extension)) return response.status(422).json({ error: "Only PDF, JPG, JPEG, and PNG files are allowed." }); const path = `${actor.id}/${quoteId}/${crypto.randomUUID()}.${extension}`; const { data, error } = await supabase.storage.from("brokerage-quote-attachments").createSignedUploadUrl(path); if (error) throw error; response.json({ path, signed_url: data.signedUrl });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/attachments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const input = z.object({ file_name: z.string().min(1).max(180), storage_path: z.string().min(2).max(500) }).parse(request.body);
    const quoteId = z.string().uuid().parse(request.params.id);
    const supabase = adminClient();
    const { data: quote } = await supabase.from("sales_quotes").select("id, created_by, sales_leads(owner_id, team_id, department_id)").eq("id", quoteId).maybeSingle();
    const lead: any = Array.isArray((quote as any)?.sales_leads) ? (quote as any).sales_leads[0] : (quote as any)?.sales_leads;
    const scope = await teamScope(actor);
    const teamEditor = !!lead?.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!lead || !(isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || teamEditor)) return response.status(403).json({ error: "Quote update permission is required." });
    const { data, error } = await supabase.from("quote_attachments").insert({ quote_id: quoteId, uploaded_by: actor.id, ...input }).select().single();
    if (error) throw error;
    await supabase.from("quote_events").insert({ quote_id: quoteId, actor_id: actor.id, event_type: "ATTACHMENT_ADDED", body: input.file_name });
    response.status(201).json({ attachment: data });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/quote-attachments/:id/download-url", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const supabase = adminClient();
    const attachmentId = z.string().uuid().parse(request.params.id);
    const { data: attachment, error } = await supabase
      .from("quote_attachments")
      .select("id, storage_path, quote_id, sales_quotes(created_by, sales_leads(owner_id, team_id, department_id))")
      .eq("id", attachmentId)
      .single();
    if (error || !attachment) return response.status(404).json({ error: "Quote attachment not found." });
    const quote: any = Array.isArray((attachment as any).sales_quotes) ? (attachment as any).sales_quotes[0] : (attachment as any).sales_quotes;
    const lead: any = Array.isArray(quote?.sales_leads) ? quote.sales_leads[0] : quote?.sales_leads;
    const scope = await teamScope(actor);
    const allowed = lead && (
      isSuper(actor) ||
      (isManager(actor) && actor.department_id === lead.department_id) ||
      lead.owner_id === actor.id ||
      (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.view_team"))
    );
    if (!allowed) return response.status(403).json({ error: "Quote attachment is outside your work scope." });
    const { data, error: urlError } = await supabase.storage.from("brokerage-quote-attachments").createSignedUrl((attachment as any).storage_path, 60 * 10);
    if (urlError || !data?.signedUrl) throw urlError ?? new Error("Unable to create a download URL.");
    response.json({ signed_url: data.signedUrl });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/comments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const input = commentSchema.parse(request.body);
    const supabase = adminClient();
    const quoteId = z.string().uuid().parse(request.params.id);
    const { data: quote } = await supabase.from("sales_quotes").select("id, created_by, sales_leads(owner_id, team_id, department_id)").eq("id", quoteId).maybeSingle();
    const lead: any = Array.isArray((quote as any)?.sales_leads) ? (quote as any).sales_leads[0] : (quote as any)?.sales_leads;
    const scope = await teamScope(actor);
    const teamEditor = !!lead?.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.leads.edit_team");
    if (!quote || !lead || !(isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || lead.owner_id === actor.id || teamEditor)) return response.status(403).json({ error: "Quote is outside your work scope." });
    const { data, error } = await supabase.from("record_comments").insert({ entity_type: "QUOTE", entity_id: quoteId, author_id: actor.id, body: input.body }).select().single();
    if (error) throw error;
    await supabase.from("quote_events").insert({ quote_id: quoteId, actor_id: actor.id, event_type: "COMMENT_ADDED", body: input.body });
    if (quote.created_by !== actor.id) await supabase.from("notifications").insert({ recipient_id: quote.created_by, kind: "QUOTE_COMMENT", title: "New quote comment", body: input.body.slice(0, 140), entity_type: "QUOTE", entity_id: quoteId });
    response.status(201).json({ comment: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/review", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = reviewSchema.parse(request.body); const supabase = adminClient(); const { data: quote, error: quoteError } = await supabase.from("sales_quotes").select("id, stage, created_by, sales_leads(department_id, team_id)").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (quoteError || !quote) return response.status(404).json({ error: "Quote not found." }); const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads; const scope = await teamScope(actor);
    const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.quotes.review")));
    if (!allowed) return response.status(403).json({ error: "Quote review permission is required." }); if ((quote as any).stage !== "SUBMITTED") return response.status(422).json({ error: "Only a submitted quote can be reviewed." }); const stage = input.action === "APPROVE" ? "APPROVED" : "REJECTED";
    const { data, error } = await supabase.from("sales_quotes").update({ stage, reviewed_by: actor.id, reviewed_at: new Date().toISOString(), rejection_note: input.action === "REJECT" ? (input.note ?? "Rework requested") : null }).eq("id", quote.id).select().single(); if (error) throw error; await supabase.from("quote_events").insert({ quote_id: quote.id, actor_id: actor.id, event_type: `QUOTE_${stage}`, body: input.note ?? null }); if ((quote as any).created_by) await supabase.from("notifications").insert({ recipient_id: (quote as any).created_by, kind: input.action === "REJECT" ? "QUOTE_REWORK" : "QUOTE_APPROVED", title: input.action === "REJECT" ? "Quote returned for rework" : "Quote approved", body: input.action === "REJECT" ? (input.note ?? "A reviewer requested changes.") : "Your quote is approved and ready for Operations handoff.", entity_type: "QUOTE", entity_id: quote.id }); await writeAudit(supabase, actor.id, `QUOTE_${stage}`, "quote", quote.id, { note: input.note ?? null }); response.json({ quote: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/quotes/:id/handoff", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = handoffSchema.parse(request.body); const supabase = adminClient(); const { data: quote, error: quoteError } = await supabase.from("sales_quotes").select("*, sales_leads(*)").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (quoteError || !quote) return response.status(404).json({ error: "Quote not found." }); const lead: any = Array.isArray((quote as any).sales_leads) ? (quote as any).sales_leads[0] : (quote as any).sales_leads; const scope = await teamScope(actor);
    const allowed = lead && (isSuper(actor) || (isManager(actor) && actor.department_id === lead.department_id) || (!!lead.team_id && scope.leadTeamIds.includes(lead.team_id) && scope.permissions.has("sales.quotes.handoff")));
    if (!allowed) return response.status(403).json({ error: "Operations handoff permission is required." }); if ((quote as any).stage !== "APPROVED") return response.status(422).json({ error: "Only an approved quote can be handed to Operations." });
    const { data: operationsDepartment } = await supabase.from("departments").select("id, business_unit, function").eq("id", input.operations_department_id).single(); if (!operationsDepartment || (operationsDepartment as any).business_unit !== "BROKERAGE" || (operationsDepartment as any).function !== "OPERATIONS") return response.status(422).json({ error: "Choose a Brokerage Operations department." });
    const { data: customer } = await supabase.from("brokerage_customers").select("id").eq("lead_id", lead.id).maybeSingle();
    const { data: shipment, error } = await supabase.from("brokerage_shipments").insert({ quote_id: quote.id, customer_id: customer?.id ?? null, sales_department_id: lead.department_id, operations_department_id: input.operations_department_id, team_id: input.team_id ?? null, reference_number: input.reference_number, customer_name: input.customer_name, pickup_location: (quote as any).pickup_location, delivery_location: (quote as any).delivery_location, equipment_type: (quote as any).equipment_type, amount_quoted: (quote as any).quoted_rate ?? null, sales_status: "BOOKED" }).select().single();
    if (error) throw error;
    await supabase.from("sales_quotes").update({ stage: "HANDED_OFF" }).eq("id", quote.id);
    const { data: operationsManagers } = await supabase.from("profiles").select("id").eq("department_id", input.operations_department_id).eq("role", "MANAGER").eq("is_active", true);
    if (operationsManagers?.length) await supabase.from("notifications").insert(operationsManagers.filter((manager) => manager.id !== actor.id).map((manager) => ({ recipient_id: manager.id, kind: "QUOTE_HANDED_OFF", title: "New Sales handoff", body: `${input.reference_number} is ready for Operations assignment.`, entity_type: "SHIPMENT", entity_id: shipment.id })));
    await writeAudit(supabase, actor.id, "QUOTE_HANDED_OFF", "quote", quote.id, { shipment_id: shipment.id, operations_department_id: input.operations_department_id });
    response.status(201).json({ shipment });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/operations-directory", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; if (!isOperations(actor) || !isManager(actor) || !actor.department_id) return response.status(403).json({ error: "Only a Brokerage Operations Manager can manage assignments." }); const supabase = adminClient(); const [{ data: users, error }, { data: teams, error: teamsError }] = await Promise.all([supabase.from("profiles").select("id, full_name, email, role").eq("department_id", actor.department_id).eq("is_active", true).eq("role", "AGENT"), supabase.from("teams").select("id, name, team_lead_id").eq("department_id", actor.department_id).eq("is_active", true).order("name")]); if (error || teamsError) throw error ?? teamsError; response.json({ users: users ?? [], teams: teams ?? [] }); } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/shipments/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = shipmentUpdateSchema.parse(request.body); const supabase = adminClient(); const { data: shipment, error: shipmentError } = await supabase.from("brokerage_shipments").select("*").eq("id", z.string().uuid().parse(request.params.id)).single();
    if (shipmentError || !shipment) return response.status(404).json({ error: "Shipment not found." }); const scope = await teamScope(actor);
    const departmentManager = isManager(actor) && actor.department_id === shipment.operations_department_id;
    const teamViewer = !!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.view_team"); const ownScope = shipment.assigned_to === actor.id;
    if (!(isSuper(actor) || departmentManager || ownScope || teamViewer)) return response.status(403).json({ error: "Shipment is outside your work scope." });
    const teamUpdater = !!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.update_team"); const canUpdate = isSuper(actor) || departmentManager || ownScope || teamUpdater;
    const canAssign = isSuper(actor) || departmentManager || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.assign"));
    const canResolveExceptions = isSuper(actor) || departmentManager || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.exceptions.resolve"));
    const canRecordFinance = canUpdate;
    const canManageInvoiceReadiness = isSuper(actor) || departmentManager || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.billing.mark_invoice_ready"));
    if ((input.assigned_to !== undefined || input.team_id !== undefined) && !canAssign) return response.status(403).json({ error: "Shipment assignment permission is required." });
    if (input.status && ["QUOTED", "PAID"].includes(input.status)) return response.status(422).json({ error: "Use the Sales commercial lifecycle or invoice ledger for this status." });
    const changesFinancials = input.amount_quoted !== undefined || input.amount_invoiced !== undefined || input.amount_paid !== undefined || input.payment_status !== undefined || input.pickup_date !== undefined || input.delivery_date !== undefined;
    if ((input.status || input.carrier_name !== undefined || input.note) && !canUpdate) return response.status(403).json({ error: "Shipment update permission is required." });
    if (changesFinancials && !canRecordFinance) return response.status(403).json({ error: "Shipment finance update permission is required." });
    if (input.exception_note !== undefined && !canUpdate) return response.status(403).json({ error: "Shipment update permission is required." });
    if ((input.exception_owner_id !== undefined || input.exception_resolution !== undefined) && !canResolveExceptions) return response.status(403).json({ error: "Exception resolution permission is required." });
    if (input.invoice_ready !== undefined && !canManageInvoiceReadiness) return response.status(403).json({ error: "Invoice readiness permission is required." });
    if (input.assigned_to && !await validDepartmentPeople(shipment.operations_department_id, [input.assigned_to])) return response.status(422).json({ error: "The assignee must be active in this Operations department." });
    if (input.team_id) { const { data: team } = await supabase.from("teams").select("id").eq("id", input.team_id).eq("department_id", shipment.operations_department_id).eq("is_active", true).maybeSingle(); if (!team) return response.status(422).json({ error: "The team must be active in this Operations department." }); }
    if (input.exception_owner_id && !await validDepartmentPeople(shipment.operations_department_id, [input.exception_owner_id])) return response.status(422).json({ error: "The exception owner must be an active Operations Agent." });
    const { note, ...update } = input;
    if (input.status === "DELIVERED" || input.status === "COMPLETED") (update as any).sales_status = "DELIVERED";
    const { data, error } = await supabase.from("brokerage_shipments").update(update).eq("id", shipment.id).select().single(); if (error) throw error;
    if (input.assigned_to !== undefined) { await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "ASSIGNED", body: input.assigned_to ?? "Unassigned" }); if (input.assigned_to && input.assigned_to !== actor.id) await supabase.from("notifications").insert({ recipient_id: input.assigned_to, kind: "SHIPMENT_ASSIGNED", title: "New shipment assignment", body: `${shipment.reference_number} is ready for your review.`, entity_type: "SHIPMENT", entity_id: shipment.id }); }
    if (input.team_id !== undefined) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "TEAM_ASSIGNED", body: input.team_id ?? "Team removed" });
    if (input.exception_owner_id !== undefined) { await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "EXCEPTION_OWNER_ASSIGNED", body: input.exception_owner_id ?? "Unassigned" }); if (input.exception_owner_id && input.exception_owner_id !== actor.id) await supabase.from("notifications").insert({ recipient_id: input.exception_owner_id, kind: "EXCEPTION_ASSIGNED", title: "Exception assigned", body: `${shipment.reference_number} needs your attention.`, entity_type: "SHIPMENT", entity_id: shipment.id }); }
    if (input.status && input.status !== shipment.status) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "STATUS_CHANGED", from_status: shipment.status, to_status: input.status });
    if (input.exception_note !== undefined) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: input.exception_note ? "EXCEPTION_RAISED" : "EXCEPTION_RESOLVED", body: input.exception_note ?? null });
    if (input.exception_resolution !== undefined) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "EXCEPTION_RESOLUTION_UPDATED", body: input.exception_resolution ?? null });
    if (input.invoice_ready) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "INVOICE_READY" }); if (note) await supabase.from("shipment_events").insert({ shipment_id: shipment.id, actor_id: actor.id, event_type: "NOTE", body: note });
    await writeAudit(supabase, actor.id, "SHIPMENT_UPDATED", "shipment", shipment.id, { fields: Object.keys(input) }); response.json({ shipment: data });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/shipments/:id/invoice", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const supabase = adminClient(); const shipmentId = z.string().uuid().parse(request.params.id);
    const { data: shipment, error } = await supabase.from("brokerage_shipments").select("*").eq("id", shipmentId).single();
    if (error || !shipment) return response.status(404).json({ error: "Shipment not found." });
    if (!(isSuper(actor) || (isManager(actor) && actor.department_id === shipment.operations_department_id))) return response.status(403).json({ error: "Only the Operations Manager can generate an invoice." });
    if (!['DELIVERED', 'COMPLETED'].includes(shipment.status)) return response.status(422).json({ error: "A shipment must be delivered before invoicing." });
    const { data: existing } = await supabase.from("brokerage_invoices").select("*").eq("shipment_id", shipment.id).maybeSingle();
    if (existing) return response.json({ invoice: existing, existing: true });
    const input = invoiceSchema.parse(request.body ?? {}); const invoiceNumber = `INV-${new Date().getUTCFullYear()}-${shipment.reference_number}-${shipment.id.slice(0, 6).toUpperCase()}`;
    const { data: invoice, error: invoiceError } = await supabase.from("brokerage_invoices").insert({ shipment_id: shipment.id, department_id: shipment.operations_department_id, invoice_number: invoiceNumber, amount: input.amount ?? shipment.amount_invoiced ?? shipment.amount_quoted ?? 0, amount_paid: input.amount_paid ?? shipment.amount_paid ?? 0, status: input.status ?? 'DRAFT', due_date: input.due_date ?? null, issued_at: new Date().toISOString(), created_by: actor.id }).select().single();
    if (invoiceError || !invoice) throw invoiceError; await writeAudit(supabase, actor.id, "INVOICE_GENERATED", "invoice", invoice.id, { shipment_id: shipment.id }); response.status(201).json({ invoice });
  } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/invoices/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!; const input = invoiceSchema.parse(request.body); const supabase = adminClient(); const invoiceId = z.string().uuid().parse(request.params.id);
    const { data: invoice, error } = await supabase.from("brokerage_invoices").select("*, brokerage_shipments(operations_department_id)").eq("id", invoiceId).single();
    if (error || !invoice) return response.status(404).json({ error: "Invoice not found." }); const shipment: any = Array.isArray((invoice as any).brokerage_shipments) ? (invoice as any).brokerage_shipments[0] : (invoice as any).brokerage_shipments;
    if (!(isSuper(actor) || (isManager(actor) && actor.department_id === shipment?.operations_department_id))) return response.status(403).json({ error: "Only the Operations Manager can update an invoice." });
    const update: Record<string, unknown> = { ...input }; if (input.status === 'PAID') update.paid_at = new Date().toISOString();
    const { data, error: updateError } = await supabase.from("brokerage_invoices").update(update).eq("id", invoice.id).select().single(); if (updateError || !data) throw updateError;
    await supabase.from("brokerage_shipments").update({ amount_invoiced: input.amount ?? invoice.amount, amount_paid: input.amount_paid ?? invoice.amount_paid, payment_status: input.status ?? invoice.status, ...(input.status === "PAID" ? { sales_status: "PAID" } : {}) }).eq("id", invoice.shipment_id);
    await writeAudit(supabase, actor.id, "INVOICE_UPDATED", "invoice", invoice.id, { fields: Object.keys(input) }); response.json({ invoice: data });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/invoices", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    if (!(isSuper(actor) || (isOperations(actor) && actor.department_id))) return response.status(403).json({ error: "Operations access is required." });
    const supabase = adminClient();
    let overdueQuery = supabase.from("brokerage_invoices").select("id, invoice_number, created_by, department_id").lt("due_date", new Date().toISOString().slice(0, 10)).in("status", ["DRAFT", "SENT", "PENDING"]);
    if (!isSuper(actor)) overdueQuery = overdueQuery.eq("department_id", actor.department_id!);
    const { data: overdue, error: overdueError } = await overdueQuery;
    if (overdueError) throw overdueError;
    if (overdue?.length) {
      await supabase.from("brokerage_invoices").update({ status: "OVERDUE" }).in("id", overdue.map((invoice) => invoice.id));
      const alerts = overdue.filter((invoice) => invoice.created_by !== actor.id).map((invoice) => ({ recipient_id: invoice.created_by, kind: "INVOICE_OVERDUE", title: "Invoice overdue", body: `${invoice.invoice_number} passed its due date.`, entity_type: "INVOICE", entity_id: invoice.id }));
      if (alerts.length) await supabase.from("notifications").insert(alerts);
    }
    let query = supabase.from("brokerage_invoices").select("*, brokerage_shipments(reference_number, customer_name, assigned_to)").order("updated_at", { ascending: false }).limit(200);
    if (!isSuper(actor)) query = query.eq("department_id", actor.department_id!);
    const { data, error } = await query;
    if (error) throw error;
    response.json({ invoices: data ?? [] });
  } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/shipments/:id/documents", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const input = documentSchema.parse(request.body); const supabase = adminClient(); const { data: shipment } = await supabase.from("brokerage_shipments").select("*").eq("id", z.string().uuid().parse(request.params.id)).maybeSingle(); if (!shipment) return response.status(404).json({ error: "Shipment not found." }); const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment.operations_department_id) || shipment.assigned_to === actor.id || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.update_team")); if (!allowed) return response.status(403).json({ error: "Shipment update permission is required." }); const { data, error } = await supabase.from("shipment_documents").insert({ ...input, shipment_id: shipment.id, uploaded_by: actor.id }).select().single(); if (error) throw error; await writeAudit(supabase, actor.id, "SHIPMENT_DOCUMENT_ADDED", "shipment", shipment.id, { document_type: input.document_type }); response.status(201).json({ document: data }); } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/documents/:id/review", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const body = documentReviewSchema.parse(request.body); const supabase = adminClient(); const { data: document, error: documentError } = await supabase.from("shipment_documents").select("id, shipment_id, uploaded_by, document_type, brokerage_shipments(operations_department_id, team_id)").eq("id", z.string().uuid().parse(request.params.id)).single(); if (documentError || !document) return response.status(404).json({ error: "Document not found." }); const shipment: any = Array.isArray((document as any).brokerage_shipments) ? (document as any).brokerage_shipments[0] : (document as any).brokerage_shipments; const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment?.operations_department_id) || (!!shipment?.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.documents.review")); if (!allowed) return response.status(403).json({ error: "Document review permission is required." }); const review = { ...body, reviewed_by: actor.id, reviewed_at: new Date().toISOString() }; const { data, error } = await supabase.from("shipment_documents").update(review).eq("id", document.id).select().single(); if (error || !data) throw error; if ((document as any).uploaded_by !== actor.id) await supabase.from("notifications").insert({ recipient_id: (document as any).uploaded_by, kind: body.is_verified ? "DOCUMENT_VERIFIED" : "DOCUMENT_REJECTED", title: body.is_verified ? "Document verified" : "Document returned", body: body.review_note ?? `${(document as any).document_type} was ${body.is_verified ? "verified" : "returned for changes"}.`, entity_type: "SHIPMENT", entity_id: (document as any).shipment_id }); await writeAudit(supabase, actor.id, "SHIPMENT_DOCUMENT_REVIEWED", "shipment_document", data.id, body); response.json({ document: data }); } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/documents/:id/download-url", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const supabase = adminClient(); const { data: document, error } = await supabase.from("shipment_documents").select("id, storage_path, brokerage_shipments(operations_department_id, assigned_to, team_id)").eq("id", z.string().uuid().parse(request.params.id)).single(); if (error || !document) return response.status(404).json({ error: "Document not found." }); const shipment: any = Array.isArray((document as any).brokerage_shipments) ? (document as any).brokerage_shipments[0] : (document as any).brokerage_shipments; const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment?.operations_department_id) || shipment?.assigned_to === actor.id || (!!shipment?.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.view_team")); if (!allowed) return response.status(403).json({ error: "Document is outside your work scope." }); const { data: signed, error: signError } = await supabase.storage.from("brokerage-documents").createSignedUrl((document as any).storage_path, 60); if (signError) throw signError; response.json({ signed_url: signed.signedUrl }); } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/reports", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try {
    const actor = request.actor!;
    const range = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), agent_id: z.string().uuid().optional() }).parse(request.query);
    if (range.agent_id && !isSuper(actor) && !isManager(actor)) return response.status(403).json({ error: "Only a manager can open an individual agent report." });
    const scope = await teamScope(actor);
    const supabase = adminClient();
    const tally = (rows: any[], field: string) => rows.reduce((total: Record<string, number>, row: any) => {
      const value = row[field] ?? "UNASSIGNED";
      total[value] = (total[value] ?? 0) + 1;
      return total;
    }, {});
    const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);

    let leadQuery = supabase.from("sales_leads").select("id, stage, owner_id, team_id, company_name, estimated_monthly_value, created_at").order("created_at", { ascending: false }).limit(1000);
    if (!isSuper(actor)) {
      if (isSales(actor)) {
        leadQuery = leadQuery.eq("department_id", actor.department_id!);
        if (!isManager(actor)) leadQuery = scope.permissions.has("sales.reports.view_team") && scope.leadTeamIds.length ? leadQuery.in("team_id", scope.leadTeamIds) : leadQuery.eq("owner_id", actor.id);
      } else leadQuery = leadQuery.eq("id", "00000000-0000-0000-0000-000000000000");
    }
    if (range.agent_id) leadQuery = leadQuery.eq("owner_id", range.agent_id);
    if (range.from) leadQuery = leadQuery.gte("created_at", `${range.from}T00:00:00.000Z`);
    if (range.to) leadQuery = leadQuery.lte("created_at", `${range.to}T23:59:59.999Z`);
    const { data: leads, error: leadsError } = await leadQuery;
    if (leadsError) throw leadsError;
    const leadIds = (leads ?? []).map((lead) => lead.id);
    const { data: quotes, error: quoteError } = leadIds.length
      ? await supabase.from("sales_quotes").select("id, lead_id, stage, quoted_rate, created_by, created_at").in("lead_id", leadIds).order("created_at", { ascending: false })
      : { data: [] as any[], error: null };
    if (quoteError) throw quoteError;
    const { data: salesCustomers, error: customerError } = leadIds.length
      ? await supabase.from("brokerage_customers").select("id, owner_id, company_name, lead_id").in("lead_id", leadIds)
      : { data: [] as any[], error: null };
    if (customerError) throw customerError;
    const customerIds = (salesCustomers ?? []).map((customer) => customer.id);
    let salesShipmentQuery = supabase.from("brokerage_shipments").select("id, customer_id, customer_name, sales_status, amount_quoted, pickup_date, delivery_date, created_at").order("created_at", { ascending: false }).limit(1000);
    salesShipmentQuery = customerIds.length ? salesShipmentQuery.in("customer_id", customerIds) : salesShipmentQuery.eq("id", "00000000-0000-0000-0000-000000000000");
    if (range.from) salesShipmentQuery = salesShipmentQuery.gte("created_at", `${range.from}T00:00:00.000Z`);
    if (range.to) salesShipmentQuery = salesShipmentQuery.lte("created_at", `${range.to}T23:59:59.999Z`);
    const { data: salesShipments, error: salesShipmentError } = await salesShipmentQuery;
    if (salesShipmentError) throw salesShipmentError;

    let shipmentQuery = supabase.from("brokerage_shipments").select("id, status, assigned_to, team_id, customer_name, invoice_ready, exception_note, amount_quoted, amount_invoiced, amount_paid, payment_status, created_at").order("created_at", { ascending: false }).limit(1000);
    if (!isSuper(actor)) {
      if (isOperations(actor)) {
        shipmentQuery = shipmentQuery.eq("operations_department_id", actor.department_id!);
        if (!isManager(actor)) shipmentQuery = scope.permissions.has("operations.reports.view_team") && scope.leadTeamIds.length ? shipmentQuery.in("team_id", scope.leadTeamIds) : shipmentQuery.eq("assigned_to", actor.id);
      } else shipmentQuery = shipmentQuery.eq("id", "00000000-0000-0000-0000-000000000000");
    }
    if (range.from) shipmentQuery = shipmentQuery.gte("created_at", `${range.from}T00:00:00.000Z`);
    if (range.to) shipmentQuery = shipmentQuery.lte("created_at", `${range.to}T23:59:59.999Z`);
    const { data: shipments, error: shipmentError } = await shipmentQuery;
    if (shipmentError) throw shipmentError;
    const shipmentIds = (shipments ?? []).map((shipment) => shipment.id);
    const { data: invoices, error: invoiceError } = shipmentIds.length
      ? await supabase.from("brokerage_invoices").select("id, shipment_id, amount, amount_paid, status, due_date, created_at").in("shipment_id", shipmentIds)
      : { data: [] as any[], error: null };
    if (invoiceError) throw invoiceError;

    const leadRows = leads ?? [];
    const quoteRows = quotes ?? [];
    const salesShipmentRows = salesShipments ?? [];
    const shipmentRows = shipments ?? [];
    const invoiceRows = invoices ?? [];
    const customerNames = new Set((salesCustomers ?? []).map((customer) => customer.company_name));
    const ownerIds = [...new Set(leadRows.map((lead) => lead.owner_id).filter(Boolean))];
    const { data: owners } = ownerIds.length ? await supabase.from("profiles").select("id, full_name").in("id", ownerIds) : { data: [] as any[] };
    const ownerNames = new Map((owners ?? []).map((owner) => [owner.id, owner.full_name]));
    const salesByAgent = leadRows.reduce((totals: Record<string, number>, lead) => {
      const label = ownerNames.get(lead.owner_id) ?? lead.owner_id ?? "UNASSIGNED";
      totals[label] = (totals[label] ?? 0) + 1;
      return totals;
    }, {});
    const customerOutcomes = salesShipmentRows.reduce((totals: Record<string, number>, shipment) => {
      const label = `${shipment.customer_name} · ${shipment.sales_status}`;
      totals[label] = (totals[label] ?? 0) + 1;
      return totals;
    }, {});
    response.json({
      range,
      sales: {
        totals: { leads: leadRows.length, customers: customerNames.size, shipments: salesShipmentRows.length, pipeline_value: sum(leadRows, "estimated_monthly_value"), quoted_value: sum(quoteRows, "quoted_rate"), gross_generated: sum(salesShipmentRows.filter((shipment) => ["BOOKED", "DELIVERED", "PAID"].includes(shipment.sales_status)), "amount_quoted") },
        lead_stages: tally(leadRows, "stage"),
        quote_stages: tally(quoteRows, "stage"),
        shipment_statuses: tally(salesShipmentRows, "sales_status"),
        customer_outcomes: customerOutcomes,
        by_agent: salesByAgent,
        by_team: tally(leadRows, "team_id"),
        rows: salesShipmentRows.length ? salesShipmentRows : leadRows,
        lead_rows: leadRows,
        shipment_rows: salesShipmentRows,
        agents: (owners ?? []).sort((left, right) => left.full_name.localeCompare(right.full_name))
      },
      operations: {
        totals: { shipments: shipmentRows.length, quoted: sum(shipmentRows, "amount_quoted"), invoiced: sum(invoiceRows, "amount"), paid: sum(invoiceRows, "amount_paid"), outstanding: Math.max(0, sum(invoiceRows, "amount") - sum(invoiceRows, "amount_paid")) },
        shipment_statuses: tally(shipmentRows, "status"),
        workload: tally(shipmentRows, "assigned_to"),
        by_team: tally(shipmentRows, "team_id"),
        by_customer: tally(shipmentRows, "customer_name"),
        invoice_statuses: tally(invoiceRows, "status"),
        invoice_ready: shipmentRows.filter((row) => row.invoice_ready).length,
        exceptions: shipmentRows.filter((row) => row.exception_note).length,
        rows: shipmentRows,
        invoices: invoiceRows
      }
    });
  } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/overview", requireSuperAdmin, async (_request, response, next) => {
  try { const supabase = adminClient(); const [departments, teams, leads, quotes, shipments, audit] = await Promise.all([supabase.from("departments").select("id, name, business_unit, function").eq("business_unit", "BROKERAGE"), supabase.from("teams").select("id, name, department_id, is_active"), supabase.from("sales_leads").select("id, stage, department_id"), supabase.from("sales_quotes").select("id, stage"), supabase.from("brokerage_shipments").select("id, status, operations_department_id, invoice_ready, exception_note"), supabase.from("audit_events").select("id, action, entity_type, entity_id, detail, created_at").order("created_at", { ascending: false }).limit(30)]); response.json({ departments: departments.data ?? [], teams: teams.data ?? [], leads: leads.data ?? [], quotes: quotes.data ?? [], shipments: shipments.data ?? [], audit: audit.data ?? [] }); } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/shipments/:id/detail", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const supabase = adminClient(); const { data: shipment, error } = await supabase.from("brokerage_shipments").select("*").eq("id", z.string().uuid().parse(request.params.id)).single(); if (error || !shipment) return response.status(404).json({ error: "Shipment not found." }); const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment.operations_department_id) || shipment.assigned_to === actor.id || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.view_team")); if (!allowed) return response.status(403).json({ error: "Shipment is outside your work scope." }); const [documents, events, comments, invoice] = await Promise.all([supabase.from("shipment_documents").select("*").eq("shipment_id", shipment.id).order("created_at", { ascending: false }), supabase.from("shipment_events").select("*").eq("shipment_id", shipment.id).order("created_at", { ascending: false }), supabase.from("record_comments").select("*").eq("entity_type", "SHIPMENT").eq("entity_id", shipment.id).order("created_at", { ascending: false }), supabase.from("brokerage_invoices").select("*").eq("shipment_id", shipment.id).maybeSingle()]); response.json({ shipment, documents: documents.data ?? [], events: events.data ?? [], comments: comments.data ?? [], invoice: invoice.data ?? null }); } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/shipments/:id/upload-url", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const input = z.object({ file_name: z.string().min(1).max(180), content_type: z.enum(["application/pdf", "image/jpeg", "image/png"]) }).parse(request.body); const supabase = adminClient(); const { data: shipment } = await supabase.from("brokerage_shipments").select("*").eq("id", z.string().uuid().parse(request.params.id)).maybeSingle(); if (!shipment) return response.status(404).json({ error: "Shipment not found." }); const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment.operations_department_id) || shipment.assigned_to === actor.id || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.update_team")); if (!allowed) return response.status(403).json({ error: "Shipment is outside your update scope." }); const extension = input.file_name.split(".").pop()?.toLowerCase(); if (!extension || !["pdf", "jpg", "jpeg", "png"].includes(extension)) return response.status(422).json({ error: "Only PDF, JPG, JPEG, and PNG files are allowed." }); const path = `${actor.id}/${shipment.id}/${crypto.randomUUID()}.${extension}`; const { data, error } = await supabase.storage.from("brokerage-documents").createSignedUploadUrl(path); if (error) throw error; response.json({ path, token: data.token, signed_url: data.signedUrl }); } catch (error) { next(error); }
});

app.post("/api/v1/brokerage/shipments/:id/comments", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const input = commentSchema.parse(request.body); const supabase = adminClient(); const { data: shipment } = await supabase.from("brokerage_shipments").select("*").eq("id", z.string().uuid().parse(request.params.id)).maybeSingle(); if (!shipment) return response.status(404).json({ error: "Shipment not found." }); const scope = await teamScope(actor); const allowed = isSuper(actor) || (isManager(actor) && actor.department_id === shipment.operations_department_id) || shipment.assigned_to === actor.id || (!!shipment.team_id && scope.leadTeamIds.includes(shipment.team_id) && scope.permissions.has("operations.shipments.view_team")); if (!allowed) return response.status(403).json({ error: "Shipment is outside your work scope." }); const { data, error } = await supabase.from("record_comments").insert({ entity_type: "SHIPMENT", entity_id: shipment.id, author_id: actor.id, body: input.body }).select().single(); if (error) throw error; if (shipment.assigned_to && shipment.assigned_to !== actor.id) await supabase.from("notifications").insert({ recipient_id: shipment.assigned_to, kind: "SHIPMENT_COMMENT", title: "New shipment comment", body: input.body.slice(0, 140), entity_type: "SHIPMENT", entity_id: shipment.id }); await writeAudit(supabase, actor.id, "COMMENT_ADDED", "shipment", shipment.id); response.status(201).json({ comment: data }); } catch (error) { next(error); }
});

app.get("/api/v1/brokerage/department-users", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; if (!isManager(actor) || !actor.department_id) return response.status(403).json({ error: "Manager access is required." }); const supabase = adminClient(); const [{ data: users, error }, { data: grants }] = await Promise.all([supabase.from("profiles").select("id, full_name, email, role, is_active").eq("department_id", actor.department_id).order("full_name"), supabase.from("user_permissions").select("user_id, permission_key").eq("department_id", actor.department_id)]); if (error) throw error; response.json({ users: users ?? [], permissions: grants ?? [] }); } catch (error) { next(error); }
});

app.patch("/api/v1/brokerage/department-users/:id", requireBrokerageUser, async (request: BrokerageRequest, response, next) => {
  try { const actor = request.actor!; const userId = z.string().uuid().parse(request.params.id); const input = z.object({ is_active: z.boolean().optional() }).strict().parse(request.body); if (!isManager(actor) || !actor.department_id) return response.status(403).json({ error: "Manager access is required." }); const supabase = adminClient(); const { data: target } = await supabase.from("profiles").select("id, role").eq("id", userId).eq("department_id", actor.department_id).maybeSingle(); if (!target || target.role !== "AGENT") return response.status(404).json({ error: "Agent not found in your department." }); if (input.is_active !== undefined) { const { error } = await supabase.from("profiles").update({ is_active: input.is_active }).eq("id", userId); if (error) throw error; await writeAudit(supabase, actor.id, input.is_active ? "ACCESS_RESTORED" : "ACCESS_REVOKED", "profile", userId); } response.json({ ok: true }); } catch (error) { next(error); }
});

app.use((_request, response) => response.status(404).json({ error: "Route not found." }));
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (error instanceof z.ZodError) return response.status(400).json({ error: "Invalid request data.", issues: error.issues });
  response.status(500).json({ error: error instanceof Error ? error.message : "An unexpected server error occurred." });
});

app.listen(port, () => console.log(`DEBOSS API listening on port ${port}`));
