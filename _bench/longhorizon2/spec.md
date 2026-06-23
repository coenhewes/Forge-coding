# Build task: "Forgeflow" — a multi-tenant team project-management SaaS (from scratch)

You are building a complete, **production-quality, well-designed** multi-tenant SaaS web app called
**Forgeflow** in this empty repository. It is much larger than a toy app: teams, roles, projects,
boards, tasks, comments, attachments, search, notifications, real-time updates, seat-based Stripe
billing, a public REST API with tokens and rate limiting, outgoing webhooks, and an admin/audit area —
all behind a polished, modern UI.

This is a **VERY LONG-HORIZON** task. It is far too large to finish in a single burst. **Do not stop
early.** Keep working — across as many steps and hours as it takes — until the WHOLE spec is
implemented, every flow actually works when clicked through in a browser, earlier features still work
after you add later ones, and the design is something you'd be proud to ship. "The tests pass" or "the
API returns 200" is NOT done. **Done means a real person can use every feature and it looks
professional.** As you add features, RE-VERIFY the earlier ones still work — regressions are failures.

## Credentials — already provided in `.env`

A `.env` file in the repo root contains the Stripe **test-mode** account secrets:
`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`. **Load `.env` at startup**
(`process.loadEnvFile()` or a dotenv loader) and read from `process.env`. Do not fabricate or hardcode
credentials. If you need a resource genuinely outside your control that is not present, append
`REQUEST: <description>` to `RESOURCE_REQUESTS.txt` and keep working; never block.

**You must provision your own Stripe catalog.** No price IDs are given — using the `STRIPE_SECRET_KEY`,
create (via the Stripe API/SDK) your own Product(s) and the recurring **Prices** you need: a base
monthly price for the paid plans and a **per-seat** recurring price. Do this idempotently (e.g., a
one-time setup step, a boot-time "ensure catalog" routine keyed by product/price lookup or a stored
id) so restarts don't create duplicates. Wire Checkout to the prices you created. This is part of the
task — a real engineer sets up the billing catalog themselves; only the account secret is provided.

## Stack (REQUIRED — the acceptance suite depends on these)

- **Language:** TypeScript on Node.js 20+ (runs on Node 26).
- **Database:** SQLite via Node's **built-in** `node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`).
  `better-sqlite3` will NOT compile — use the built-in. A local `data.sqlite` file in the repo root.
- **HTTP:** any Node framework. Server MUST listen on `process.env.PORT` (default `3000`), bind `0.0.0.0`.
- **Frontend:** modern, polished, **responsive** UI — real visual design (coherent layout, spacing,
  typography, color system, styled components, hover/active/focus states, empty/loading/error states).
  Bare unstyled HTML is a FAIL. Every page must look professional on desktop AND mobile.
- **Billing:** real **Stripe test mode** via the official `stripe` SDK. Only external calls allowed are
  to Stripe's test API and to outgoing-webhook URLs the app is configured with.
- **Start:** `npm install` then `npm start` from a clean checkout must build (`npm run build` exits 0)
  and start the app on `$PORT`. Load `.env` at startup.

## Auth model

Two auth schemes:
1. **Session cookie** for the web UI and `/api/*` routes (set on signup/login).
2. **Bearer API token** (`Authorization: Bearer <token>`) for `/api/v1/*` public API routes.

Protected routes return **401** unauthenticated. Standard codes: **422** validation, **403** forbidden
(wrong role / not a member / not owner), **402** plan-limit, **404** missing, **409** conflict,
**429** rate-limited.

## Data model (SQLite; parameterized SQL only; hash passwords with bcrypt/scrypt/argon2)

- **User**: id, email (unique), passwordHash, name, createdAt.
- **Org**: id, name, ownerId, plan ("free"|"pro"|"business", default "free"), stripeCustomerId (nullable),
  seats (int, default 1), createdAt.
- **Membership**: id, orgId, userId, role ("owner"|"admin"|"member"), createdAt. (unique orgId+userId)
- **Invite**: id, orgId, email, role, token (unique), acceptedAt (nullable), createdAt.
- **Project**: id, orgId, name, key (short uppercase, unique within org), archived (bool), createdAt.
- **Task**: id, projectId, title, description, status ("todo"|"doing"|"review"|"done", default "todo"),
  priority ("low"|"med"|"high","urgent"; default "med"), assigneeId (nullable user), dueDate (nullable),
  position (int, for ordering), createdAt.
- **Label**: id, projectId, name, color. **TaskLabel**: taskId, labelId.
- **Comment**: id, taskId, userId, body, createdAt.
- **Attachment**: id, taskId, userId, filename, mime, sizeBytes, path, createdAt.
- **Notification**: id, userId, type, payload(JSON), readAt (nullable), createdAt.
- **ApiToken**: id, userId, name, tokenHash, lastUsedAt, createdAt.
- **WebhookEndpoint**: id, orgId, url, secret, events(JSON array), active(bool), createdAt.
- **AuditLog**: id, orgId, actorId, action, target, meta(JSON), createdAt.

