# Build task: "TaskFlow" — a task-management SaaS (from scratch)

You are building a complete, **production-quality, well-designed** SaaS web app called **TaskFlow** in
this empty repository. Implement the FULL spec below and make it genuinely good: it must actually
**work end-to-end for a real user in a browser** and **look like a modern, polished SaaS product** —
not a developer placeholder.

This is a LONG-HORIZON task. Do not stop early. Keep working — across as many steps as it takes —
until the product is complete, every flow actually works when clicked through in a browser, and the
design is something you'd be proud to ship. "The tests pass" or "the API returns 200" is NOT done;
**done means a real person can sign up, use every feature, and it looks professional.** Verify by
actually driving the running app in a browser (not just hitting the API), and keep going until it's
right.

## Requesting resources you cannot create yourself (IMPORTANT)

Some things an AI genuinely cannot self-provision: real API keys, secrets, paid accounts. **Do not
fabricate, hardcode, or stub these.** When you need one, REQUEST it:

- Append one line to `RESOURCE_REQUESTS.txt` in the repo root: `REQUEST: <clear description>`
  (e.g. `REQUEST: Stripe test-mode secret + publishable keys and a recurring price id`).
- Shortly after, the granted values will be written into `.env` (KEY=VALUE lines) and acknowledged in
  `RESOURCE_GRANTS.txt`. Poll those files; read the keys from `.env` (load it with a dotenv loader).
- If a request cannot be fulfilled, the grant note will say so — then use your best engineering
  judgment and continue. Never block forever; never invent a credential.

You WILL need Stripe test-mode credentials for billing (below). Request them this way.

## Stack (REQUIRED — the automated acceptance suite depends on these)

- **Language:** TypeScript on Node.js 20+.
- **Database:** SQLite via Node's **built-in** `node:sqlite` module (this runs on Node 26; native
  addons like `better-sqlite3` will NOT compile — use the built-in). API:
  `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('data.sqlite');
  db.exec(sql); db.prepare(sql).run(...args); db.prepare(sql).get(...args); db.prepare(sql).all(...args)`.
  A local file in the repo root. No external DB/service.
- **HTTP:** any Node framework. The server MUST listen on `process.env.PORT` (default `3000`), bind
  `0.0.0.0`.
- **Frontend:** your choice of approach, but the result must be a **modern, polished, responsive**
  UI — real visual design (consistent layout, spacing, typography, a coherent color system, styled
  components, hover/active states, sensible empty states, loading/error feedback). Bare unstyled HTML
  forms are a FAIL. Every page must be usable and look professional on both desktop and mobile.
- **Billing:** real **Stripe test mode** via the official `stripe` SDK (details below). The only
  external network calls allowed are to Stripe's test API.
- **Start:** `npm install` then `npm start` from a clean checkout must build (provide `npm run build`,
  exit 0 even if a no-op) and start the app on `$PORT`. Load `.env` at startup.

## Data model

- **User**: id, email (unique), passwordHash, plan ("free" | "pro", default "free"),
  stripeCustomerId (nullable), createdAt.
- **Project**: id, userId, name, createdAt.
- **Task**: id, projectId, title, status ("todo"|"doing"|"done", default "todo"),
  dueDate (nullable ISO string), createdAt.

Passwords MUST be hashed (bcrypt/scrypt/argon2). Never store plaintext.

## REST API contract (EXACT — the acceptance suite calls these)

JSON bodies. Auth via session cookie set on login/signup; protected routes return **401** when
unauthenticated. Status codes: **422** validation error, **403** accessing another user's resource,
**402** plan-limit violation, **404** missing, **409** conflict.

### Auth
- `POST /api/auth/signup` `{email,password}` → 201 `{id,email,plan}` + session cookie.
  409 if email exists; 422 if email invalid or password < 8 chars.
- `POST /api/auth/login` `{email,password}` → 200 `{id,email,plan}` + cookie. 401 bad creds.
- `POST /api/auth/logout` → 204, clears session.
- `GET /api/me` → 200 `{id,email,plan}` (401 if not logged in).

