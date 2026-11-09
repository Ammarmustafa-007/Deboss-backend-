# 8. Chat

Code: `src/chat.ts`, migrations 016, 017, 023. Messages are sent and received **by the browser directly through Supabase** (insert + Realtime), protected by row-level security. The API decides who may talk to whom, builds the inbox, serves history, manages groups and channel membership, and posts system updates.

## 8.1 Tables

| Table | Purpose |
|---|---|
| `chat_conversations` | `kind` = `DIRECT` (two people, unique `direct_key` = the two ids sorted and joined by `:`), `GROUP` (one per team, `team_id`), or `CHANNEL` (`channel_key` = `QUOTES`, `UPDATES`, `ANNOUNCEMENTS`). Name and photo for groups |
| `chat_members` | Who is in a conversation, their `role` there (`ADMIN` / `MEMBER`) and `last_read_at` |
| `chat_messages` | `body`, `sender_id`, `kind` = `USER` (typed by a person) or `EVENT` (posted by the system) |

## 8.2 Direct messages

| From → To | Allowed |
|---|---|
| Manager → any manager (any department or business unit) | Yes |
| Manager → agent of **their own business unit** (Brokerage: Sales, Operations, Fronters; Dispatch: Sales, Operations) | Yes |
| Agent → manager of **their own business unit** (a Brokerage agent → Brokerage managers; a Dispatch agent → Dispatch managers) | Yes |
| Agent → agent | No (they use their team group) |
| Super Admin ↔ anyone | No |

`mayDirect()` enforces it, `contactsFor()` lists who the caller may start a conversation with, and `POST /chat/direct` opens or creates the conversation (re-using an existing one for the same pair).

## 8.3 Team groups

`syncTeamGroup(teamId)` creates and maintains one `GROUP` per team. Members are the team's members, its Team Lead, and the department manager, who is the group `ADMIN`. It runs whenever a team is created or edited. The admin can rename the group and set its photo (stored in the public `chat-photos` bucket); nobody can leave a group by themselves.

**Managers' own groups.** A manager creates a group (`POST /chat/groups` with a name and `member_ids`) with anyone they may message directly, and is its `ADMIN`. Its `team_id` is empty, so the admin adds and removes members themselves (`PATCH /chat/groups/:id` with `add_members` / `remove_members`; the admin can't remove themselves). Agents can't create groups. A team group's members still follow the team only.

## 8.4 Company channels

| Channel | Members (`channelsFor()`) | Who posts |
|---|---|---|
| Company announcements | Everyone, including the Super Admin | Managers and the Super Admin |
| Quotes | Brokerage Sales and Brokerage Operations | Members, plus `EVENT` posts |
| Updates | Brokerage Sales, Operations and Fronters | Members, plus `EVENT` posts |

Membership is synced on every inbox load (`syncChannels()`): people join or leave as their role and department change. Someone joining late sees earlier **announcements** as unread, but not old Quotes or Updates history.

System posts use `postEvent(channel, actorId, body)`, which inserts an `EVENT` message and never blocks the action it reports. See the list in [05-brokerage.md](05-brokerage.md#58-notifications-and-channel-posts). Posts never name a carrier, because Sales reads them.

## 8.5 Row-level security (the browser side)

| Function / policy | Rule |
|---|---|
| `is_chat_member(conversation)` | The caller is in `chat_members` for it |
| `chat_can_post(conversation)` | Member, active, and for Announcements a manager or Super Admin |
| `members send messages` (insert) | `sender_id = auth.uid()`, `kind = 'USER'`, `chat_can_post` |
| `members read …` (select) | Only conversations, members and messages of conversations the caller is in |
| `mark_chat_read(conversation)` | Sets the caller's `last_read_at` |
| `chat_typing_member(topic)` + `realtime.messages` policies | The typing indicator travels on a private Realtime broadcast channel `typing:<conversation id>`, which only members can join |

Messages can't be edited or deleted. There are no attachments.

## 8.6 API

| Endpoint | Purpose |
|---|---|
| `GET /chat/inbox` | Conversations with last message, unread count and members, plus who the caller may message |
| `POST /chat/direct` | Open a direct conversation |
| `GET /chat/conversations/:id/messages` | History |
| `POST /chat/groups` | A manager creates their own group (name, members) |
| `PATCH /chat/groups/:id` | Rename / photo (group admin); add or remove members in a manager's own group |
| `POST /chat/photo-upload-url` | Signed upload URL for a group photo (managers) |
| `GET /admin/communication` | Super Admin: every team group and its members |
