import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Chat module.
 *  - Direct messages: manager <-> manager (whole company) and agent <-> manager. Agent <-> agent is never allowed.
 *    A manager can start a message with agents of their own department; an agent can message any manager.
 *  - Groups: one per team, created and kept in sync from the team form. The team's manager is the group admin
 *    (rename, photo, members); nobody can leave. Messages can't be edited or deleted.
 *  - Channels (client flow v2, section 8): Quotes (Brokerage Sales + Operations), Updates (also Fronters) and Company
 *    announcements (everyone reads; managers and the Super Admin post). Membership follows the person's department and is
 *    synced on every inbox load. Key Brokerage events are posted into Quotes / Updates as EVENT messages (postEvent).
 *  - The Super Admin takes part only in Company announcements; the Communication page lists every group and its members.
 * Messages are inserted and received directly by the browser through Supabase (row-level security + Realtime);
 * this API handles who may talk to whom, the inbox, history and group settings.
 */

type Actor = { id: string; role: string; department_id: string | null; department?: { business_unit: string; function: string } | null };
type Handler = (request: Request, response: Response, next: NextFunction) => unknown;
type Req = Request & { actor?: Actor };
type Deps = {
  adminClient: () => SupabaseClient;
  requireUser: Handler;
  requireSuperAdmin: Handler;
  writeAudit: (supabase: SupabaseClient, actorId: string, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) => Promise<void>;
};

const uuid = z.string().uuid();
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
const directKey = (a: string, b: string) => [a, b].sort().join(":");

/** Channels a person belongs to: Quotes (Brokerage Sales + Operations), Updates (also Fronters), announcements (everyone). */
export function channelsFor(actor: { role: string; department?: { business_unit: string; function: string } | null }) {
  if (actor.role === "SUPER_ADMIN") return ["ANNOUNCEMENTS"];
  const brokerage = actor.department?.business_unit === "BROKERAGE";
  const fn = actor.department?.function;
  return ["ANNOUNCEMENTS", ...(brokerage && (fn === "SALES" || fn === "OPERATIONS") ? ["QUOTES"] : []), ...(brokerage && ["SALES", "OPERATIONS", "FRONTER"].includes(fn ?? "") ? ["UPDATES"] : [])];
}

/** Posts a system update into a channel (Quotes or Updates). Never mention a carrier's identity: Sales reads these. */
export async function postEvent(supabase: SupabaseClient, channel: "QUOTES" | "UPDATES", actorId: string, body: string) {
  try {
    const { data: conversation } = await supabase.from("chat_conversations").select("id").eq("channel_key", channel).maybeSingle();
    if (conversation) await supabase.from("chat_messages").insert({ conversation_id: conversation.id, sender_id: actorId, body: body.slice(0, 4000), kind: "EVENT" });
  } catch { /* a channel post never blocks the action it reports */ }
}

/** Group membership mirrors the team: every member, the team lead and the team's manager (admin). */
export async function syncTeamGroup(supabase: SupabaseClient, teamId: string, settings: { name?: string | null; photo_url?: string | null } = {}) {
  const { data: team } = await supabase.from("teams").select("id, name, manager_id, team_lead_id, team_members(user_id)").eq("id", teamId).maybeSingle();
  if (!team) return null;
  const { data: existing } = await supabase.from("chat_conversations").select("id, name, photo_url").eq("team_id", teamId).maybeSingle();
  let conversation = existing;
  if (!conversation) {
    const { data, error } = await supabase.from("chat_conversations").insert({ kind: "GROUP", team_id: teamId, name: settings.name?.trim() || team.name, photo_url: settings.photo_url ?? null, created_by: team.manager_id }).select("id, name, photo_url").single();
    if (error) throw error;
    conversation = data;
  } else if (settings.name !== undefined || settings.photo_url !== undefined) {
    const patch: Record<string, unknown> = {};
    if (settings.name?.trim()) patch.name = settings.name.trim();
    if (settings.photo_url !== undefined) patch.photo_url = settings.photo_url;
    if (Object.keys(patch).length) await supabase.from("chat_conversations").update(patch).eq("id", conversation.id);
  }
  const wanted = new Set<string>([team.manager_id, ...(team.team_lead_id ? [team.team_lead_id] : []), ...((team as any).team_members ?? []).map((row: any) => row.user_id)]);
  const { data: current } = await supabase.from("chat_members").select("user_id, role").eq("conversation_id", conversation!.id);
  const have = new Map((current ?? []).map((row: any) => [row.user_id as string, row.role as string]));
  const add = [...wanted].filter((id) => !have.has(id)).map((user_id) => ({ conversation_id: conversation!.id, user_id, role: user_id === team.manager_id ? "ADMIN" : "MEMBER" }));
  const remove = [...have.keys()].filter((id) => !wanted.has(id));
  if (add.length) await supabase.from("chat_members").insert(add);
  if (remove.length) await supabase.from("chat_members").delete().eq("conversation_id", conversation!.id).in("user_id", remove);
  if (have.get(team.manager_id) === "MEMBER") await supabase.from("chat_members").update({ role: "ADMIN" }).eq("conversation_id", conversation!.id).eq("user_id", team.manager_id);
  return conversation!.id;
}

