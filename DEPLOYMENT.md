# Love Story — deployment notes

Written now, while the decisions are fresh, so that moving this to a server
later is a morning's work rather than an archaeology project. **Nothing here
has been done yet.** No server, no domain, no cloud storage. The project still
runs locally exactly as it always has.

---

## What the archive is made of

Three things, and only three:

| | where it is now | what it is |
|---|---|---|
| **the database** | `backend/lovestory.db` | one SQLite file: memories, photographs' filenames, users, sessions, plans, anniversaries |
| **the photographs** | `backend/uploads/` | the image files themselves, named by the database |
| **the code** | this repository | static HTML/CSS/JS front-end, FastAPI back-end |

There is no object storage, no second database, and no build step. That is
deliberate: a two-person archive does not need any of them, and every one of
them is another thing that can be lost, leaked, or billed for.

---

## The one thing to get right: a persistent disk

The database and the uploads directory must live on **the same persistent
volume**, and it must not be the container's own filesystem. Two paths, set by
environment variable:

```bash
LOVE_STORY_DB_PATH=/data/lovestory.db
LOVE_STORY_UPLOAD_DIR=/data/uploads
```

Both default to inside the repository (`backend/lovestory.db`,
`backend/uploads/`) when unset, which is what local development wants. The
code takes the paths from `backend/database.py` and nowhere else — no other
file builds a path of its own — so moving them is a configuration change and
not a code change.

Why the same volume: a backup has to contain both halves. A restored database
whose rows point at photographs that were not restored is worse than a
database that never existed, because it looks fine until someone opens it.

`/data` is not created by this round and the current archive is not moved.
This is a note about the future, not a change to the present.

---

## The API address

The front-end works it out at load time, in `config.js`, from the hostname it
was served on:

| served from | API base | why |
|---|---|---|
| `localhost` / `127.0.0.1` | `http://127.0.0.1:8000` | development: static server and uvicorn are two origins |
| anything else | `""` — the page's own origin | production: one origin, one proxy |

That second row is the recommended production shape:

```
https://ourstory.example/            → the static front-end
https://ourstory.example/api/...     → the FastAPI app
https://ourstory.example/uploads/... → the same app's static mount
```