### Projects (auth; own only)
- `GET /api/projects` → 200 `[{id,name,taskCount,createdAt}]`.
- `POST /api/projects` `{name}` → 201 `{id,name}`. **Free: max 3 projects → 4th = 402.** 422 empty name.
- `PATCH /api/projects/:id` `{name}` → 200 `{id,name}`. 403 not owner, 404 missing.
- `DELETE /api/projects/:id` → 204 (cascades tasks). 403 not owner.

### Tasks (auth; within own projects)
- `GET /api/projects/:id/tasks` → 200 `[{id,title,status,dueDate,createdAt}]`.
- `POST /api/projects/:id/tasks` `{title,dueDate?}` → 201 `{id,title,status}`.
  **Free: max 20 tasks/project → 21st = 402.** 422 empty title.
- `PATCH /api/tasks/:id` `{title?,status?,dueDate?}` → 200 updated. 422 invalid status. 403 not owner.
- `DELETE /api/tasks/:id` → 204. 403 not owner.

### Billing (REAL Stripe test mode)
Use the `stripe` SDK with the test secret key from `.env` (request it as above). Use the provided
recurring `STRIPE_PRICE_ID`.
- `POST /api/billing/checkout` (auth) → creates a real Stripe **Checkout Session** in `subscription`
  mode for the current user (set `client_reference_id` to the user's id; create/reuse a Stripe
  customer). → 200 `{ url, sessionId }` (a real `https://checkout.stripe.com/...` url).
- `POST /api/billing/webhook` — Stripe webhook receiver. Verify the signature with
  `STRIPE_WEBHOOK_SECRET` (from `.env`) using `stripe.webhooks.constructEvent` over the **raw** body.
  On `checkout.session.completed` (or `customer.subscription.created`), set the user identified by the
  event's `client_reference_id` to plan "pro". Return 200 `{received:true}`; 400 on bad signature.
  After upgrade, the free project/task limits no longer apply to that user.

### UI (REQUIRED routes + `data-testid` hooks — within a polished, working design)
Every page below must be **visually designed** (see Frontend) and the flows must **actually work
when a user clicks through them in a browser**. The `data-testid` attributes are automation hooks the
grader uses to drive the real UI — put them on the real, functioning, styled elements (a form that
truly submits and logs the user in; a button that truly creates the project; etc.). A page that has
the testids but whose form does nothing when submitted is a FAIL.

- `GET /signup`, `GET /login` — forms with `data-testid` = `email`, `password`, `submit`; wrong login
  shows `data-testid="error"`; success → `/dashboard`.
- `GET /dashboard` (auth; else redirect `/login`) — projects as `data-testid="project-item"`;
  `data-testid="new-project-name"` + `data-testid="create-project"`; `data-testid="logout"`;
  a `data-testid="upgrade"` control that starts checkout.
- `GET /projects/:id` (auth) — tasks as `data-testid="task-item"`; `data-testid="new-task-title"` +
  `data-testid="add-task"`; each task a `data-testid="task-done"` control.

## Quality bar
Enforce authorization everywhere. Validate inputs; return documented codes. Hash passwords.
Parameterized SQL. Real Stripe signature verification (no skipping). Keep earlier features working as
you add later ones. **And it must look and feel like a real, modern, polished SaaS** — design is part
of quality, not optional.

## Definition of done (read carefully — do NOT stop short of this)
`npm install && npm start` brings up an app on `$PORT` where a real person can:
- sign up, log in, and log out **through the UI** (the forms work when clicked);
- create/rename/delete projects and tasks **through the UI**, with limits enforced;
- upgrade via real Stripe test-mode checkout;
…and **every page looks like a professional modern SaaS**. The whole API contract, the UI flows, real
Stripe billing, and the visual design ALL count. Verify the running app in a browser yourself before
considering it done. Partial credit is given per check, but aim for a complete, working, beautiful
product — keep going until it is one.