export function registerChatRoutes(app: Express, deps: Deps) {
  const { adminClient, requireUser, requireSuperAdmin, writeAudit } = deps;

  function chatUser(request: Req, response: Response, next: NextFunction) {
    const actor = request.actor!;
    if (actor.role === "SUPER_ADMIN") return next(); // Company announcements only (see channelsFor).
    if (!["MANAGER", "AGENT"].includes(actor.role) || !actor.department_id) return response.status(403).json({ error: "Chat is available to managers and agents." });
    return next();
  }
  const guard = [requireUser, chatUser] as Handler[];

  /** Keeps the person's channel memberships in line with their role and department (joins quietly, from now on). */
  async function syncChannels(supabase: SupabaseClient, actor: Actor) {
    const { data: channels } = await supabase.from("chat_conversations").select("id, channel_key").eq("kind", "CHANNEL");
    const allowed = new Set(channelsFor(actor));
    const join = (channels ?? []).filter((channel: any) => allowed.has(channel.channel_key)).map((channel: any) => ({ conversation_id: channel.id, user_id: actor.id, role: "MEMBER" }));
    const leave = (channels ?? []).filter((channel: any) => !allowed.has(channel.channel_key)).map((channel: any) => channel.id);
    if (join.length) await supabase.from("chat_members").upsert(join, { onConflict: "conversation_id,user_id", ignoreDuplicates: true });
    if (leave.length) await supabase.from("chat_members").delete().eq("user_id", actor.id).in("conversation_id", leave);
  }

  /** Who this person may start a direct message with. */
  async function contactsFor(supabase: SupabaseClient, actor: Actor) {
    const { data: people } = await supabase.from("profiles").select("id, full_name, role, department_id, departments!profiles_department_id_fkey(name, business_unit, function)").eq("is_active", true).in("role", ["MANAGER", "AGENT"]).neq("id", actor.id).order("full_name");
    return (people ?? []).filter((person: any) => person.role === "MANAGER" || (actor.role === "MANAGER" && person.department_id === actor.department_id))
      .map((person: any) => { const department = one(person.departments); return { id: person.id, full_name: person.full_name, role: person.role, department: department?.name ?? null }; });
  }
  function mayDirect(actor: Actor, other: { role: string; department_id: string | null; is_active: boolean }) {
    if (!other.is_active || !["MANAGER", "AGENT"].includes(other.role)) return false;
    if (actor.role === "AGENT" && other.role === "AGENT") return false;
    if (actor.role === "MANAGER" && other.role === "AGENT") return other.department_id === actor.department_id;
    return true;
  }

  app.get("/api/v1/chat/inbox", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const supabase = adminClient();
      await syncChannels(supabase, actor);
      const { data: memberships } = await supabase.from("chat_members").select("conversation_id, role, last_read_at").eq("user_id", actor.id);
      const ids = (memberships ?? []).map((row: any) => row.conversation_id);
      const [{ data: conversations }, { data: members }, contacts] = await Promise.all([
        ids.length ? supabase.from("chat_conversations").select("*").in("id", ids) : Promise.resolve({ data: [] as any[] }),
        ids.length ? supabase.from("chat_members").select("conversation_id, user_id, role, last_read_at, profiles(full_name, role)").in("conversation_id", ids) : Promise.resolve({ data: [] as any[] }),
        actor.role === "SUPER_ADMIN" ? Promise.resolve([]) : contactsFor(supabase, actor),
      ]);
      // Last message and unread count per conversation.
      const summaries = await Promise.all((conversations ?? []).map(async (conversation: any) => {
        const mine = (memberships ?? []).find((row: any) => row.conversation_id === conversation.id);
        const [{ data: last }, { count }] = await Promise.all([
          supabase.from("chat_messages").select("id, body, sender_id, created_at").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
          supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversation.id).neq("sender_id", actor.id).gt("created_at", mine?.last_read_at ?? "1970-01-01"),
        ]);
        const people = (members ?? []).filter((row: any) => row.conversation_id === conversation.id).map((row: any) => ({ id: row.user_id, full_name: one(row.profiles)?.full_name ?? "Unknown", role: one(row.profiles)?.role ?? null, chat_role: row.role, last_read_at: row.last_read_at }));
        const other = conversation.kind === "DIRECT" ? people.find((person: any) => person.id !== actor.id) : null;
        return {
          id: conversation.id, kind: conversation.kind, team_id: conversation.team_id,
          name: conversation.kind === "DIRECT" ? other?.full_name ?? "Conversation" : conversation.name,
          channel_key: conversation.channel_key ?? null,
          can_post: conversation.channel_key !== "ANNOUNCEMENTS" || ["MANAGER", "SUPER_ADMIN"].includes(actor.role),
          photo_url: conversation.photo_url, last_message: last ?? null, last_message_at: conversation.last_message_at ?? conversation.created_at,
          unread: count ?? 0, my_role: mine?.role ?? "MEMBER", members: people, other,
        };
      }));
      summaries.sort((left, right) => String(right.last_message_at).localeCompare(String(left.last_message_at)));
      response.json({ me: actor.id, conversations: summaries, contacts, unread: summaries.reduce((sum, row) => sum + row.unread, 0) });
    } catch (error) { next(error); }
  });

  /** Opens (or creates) a direct conversation, only between people allowed to talk one to one. */
  app.post("/api/v1/chat/direct", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const { user_id } = z.object({ user_id: uuid }).parse(request.body); const supabase = adminClient();
      if (actor.role === "SUPER_ADMIN") return response.status(403).json({ error: "The Super Admin uses Company announcements, not direct messages." });
      if (user_id === actor.id) return response.status(422).json({ error: "Choose someone else." });
      const { data: other } = await supabase.from("profiles").select("id, role, department_id, is_active").eq("id", user_id).maybeSingle();
      if (!other || !mayDirect(actor, other)) return response.status(403).json({ error: actor.role === "AGENT" ? "Agents can message managers directly; talk with other agents in your team group." : "You can't start a direct message with this person." });
      const key = directKey(actor.id, user_id);
      const { data: existing } = await supabase.from("chat_conversations").select("id").eq("direct_key", key).maybeSingle();
      if (existing) return response.json({ conversation_id: existing.id });
      const { data, error } = await supabase.from("chat_conversations").insert({ kind: "DIRECT", direct_key: key, created_by: actor.id }).select("id").single();
      if (error) {
        // Two people opening the same conversation at once: use the one that won.
        const { data: raced } = await supabase.from("chat_conversations").select("id").eq("direct_key", key).maybeSingle();
        if (raced) return response.json({ conversation_id: raced.id });
        throw error;
      }
      await supabase.from("chat_members").insert([{ conversation_id: data.id, user_id: actor.id }, { conversation_id: data.id, user_id }]);
      response.status(201).json({ conversation_id: data.id });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/chat/conversations/:id/messages", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const id = uuid.parse(request.params.id); const supabase = adminClient();
      const { before } = z.object({ before: z.string().datetime().optional() }).parse(request.query);
      const { data: member } = await supabase.from("chat_members").select("user_id").eq("conversation_id", id).eq("user_id", actor.id).maybeSingle();
      if (!member) return response.status(403).json({ error: "You're not in this conversation." });
      let query = supabase.from("chat_messages").select("id, conversation_id, sender_id, body, kind, created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(60);
      if (before) query = query.lt("created_at", before);
      const { data, error } = await query; if (error) throw error;
      response.json({ messages: (data ?? []).reverse(), has_more: (data ?? []).length === 60 });
    } catch (error) { next(error); }
  });

  /** Group admin (the team's manager): rename and photo. Members are managed through the team. */
  app.patch("/api/v1/chat/groups/:id", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!; const id = uuid.parse(request.params.id); const supabase = adminClient();
      const input = z.object({ name: z.string().trim().min(2).max(80).optional(), photo_url: z.string().url().max(500).nullable().optional() }).strict().parse(request.body);
      const { data: member } = await supabase.from("chat_members").select("role, chat_conversations(kind)").eq("conversation_id", id).eq("user_id", actor.id).maybeSingle();
      if (!member || member.role !== "ADMIN" || one((member as any).chat_conversations)?.kind !== "GROUP") return response.status(403).json({ error: "Only the group admin can change the group." });
      const { data, error } = await supabase.from("chat_conversations").update(input).eq("id", id).select().single(); if (error) throw error;
      await writeAudit(supabase, actor.id, "CHAT_GROUP_UPDATED", "chat_conversation", id, { fields: Object.keys(input) });
      response.json({ conversation: data });
    } catch (error) { next(error); }
  });

  /** Upload slot for a group photo (also used by the team form before the group exists). */
  app.post("/api/v1/chat/photo-upload-url", ...guard, async (request: Req, response, next) => {
    try {
      const actor = request.actor!;
      if (actor.role !== "MANAGER") return response.status(403).json({ error: "Only managers set group photos." });
      const input = z.object({ content_type: z.enum(["image/jpeg", "image/png", "image/webp"], { message: "Use a JPG, PNG or WebP image" }), file_size: z.number().int().positive().max(2 * 1024 * 1024, { message: "Photo is larger than 2 MB" }) }).parse(request.body);
      const extension = input.content_type === "image/png" ? "png" : input.content_type === "image/webp" ? "webp" : "jpg";
      const path = `${actor.id}/${crypto.randomUUID()}.${extension}`;
      const supabase = adminClient();
      const { data, error } = await supabase.storage.from("chat-photos").createSignedUploadUrl(path); if (error) throw error;
      const { data: publicUrl } = supabase.storage.from("chat-photos").getPublicUrl(path);
      response.json({ signed_url: data.signedUrl, public_url: publicUrl.publicUrl });
    } catch (error) { next(error); }
  });

  /** Super Admin: every group and who is in it (Communication page). */
  app.get("/api/v1/admin/communication", requireSuperAdmin, async (_request, response, next) => {
    try {
      const supabase = adminClient();
      const [{ data: groups }, { data: members }, { count: directs }] = await Promise.all([
        supabase.from("chat_conversations").select("id, name, photo_url, team_id, created_at, last_message_at, teams(name, is_active, departments(name, business_unit, function))").eq("kind", "GROUP").order("name"),
        supabase.from("chat_members").select("conversation_id, user_id, role, profiles(full_name, email, role, is_active)"),
        supabase.from("chat_conversations").select("id", { count: "exact", head: true }).eq("kind", "DIRECT"),
      ]);
      const counts = await Promise.all((groups ?? []).map(async (group: any) => (await supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("conversation_id", group.id)).count ?? 0));
      response.json({
        direct_conversations: directs ?? 0,
        groups: (groups ?? []).map((group: any, index: number) => {
          const team = one(group.teams); const department = one(team?.departments);
          return {
            id: group.id, name: group.name, photo_url: group.photo_url, team: team?.name ?? null, team_active: team?.is_active ?? false, department: department?.name ?? null,
            created_at: group.created_at, last_message_at: group.last_message_at, messages: counts[index],
            members: (members ?? []).filter((row: any) => row.conversation_id === group.id).map((row: any) => ({ id: row.user_id, full_name: one(row.profiles)?.full_name ?? "Unknown", email: one(row.profiles)?.email ?? null, role: one(row.profiles)?.role ?? null, chat_role: row.role, active: one(row.profiles)?.is_active ?? false })),
          };
        }),
      });
    } catch (error) { next(error); }
  });
}