One origin means no CORS at all, no third-party cookie questions, and no
address to rewrite when the domain changes. A reverse proxy (nginx, Caddy,
Render's own routing) sends `/api` and `/uploads` to the back-end and
everything else to the static files.

If instead the API must live on its own subdomain, set the base explicitly
*before* `config.js` loads:

```html
<script>window.LOVE_STORY_API_BASE = "https://api.ourstory.example";</script>
<script src="config.js"></script>
```

and tell the back-end who may call it:

```bash
LOVE_STORY_FRONTEND_ORIGINS=https://ourstory.example
```

---

## Production environment

```bash
LOVE_STORY_ENV=production
LOVE_STORY_DB_PATH=/data/lovestory.db
LOVE_STORY_UPLOAD_DIR=/data/uploads
LOVE_STORY_FRONTEND_ORIGINS=          # empty when same-origin (recommended)
LOVE_STORY_COOKIE_SECURE=             # defaults to on when ENV=production
```

`LOVE_STORY_ENV=production` changes exactly two things: the session cookie is
sent `Secure`, and the development loopback CORS rule stops applying. Nothing
else about the code behaves differently, which is the point — the same code is
tested locally and shipped.

The server prints its configuration at startup, so a mistake is visible:

```
Love Story API
  database : /data/lovestory.db
  uploads  : /data/uploads
  env      : production
  origins  : (same-origin only)
  cookie   : secure=yes samesite=lax
```

---

## What is deliberately not here yet

Deferred on purpose, not forgotten:

- **HTTPS certificate** — needed before `Secure` cookies work at all. In
  practice the platform provides it; if not, Caddy does it in two lines.
- **Backups.** The single most important missing piece. A cron job that copies
  `/data` somewhere else, and a restore that has actually been tried once. An
  untested backup is a rumour.
- **A domain name.**
- **PostgreSQL, S3/R2, Docker, a CI pipeline.** None of them are required by
  anything the archive does today.
- **Email and push.** Nobody is emailed and nothing is pushed: an invitation is
  a link or a short code the person who made the space sends by hand, and a
  notification waits for its owner in the Notification Center until they look.

---

## Accounts, spaces and notifications

One account, one personal space, any number of groups. Nothing about that needs
new infrastructure, but two things are worth knowing when the archive moves:

- **Sessions are per space.** A session records which space that sign-in is
  looking at (`sessions.current_space_id`), and it is re-checked against a live
  membership on every read. A stale id, a membership that has since ended or a
  session from before spaces existed all fall back to the person's own space —
  never to a group they did not choose.
- **Notifications belong to the account**, not to the current space, which is
  why `GET /api/notifications` takes no space. A message about a group somebody
  has been removed from still has to reach them. They are written by the server
  when a request is made or answered and when a role changes; nothing polls and
  nothing is pushed.

The management routes are addressed by an explicit space id
(`/api/spaces/{space_id}/members`, `/invitations`, `/join-requests`), so a group
is run from a page whose session may be looking at another one. The legacy
session-scoped forms (`/api/spaces/invitations`, `/api/auth/invite-partner`)
still answer, for any client already holding those addresses, and the front-end
no longer uses them.

---

## The Private Archive

A second lock, at the account rather than the space:

- **A privacy password**, separate from the sign-in password, hashed with the
  same bcrypt cost. Setting or changing it requires the ACCOUNT password, so a
  computer left signed in cannot be used to install or replace it.
- **An unlock belongs to a sign-in, not to an account.** `sessions` carries
  `privacy_unlocked_until`, so unlocking the laptop does not unlock the phone,
  and logging out locks the private archive for free — the session row is what
  holds the unlock, and logout deletes it. `LOVE_STORY_PRIVACY_UNLOCK_MINUTES`
  (default 10) is measured from the last private request; the status endpoint
  deliberately does not extend it, or a polling page would hold it open for ever.
- **Per-memory permission**, in `memory_private_access`. A private memory is
  visible to the person who created it and to the `viewer`/`editor` rows they
  added, and to nobody else — not to a space's creator, not to an admin. The
  owner has no row: ownership is `memories.created_by_user_id`.
- **Removing somebody from a space revokes their private access** in the same
  transaction, so re-joining later restores nothing.

`GET /uploads/{filename}` is the only way to a photograph. The StaticFiles mount
is gone: the route looks the filename up in `photos`, checks that the caller is
an active member of the memory's space, and — for a private memory — checks the
permission and the unlock. Private media is `Cache-Control: private, no-store`;
standard media is `private, max-age=300`.

**This makes the cookie setting load-bearing for images.** A browser attaches the
session cookie to an `<img>` request when the front-end and the API are on the
same SITE: the same origin, two subdomains of one domain, or the recommended
reverse proxy that serves both `/api` and `/uploads` from one address. A
front-end and an API on genuinely different sites need `SameSite=none` with
`Secure`, or every photograph answers 401 and looks broken. This is a change
from before: a photograph used to be readable by anyone who knew its URL.

This is **access control, not encryption**. The server can read every memory it
stores. It is a second, server-verified lock plus per-memory authorisation, and
calling it end-to-end encrypted or zero-knowledge would be false.

---

## Migrating the existing archive

When the time comes, all three steps are copies:

1. Copy the code to the server.
2. Copy `backend/lovestory.db` to `$LOVE_STORY_DB_PATH`.
3. Copy everything in `backend/uploads/` to `$LOVE_STORY_UPLOAD_DIR`.

Then start the server once. `init_db()` runs on startup and is **additive
only** — it creates anything missing and never drops, deletes or rewrites a
row. That is what makes an existing archive safe to open with a newer version
of the code: it is also what this project has relied on for every schema change
so far.

Sessions survive the move, because they live in the database rather than in
server memory. Nobody is signed out by a restart or a migration.