## Plan limits (enforced; lifted per-org when plan is pro/business)

- **free**: max 1 org owned, max 3 projects/org, max 3 members/org, max 50 tasks/project, no API tokens,
  no outgoing webhooks.
- **pro**: unlimited projects, up to 15 members/org, unlimited tasks, API tokens enabled, webhooks enabled.
- **business**: everything unlimited, plus audit log export.

Exceeding a limit on the relevant create endpoint returns **402** with `{error, limit}`.

## REST API contract (EXACT — the acceptance suite calls these)

### Auth & account
- `POST /api/auth/signup` `{email,password,name}` → 201 `{id,email,name}` + cookie. 409 dup; 422 bad
  (email invalid or password <8).
- `POST /api/auth/login` `{email,password}` → 200 `{id,email,name}` + cookie. 401 bad creds.
- `POST /api/auth/logout` → 204.
- `GET /api/me` → 200 `{id,email,name,orgs:[{id,name,role,plan}]}` (401 if not logged in).

### Orgs & members (role-gated)
- `POST /api/orgs` `{name}` → 201 `{id,name,plan}` (creator becomes owner + membership). free: 402 if
  user already owns 1 org.
- `GET /api/orgs/:id` → 200 `{id,name,plan,seats,role,memberCount,projectCount}` (403 if not a member).
- `PATCH /api/orgs/:id` `{name}` → 200 (owner/admin only; 403 member). 
- `GET /api/orgs/:id/members` → 200 `[{userId,email,name,role}]` (member+).
- `POST /api/orgs/:id/invites` `{email,role}` → 201 `{id,token}` (owner/admin only; 403 member). 402 if
  member limit reached. 409 if already a member/invited.
- `POST /api/invites/:token/accept` (auth) → 200 `{orgId}` (adds membership; 404 bad token; 409 used).
- `PATCH /api/orgs/:id/members/:userId` `{role}` → 200 (owner only; cannot demote last owner → 409).
- `DELETE /api/orgs/:id/members/:userId` → 204 (owner/admin; 403 member; cannot remove last owner 409).

### Projects (within an org; member+)
- `GET /api/orgs/:id/projects` → 200 `[{id,name,key,taskCount,archived}]`.
- `POST /api/orgs/:id/projects` `{name,key}` → 201 `{id,name,key}`. 402 plan limit; 409 dup key; 422 bad.
- `PATCH /api/projects/:id` `{name?,archived?}` → 200 (member+; 403 if not in org).
- `DELETE /api/projects/:id` → 204 (owner/admin only; cascades tasks/labels/comments).

### Tasks, labels, comments, attachments
- `GET /api/projects/:id/tasks?status=&assignee=&label=&q=&page=&pageSize=` → 200
  `{tasks:[{id,title,status,priority,assigneeId,dueDate,labels:[{id,name,color}],commentCount}],total,page}`.
  Supports filtering by status/assignee/label, full-text `q` on title+description, and pagination
  (default pageSize 20).
- `POST /api/projects/:id/tasks` `{title,description?,priority?,assigneeId?,dueDate?}` → 201 task.
  402 free task limit; 422 empty title or invalid priority; 403 assignee not a member of the org.
- `PATCH /api/tasks/:id` `{title?,description?,status?,priority?,assigneeId?,dueDate?,position?}` → 200.
  422 invalid status/priority; 403 not in org. Assigning a task creates a Notification for the assignee.
- `DELETE /api/tasks/:id` → 204 (member+).
- `POST /api/tasks/:id/labels` `{labelId}` → 200; `DELETE /api/tasks/:id/labels/:labelId` → 204.
- `GET /api/projects/:id/labels` → 200 `[{id,name,color}]`; `POST /api/projects/:id/labels`
  `{name,color}` → 201.
- `GET /api/tasks/:id/comments` → 200 `[{id,body,userId,userName,createdAt}]`.
- `POST /api/tasks/:id/comments` `{body}` → 201. Creates a Notification for the task assignee (if any,
  and not the commenter). 422 empty body.
- `POST /api/tasks/:id/attachments` (multipart file field `file`) → 201
  `{id,filename,mime,sizeBytes}`. Stores the file under an uploads dir. 422 if no file.
- `GET /api/attachments/:id` → 200 streams the file with correct content-type (403 if not in org).

### Notifications
- `GET /api/notifications` → 200 `[{id,type,payload,readAt,createdAt}]` (current user).
- `POST /api/notifications/:id/read` → 204. `POST /api/notifications/read-all` → 204.
- `GET /api/notifications/stream` → **Server-Sent Events** stream; pushes a `notification` event when a
  new notification is created for the current user (real-time).

### Billing (REAL Stripe test mode; org-scoped; owner only)
- `POST /api/orgs/:id/billing/checkout` `{plan}` (owner only) → 200 `{url,sessionId}`. Creates a real
  Stripe **Checkout Session** in `subscription` mode using the base price you provisioned for that plan
  plus a per-seat line using your per-seat price with `quantity` = current memberCount. Set
  `client_reference_id` to the org id; create/reuse a Stripe customer. The returned `url` must be a real
  `https://checkout.stripe.com/...` session URL.
- `POST /api/orgs/:id/billing/portal` (owner) → 200 `{url}` (real Stripe billing portal session).
- `POST /api/billing/webhook` — verify signature with `STRIPE_WEBHOOK_SECRET` via
  `stripe.webhooks.constructEvent` over the **raw** body. Handle: `checkout.session.completed` →
  set org (by `client_reference_id`) to the purchased plan; `customer.subscription.updated` → sync
  plan/seats; `customer.subscription.deleted` → downgrade org to free. Return 200 `{received:true}`;
  400 on bad signature. After upgrade, plan limits for that org are lifted.

### Public API v1 (Bearer token; rate-limited)
- `POST /api/tokens` (session auth) `{name}` → 201 `{id,name,token}` (token shown ONCE; store only a
  hash). 402 if plan has no API tokens. `GET /api/tokens` → 200 `[{id,name,lastUsedAt}]`;
  `DELETE /api/tokens/:id` → 204.
- `GET /api/v1/projects` (Bearer) → 200 list of the token owner's accessible projects. 401 bad/missing
  token.
- `POST /api/v1/projects/:id/tasks` (Bearer) `{title}` → 201 task.
- **Rate limit:** `/api/v1/*` limited to **60 requests/minute per token** → **429** with
  `Retry-After` header when exceeded.

### Outgoing webhooks
- `GET/POST/DELETE /api/orgs/:id/webhooks` (owner/admin; plan-gated) manage `WebhookEndpoint`s with a
  set of subscribed `events` (e.g. `task.created`, `task.completed`).
- When a subscribed event occurs, POST `{event,data}` to each active endpoint URL with header
  `X-Forgeflow-Signature: sha256=<hmac of body using the endpoint secret>`. Retries are nice-to-have.

### Admin & audit
- Mutating actions (member add/remove, role change, project delete, plan change) append an `AuditLog`.
- `GET /api/orgs/:id/audit` (owner/admin) → 200 `[{action,actorId,target,createdAt}]`, paginated.

## UI (REQUIRED routes + `data-testid` hooks — polished, working, responsive)

Each page must be visually designed AND actually work when clicked. testids go on real, functioning,
styled elements.
- `GET /signup`, `GET /login` — `data-testid` `email`,`password`,`name`(signup),`submit`; bad login →
  `data-testid="error"`; success → `/app`.
- `GET /app` (auth; else `/login`) — org switcher `data-testid="org-switcher"`; create-org
  `data-testid="new-org-name"` + `data-testid="create-org"`; list projects as
  `data-testid="project-item"`; `data-testid="new-project-name"`,`data-testid="new-project-key"`,
  `data-testid="create-project"`; `data-testid="logout"`; `data-testid="notifications"` (badge with
  unread count); `data-testid="upgrade"` (starts checkout).
- `GET /app/projects/:id` — board view with columns; tasks as `data-testid="task-item"`;
  `data-testid="new-task-title"` + `data-testid="add-task"`; each task opens a detail with
  `data-testid="task-status"`, `data-testid="task-assignee"`, `data-testid="comment-body"` +
  `data-testid="add-comment"`. A view switch `data-testid="view-list"`/`data-testid="view-board"`.
- `GET /app/projects/:id?view=list` — list view of the same tasks (filter/search box
  `data-testid="task-search"`).
- `GET /app/settings/members` — members table `data-testid="member-row"`; invite form
  `data-testid="invite-email"` + `data-testid="invite-send"`; role controls.
- `GET /app/settings/billing` — current plan, `data-testid="plan-name"`, upgrade/portal buttons.
- `GET /app/settings/api` — create token `data-testid="token-name"` + `data-testid="create-token"`;
  token list.
- `GET /app/notifications` — list `data-testid="notification-item"`; mark-all `data-testid="mark-all-read"`.

## Quality bar
Enforce RBAC on EVERY route. Validate inputs; return documented codes. Hash passwords + API tokens.
Parameterized SQL. Real Stripe signature verification. Plan limits enforced and lifted on upgrade.
**Keep earlier features working as you add later ones — re-verify; regressions are failures.** And it
must look and feel like a real, modern, polished SaaS — design is part of quality.

## Definition of done (do NOT stop short)
`npm install && npm start` brings up an app where a real person can: sign up; create an org; invite
and manage members with roles; create projects/tasks/labels/comments/attachments; filter, search and
paginate tasks; get real-time notifications; upgrade the org via real Stripe seat-based checkout and
have limits lifted; create an API token and use the Bearer API (and hit the rate limit); register an
outgoing webhook; and see an audit log — **with every page looking like a professional modern SaaS.**
Verify the running app in a browser yourself. Partial credit is given per check across all areas, but
aim for the complete, working, beautiful product. Keep going until it is one.
