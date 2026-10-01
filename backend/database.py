"""LoveStory — SQLite access for the first backend phase.

Deliberately plain: the standard library's sqlite3, no ORM. One memory can own
many photographs; the photographs themselves live on disk in backend/uploads/
and only their filenames are recorded here.

Every path is derived from this file's own location, so the server can be
started from the project root or from backend/ and still find its database.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

# --- locations ---------------------------------------------------------------
# __file__ is .../lovestoryweb/backend/database.py, so these are absolute and
# independent of the process working directory. Every connection in this module
# uses DB_PATH and nothing else.
BASE_DIR = Path(__file__).resolve().parent

# The two environment variables exist so an automated test can work in a
# temporary directory. Nothing in normal use sets them, so the archive always
# lives in backend/ — and a test can never touch it.
DB_PATH = Path(os.environ.get("LOVE_STORY_DB_PATH") or (BASE_DIR / "lovestory.db"))
UPLOAD_DIR = Path(os.environ.get("LOVE_STORY_UPLOAD_DIR") or (BASE_DIR / "uploads"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT    NOT NULL,
    date              TEXT    NOT NULL,
    time              TEXT,
    country           TEXT,
    city              TEXT,
    place_name        TEXT,
    latitude          REAL,
    longitude         REAL,
    weather           TEXT,
    temperature       REAL,
    mood              TEXT,
    description       TEXT,
    favorite          INTEGER DEFAULT 0,
    show_on_timeline  INTEGER DEFAULT 0,
    /* standard  what the archive has always been: everybody in the memory's
                  space reads it and may edit it.
       private   visible only to the person who made it and to the people they
                  have named in memory_private_access, and only while their
                  private archive is unlocked in this sign-in.

       Not "public" for the other one: nothing here is public, because reading
       the archive already requires a space. The pair is standard/private. */
    privacy_mode      TEXT    NOT NULL DEFAULT 'standard'
                      CHECK (privacy_mode IN ('standard', 'private')),
    created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id      INTEGER NOT NULL,
    filename       TEXT    NOT NULL,
    original_name  TEXT,
    sort_order     INTEGER DEFAULT 0,
    is_cover       INTEGER DEFAULT 0,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_photos_memory ON photos(memory_id);
CREATE INDEX IF NOT EXISTS idx_memories_date ON memories(date);

-- ---------------------------------------------------------------------------
-- Accounts. There are exactly two people: one owner and one partner. A guest
-- is simply "no session", and is never a row in this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE,
    display_name   TEXT    NOT NULL,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN ('owner', 'partner')),
    avatar_url     TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT
);

-- One row per signed-in browser. The token itself is never stored: only its
-- SHA-256, so a copy of this file cannot be used to impersonate anyone.
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash    TEXT    NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL,
    created_at    TEXT    NOT NULL,
    expires_at    TEXT    NOT NULL,
    last_seen_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A single-use invitation from the owner to the partner.
CREATE TABLE IF NOT EXISTS invite_tokens (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash          TEXT    NOT NULL UNIQUE,
    created_by_user_id  INTEGER,
    role                TEXT    NOT NULL DEFAULT 'partner',
    expires_at          TEXT    NOT NULL,
    used_at             TEXT,
    created_at          TEXT    NOT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

-- What happened, and who did it. This is the real log; "notifications" are
-- only a marker of how far each editor has read.
CREATE TABLE IF NOT EXISTS activities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id  INTEGER,
    action_type    TEXT    NOT NULL,
    memory_id      INTEGER,
    created_at     TEXT    NOT NULL,
    metadata_json  TEXT,
    FOREIGN KEY (actor_user_id) REFERENCES users(id),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notification_state (
    user_id                INTEGER PRIMARY KEY,
    last_seen_activity_id  INTEGER,
    updated_at             TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invite_tokens(token_hash);

/* --------------------------------------------------------------------------
   Plan the Future

   A plan is a trip the two of us mean to take: a name, a place, a date range
   and what it is for. Duration and status are NOT stored — they follow from
   the dates and from today's date, and a second copy of a fact is a second
   version of it to keep in step.

   A plan owns its days, and a day owns its activities. Both cascade, so
   removing a plan cannot leave a day behind pointing at nothing.
   -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS future_plans (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT    NOT NULL,
    location            TEXT    NOT NULL,
    start_date          TEXT    NOT NULL,
    end_date            TEXT    NOT NULL,
    description         TEXT    NOT NULL,
    transportation      TEXT,
    accommodation       TEXT,
    notes               TEXT,
    created_by_user_id  INTEGER,
    updated_by_user_id  INTEGER,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS future_plan_days (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL,
    day_number  INTEGER NOT NULL,
    date        TEXT    NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES future_plans(id) ON DELETE CASCADE,
    UNIQUE (plan_id, day_number)
);

CREATE TABLE IF NOT EXISTS future_plan_activities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day_id      INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (day_id) REFERENCES future_plan_days(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plans_start ON future_plans(start_date);
CREATE INDEX IF NOT EXISTS idx_plan_days_plan ON future_plan_days(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_activities_day ON future_plan_activities(day_id);

/* --------------------------------------------------------------------------
   An anniversary is a date that comes round every year: the day our story
   began, the day we met, the day we moved in. It is created on purpose by one
   of the two people who own this archive, and it shares nothing with a
   memory.

   Only `original_date` is stored. Everything the page shows — the next
   occurrence, the days remaining, which anniversary number it will be, how
   many have already passed — is worked out from that one date and today's
   date. Storing any of them would be storing a second answer to a question
   that already has one, and the two would part company the first time a
   birthday was edited.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS anniversaries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT    NOT NULL,
    original_date       TEXT    NOT NULL,
    note                TEXT,
    created_by_user_id  INTEGER,
    updated_by_user_id  INTEGER,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);

/* --------------------------------------------------------------------------
   Asking to join a shared space.

   An invitation is not a membership. Following a link says "may I?", and the
   person who made the space says yes — so the invitation produces a REQUEST,
   and only an approval produces a member. Nothing else can add somebody to a
   group: there is no path that skips this table.

   A request outlives the browser, the session and the invitation that started
   it. It is the record of somebody waiting to be let in.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS space_join_requests (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id             INTEGER NOT NULL,
    requester_user_id    INTEGER NOT NULL,
    invite_id            INTEGER,
    status               TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    requested_at         TEXT    NOT NULL,
    reviewed_at          TEXT,
    reviewed_by_user_id  INTEGER,
    FOREIGN KEY (space_id)            REFERENCES spaces(id),
    FOREIGN KEY (requester_user_id)   REFERENCES users(id),
    FOREIGN KEY (invite_id)           REFERENCES invite_tokens(id),
    FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)
);

/* One live request per person per space. Declined and approved requests stay
   as history and do not block a later one. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending
    ON space_join_requests(space_id, requester_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_requests_space ON space_join_requests(space_id, status);

/* --------------------------------------------------------------------------
   Notifications — something a PERSON needs to know or act on.

   Deliberately not the activity feed. An activity is a line in a space's
   history that everyone in it may read ("a memory was added"). A notification
   is addressed to one account and usually asks it to do something ("Amy wants
   to join Cairns Trip"). Mixing them would mean either telling everybody about
   one person's request, or hiding a space's history from its members.

   A notification belongs to the ACCOUNT, not to a space, so it survives being
   removed from the space it is about — which is exactly when somebody most
   needs to be told.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS notifications (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                  INTEGER NOT NULL,
    space_id                 INTEGER,
    type                     TEXT    NOT NULL,
    actor_user_id            INTEGER,
    related_join_request_id  INTEGER,
    title                    TEXT,
    body                     TEXT,
    created_at               TEXT    NOT NULL,
    read_at                  TEXT,
    FOREIGN KEY (user_id)                 REFERENCES users(id),
    FOREIGN KEY (space_id)                REFERENCES spaces(id),
    FOREIGN KEY (actor_user_id)           REFERENCES users(id),
    FOREIGN KEY (related_join_request_id) REFERENCES space_join_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications(user_id, read_at, id DESC);

/* Every read is "soonest next occurrence first", which starts from the month
   and day of the original date. */
CREATE INDEX IF NOT EXISTS idx_anniversaries_date ON anniversaries(original_date);

/* --------------------------------------------------------------------------
   Our Space — the thing two people share.

   An account is a person. A space is what they share: the memories, the
   photographs, the plans, the anniversaries. The two are deliberately not the
   same table, and a user is joined to a space by a membership row rather than
   by a column on `users`, because the relationship is the thing that carries
   the role, the date they joined, and — later — the date they left.

   There is no `name` yet. A space is "ours" for now, and a display name is a
   column to add when there is a screen that asks for one.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS spaces (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    /* What the space is for. A space for one person and a space for several
       are the same thing with different rules, not two different things. */
    name                TEXT    NOT NULL DEFAULT '',
    space_type          TEXT    NOT NULL DEFAULT 'group'
                        CHECK (space_type IN ('personal', 'group')),
    created_by_user_id  INTEGER,
    status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'archived')),
    created_at          TEXT    NOT NULL,
    archived_at         TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

/* Who is in a space, and in what capacity.
   `creator` is the person who opened it; `member` is the person who joined.
   The words are the data model's, not the interface's — the pages still say
   Owner and Partner. */
CREATE TABLE IF NOT EXISTS space_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id     INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    /* creator  the space's authority: one per space, and never removable by
                anybody else.
       admin    a manager: may run the space, may not displace the creator.
       member   a collaborator: edits everything the space holds.
       All three may create and edit shared content; the difference between
       them is management, which is Phase 2's business. */
    member_role  TEXT    NOT NULL CHECK (member_role IN ('creator', 'admin', 'member')),
    joined_at    TEXT    NOT NULL,
    left_at      TEXT,
    FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id);
CREATE INDEX IF NOT EXISTS idx_space_members_user  ON space_members(user_id);
CREATE INDEX IF NOT EXISTS idx_spaces_status       ON spaces(status);

/* The same person cannot be in the same space twice. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_active_pair
    ON space_members(space_id, user_id) WHERE left_at IS NULL;

/* One creator per space, and only one. Admins and members are unlimited.
   (Retired, here and in the migration: one active space per account, and the
   two-person ceiling that made a second member impossible.) */
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_active_creator
    ON space_members(space_id) WHERE member_role = 'creator' AND left_at IS NULL;

/* ==========================================================================
   THE PRIVATE ARCHIVE

   A memory is either STANDARD or PRIVATE. A standard memory is what the whole
   archive has always been: everybody in its space reads it, everybody in its
   space may edit it. A private memory is visible only to the person who made
   it and to the people they have named — and only while their Private Archive
   is unlocked in this sign-in.

   Two tables, and neither of them is a second copy of anything:

     memory_private_access      who besides the owner may see one memory
     user_privacy_credentials   the second password that unlocks a person's
                                private archive

   The owner is NOT here. `memories.created_by_user_id` already says who made a
   memory, and a second owner column would be a second answer to a question
   that already has one.
   ========================================================================== */

/* Who may see one private memory, and how.

   The owner is deliberately absent: ownership is the memory's
   `created_by_user_id`, so the owner has no row here and can never be locked
   out of their own memory by a bad edit to this table. What is here is
   everybody else, one row each, with no way to hold two rows at once. */
CREATE TABLE IF NOT EXISTS memory_private_access (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id          INTEGER NOT NULL,
    user_id            INTEGER NOT NULL,
    /* viewer  may read the memory and its photographs.
       editor  may read it and change its ordinary content — nothing about who
               may see it, and nothing about who owns it. */
    permission         TEXT    NOT NULL CHECK (permission IN ('viewer', 'editor')),
    granted_by_user_id INTEGER NOT NULL,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL,
    FOREIGN KEY (memory_id)          REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)            REFERENCES users(id),
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id),
    UNIQUE (memory_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_private_access_memory ON memory_private_access(memory_id);
CREATE INDEX IF NOT EXISTS idx_private_access_user   ON memory_private_access(user_id);

/* The second password, one per account.

   Separate from `users.password_hash` on purpose. The account password is how
   you sign in, and a sign-in lasts a month; this one guards the private
   archive, and an unlock lasts ten minutes. They are different secrets because
   they answer different questions.

   Hashed with the same bcrypt cost as the account password, and never
   recoverable: a forgotten privacy password is reset with the account
   password, not read back. */
CREATE TABLE IF NOT EXISTS user_privacy_credentials (
    user_id       INTEGER PRIMARY KEY,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

# Columns added to `memories` after it already existed. SQLite cannot add a
# foreign key by ALTER, so these are plain integers — the relationship is
# enforced by the API, and historical rows keep NULL rather than being
# retro-actively assigned to the owner.
MEMORIES_COLUMNS = (
    ("created_by_user_id", "INTEGER"),
    ("updated_by_user_id", "INTEGER"),
    ("updated_at", "TEXT"),
    # Added with the private archive. Every row that already exists is standard,
    # and the CHECK is written into the column so the database refuses a third
    # value even if the API one day forgets to.
    ("privacy_mode",
     "TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_mode IN ('standard', 'private'))"),
)

# The collections a space owns. Same reasoning as MEMORIES_COLUMNS: SQLite
# cannot add a foreign key by ALTER, so these are plain integers and the
# relationship is enforced by the API. They are nullable only because every row
# that already exists predates the space it belongs to — the migration below
# fills them in, and nothing new is ever written without one.
#
# Deliberately absent: photos (a photograph belongs to a memory, and a memory
# belongs to a space — copying the id down would be a second answer to a
# question that already has one), future_plan_days (same, via its plan), and
# notification_state (a person's read marker, not a space's data).
# Columns added to `invite_tokens` for the pairing flow. Both nullable and
# additive; an invitation created before this simply has neither.
INVITE_COLUMNS = (
    ("code_hash", "TEXT"),
    ("revoked_at", "TEXT"),
)

SPACE_COLUMNS = (
    ("memories", "space_id", "INTEGER"),
    ("future_plans", "space_id", "INTEGER"),
    ("anniversaries", "space_id", "INTEGER"),
    ("activities", "space_id", "INTEGER"),
    ("invite_tokens", "space_id", "INTEGER"),
)

# The privacy state of a SIGN-IN. It lives on the session, not on the account,
# because it means "this browser, on this computer, was unlocked ten minutes
# ago" — the laptop somebody borrowed is a different session from the phone in
# their pocket, and unlocking one must not unlock the other.
#
# Three columns rather than a table, because they are replaced wholesale, never
# queried across sessions, and belong to a row that is already deleted at
# logout — which is what makes logout lock the private archive for free.
PRIVACY_SESSION_COLUMNS = (
    ("privacy_unlocked_until", "TEXT"),
    ("privacy_failed_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("privacy_retry_after", "TEXT"),
)


REQUIRED_TABLES = ("memories", "photos", "users", "sessions",
                   "future_plans", "future_plan_days", "future_plan_activities",
                   "anniversaries", "spaces", "space_members",
                   "space_join_requests", "notifications",
                   "memory_private_access", "user_privacy_credentials")

# Every memory read carries the display identity of its uploader and last
# editor. A LEFT JOIN, so a memory from before accounts existed still returns.
MEMORY_SELECT = """
SELECT m.*,
       c.id           AS creator_id,
       c.display_name AS creator_name,
       c.role         AS creator_role,
       e.id           AS editor_id,
       e.display_name AS editor_name,
       e.role         AS editor_role
  FROM memories m
  LEFT JOIN users c ON c.id = m.created_by_user_id
  LEFT JOIN users e ON e.id = m.updated_by_user_id
"""


def connect() -> sqlite3.Connection:
    """A connection with row access by name and foreign keys enforced.

    `PRAGMA foreign_keys` is a per-connection setting, not a property of the
    file, so it has to be set on every connection — not once at creation.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _signature() -> tuple[int, int, int] | None:
    """The identity of the database file: device, inode, size."""
    try:
        info = DB_PATH.stat()
    except OSError:
        return None
    return (info.st_dev, info.st_ino, info.st_size)


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn: sqlite3.Connection) -> list[str]:
    """Add anything an older database is missing. Never drops, never rewrites.

    `ALTER TABLE ... ADD COLUMN` is the only structural change made here, and
    only for columns that are genuinely absent, so running this against an
    existing archive adds what is new and leaves every row untouched.

    Three things happen, and they are ordered deliberately:

      1. the columns an older table is missing are added;
      2. the space model is introduced and every existing row is adopted into
         the one space this archive has always been;
      3. the old global "one owner, one partner" rule is retired, because the
         same rule now belongs to a space rather than to the whole database.

    Steps 2 and 3 are both idempotent — running this on every startup must
    change nothing after the first time.
    """
    added = []

    # 1. Columns that were added to a table after the fact.
    if _table_exists(conn, "memories"):
        present = _columns(conn, "memories")
        for name, kind in MEMORIES_COLUMNS:
            if name not in present:
                conn.execute(f"ALTER TABLE memories ADD COLUMN {name} {kind}")
                added.append(f"memories.{name}")

    if _table_exists(conn, "invite_tokens"):
        present = _columns(conn, "invite_tokens")
        for name, kind in INVITE_COLUMNS:
            if name not in present:
                conn.execute(f"ALTER TABLE invite_tokens ADD COLUMN {name} {kind}")
                added.append(f"invite_tokens.{name}")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_invites_code ON invite_tokens(code_hash)"
        )

    for table, name, kind in SPACE_COLUMNS:
        if not _table_exists(conn, table):
            continue
        if name in _columns(conn, table):
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
        added.append(f"{table}.{name}")

    # The private archive's session state. Same additive rule as everything
    # else: a column that is genuinely missing is added, and an existing one is
    # left exactly as it is.
    if _table_exists(conn, "sessions"):
        present = _columns(conn, "sessions")
        for name, kind in PRIVACY_SESSION_COLUMNS:
            if name not in present:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {name} {kind}")
                added.append(f"sessions.{name}")

    # Privacy is read on every ordinary memory query, so the filter is indexed.
    if _table_exists(conn, "memories"):
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memories_privacy"
            " ON memories(space_id, privacy_mode)"
        )

    # 2. The space tables need a new shape before anything else can be true of
    #    them, so they are rebuilt first.
    _rebuild_space_tables(conn)
    _add_session_space_column(conn)

    # 3. Adopt everything that already exists into its space.
    _migrate_into_spaces(conn)

    # 3b. Every memory must have an owner before a private memory can mean
    #     anything, so a historical row with no creator is repaired here.
    _backfill_memory_owners(conn)

    # 4. Move the editor limit from the database to the space.
    _retire_global_editor_limit(conn)

    return added


def _backfill_memory_owners(conn: sqlite3.Connection) -> None:
    """Give a memory with no owner the space's own creator.

    Before the private archive, `created_by_user_id` was attribution — worth
    having, but nothing depended on it. Ownership does now: it is the whole of a
    private memory's permission, so a NULL would mean a memory nobody can ever
    open.

    Conservative on purpose:

      · only a NULL or dangling creator is touched, and only when the memory has
        a space with exactly one active creator — an ambiguous archive is
        reported, not guessed at;
      · a memory whose space has no active creator is left alone and named in
        the report, so the problem is visible rather than silently "fixed" by
        assigning it to somebody who never made it;
      · running it twice writes nothing the second time.
    """
    if not _table_exists(conn, "memories") or not _table_exists(conn, "space_members"):
        return

    rows = conn.execute(
        """
        SELECT m.id, m.space_id
          FROM memories m
          LEFT JOIN users u ON u.id = m.created_by_user_id
         WHERE m.created_by_user_id IS NULL OR u.id IS NULL
         ORDER BY m.id
        """
    ).fetchall()
    if not rows:
        return

    adopted, unowned = 0, []
    for row in rows:
        if row["space_id"] is None:
            unowned.append(int(row["id"]))
            continue
        creators = conn.execute(
            "SELECT user_id FROM space_members WHERE space_id = ?"
            " AND member_role = 'creator' AND left_at IS NULL",
            (row["space_id"],),
        ).fetchall()
        if len(creators) != 1:
            unowned.append(int(row["id"]))
            continue
        conn.execute("UPDATE memories SET created_by_user_id = ? WHERE id = ?",
                     (int(creators[0]["user_id"]), int(row["id"])))
        adopted += 1

    if adopted:
        print(f"[db] backfilled the owner of {adopted} memory/memories from the"
              f" space's creator", flush=True)
    if unowned:
        print(f"[db] {len(unowned)} memory/memories still have no owner (no single"
              f" active creator to attribute them to): {unowned}", flush=True)


# --- the space model --------------------------------------------------------

# Activity that belongs to a space's shared history, as opposed to something
# that happened to an account. Kept as a list rather than a rule like "not
# owner_created", so a new account-level event is NULL by default instead of
# being quietly filed under a space.
SPACE_ACTIVITY_TYPES = (
    "memory_created", "memory_updated", "memory_deleted",
    "partner_invited", "partner_joined", "partner_invite_revoked",
    "plan_created", "plan_updated", "plan_deleted",
    "anniversary_created", "anniversary_updated", "anniversary_deleted",
)


def _active_users(conn: sqlite3.Connection, role: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM users WHERE role = ? AND is_active = 1 ORDER BY id", (role,)
    ).fetchall()


def _migrate_into_spaces(conn: sqlite3.Connection) -> None:
    """Give the existing archive the one space it has always implicitly been.

    Before this, the whole database WAS the space: everybody with an account
    shared one set of memories. That is now written down explicitly, so the
    second space can exist later without anything having to be untangled.

    Deliberately conservative. It never guesses:

      · a space is created only when there is none, and only when there is
        somebody to belong to it;
      · a membership is created only for a role held by exactly one active
        account — an archive with two owners is reported, not resolved;
      · a row is backfilled only when its `space_id` is still NULL, so running
        this a second time writes nothing at all.
    """
    if not _table_exists(conn, "spaces") or not _table_exists(conn, "space_members"):
        return

    existing_spaces = conn.execute("SELECT COUNT(*) FROM spaces").fetchone()[0]
    users = conn.execute("SELECT * FROM users ORDER BY id").fetchall()

    if not users:
        # A genuinely empty archive. There is nothing to migrate, and inventing
        # a space with nobody in it would only have to be cleaned up later.
        return

    already_migrated = bool(existing_spaces) and bool(conn.execute(
        "SELECT COUNT(*) FROM space_members WHERE left_at IS NULL"
    ).fetchone()[0])

    if already_migrated:
        # The archive has been through this before. Everything below is
        # idempotent, so it runs again and writes nothing: the space is named,
        # any missing personal space is created, any unadopted row is adopted.
        _name_the_legacy_space(conn)
        _ensure_personal_spaces(conn)
        _backfill_space_ids(conn, _oldest_active_space_id(conn))
        _backfill_session_spaces(conn)
        return

    owners = _active_users(conn, "owner")
    partners = _active_users(conn, "partner")

    anomalies = []
    if len(owners) > 1:
        anomalies.append(
            f"{len(owners)} active owners: {', '.join(u['username'] for u in owners)}"
        )
    if len(partners) > 1:
        anomalies.append(
            f"{len(partners)} active partners: {', '.join(u['username'] for u in partners)}"
        )

    if anomalies:
        # The data is unambiguous — all of it belongs to the one space — but
        # WHO belongs to it is not. So the data is adopted and the memberships
        # are left for a person to decide.
        print("[db] SPACE MIGRATION ANOMALY — this archive needs a decision:",
              flush=True)
        for line in anomalies:
            print(f"[db]   {line}", flush=True)
        print("[db]   The space was created and all data was adopted, but no"
              " membership was written. Resolve the accounts above and restart.",
              flush=True)

    creator = owners[0] if len(owners) == 1 else (users[0] if not owners else None)

    space_id = existing_spaces and _oldest_active_space_id(conn) or None
    if space_id is None:
        cursor = conn.execute(
            "INSERT INTO spaces (created_by_user_id, status, created_at)"
            " VALUES (?, 'active', ?)",
            (creator["id"] if creator is not None else None, _now()),
        )
        space_id = int(cursor.lastrowid)
        print(f"[db] created the existing space (id {space_id}) from this archive",
              flush=True)

    if not anomalies:
        joined = {
            "creator": owners[0]["id"] if len(owners) == 1 else None,
            "member": partners[0]["id"] if len(partners) == 1 else None,
        }
        for role, user_id in joined.items():
            if user_id is None:
                continue
            already = conn.execute(
                "SELECT 1 FROM space_members WHERE user_id = ? AND left_at IS NULL",
                (user_id,),
            ).fetchone()
            if already is not None:
                continue
            conn.execute(
                "INSERT INTO space_members (space_id, user_id, member_role, joined_at)"
                " VALUES (?, ?, ?, ?)",
                (space_id, user_id, role, _now()),
            )
            print(f"[db] space {space_id}: user {user_id} joined as {role}",
                  flush=True)

    _name_the_legacy_space(conn)
    _ensure_personal_spaces(conn)
    _backfill_space_ids(conn, space_id)
    _backfill_session_spaces(conn)


def _rebuild_space_tables(conn: sqlite3.Connection) -> None:
    """Give `spaces` and `space_members` their new shape, keeping every row.

    SQLite cannot alter a CHECK constraint, so the two tables have to be
    rebuilt. That is the one operation in this project that comes near losing
    data, and it is done the way SQLite documents it, with the safety rails
    that matter:

      · FOREIGN KEYS ARE OFF for the duration. This is not a detail: `spaces`
        is the parent of `space_members` with ON DELETE CASCADE, so dropping it
        with enforcement on would silently delete every membership in the
        archive. Turning them off and back on is what makes the rebuild safe.
      · ONE TRANSACTION. A failure at any point rolls the whole thing back and
        leaves the original tables exactly as they were.
      · ROW IDS AND EVERY COLUMN ARE COPIED, not regenerated.
      · THE COPY IS COUNTED before the originals are dropped. If the new table
        does not hold exactly what the old one did, the transaction is abandoned.
      · `PRAGMA foreign_key_check` afterwards, so a broken reference is loud.

    Idempotent: it looks at the stored schema and does nothing if the tables
    are already the new shape.
    """
    if not (_table_exists(conn, "spaces") and _table_exists(conn, "space_members")):
        return

    ddl = " ".join(
        (row["sql"] or "")
        for row in conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN"
            " ('spaces', 'space_members')"
        )
    )
    if "space_type" in ddl and "'admin'" in ddl:
        return                                    # already the new shape

    before = _space_row_counts(conn)

    # PRAGMA foreign_keys is a no-op inside a transaction, and the connection's
    # own transaction handling would fight an explicit BEGIN — so both are
    # taken over here and handed back afterwards.
    isolation = conn.isolation_level
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")

        conn.execute("""
            CREATE TABLE spaces_new (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT    NOT NULL DEFAULT '',
                space_type          TEXT    NOT NULL DEFAULT 'group'
                                    CHECK (space_type IN ('personal', 'group')),
                created_by_user_id  INTEGER,
                status              TEXT    NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'archived')),
                created_at          TEXT    NOT NULL,
                archived_at         TEXT,
                FOREIGN KEY (created_by_user_id) REFERENCES users(id)
            )
        """)
        conn.execute("""
            INSERT INTO spaces_new
                (id, name, space_type, created_by_user_id, status, created_at, archived_at)
            SELECT id, '', 'group', created_by_user_id, status, created_at, archived_at
              FROM spaces
        """)

        conn.execute("""
            CREATE TABLE space_members_new (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                space_id     INTEGER NOT NULL,
                user_id      INTEGER NOT NULL,
                member_role  TEXT    NOT NULL CHECK (member_role IN ('creator', 'admin', 'member')),
                joined_at    TEXT    NOT NULL,
                left_at      TEXT,
                FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
            )
        """)
        conn.execute("""
            INSERT INTO space_members_new
                (id, space_id, user_id, member_role, joined_at, left_at)
            SELECT id, space_id, user_id, member_role, joined_at, left_at
              FROM space_members
        """)

        after = _space_row_counts(conn, suffix="_new")
        if before != after:
            raise RuntimeError(
                f"space migration refused: before {before}, after {after}"
            )

        conn.execute("DROP TABLE space_members")
        conn.execute("DROP TABLE spaces")
        conn.execute("ALTER TABLE spaces_new RENAME TO spaces")
        conn.execute("ALTER TABLE space_members_new RENAME TO space_members")

        conn.execute("CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_space_members_user  ON space_members(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_spaces_status       ON spaces(status)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_active_pair"
                     " ON space_members(space_id, user_id) WHERE left_at IS NULL")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_active_creator"
                     " ON space_members(space_id) WHERE member_role = 'creator' AND left_at IS NULL")

        conn.execute("COMMIT")

        # What THIS migration is answerable for: nobody left in a space that no
        # longer exists. That is checked and is fatal, because it would mean the
        # rebuild lost a parent.
        orphans = conn.execute(
            "SELECT COUNT(*) FROM space_members m"
            " WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = m.space_id)"
        ).fetchone()[0]
        if int(orphans):
            raise RuntimeError(
                f"space migration left {orphans} membership(s) without a space"
            )

        # Anything else the check finds was already there — a reference broken
        # by some earlier write, unrelated to spaces. Reported, not fatal: an
        # archive must not become unopenable because of damage it already had.
        broken = conn.execute("PRAGMA foreign_key_check").fetchall()
        if broken:
            print(f"[db] note: {len(broken)} pre-existing broken reference(s) in"
                  " this archive, unrelated to spaces:", flush=True)
            for row in broken[:5]:
                print(f"[db]   {row[0]} row {row[1]} -> {row[2]}", flush=True)

        print(f"[db] rebuilt spaces and space_members ({before[0]} spaces,"
              f" {before[1]} memberships preserved)", flush=True)
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.isolation_level = isolation


# The name the archive's original space is given when it has none. Every other
# space is named by whoever made it.
LEGACY_SPACE_NAME = "Our Space"
PERSONAL_SPACE_NAME = "My Space"


def _add_session_space_column(conn: sqlite3.Connection) -> None:
    """`sessions.current_space_id` — which space this sign-in is looking at.

    On the session rather than on the account, because the same person may be
    in Our Space on the laptop and My Space on the phone, and both are right.
    """
    if not _table_exists(conn, "sessions"):
        return
    if "current_space_id" in _columns(conn, "sessions"):
        return
    conn.execute("ALTER TABLE sessions ADD COLUMN current_space_id INTEGER")


def _name_the_legacy_space(conn: sqlite3.Connection) -> None:
    """Name the archive's original space, without ever overwriting a name."""
    conn.execute(
        "UPDATE spaces SET space_type = 'group' WHERE space_type = '' OR space_type IS NULL"
    )
    named = conn.execute(
        "UPDATE spaces SET name = ? WHERE (name IS NULL OR name = '')"
        " AND id = (SELECT id FROM spaces ORDER BY id LIMIT 1)",
        (LEGACY_SPACE_NAME,),
    ).rowcount
    if named:
        print(f"[db] named the existing space \"{LEGACY_SPACE_NAME}\"", flush=True)


def personal_space_for_user(user_id: int) -> sqlite3.Row | None:
    """The one personal space this account owns, if it has been created."""
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            """
            SELECT s.* FROM spaces s
              JOIN space_members m ON m.space_id = s.id
             WHERE m.user_id = ? AND m.left_at IS NULL
               AND s.space_type = 'personal' AND s.status = 'active'
             ORDER BY s.id LIMIT 1
            """,
            (user_id,),
        ).fetchone()


def personal_space_id(conn: sqlite3.Connection, user_id: int) -> int | None:
    """This account's personal space, if it has one."""
    row = conn.execute(
        """
        SELECT s.id FROM spaces s
          JOIN space_members m ON m.space_id = s.id
         WHERE m.user_id = ? AND m.left_at IS NULL
           AND s.space_type = 'personal' AND s.status = 'active'
         LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    return int(row["id"]) if row is not None else None


def open_personal_space(conn: sqlite3.Connection, user_id: int) -> tuple[int, bool]:
    """Open the personal space an account gets, once. Returns (id, created).

    Idempotent: an account that already has one keeps it, and nothing here can
    make a second — enforced by this check and reported by the second half of
    the return value, so a caller can tell "made one" from "already had one"
    and say so honestly.
    """
    existing = personal_space_id(conn, user_id)
    if existing is not None:
        return existing, False

    cursor = conn.execute(
        "INSERT INTO spaces (name, space_type, created_by_user_id, status, created_at)"
        " VALUES (?, 'personal', ?, 'active', ?)",
        (PERSONAL_SPACE_NAME, user_id, _now()),
    )
    space_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO space_members (space_id, user_id, member_role, joined_at)"
        " VALUES (?, ?, 'creator', ?)",
        (space_id, user_id, _now()),
    )
    return space_id, True


def _ensure_personal_spaces(conn: sqlite3.Connection) -> None:
    """Every account has a space of its own. Existing content is left where it is."""
    created = 0
    for user in conn.execute("SELECT id FROM users WHERE is_active = 1 ORDER BY id"):
        _space_id, made = open_personal_space(conn, int(user["id"]))
        if made:
            created += 1
    if created:
        print(f"[db] opened {created} personal space(s)", flush=True)


def _backfill_session_spaces(conn: sqlite3.Connection) -> None:
    """A sign-in that predates spaces opens on the archive's original space.

    Not on the personal one: somebody who has been using this archive for
    months should not refresh into an empty room. Only sessions with no space
    at all are touched.
    """
    if not _table_exists(conn, "sessions"):
        return
    if "current_space_id" not in _columns(conn, "sessions"):
        return

    sessions = conn.execute(
        "SELECT id, user_id FROM sessions WHERE current_space_id IS NULL"
    ).fetchall()
    for session in sessions:
        space_id = _preferred_space_for_user(conn, int(session["user_id"]))
        if space_id is None:
            continue
        conn.execute(
            "UPDATE sessions SET current_space_id = ? WHERE id = ?",
            (space_id, session["id"]),
        )
    if sessions:
        print(f"[db] pointed {len(sessions)} existing session(s) at their space",
              flush=True)


def _preferred_space_for_user(conn: sqlite3.Connection, user_id: int) -> int | None:
    """The space a person should land in: the shared one they were already in,
    or failing that their own."""
    row = conn.execute(
        """
        SELECT s.id FROM spaces s
          JOIN space_members m ON m.space_id = s.id
         WHERE m.user_id = ? AND m.left_at IS NULL AND s.status = 'active'
           AND s.space_type = 'group'
         ORDER BY s.id LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    if row is not None:
        return int(row["id"])

    row = conn.execute(
        """
        SELECT s.id FROM spaces s
          JOIN space_members m ON m.space_id = s.id
         WHERE m.user_id = ? AND m.left_at IS NULL AND s.status = 'active'
         ORDER BY s.id LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    return int(row["id"]) if row is not None else None


def _space_row_counts(conn: sqlite3.Connection, suffix: str = "") -> tuple[int, int]:
    spaces = conn.execute(f"SELECT COUNT(*) FROM spaces{suffix}").fetchone()[0]
    members = conn.execute(f"SELECT COUNT(*) FROM space_members{suffix}").fetchone()[0]
    return int(spaces), int(members)


def _oldest_active_space_id(conn: sqlite3.Connection) -> int | None:
    """The space this archive has always been.

    Used for one thing only: adopting rows that predate spaces, and the
    temporary guest read while the Hub is still public. It is never how a
    signed-in person's space is decided — that is always their membership.
    """
    row = conn.execute(
        "SELECT id FROM spaces WHERE status = 'active' ORDER BY id LIMIT 1"
    ).fetchone()
    return int(row["id"]) if row is not None else None


def _backfill_space_ids(conn: sqlite3.Connection, space_id: int | None) -> None:
    """Adopt every row that does not yet belong to a space.

    Only rows whose `space_id` is NULL are touched, so this is safe to run on
    every startup: after the first time it updates nothing. Rows that are
    already owned are never reassigned.
    """
    if space_id is None:
        return

    for table, name, _kind in SPACE_COLUMNS:
        if not _table_exists(conn, table) or name not in _columns(conn, table):
            continue

        where = f"{name} IS NULL"
        params: tuple[Any, ...] = (space_id,)
        if table == "activities":
            # Account-level events have no space to belong to. Everything else
            # is part of the shared history.
            marks = ",".join("?" * len(SPACE_ACTIVITY_TYPES))
            where += f" AND action_type IN ({marks})"
            params = (space_id, *SPACE_ACTIVITY_TYPES)

        cursor = conn.execute(
            f"UPDATE {table} SET {name} = ? WHERE {where}", params
        )
        if cursor.rowcount:
            print(f"[db] adopted {cursor.rowcount} row(s) of {table} into"
                  f" space {space_id}", flush=True)


def _retire_global_editor_limit(conn: sqlite3.Connection) -> None:
    """Move "one owner, one partner" from the database to the space.

    These two indexes were right while the whole database was one space, and
    they are wrong the moment a second space exists: two spaces each need their
    own owner. The rule has not been dropped, it has moved — `space_members`
    carries the equivalent partial unique indexes per space, so a space still
    cannot hold two creators or two members.

    Dropping an index removes no row.
    """
    if not _table_exists(conn, "users"):
        return

    for role in ("owner", "partner"):
        name = f"idx_users_single_{role}"
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)
        ).fetchone() is None:
            continue
        conn.execute(f"DROP INDEX {name}")
        print(f"[db] retired {name}: the editor limit now belongs to a space",
              flush=True)


# Cached so the check below costs one stat() call instead of a query.
_schema_signature: tuple[int, int, int] | None = None
_schema_ready = False


def init_db() -> None:
    """Create the database file, the tables and the upload directory.

    Idempotent and NON-DESTRUCTIVE: only `CREATE ... IF NOT EXISTS` runs, so
    calling it on an existing archive adds whatever is missing and changes
    nothing that is already there. It never drops, deletes or truncates.
    """
    global _schema_signature, _schema_ready

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    conn = connect()
    try:
        conn.executescript(SCHEMA)
        added = _migrate(conn)
        if added:
            print(f"[db] migrated memories: added {', '.join(added)}", flush=True)
        conn.commit()                     # explicit: never rely on the caller

        missing = [t for t in REQUIRED_TABLES if not _table_exists(conn, t)]
        if missing:
            raise RuntimeError(
                f"the archive at {DB_PATH} is missing {', '.join(missing)} "
                "after initialisation"
            )
    finally:
        conn.close()

    _schema_signature = _signature()
    _schema_ready = True


def ensure_schema() -> None:
    """Make sure the schema is present before any read or write.

    Normally this is a single `stat()` and returns. It re-runs the (safe,
    additive) initialisation when the file underneath has changed — which is
    what happens if the database is deleted, replaced, or truncated while the
    server is running. Without this, a running process keeps talking to a file
    that no longer has any tables and every request fails with
    "no such table: memories", which is exactly the fault this guards against.
    """
    signature = _signature()

    if (_schema_ready
            and signature is not None
            and signature == _schema_signature
            and signature[2] > 0):
        return

    init_db()


def schema_status() -> dict[str, Any]:
    """Which tables exist right now. For the startup log and the health route.

    Never includes any memory content — only structure.
    """
    if not DB_PATH.exists():
        return {"path": str(DB_PATH), "ready": False, "tables": []}

    conn = connect()
    try:
        tables = [
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
    finally:
        conn.close()

    return {
        "path": str(DB_PATH),
        "ready": all(t in tables for t in REQUIRED_TABLES),
        "tables": tables,
    }


# --- serialisation -----------------------------------------------------------

def _as_bool(value: Any) -> bool:
    return bool(value)


def _who(row: sqlite3.Row, prefix: str) -> dict[str, Any] | None:
    """The display identity of whoever touched a memory. Never a username, an
    email or anything from the account's private side."""
    if row[f"{prefix}_id"] is None:
        return None
    return {
        "id": row[f"{prefix}_id"],
        "displayName": row[f"{prefix}_name"] or "",
        "role": row[f"{prefix}_role"] or "",
    }


def _row_to_memory(row: sqlite3.Row, photos: list[dict[str, Any]]) -> dict[str, Any]:
    """The JSON shape the front-end reads: location and weather nested."""
    return {
        "id": row["id"],
        "title": row["title"],
        "date": row["date"],
        "time": row["time"] or "",
        "location": {
            "country": row["country"] or "",
            "city": row["city"] or "",
            "placeName": row["place_name"] or "",
            "latitude": row["latitude"],
            "longitude": row["longitude"],
        },
        "weather": {
            "condition": row["weather"] or "",
            "temperature": row["temperature"],
        },
        "mood": row["mood"] or "",
        "description": row["description"] or "",
        "favorite": _as_bool(row["favorite"]),
        "showOnTimeline": _as_bool(row["show_on_timeline"]),
        # "standard" or "private". Only the private archive ever returns a
        # private memory, but the field is on every memory so a client never has
        # to infer it from which endpoint answered.
        "privacyMode": (row["privacy_mode"] if "privacy_mode" in row.keys()
                        and row["privacy_mode"] else "standard"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"] if "updated_at" in row.keys() else None,
        "createdBy": _who(row, "creator"),
        "updatedBy": _who(row, "editor"),
        "photos": photos,
    }


def _photo_url(filename: str) -> str:
    """A path the browser can load, relative to the server root."""
    return f"/uploads/{filename}"


def _row_to_photo(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "url": _photo_url(row["filename"]),
        "originalName": row["original_name"] or "",
        "order": row["sort_order"],
        "isCover": _as_bool(row["is_cover"]),
    }


def photo_for_media(filename: str) -> dict[str, Any] | None:
    """Everything the media route needs to decide about one file.

    One query, by the stored filename — never by building a path from what the
    URL said. The row is the authority on whether a file may be served, which is
    also what makes a path traversal impossible: a name that is not in the
    database has no row, and a name that is in the database is one this server
    wrote there.

    Returns None when the file is not part of any memory. A memory with no space
    is returned with `spaceId: None`, and the route refuses it: a memory that
    belongs to nobody cannot be shown to somebody.
    """
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT p.id AS photo_id, p.filename, p.memory_id,
                   m.space_id, m.privacy_mode, m.created_by_user_id
              FROM photos p
              JOIN memories m ON m.id = p.memory_id
             WHERE p.filename = ?
             LIMIT 1
            """,
            (filename,),
        ).fetchone()
    if row is None:
        return None
    return {
        "photoId": row["photo_id"],
        "filename": row["filename"],
        "memoryId": row["memory_id"],
        "spaceId": row["space_id"],
        "privacyMode": row["privacy_mode"] or STANDARD,
        "ownerId": row["created_by_user_id"],
    }


# --- queries -----------------------------------------------------------------

# The two words the whole private archive is built on. `standard` is what a
# memory is unless somebody says otherwise, and it is the DEFAULT OF EVERY
# ORDINARY QUERY below — a new surface that forgets to ask is safe by accident,
# which is the only kind of safety that survives contact with new code.
STANDARD = "standard"
PRIVATE = "private"


def _privacy_guard(alias: str, privacy: str | None) -> tuple[str, tuple[Any, ...]]:
    """`AND privacy_mode = ?` for an ordinary read, and nothing for an internal
    one. `None` means "either kind" and is used only where the caller has
    already established the right to see what it is asking for."""
    if privacy is None:
        return "", ()
    if privacy not in (STANDARD, PRIVATE):
        raise ValueError(f"unknown privacy mode: {privacy}")
    return f" AND {alias}.privacy_mode = ?", (privacy,)


def list_memories(space_id: int | None = None, privacy: str | None = STANDARD,
                  user_id: int | None = None) -> list[dict[str, Any]]:
    """The memories of one space, newest first, each with its photographs.

    `space_id` is how a signed-in person's archive is kept separate from
    anybody else's. It is None in one case only — an archive that has no space
    at all yet.

    `privacy` is `standard` by default, which is the rule and not a
    convenience: the ordinary archive — Moments, the Timeline, Our World, the
    Gallery, every count — is fed by this function, and none of those may ever
    contain a private memory. The private archive lists its own, through
    list_private_memories(), which is the only caller that passes `private` and
    the only one that has to prove who is asking.
    """
    ensure_schema()
    guard, params = _privacy_guard("m", privacy)
    sql = MEMORY_SELECT + " WHERE 1 = 1" + guard
    if space_id is not None:
        sql += " AND m.space_id = ?"
        params = params + (space_id,)
    sql += " ORDER BY m.date DESC, m.id DESC"

    with connect() as conn:
        memories = conn.execute(sql, params).fetchall()

        if not memories:
            return []

        ids = [m["id"] for m in memories]
        placeholders = ",".join("?" * len(ids))
        photo_rows = conn.execute(
            f"SELECT * FROM photos WHERE memory_id IN ({placeholders}) "
            "ORDER BY memory_id, sort_order, id",
            ids,
        ).fetchall()

    by_memory: dict[int, list[dict[str, Any]]] = {}
    for row in photo_rows:
        by_memory.setdefault(row["memory_id"], []).append(_row_to_photo(row))

    return [_row_to_memory(m, by_memory.get(m["id"], [])) for m in memories]


def _space_guard(table: str, row_id: int, space_id: int | None) -> tuple[str, tuple[Any, ...]]:
    """`AND space_id = ?` for a statement that already has `WHERE id = ?`.

    One helper, so no mutation can forget the check. When no space is given the
    guard is empty — that is the migration path and the documented temporary
    guest read, never a signed-in request.
    """
    if space_id is None:
        return "", ()
    return f" AND {table}.space_id = ?", (space_id,)


def get_memory(memory_id: int, space_id: int | None = None,
               privacy: str | None = STANDARD) -> dict[str, Any] | None:
    """One memory. With a space given, a memory in another space is simply not
    found — it does not exist as far as this caller is concerned.

    `privacy` defaults to `standard`, which is what makes the ordinary single
    memory endpoint safe: a private memory is not found there even by the person
    who owns it, because the ordinary content layer is not a way into the
    private archive. `None` means "either kind", and is passed only by the
    private archive's own reads and by the internal read-back after a write.
    """
    ensure_schema()
    guard, params = _privacy_guard("m", privacy)
    sql = MEMORY_SELECT + " WHERE m.id = ?" + guard
    values: tuple[Any, ...] = (memory_id,) + params
    if space_id is not None:
        sql += " AND m.space_id = ?"
        values = values + (space_id,)

    with connect() as conn:
        row = conn.execute(sql, values).fetchone()
        if row is None:
            return None
        photos = conn.execute(
            "SELECT * FROM photos WHERE memory_id = ? ORDER BY sort_order, id",
            (memory_id,),
        ).fetchall()
    return _row_to_memory(row, [_row_to_photo(p) for p in photos])


def get_private_memory(memory_id: int, space_id: int, user_id: int) -> dict[str, Any] | None:
    """One private memory, if this account may see it at all.

    Returns None — which every caller turns into 404 — when the memory is not in
    this space, is not private, or is private and this account is neither the
    owner nor named in its ACL. Note what is NOT here: whether the private
    archive is unlocked. That is the session's business, and it is checked after
    this, so that somebody with no access learns nothing even by asking while
    locked.
    """
    memory = get_memory(memory_id, space_id, privacy=PRIVATE)
    if memory is None:
        return None
    permission = private_memory_permission(memory_id, user_id)
    if permission == "none":
        return None
    return _with_private_permission(memory, memory_id, user_id, permission)


def create_memory(
    metadata: dict[str, Any],
    saved: Iterable[dict[str, Any]],
    actor_user_id: int | None = None,
    space_id: int | None = None,
    privacy_mode: str = STANDARD,
    access: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Insert one memory and its photographs in a single transaction.

    `saved` describes files that are ALREADY on disk (see main.py, which writes
    them first so a write failure can never leave a memory without its
    photographs). If the transaction fails, the caller removes those files.

    `access` is the private ACL to write alongside it, and is only meaningful
    when `privacy_mode` is private. It is validated by the caller (targets must
    be active members of this space) and normalised by the store: the owner is
    removed from it, because the owner is implicit and always has been.

    Returns the created memory exactly as GET would.
    """
    ensure_schema()
    if privacy_mode not in (STANDARD, PRIVATE):
        raise ValueError(f"unknown privacy mode: {privacy_mode}")

    photos = list(saved)
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with connect() as conn:          # commits on success, rolls back on raise
        cursor = conn.execute(
            """
            INSERT INTO memories (
                title, date, time, country, city, place_name,
                latitude, longitude, weather, temperature, mood,
                description, favorite, show_on_timeline, created_at,
                created_by_user_id, space_id, privacy_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                metadata["title"],
                metadata["date"],
                metadata.get("time") or "",
                metadata.get("country") or "",
                metadata.get("city") or "",
                metadata.get("place_name") or "",
                metadata.get("latitude"),
                metadata.get("longitude"),
                metadata.get("weather") or "",
                metadata.get("temperature"),
                metadata.get("mood") or "",
                metadata.get("description") or "",
                1 if metadata.get("favorite") else 0,
                1 if metadata.get("show_on_timeline") else 0,
                created_at,
                actor_user_id,
                space_id,
                privacy_mode,
            ),
        )
        memory_id = int(cursor.lastrowid)

        conn.executemany(
            """
            INSERT INTO photos (memory_id, filename, original_name, sort_order, is_cover)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    memory_id,
                    photo["filename"],
                    photo.get("original_name") or "",
                    index,
                    1 if index == photo.get("cover_index", 0) else 0,
                )
                for index, photo in enumerate(photos)
            ],
        )

        if privacy_mode == PRIVATE and access:
            _write_private_access(conn, memory_id, access, int(actor_user_id or 0))

        # The event log is written by the same transaction as the memory, so a
        # memory can never exist without the record of it being made.
        #
        # A private memory writes NO activity and NO notification. The archive's
        # shared history is shared: an entry saying "a memory was added" is
        # already too much when the memory itself is not in anybody else's
        # archive, and a title in a log is worse.
        if privacy_mode == STANDARD:
            _insert_activity(
                conn, actor_user_id, "memory_created", memory_id, created_at,
                {"title": metadata["title"], "photos": len(photos)},
                space_id=space_id,
            )

    created = get_memory(memory_id, privacy=None)
    assert created is not None
    return created


def count_memories(space_id: int | None = None,
                   privacy: str | None = STANDARD) -> int:
    """How many memories there are. Standard by default, for the same reason
    everything else is: a count is a discovery surface, and "3" next to a space
    that holds 5 would be the private archive announcing itself."""
    ensure_schema()
    guard, params = _privacy_guard("m", privacy)
    sql = "SELECT COUNT(*) FROM memories m WHERE 1 = 1" + guard
    if space_id is not None:
        sql += " AND m.space_id = ?"
        params = params + (space_id,)
    with connect() as conn:
        return int(conn.execute(sql, params).fetchone()[0])


# ===========================================================================
# The private archive
#
# Four questions, asked in one place each, so no endpoint has to work out for
# itself who may see what:
#
#   private_memory_permission()   who is this, for THIS memory
#   list_private_memories()       what may they see in this space
#   replace_private_memory_access()  who else may see it
#   the credential and unlock helpers at the end of this section
#
# The rule underneath all of them: a private memory is visible to its owner and
# to the people the owner named, and to nobody else. Not to the space's creator,
# not to an admin, not because somebody is in the same group. Group management
# and private permission are two different questions with two different answers,
# and this section answers only the second one.
# ===========================================================================

PRIVATE_PERMISSIONS = ("owner", "editor", "viewer")
GRANTABLE_PERMISSIONS = ("viewer", "editor")


def _private_access_rows(conn: sqlite3.Connection, memory_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT a.user_id, a.permission, a.granted_by_user_id,
               a.created_at, a.updated_at, u.display_name
          FROM memory_private_access a
          LEFT JOIN users u ON u.id = a.user_id
         WHERE a.memory_id = ?
         ORDER BY a.id
        """,
        (memory_id,),
    ).fetchall()
    return [
        {
            "userId": row["user_id"],
            "displayName": row["display_name"] or "",
            "permission": row["permission"],
            "grantedByUserId": row["granted_by_user_id"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def private_access_for_memory(memory_id: int) -> list[dict[str, Any]]:
    """The ACL of one memory, as the OWNER sees it. Nobody else is given this:
    a viewer does not learn who else was trusted with the same memory."""
    ensure_schema()
    with connect() as conn:
        return _private_access_rows(conn, memory_id)


def _with_private_permission(memory: dict[str, Any], memory_id: int, user_id: int,
                             permission: str) -> dict[str, Any]:
    """The private shape of a memory: its permission, and its ACL only for the
    owner — who needs it to edit the list, and is the only person entitled to
    see who else can read it."""
    memory["privacyMode"] = PRIVATE
    memory["privatePermission"] = permission
    if permission == "owner":
        memory["privateAccess"] = private_access_for_memory(memory_id)
    return memory


def private_memory_permission(memory_id: int, user_id: int | None) -> str:
    """owner, editor, viewer or none — the whole of a private memory's ACL.

    One query, and the owner is decided first: an ACL row naming the owner is
    ignored rather than believed, because ownership is not something a table may
    contradict.
    """
    ensure_schema()
    if user_id is None:
        return "none"
    with connect() as conn:
        row = conn.execute(
            """
            SELECT m.created_by_user_id, m.privacy_mode, a.permission AS granted
              FROM memories m
              LEFT JOIN memory_private_access a
                     ON a.memory_id = m.id AND a.user_id = ?
             WHERE m.id = ?
            """,
            (int(user_id), memory_id),
        ).fetchone()

    if row is None or row["privacy_mode"] != PRIVATE:
        return "none"
    if row["created_by_user_id"] is not None and int(row["created_by_user_id"]) == int(user_id):
        return "owner"
    return row["granted"] if row["granted"] in GRANTABLE_PERMISSIONS else "none"


def is_private_memory_owner(memory_id: int, user_id: int | None) -> bool:
    return private_memory_permission(memory_id, user_id) == "owner"


def can_view_private_memory(memory_id: int, user_id: int | None) -> bool:
    return private_memory_permission(memory_id, user_id) in PRIVATE_PERMISSIONS


def can_edit_private_memory(memory_id: int, user_id: int | None) -> bool:
    """The memory's ordinary content only. An editor may change what the memory
    says; never who may see it."""
    return private_memory_permission(memory_id, user_id) in ("owner", "editor")


def memory_owner_id(memory_id: int) -> int | None:
    ensure_schema()
    with connect() as conn:
        row = conn.execute("SELECT created_by_user_id FROM memories WHERE id = ?",
                           (memory_id,)).fetchone()
    return int(row["created_by_user_id"]) if row and row["created_by_user_id"] else None


def list_private_memories(space_id: int, user_id: int) -> list[dict[str, Any]]:
    """The private memories of THIS space that this account may see.

    The current space, deliberately: the private archive shows what belongs
    where the person is standing, exactly as the ordinary archive does. Somebody
    in three groups does not get all three at once.

    Membership of the space is NOT asked here — the caller has already resolved
    the session's space and verified membership of it. What is asked is the only
    question this layer owns: owner, named, or nobody.
    """
    ensure_schema()
    memories = list_memories(space_id, privacy=PRIVATE)
    visible: list[dict[str, Any]] = []
    for memory in memories:
        permission = private_memory_permission(int(memory["id"]), user_id)
        if permission == "none":
            continue
        visible.append(_with_private_permission(memory, int(memory["id"]), user_id,
                                                permission))
    return visible


def memory_privacy(memory_id: int, space_id: int | None = None) -> str | None:
    """The memory's privacy mode, or None when it is not this space's memory."""
    ensure_schema()
    sql = "SELECT privacy_mode FROM memories WHERE id = ?"
    params: tuple[Any, ...] = (memory_id,)
    if space_id is not None:
        sql += " AND space_id = ?"
        params = params + (space_id,)
    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return row["privacy_mode"] if row else None


def set_memory_privacy(memory_id: int, privacy: str, space_id: int | None = None,
                       actor_user_id: int | None = None) -> bool:
    """Change a memory between standard and private, in one transaction.

    Going private keeps the memory and leaves its ACL empty — "only me" is the
    safe default, and sharing is a separate, deliberate act.

    Going standard DELETES the ACL, because the list of people trusted with a
    memory stops meaning anything the moment the memory is no longer private;
    keeping it would leave a list that would silently come back into force if
    the memory were ever made private again.
    """
    if privacy not in (STANDARD, PRIVATE):
        raise ValueError(f"unknown privacy mode: {privacy}")
    ensure_schema()
    guard, guard_params = _space_guard("memories", memory_id, space_id)

    with connect() as conn:
        cursor = conn.execute(
            f"UPDATE memories SET privacy_mode = ?, updated_by_user_id = ?,"
            f" updated_at = ? WHERE id = ?{guard}",
            (privacy, actor_user_id, _now(), memory_id, *guard_params),
        )
        if cursor.rowcount == 0:
            return False
        if privacy == STANDARD:
            conn.execute("DELETE FROM memory_private_access WHERE memory_id = ?",
                         (memory_id,))
        # No activity, either way. A memory becoming private is not a thing the
        # space's history should record — the entry would say a memory exists
        # that nobody reading the history is allowed to know about.
    return True


def _write_private_access(conn: sqlite3.Connection, memory_id: int,
                          entries: list[dict[str, Any]],
                          granted_by_user_id: int) -> None:
    """Write the ACL rows for one memory. Runs inside the caller's transaction.

    A copy of the owner's own row is dropped rather than refused: the owner is
    implicit, so a request that names them is not an error, it is a request that
    already holds.
    """
    owner_id = conn.execute("SELECT created_by_user_id FROM memories WHERE id = ?",
                            (memory_id,)).fetchone()
    owner = int(owner_id["created_by_user_id"]) if owner_id and owner_id["created_by_user_id"] else None
    now = _now()
    for entry in entries:
        user_id = int(entry["userId"])
        if owner is not None and user_id == owner:
            continue
        conn.execute(
            """
            INSERT INTO memory_private_access
                (memory_id, user_id, permission, granted_by_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id, user_id) DO UPDATE SET
                permission = excluded.permission,
                granted_by_user_id = excluded.granted_by_user_id,
                updated_at = excluded.updated_at
            """,
            (memory_id, user_id, entry["permission"], granted_by_user_id, now, now),
        )


def normalize_private_access(entries: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Check the SHAPE of an access list, and refuse one that answers the same
    question twice.

    Two rows for one person — viewer and editor — is not a preference to be
    resolved but a request that does not know what it wants, and guessing would
    silently make somebody more powerful than the person meant.
    """
    normalized: list[dict[str, Any]] = []
    seen: set[int] = set()
    for entry in entries or []:
        if not isinstance(entry, dict):
            raise PrivacyRefused("invalid_access", "Each entry must be a person and a permission.")
        try:
            user_id = int(entry.get("userId"))
        except (TypeError, ValueError):
            raise PrivacyRefused("invalid_access", "Each entry must name a person.") from None
        permission = str(entry.get("permission") or "").strip().lower()
        if permission not in GRANTABLE_PERMISSIONS:
            raise PrivacyRefused("invalid_access",
                                 "A permission can only be viewer or editor.")
        if user_id in seen:
            raise PrivacyRefused("duplicate_user",
                                 "That list names the same person twice.")
        seen.add(user_id)
        normalized.append({"userId": user_id, "permission": permission})
    return normalized


def active_member_ids(space_id: int) -> set[int]:
    ensure_schema()
    with connect() as conn:
        return {
            int(row["user_id"]) for row in conn.execute(
                "SELECT user_id FROM space_members WHERE space_id = ?"
                " AND left_at IS NULL",
                (space_id,),
            )
        }


def replace_private_memory_access(memory_id: int, space_id: int,
                                  entries: list[dict[str, Any]],
                                  granted_by_user_id: int) -> list[dict[str, Any]]:
    """Replace a private memory's ACL, all or nothing.

    Replace, not merge: the list that comes back from the edit screen is the
    list that is saved, so removing somebody is a thing the UI can express by
    leaving them out rather than by having to remember to call a second
    endpoint.

    Every step happens in one transaction, and the validation happens BEFORE
    the delete: a request naming somebody from another space changes nothing at
    all, rather than emptying the ACL and then failing.

      1. the memory is private and in this space;
      2. every target is an ACTIVE member of that same space;
      3. every permission is viewer or editor, and nobody appears twice;
      4. the old rows go, the new rows arrive, together.
    """
    ensure_schema()
    normalized = normalize_private_access(entries)

    with connect() as conn:
        row = conn.execute(
            "SELECT space_id, privacy_mode, created_by_user_id FROM memories WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if row is None or row["space_id"] is None \
                or int(row["space_id"]) != int(space_id) \
                or row["privacy_mode"] != PRIVATE:
            raise PrivacyRefused("not_private", "That memory is not in this space.")

        # The person who made the memory is the only one who may say who else
        # sees it, and the API has already checked that — this checks it again
        # against the row itself, so the store cannot be talked into it.
        if row["created_by_user_id"] is None \
                or int(row["created_by_user_id"]) != int(granted_by_user_id):
            raise PrivacyRefused("not_owner", "Only the owner can change who sees this.")

        members = {
            int(m["user_id"]) for m in conn.execute(
                "SELECT user_id FROM space_members WHERE space_id = ? AND left_at IS NULL",
                (space_id,),
            )
        }
        for entry in normalized:
            if entry["userId"] not in members:
                raise PrivacyRefused(
                    "not_member",
                    "Only people who are in this space can be given access.",
                )

        conn.execute("DELETE FROM memory_private_access WHERE memory_id = ?", (memory_id,))
        _write_private_access(conn, memory_id, normalized, granted_by_user_id)
        # What the ACL now is, read back inside the same transaction.
        return _private_access_rows(conn, memory_id)


def delete_private_access_for_memory(memory_id: int) -> int:
    """Forget who was trusted with a memory. Used when it stops being one."""
    ensure_schema()
    with connect() as conn:
        return conn.execute("DELETE FROM memory_private_access WHERE memory_id = ?",
                            (memory_id,)).rowcount


def prune_private_access(memory_id: int) -> int:
    """Drop ACL rows for people who are no longer in the memory's space.

    Called after a removal as well as on the ACL itself, because a membership
    can end by paths that predate this table. A row that survives removal would
    be a grant that comes back to life if the person ever rejoins, which is
    exactly what must not happen.
    """
    ensure_schema()
    with connect() as conn:
        row = conn.execute("SELECT space_id FROM memories WHERE id = ?",
                           (memory_id,)).fetchone()
        if row is None or row["space_id"] is None:
            return 0
        return conn.execute(
            """
            DELETE FROM memory_private_access
             WHERE memory_id = ?
               AND user_id NOT IN (
                     SELECT user_id FROM space_members
                      WHERE space_id = ? AND left_at IS NULL)
            """,
            (memory_id, int(row["space_id"])),
        ).rowcount


# --- the privacy password and the unlock ------------------------------------

class PrivacyRefused(Exception):
    """A privacy operation that must not happen. Carries a reason the API turns
    into a status code and a sentence."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


def privacy_credentials_for_user(user_id: int) -> sqlite3.Row | None:
    """This account's privacy credential row, or None when none is set.

    Returns the row rather than the hash, so the one caller that checks a
    password can do so and every other caller can ask `is not None`.
    """
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM user_privacy_credentials WHERE user_id = ?", (user_id,)
        ).fetchone()


def is_privacy_configured(user_id: int) -> bool:
    return privacy_credentials_for_user(user_id) is not None


def set_privacy_credentials(user_id: int, password_hash: str) -> None:
    """Write the privacy password, and lock every sign-in of this account.

    Changing the secret ends every unlock that was granted under the old one.
    The person doing it is locked too and unlocks again with the password they
    have just chosen — which is both the clearest rule to state and the one that
    cannot leave a session unlocked by a credential that no longer exists.
    """
    ensure_schema()
    now = _now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO user_privacy_credentials (user_id, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                password_hash = excluded.password_hash,
                updated_at = excluded.updated_at
            """,
            (user_id, password_hash, now, now),
        )
        conn.execute(
            "UPDATE sessions SET privacy_unlocked_until = NULL,"
            " privacy_failed_attempts = 0, privacy_retry_after = NULL"
            " WHERE user_id = ?",
            (user_id,),
        )


def session_privacy_state(token_hash: str) -> dict[str, Any]:
    """Whether THIS sign-in has the private archive open, and until when.

    Read-only: the expiry is compared with the clock here and nowhere else, so
    a status page cannot extend an unlock by asking about it.
    """
    ensure_schema()
    row = session_row(token_hash)
    if row is None:
        return {"unlocked": False, "unlockedUntil": None, "failedAttempts": 0,
                "retryAfter": None}
    keys = row.keys()
    until = row["privacy_unlocked_until"] if "privacy_unlocked_until" in keys else None
    retry = row["privacy_retry_after"] if "privacy_retry_after" in keys else None
    failed = row["privacy_failed_attempts"] if "privacy_failed_attempts" in keys else 0
    unlocked = bool(until) and str(until) > _now()
    return {
        "unlocked": unlocked,
        "unlockedUntil": until if unlocked else None,
        "failedAttempts": int(failed or 0),
        "retryAfter": retry if retry and str(retry) > _now() else None,
    }


def is_privacy_unlocked(token_hash: str) -> bool:
    return bool(session_privacy_state(token_hash)["unlocked"])


def unlock_privacy_session(token_hash: str, minutes: int) -> str:
    """Open the private archive for this sign-in, until now + minutes."""
    ensure_schema()
    until = _minutes_from_now(minutes)
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET privacy_unlocked_until = ?,"
            " privacy_failed_attempts = 0, privacy_retry_after = NULL"
            " WHERE token_hash = ?",
            (until, token_hash),
        )
    return until


def touch_privacy_unlock(token_hash: str, minutes: int) -> str | None:
    """Push the expiry back after the archive has actually been used.

    Only a real private request calls this. The status endpoint deliberately
    does not: anything the front-end polls would otherwise keep the private
    archive open for ever, which is the one thing the timeout exists to
    prevent.
    """
    ensure_schema()
    if not is_privacy_unlocked(token_hash):
        return None
    until = _minutes_from_now(minutes)
    with connect() as conn:
        conn.execute("UPDATE sessions SET privacy_unlocked_until = ? WHERE token_hash = ?",
                     (until, token_hash))
    return until


def lock_privacy_session(token_hash: str) -> None:
    """Close the private archive for this sign-in, now.

    The account's sign-in is untouched: one is a month-long answer to "who is
    this", the other is a ten-minute answer to "may this browser see the private
    archive". Locking the second must never be a way to sign the first out, and
    signing out must never leave the second behind — which is free, because the
    unlock lives on the session row that logout deletes.
    """
    ensure_schema()
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET privacy_unlocked_until = NULL,"
            " privacy_failed_attempts = 0, privacy_retry_after = NULL"
            " WHERE token_hash = ?",
            (token_hash,),
        )


def register_privacy_failure(token_hash: str, limit: int, cooldown_seconds: int) -> dict[str, Any]:
    """Count a wrong privacy password, and slow the next try down if there have
    been too many.

    Per sign-in, not per account and not per address: five wrong tries on this
    browser cost this browser a minute. No IP tracking, no shared counter, no
    lockout that somebody else can trigger for you. An attacker with the laptop
    can start a new sign-in — but starting a new sign-in needs the account
    password, which is the thing they were trying to get past in the first
    place.
    """
    ensure_schema()
    state = session_privacy_state(token_hash)
    attempts = int(state["failedAttempts"]) + 1
    retry_after = None
    if attempts >= limit:
        retry_after = _seconds_from_now(cooldown_seconds)
        attempts = 0
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET privacy_failed_attempts = ?, privacy_retry_after = ?"
            " WHERE token_hash = ?",
            (attempts, retry_after, token_hash),
        )
    return {"attempts": attempts, "retryAfter": retry_after}


def clear_privacy_failures(token_hash: str) -> None:
    ensure_schema()
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET privacy_failed_attempts = 0, privacy_retry_after = NULL"
            " WHERE token_hash = ?",
            (token_hash,),
        )


def _minutes_from_now(minutes: int) -> str:
    return (datetime.now(timezone.utc)
            + timedelta(minutes=int(minutes))).isoformat(timespec="seconds")


def _seconds_from_now(seconds: int) -> str:
    return (datetime.now(timezone.utc)
            + timedelta(seconds=int(seconds))).isoformat(timespec="seconds")


# ===========================================================================
# Accounts, sessions, invitations, activity
# ===========================================================================

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _insert_activity(
    conn: sqlite3.Connection,
    actor_user_id: int | None,
    action_type: str,
    memory_id: int | None,
    created_at: str,
    metadata: dict[str, Any] | None = None,
    space_id: int | None = None,
) -> int:
    """One line of the shared history.

    `space_id` is NULL for something that happened to an account rather than to
    a space — an owner being created, for instance. That is a real answer, not
    a missing one.
    """
    cursor = conn.execute(
        "INSERT INTO activities (actor_user_id, action_type, memory_id, created_at,"
        " metadata_json, space_id) VALUES (?, ?, ?, ?, ?, ?)",
        (actor_user_id, action_type, memory_id, created_at,
         json.dumps(metadata) if metadata else None, space_id),
    )
    return int(cursor.lastrowid)


def log_activity(
    actor_user_id: int | None,
    action_type: str,
    memory_id: int | None = None,
    metadata: dict[str, Any] | None = None,
    space_id: int | None = None,
) -> None:
    ensure_schema()
    with connect() as conn:
        _insert_activity(conn, actor_user_id, action_type, memory_id, _now(), metadata,
                         space_id=space_id)


# --- users -----------------------------------------------------------------

def count_users_with_role(role: str) -> int:
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role = ? AND is_active = 1", (role,)
        ).fetchone()
    return int(row[0])


def get_user_by_username(username: str) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()


def get_user(user_id: int) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def create_user(
    username: str, display_name: str, password_hash: str, role: str
) -> int:
    """Create an account. The role is decided by the caller after checking the
    rules — never taken from anything the browser sent."""
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role,"
            " is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
            (username, display_name, password_hash, role, _now()),
        )
        return int(cursor.lastrowid)


def public_user(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    """What may leave the server about a person. No username, no hash."""
    if row is None:
        return None
    return {
        "id": row["id"],
        "displayName": row["display_name"],
        "role": row["role"],
        "avatarUrl": row["avatar_url"],
    }


# --- spaces -----------------------------------------------------------------
#
# Everything below answers one of two questions: which space is this account
# in, and who is in this space. Nothing else in the codebase is allowed to ask
# those questions for itself — a second answer to "which space" is how one
# person's memories end up in another person's archive.

def _row_to_space(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": (row["name"] if "name" in row.keys() else "") or "",
        "spaceType": (row["space_type"] if "space_type" in row.keys() else "group"),
        "createdByUserId": row["created_by_user_id"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "archivedAt": row["archived_at"] if "archived_at" in row.keys() else None,
    }


def get_space(space_id: int) -> dict[str, Any] | None:
    ensure_schema()
    with connect() as conn:
        row = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,)).fetchone()
    return _row_to_space(row)


def get_space_members(space_id: int) -> list[dict[str, Any]]:
    """The people in a space, active memberships only."""
    ensure_schema()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT m.id, m.space_id, m.user_id, m.member_role, m.joined_at,
                   u.display_name, u.role AS account_role
              FROM space_members m
              JOIN users u ON u.id = m.user_id
             WHERE m.space_id = ? AND m.left_at IS NULL
             ORDER BY m.id
            """,
            (space_id,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "spaceId": row["space_id"],
            "userId": row["user_id"],
            "memberRole": row["member_role"],
            "joinedAt": row["joined_at"],
            "displayName": row["display_name"],
            "accountRole": row["account_role"],
        }
        for row in rows
    ]


def space_member_count(space_id: int) -> int:
    ensure_schema()
    with connect() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM space_members WHERE space_id = ? AND left_at IS NULL",
            (space_id,),
        ).fetchone()[0])


def is_space_member(user_id: int, space_id: int) -> bool:
    """Whether this account is currently in this space. The one question every
    resource check asks before changing anything."""
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM space_members WHERE user_id = ? AND space_id = ?"
            " AND left_at IS NULL",
            (user_id, space_id),
        ).fetchone()
    return row is not None


# A space id that cannot exist, for "this reader gets nothing". Used instead of
# None, which the query layer reads as "no filter at all".
NO_SPACE = -1

# A personal space holds one person and never will hold two; a group space
# holds as many as it likes. There is no group ceiling to tune — "no limit" is
# a decision here, not an unset value.
PERSONAL_SPACE_CAPACITY = 1
GROUP_SPACE_CAPACITY = None

# The three roles, in the order the product gives them authority.
SPACE_ROLES = ("creator", "admin", "member")


def space_capacity(space_id: int) -> int | None:
    """How many people this space may hold. None means no ceiling."""
    space = get_space(space_id)
    if space is None:
        return None
    return (PERSONAL_SPACE_CAPACITY if space["spaceType"] == "personal"
            else GROUP_SPACE_CAPACITY)


def space_role_of(user_id: int, space_id: int) -> str | None:
    """This account's active role in this space, or None if it is not in it."""
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            "SELECT member_role FROM space_members WHERE user_id = ? AND space_id = ?"
            " AND left_at IS NULL",
            (user_id, space_id),
        ).fetchone()
    return row["member_role"] if row is not None else None


def is_space_creator(user_id: int, space_id: int) -> bool:
    return space_role_of(user_id, space_id) == "creator"


def is_space_admin(user_id: int, space_id: int) -> bool:
    return space_role_of(user_id, space_id) == "admin"


def is_space_manager(user_id: int, space_id: int) -> bool:
    """Creator or admin: whoever may run the space. Phase 2 builds on this."""
    return space_role_of(user_id, space_id) in ("creator", "admin")


def can_join_space(space_id: int) -> bool:
    """True while this space will take another person.

    A group space always will — there is no ceiling. A personal space never
    will: it is one person's, and no invitation, request or stray write should
    be able to put a second account inside it.
    """
    space = get_space(space_id)
    if space is None:
        return False
    if space["spaceType"] == "personal":
        return False
    limit = space_capacity(space_id)
    return limit is None or space_member_count(space_id) < limit


def create_group_space(name: str, user_id: int) -> int:
    """Open a shared space and put its creator in it, in one transaction.

    A space with no creator is not a thing that can exist: if anything fails
    after the space row is written, the transaction takes it back.
    """
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO spaces (name, space_type, created_by_user_id, status, created_at)"
            " VALUES (?, 'group', ?, 'active', ?)",
            (name, user_id, _now()),
        )
        space_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO space_members (space_id, user_id, member_role, joined_at)"
            " VALUES (?, ?, 'creator', ?)",
            (space_id, user_id, _now()),
        )
    return space_id


def add_space_member(conn: sqlite3.Connection, space_id: int, user_id: int,
                     member_role: str) -> int:
    """Join somebody to a space, on a connection the caller already owns.

    Takes a connection rather than opening one so that accepting an invitation
    can create the account, the membership and the session as a single
    indivisible act.
    """
    cursor = conn.execute(
        "INSERT INTO space_members (space_id, user_id, member_role, joined_at)"
        " VALUES (?, ?, ?, ?)",
        (space_id, user_id, member_role, _now()),
    )
    return int(cursor.lastrowid)


def legacy_space_id() -> int | None:
    """The one space this archive has always been.

    Used for exactly two things: adopting rows that predate spaces, and the
    temporary guest read while the Hub is still public. It is never how a
    signed-in person's space is decided — that is always their membership.
    """
    ensure_schema()
    with connect() as conn:
        return _oldest_active_space_id(conn)


# --- sessions --------------------------------------------------------------

# How long a signed-in session lasts. Thirty days is the product decision: a
# person should not have to sign in again every week on their own phone. It is
# configuration rather than a constant so a deployment can choose otherwise,
# and the cookie's Max-Age is taken from this same number, so the browser and
# the database can never disagree about when the session ends.
SESSION_DAYS = max(1, int(os.environ.get("LOVE_STORY_SESSION_DAYS") or 30))


def create_session(user_id: int, token_hash: str,
                   current_space_id: int | None = None) -> str:
    """Open a session, optionally already pointed at a space.

    `current_space_id` lives on the session rather than on the account, because
    the same person may be in Our Space on the laptop and My Space on the
    phone, and both are correct.
    """
    ensure_schema()
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at,"
            " last_seen_at, current_space_id) VALUES (?, ?, ?, ?, ?, ?)",
            (token_hash, user_id, _now(), expires.isoformat(timespec="seconds"),
             _now(), current_space_id),
        )
    return expires.isoformat(timespec="seconds")


def session_row(token_hash: str) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM sessions WHERE token_hash = ?", (token_hash,)
        ).fetchone()


def set_session_space(token_hash: str, space_id: int) -> None:
    """Point this sign-in at a space. Only ever called after the membership has
    been checked by the caller."""
    ensure_schema()
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET current_space_id = ? WHERE token_hash = ?",
            (space_id, token_hash),
        )


def current_space_for_session(token_hash: str) -> dict[str, Any] | None:
    """The space this sign-in is looking at — the one place that decides.

    The stored id is never trusted on its own. A session's `current_space_id`
    can be stale (a membership that has since been left), null (a session from
    before spaces), or simply wrong; so every time it is read it is checked
    against a live membership, and a session that fails the check is moved to a
    space the account really is in.

    The fallback is the person's own space, never an arbitrary group: landing
    somebody in a shared space they did not choose would be worse than landing
    them somewhere empty.
    """
    ensure_schema()
    row = session_row(token_hash)
    if row is None:
        return None

    user_id = int(row["user_id"])
    space_id = row["current_space_id"] if "current_space_id" in row.keys() else None

    if space_id is not None and is_space_member(user_id, int(space_id)):
        space = get_space(int(space_id))
        if space is not None and space["status"] == "active":
            return space

    # Stale, missing or not ours. Move the session somewhere it is welcome.
    fallback = personal_space_for_user(user_id)
    if fallback is None:
        with connect() as conn:
            fallback_id = _preferred_space_for_user(conn, user_id)
        if fallback_id is None:
            return None
        set_session_space(token_hash, fallback_id)
        return get_space(fallback_id)

    set_session_space(token_hash, int(fallback["id"]))
    return _row_to_space(fallback)


def last_space_for_user(user_id: int) -> int | None:
    """The space this account was last working in, if it is still theirs.

    What signing in should do is continue where somebody left off, and the only
    record of that is their previous sessions. A space they have since left, or
    one that was archived, is ignored: the answer has to be a space they are
    really in.
    """
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            "SELECT current_space_id FROM sessions"
            " WHERE user_id = ? AND current_space_id IS NOT NULL"
            " ORDER BY id DESC LIMIT 1",
            (user_id,),
        ).fetchone()
    if row is None or row["current_space_id"] is None:
        return None
    space_id = int(row["current_space_id"])
    return space_id if is_space_member(user_id, space_id) else None


def preferred_space_for_user(user_id: int) -> int | None:
    """Where to put somebody who has no last-used space: a shared space they
    are in, or failing that their own. Never an arbitrary one."""
    ensure_schema()
    with connect() as conn:
        return _preferred_space_for_user(conn, user_id)


def list_spaces_for_user(user_id: int) -> list[dict[str, Any]]:
    """Every active space this account is in, newest last."""
    ensure_schema()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT s.*, m.member_role
              FROM space_members m
              JOIN spaces s ON s.id = m.space_id
             WHERE m.user_id = ? AND m.left_at IS NULL AND s.status = 'active'
             ORDER BY s.id
            """,
            (user_id,),
        ).fetchall()

    # The same shape `space_summary` gives every other endpoint: one space
    # object, described one way. A list that named its fields differently from
    # the single read would be a trap for whoever writes the next page.
    out = []
    for row in rows:
        space = space_summary(int(row["id"]), user_id) or _row_to_space(row)
        space["membershipRole"] = row["member_role"]
        out.append(space)
    return out


def user_for_session(token_hash: str) -> sqlite3.Row | None:
    """The account behind a session token, if it is valid and unexpired."""
    ensure_schema()
    now = _now()
    with connect() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1",
            (token_hash, now),
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (now, token_hash),
            )
    return row


def delete_session(token_hash: str) -> None:
    ensure_schema()
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def purge_expired_sessions() -> int:
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (_now(),))
        return cursor.rowcount


# --- invitations -----------------------------------------------------------

# An invitation lives for a day. Short on purpose: it is a code someone reads
# out loud, and an unused invitation is a way into a private space.
INVITE_HOURS = max(1, int(os.environ.get("LOVE_STORY_INVITE_HOURS") or 24))
# A group invites as many people as it has friends; this only stops an accident
# becoming a hundred live ways into a space.
MAX_ACTIVE_INVITATIONS = max(1, int(os.environ.get("LOVE_STORY_MAX_INVITES") or 20))
INVITE_DAYS = INVITE_HOURS / 24

# Why an invitation cannot be used, in words the join page can show as they are.
# Kept beside the states they describe so the two cannot drift apart.
INVITE_MESSAGES = {
    "invalid": "That invitation is not recognised.",
    "used": "That invitation has already been used.",
    "expired": "That invitation has expired.",
    "revoked": "That invitation has been withdrawn.",
    "partner_exists": "This space already has two members.",
    "space_full": "This space already has two members.",
    "already_paired": "You are already part of a space.",
    "already_member": "You are already part of this space.",
}


def get_invite(token_hash: str) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM invite_tokens WHERE token_hash = ?", (token_hash,)
        ).fetchone()


def invite_state(token_hash: str) -> str:
    """One of: ok, invalid, used, expired, revoked.

    A single word per situation, so the page can be certain which of them it is
    showing instead of reading a sentence back. Whether the space has room is a
    separate question, decided by the caller.
    """
    return invitation_state_by_token(token_hash)


def partner_status(space_id: int | None = None) -> dict[str, Any]:
    """Whether the partner's place is filled, waiting, or still empty.

    The owner's account page reads this. It is deliberately three states rather
    than a boolean, because "nobody yet" and "invited, not answered" call for
    different things on screen — and the raw invitation token is never part of
    it, in any state: that value exists once, in the response that created it.
    """
    ensure_schema()
    with connect() as conn:
        # Who is in the space, not who holds a legacy global role: the same
        # person can be in one space and not another.
        partner = conn.execute(
            """
            SELECT u.id, u.display_name, m.joined_at AS created_at
              FROM space_members m JOIN users u ON u.id = m.user_id
             WHERE m.left_at IS NULL AND m.member_role != 'creator'
               AND (? IS NULL OR m.space_id = ?)
             ORDER BY m.id LIMIT 1
            """,
            (space_id, space_id),
        ).fetchone()

        if partner is not None:
            return {
                "connected": True,
                "displayName": partner["display_name"],
                "joinedAt": partner["created_at"],
                "pending": False,
                "inviteId": None,
                "expiresAt": None,
            }

        invite = conn.execute(
            "SELECT id, expires_at, created_at FROM invite_tokens"
            " WHERE role = 'partner' AND used_at IS NULL AND expires_at > ?"
            "   AND (? IS NULL OR space_id = ?)"
            " ORDER BY id DESC LIMIT 1",
            (_now(), space_id, space_id),
        ).fetchone()

        return {
            "connected": False,
            "displayName": None,
            "joinedAt": None,
            "pending": invite is not None,
            "inviteId": invite["id"] if invite is not None else None,
            "expiresAt": invite["expires_at"] if invite is not None else None,
        }


class InviteRefused(Exception):
    """An invitation that cannot be accepted, with a reason the page can show."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


# --- pairing -----------------------------------------------------------------
#
# A pairing invitation is one record with two ways in: a long random link, and
# a short code a person can read aloud. Both are stored only as hashes, both
# expire at the same moment, and both lead to the same accept transaction —
# there is deliberately one way to join a space, not two.

# No 0/O, no 1/I/L. A code is read off one screen and typed into another, and
# those are the pairs where that goes wrong.
#
# The brief's forbidden list is "0 O 1 I L", but the alphabet it suggests
# alongside it (ABCDEFGHJKLMNPQRSTUVWXYZ) still contains L. The two disagree;
# the forbidden list is the rule and the alphabet was an example, so L is out
# and this one letter is the whole difference between them.
PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
PAIRING_CODE_LENGTH = 8


def new_pairing_code() -> str:
    """Eight characters from an alphabet without lookalikes."""
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))


def format_pairing_code(code: str) -> str:
    """7K4M92QX -> 7K4M-92QX. Presentation only; never stored this way."""
    half = len(code) // 2
    return f"{code[:half]}-{code[half:]}"


def normalize_pairing_code(code: str) -> str:
    """What a person typed -> what we hash.

    Spaces, hyphens, lower case: all of it is how a code arrives, none of it is
    what a code is. Normalising here means the stored hash never depends on the
    shape the code was typed in.
    """
    return "".join(ch for ch in str(code or "").upper()
                   if ch in PAIRING_ALPHABET)


def _invitation_row(token_hash: str | None = None,
                    code_hash: str | None = None) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        if token_hash is not None:
            return conn.execute(
                "SELECT * FROM invite_tokens WHERE token_hash = ?", (token_hash,)
            ).fetchone()
        if code_hash is not None:
            return conn.execute(
                "SELECT * FROM invite_tokens WHERE code_hash = ?", (code_hash,)
            ).fetchone()
    return None


def _row_state(row: sqlite3.Row | None) -> str:
    """ok, invalid, used, expired or revoked — the state of one invitation."""
    if row is None:
        return "invalid"
    if row["used_at"]:
        return "used"
    if "revoked_at" in row.keys() and row["revoked_at"]:
        return "revoked"
    if row["expires_at"] <= _now():
        return "expired"
    return "ok"


def invitation_state_by_token(token_hash: str) -> str:
    return _row_state(_invitation_row(token_hash=token_hash))


def invitation_state_by_code(code: str) -> str:
    normalized = normalize_pairing_code(code)
    if len(normalized) != PAIRING_CODE_LENGTH:
        return "invalid"
    return _row_state(_invitation_row(code_hash=hash_token_value(normalized)))


def hash_token_value(value: str) -> str:
    """SHA-256, the same shape auth.hash_token produces.

    Duplicated as a one-line call rather than importing auth here: database.py
    must not depend on the module that depends on it.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def invitation_for_code(code: str) -> sqlite3.Row | None:
    normalized = normalize_pairing_code(code)
    if len(normalized) != PAIRING_CODE_LENGTH:
        return None
    return _invitation_row(code_hash=hash_token_value(normalized))


def invitation_for_token(token: str) -> sqlite3.Row | None:
    return _invitation_row(token_hash=hash_token_value(token))


def list_active_invitations(space_id: int) -> list[dict[str, Any]]:
    """The invitations for this space that can still be used.

    No raw token and no code: those existed once, in the response that made
    them, and the database holds only their hashes. What is left to show is who
    made each one and when it lapses — which is what a manager needs in order to
    decide whether to withdraw it.
    """
    ensure_schema()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT i.id, i.created_by_user_id, i.created_at, i.expires_at,
                   u.display_name AS creator_name
              FROM invite_tokens i
              LEFT JOIN users u ON u.id = i.created_by_user_id
             WHERE i.space_id = ? AND i.used_at IS NULL
               AND (i.revoked_at IS NULL) AND i.expires_at > ?
             ORDER BY i.id DESC
            """,
            (space_id, _now()),
        ).fetchall()

    return [
        {
            "id": row["id"],
            "createdByUserId": row["created_by_user_id"],
            "createdByName": row["creator_name"] or "",
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
        }
        for row in rows
    ]


def pending_invitation_for_space(space_id: int) -> sqlite3.Row | None:
    """The one live invitation a space is allowed to have."""
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM invite_tokens WHERE space_id = ? AND used_at IS NULL"
            " AND (revoked_at IS NULL) AND expires_at > ? ORDER BY id DESC LIMIT 1",
            (space_id, _now()),
        ).fetchone()


def active_invitation_count(space_id: int) -> int:
    """Invitations for this space that can still be used."""
    ensure_schema()
    with connect() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM invite_tokens WHERE space_id = ? AND used_at IS NULL"
            " AND (revoked_at IS NULL) AND expires_at > ?",
            (space_id, _now()),
        ).fetchone()[0])


def create_pairing_invitation(created_by_user_id: int, space_id: int,
                              role: str = "partner") -> dict[str, Any]:
    """Mint the one live invitation for a space: a link token and a code.

    Both raw values are returned and never stored — the row keeps only their
    hashes, so a copy of the database cannot be used to join a space. The code
    is regenerated if it would collide with a live invitation; a collision is
    unlikely, not impossible, and "unlikely" is not a security argument.
    """
    ensure_schema()
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc)
               + timedelta(hours=INVITE_HOURS)).isoformat(timespec="seconds")

    with connect() as conn:
        code = new_pairing_code()
        for _attempt in range(20):
            clash = conn.execute(
                "SELECT 1 FROM invite_tokens WHERE code_hash = ? AND used_at IS NULL"
                " AND (revoked_at IS NULL) AND expires_at > ?",
                (hash_token_value(code), _now()),
            ).fetchone()
            if clash is None:
                break
            code = new_pairing_code()

        conn.execute(
            "INSERT INTO invite_tokens (token_hash, created_by_user_id, role,"
            " expires_at, created_at, space_id, code_hash)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (hash_token_value(token), created_by_user_id, role, expires, _now(),
             space_id, hash_token_value(code)),
        )

    return {
        "token": token,
        "code": format_pairing_code(code),
        "expiresAt": expires,
        "expiresInHours": INVITE_HOURS,
    }


def revoke_pending_invitation(space_id: int) -> int:
    """Take back a live invitation. The row is kept, marked — a spent or
    withdrawn invitation is part of the record, not something to erase."""
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE invite_tokens SET revoked_at = ?"
            " WHERE space_id = ? AND used_at IS NULL AND (revoked_at IS NULL)"
            "   AND expires_at > ?",
            (_now(), space_id, _now()),
        )
        return cursor.rowcount


def _claim_invitation(conn: sqlite3.Connection, row: sqlite3.Row,
                      joiner_user_id: int | None) -> int:
    """Claim an invitation and check the space can take one more person.

    The rules that decide whether a space may be joined live here and nowhere
    else, because they are the rules that must not differ between the two ways
    of joining. Called inside a transaction the caller owns: if anything
    afterwards fails, the claim rolls back with it.
    """
    now = _now()

    state = _row_state(row)
    if state != "ok":
        raise PairingRefused(state, INVITE_MESSAGES.get(state, ""))

    space_id = row["space_id"] if "space_id" in row.keys() else None
    if space_id is None:
        raise PairingRefused("invalid", "That invitation predates the pairing system.")

    space = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,)).fetchone()
    if space is None or space["status"] != "active":
        raise PairingRefused("invalid", "That space is not available.")

    creator = conn.execute(
        "SELECT user_id FROM space_members WHERE space_id = ?"
        " AND member_role = 'creator' AND left_at IS NULL",
        (space_id,),
    ).fetchone()
    if creator is None:
        raise PairingRefused("invalid", "That space is not available.")
    if joiner_user_id is not None and int(creator["user_id"]) == joiner_user_id:
        raise PairingRefused("already_member", "You are already part of this space.")

    # Claim it: only one caller can move used_at from NULL.
    claimed = conn.execute(
        "UPDATE invite_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL"
        " AND (revoked_at IS NULL)",
        (now, row["id"]),
    )
    if claimed.rowcount != 1:
        raise PairingRefused("used", INVITE_MESSAGES["used"])

    if space["space_type"] == "personal":
        raise PairingRefused("personal_space",
                             "A personal space cannot be joined.")
    limit = PERSONAL_SPACE_CAPACITY if space["space_type"] == "personal" \
        else GROUP_SPACE_CAPACITY
    if limit is not None:
        members = int(conn.execute(
            "SELECT COUNT(*) FROM space_members WHERE space_id = ? AND left_at IS NULL",
            (space_id,),
        ).fetchone()[0])
        if members >= limit:
            raise PairingRefused("space_full", INVITE_MESSAGES["space_full"])

    # A second invitation to the same space has nothing left to do.
    conn.execute(
        "UPDATE invite_tokens SET revoked_at = ?"
        " WHERE space_id = ? AND id != ? AND used_at IS NULL AND (revoked_at IS NULL)",
        (now, space_id, row["id"]),
    )

    return int(space_id)


class PairingRefused(Exception):
    """A pairing that cannot happen, with a reason the page can show as it is."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


def create_join_request(user_id: int, *, token: str | None = None,
                        code: str | None = None) -> dict[str, Any]:
    """Ask to join a group. This is what an invitation now does.

    It does NOT create a membership. Following a link says "may I?", and the
    person who made the space decides — so the invitation is spent on a
    REQUEST, and an approval is what makes somebody a member. There is no path
    into a group that skips that.

    One transaction, one implementation, whichever way the invitation arrived:

      1. find the invitation;
      2. refuse if it is spent, withdrawn or expired, or the space is not a
         joinable group;
      3. refuse if the requester is already a member;
      4. return the request they already have, rather than making a second;
      5. CLAIM the invitation — one invitation, one request — and write the
         request.

    Returns the request, whether it was just made or was already waiting.
    """
    ensure_schema()
    now = _now()

    with connect() as conn:
        row = None
        if token:
            row = conn.execute("SELECT * FROM invite_tokens WHERE token_hash = ?",
                               (hash_token_value(token),)).fetchone()
        elif code:
            normalized = normalize_pairing_code(code)
            if len(normalized) == PAIRING_CODE_LENGTH:
                row = conn.execute("SELECT * FROM invite_tokens WHERE code_hash = ?",
                                   (hash_token_value(normalized),)).fetchone()

        state = _row_state(row)
        if state != "ok":
            raise PairingRefused(state, INVITE_MESSAGES.get(state, ""))

        space_id = row["space_id"] if "space_id" in row.keys() else None
        if space_id is None:
            raise PairingRefused("invalid", "That invitation predates the space system.")

        space = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,)).fetchone()
        if space is None or space["status"] != "active":
            raise PairingRefused("invalid", "That space is not available.")
        if space["space_type"] != "group":
            raise PairingRefused("personal_space", "A personal space cannot be joined.")

        # Already in it: nothing to ask for.
        if conn.execute(
            "SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?"
            " AND left_at IS NULL",
            (space_id, user_id),
        ).fetchone() is not None:
            raise PairingRefused("already_member",
                                 "You are already a member of this space.")

        # Already waiting: the page should show that rather than a second ask.
        pending = conn.execute(
            "SELECT * FROM space_join_requests WHERE space_id = ?"
            " AND requester_user_id = ? AND status = 'pending'",
            (space_id, user_id),
        ).fetchone()
        if pending is not None:
            return {"status": "pending", "existing": True,
                    "joinRequest": _row_to_join_request(pending, space["name"])}

        # Claim the invitation: one invitation makes one request.
        claimed = conn.execute(
            "UPDATE invite_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL"
            " AND (revoked_at IS NULL)",
            (now, row["id"]),
        )
        if claimed.rowcount != 1:
            raise PairingRefused("used", INVITE_MESSAGES["used"])

        cursor = conn.execute(
            "INSERT INTO space_join_requests (space_id, requester_user_id, invite_id,"
            " status, requested_at) VALUES (?, ?, ?, 'pending', ?)",
            (space_id, user_id, row["id"], now),
        )
        request_id = int(cursor.lastrowid)

        # The creator is the one who decides, so the creator is the one told.
        creator = conn.execute(
            "SELECT user_id FROM space_members WHERE space_id = ?"
            " AND member_role = 'creator' AND left_at IS NULL",
            (space_id,),
        ).fetchone()
        if creator is not None:
            requester = conn.execute("SELECT display_name FROM users WHERE id = ?",
                                     (user_id,)).fetchone()
            _insert_notification(
                conn, int(creator["user_id"]), space_id, "join_request_created",
                actor_user_id=user_id, join_request_id=request_id,
                title=f"{(requester['display_name'] if requester else 'Someone')}"
                      f" wants to join {space['name']}",
                body="Approve or decline their request.",
                created_at=now,
            )

        request = conn.execute("SELECT * FROM space_join_requests WHERE id = ?",
                               (request_id,)).fetchone()

    return {"status": "pending", "existing": False,
            "joinRequest": _row_to_join_request(request, space["name"])}


def _row_to_join_request(row: sqlite3.Row, space_name: str | None = None) -> dict[str, Any]:
    requester = get_user(int(row["requester_user_id"]))
    return {
        "id": row["id"],
        "spaceId": row["space_id"],
        "spaceName": space_name if space_name is not None else "",
        "requesterUserId": row["requester_user_id"],
        # Display name only: who is asking, not their account.
        "requesterName": requester["display_name"] if requester else "",
        "status": row["status"],
        "requestedAt": row["requested_at"],
        "reviewedAt": row["reviewed_at"],
        "reviewedByUserId": row["reviewed_by_user_id"],
    }


def get_join_request(request_id: int) -> dict[str, Any] | None:
    ensure_schema()
    with connect() as conn:
        row = conn.execute("SELECT * FROM space_join_requests WHERE id = ?",
                           (request_id,)).fetchone()
        if row is None:
            return None
        space = conn.execute("SELECT name FROM spaces WHERE id = ?",
                             (row["space_id"],)).fetchone()
    return _row_to_join_request(row, space["name"] if space else "")


def list_join_requests(space_id: int, status: str = "pending") -> list[dict[str, Any]]:
    """The people waiting to be let into this space, oldest first."""
    ensure_schema()
    with connect() as conn:
        rows = conn.execute(
            "SELECT r.*, s.name AS space_name FROM space_join_requests r"
            " JOIN spaces s ON s.id = r.space_id"
            " WHERE r.space_id = ? AND r.status = ? ORDER BY r.id",
            (space_id, status),
        ).fetchall()
    return [_row_to_join_request(row, row["space_name"]) for row in rows]


def pending_join_request_count(space_id: int) -> int:
    ensure_schema()
    with connect() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM space_join_requests WHERE space_id = ?"
            " AND status = 'pending'",
            (space_id,),
        ).fetchone()[0])


def review_join_request(request_id: int, reviewer_user_id: int,
                        approve: bool) -> dict[str, Any]:
    """Approve or decline one request. One transaction, all of it.

    Approving is the only thing in the whole system that adds a member to a
    group, and it does so as one indivisible act: the membership, the request's
    new state, and the notification to the requester either all happen or none
    of them do.
    """
    ensure_schema()
    now = _now()

    with connect() as conn:
        request = conn.execute("SELECT * FROM space_join_requests WHERE id = ?",
                               (request_id,)).fetchone()
        if request is None:
            raise PairingRefused("invalid", "That request is not in the archive.")

        space_id = int(request["space_id"])
        space = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,)).fetchone()
        if space is None or space["space_type"] != "group":
            raise PairingRefused("invalid", "That space cannot be joined.")

        if request["status"] != "pending":
            raise PairingRefused("reviewed",
                                 "That request has already been reviewed.")

        requester_id = int(request["requester_user_id"])
        if conn.execute("SELECT 1 FROM users WHERE id = ? AND is_active = 1",
                        (requester_id,)).fetchone() is None:
            raise PairingRefused("invalid", "That account is no longer active.")

        if approve:
            already = conn.execute(
                "SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?"
                " AND left_at IS NULL",
                (space_id, requester_id),
            ).fetchone()
            if already is None:
                add_space_member(conn, space_id, requester_id, "member")

            # They are in the space now, so let this sign-in look at it.
            _point_sessions_at_space(conn, requester_id, space_id)
        else:
            if conn.execute(
                "SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?"
                " AND left_at IS NULL",
                (space_id, requester_id),
            ).fetchone() is not None:
                raise PairingRefused("already_member",
                                     "They are already a member of this space.")

        conn.execute(
            "UPDATE space_join_requests SET status = ?, reviewed_at = ?,"
            " reviewed_by_user_id = ? WHERE id = ? AND status = 'pending'",
            ("approved" if approve else "declined", now, reviewer_user_id, request_id),
        )

        _insert_notification(
            conn, requester_id, space_id,
            "join_request_approved" if approve else "join_request_declined",
            actor_user_id=reviewer_user_id, join_request_id=request_id,
            title=(f"Your request to join {space['name']} was "
                   + ("approved" if approve else "declined")),
            body=("You are now a member." if approve
                  else "You can ask again with a new invitation."),
            created_at=now,
        )

        updated = conn.execute("SELECT * FROM space_join_requests WHERE id = ?",
                               (request_id,)).fetchone()

    return _row_to_join_request(updated, space["name"])


def _point_sessions_at_space(conn: sqlite3.Connection, user_id: int,
                             space_id: int) -> None:
    """Move somebody's sign-ins to a space they have just been let into.

    Only the ones with no choice made: a session already looking at a real
    space keeps looking at it.
    """
    conn.execute(
        "UPDATE sessions SET current_space_id = ?"
        " WHERE user_id = ? AND (current_space_id IS NULL)",
        (space_id, user_id),
    )


# --- members, roles and removal ---------------------------------------------

# Who may do what to whom. One table, because "may this person change that
# person's role" is exactly the kind of question that drifts when it is written
# out in several places.
#
#   creator -> may promote and demote admins and members, and remove either
#   admin   -> may promote members, and remove members
#   member  -> may do neither
#
# Nobody may change the creator: there is one per space and no way to transfer
# it yet, so a rule that allowed touching it would be a rule with no safe
# outcome.
MANAGEABLE_ROLES = ("admin", "member")


def can_manage_member(actor_role: str | None, target_role: str | None,
                      action: str) -> bool:
    """Whether `actor_role` may `action` a member holding `target_role`."""
    if actor_role not in ("creator", "admin"):
        return False
    if target_role not in MANAGEABLE_ROLES:
        return False                       # the creator is never a target

    if actor_role == "creator":
        return True                        # creator may do anything to the rest

    # An admin may promote a member, and remove a member. They may not touch
    # another admin, either way.
    if action == "promote":
        return target_role == "member"
    if action == "remove":
        return target_role == "member"
    return False


def member_row(space_id: int, user_id: int) -> sqlite3.Row | None:
    ensure_schema()
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM space_members WHERE space_id = ? AND user_id = ?"
            " AND left_at IS NULL",
            (space_id, user_id),
        ).fetchone()


def change_member_role(space_id: int, user_id: int, role: str,
                       actor_user_id: int) -> None:
    """Promote or demote one member. Updates the role and tells them.

    The change and the notification are one transaction: somebody should not
    become an admin without being told, and should not be told about a change
    that was rolled back.
    """
    ensure_schema()
    if role not in MANAGEABLE_ROLES:
        raise PairingRefused("invalid_role",
                             "A role can only be admin or member.")
    now = _now()

    with connect() as conn:
        member = conn.execute(
            "SELECT * FROM space_members WHERE space_id = ? AND user_id = ?"
            " AND left_at IS NULL",
            (space_id, user_id),
        ).fetchone()
        if member is None:
            raise PairingRefused("not_member", "They are not a member of this space.")

        conn.execute(
            "UPDATE space_members SET member_role = ? WHERE space_id = ?"
            " AND user_id = ? AND left_at IS NULL",
            (role, space_id, user_id),
        )

        space = conn.execute("SELECT name FROM spaces WHERE id = ?",
                             (space_id,)).fetchone()
        name = space["name"] if space else "this space"
        promoting = role == "admin"
        _insert_notification(
            conn, user_id, space_id,
            "role_promoted" if promoting else "role_demoted",
            actor_user_id=actor_user_id,
            title=(f"You are now an admin of {name}." if promoting
                   else f"Your role in {name} is now member."),
            body="", created_at=now,
        )


def remove_space_member(space_id: int, user_id: int, actor_user_id: int) -> None:
    """Take somebody out of a space, keeping the record that they were in it.

    The membership is marked as left, never deleted: the space's history stays
    readable, and the content they added stays where it belongs — in the space,
    not with the account.

    Their private access goes with them. Every memory in this space that named
    them is emptied of them in the same transaction, so being removed is also
    being un-trusted — and rejoining later restores nothing, because there is
    nothing left to restore. That is the safe default: access is granted by a
    person, not by a membership, and it must be granted again by a person.

    Their sign-ins are moved to their own space in the same transaction, so the
    next request cannot land on a space they are no longer in.
    """
    ensure_schema()
    now = _now()

    with connect() as conn:
        member = conn.execute(
            "SELECT * FROM space_members WHERE space_id = ? AND user_id = ?"
            " AND left_at IS NULL",
            (space_id, user_id),
        ).fetchone()
        if member is None:
            raise PairingRefused("not_member", "They are not a member of this space.")

        conn.execute(
            "UPDATE space_members SET left_at = ? WHERE space_id = ? AND user_id = ?"
            " AND left_at IS NULL",
            (now, space_id, user_id),
        )

        # The private memory they were trusted with is still theirs to forget:
        # the grant was given by its owner for as long as they were here, and
        # they are not here any more.
        conn.execute(
            """
            DELETE FROM memory_private_access
             WHERE user_id = ?
               AND memory_id IN (SELECT id FROM memories WHERE space_id = ?)
            """,
            (user_id, space_id),
        )

        # No sign-in may keep looking at a space it has been removed from.
        fallback = personal_space_id(conn, user_id)
        conn.execute(
            "UPDATE sessions SET current_space_id = ?"
            " WHERE user_id = ? AND current_space_id = ?",
            (fallback, user_id, space_id),
        )

        space = conn.execute("SELECT name FROM spaces WHERE id = ?",
                             (space_id,)).fetchone()
        name = space["name"] if space else "the space"
        # Addressed to the account, not the space, so it is still there now
        # that they are no longer a member.
        _insert_notification(
            conn, user_id, space_id, "member_removed",
            actor_user_id=actor_user_id,
            title=f"You were removed from {name}.",
            body="", created_at=now,
        )


# --- notifications ----------------------------------------------------------

NOTIFICATION_TYPES = (
    "join_request_created",
    "join_request_approved",
    "join_request_declined",
    "role_promoted",
    "role_demoted",
    "member_removed",
)


def _insert_notification(conn: sqlite3.Connection, user_id: int,
                         space_id: int | None, type_: str,
                         actor_user_id: int | None = None,
                         join_request_id: int | None = None,
                         title: str = "", body: str = "",
                         created_at: str | None = None) -> int:
    cursor = conn.execute(
        "INSERT INTO notifications (user_id, space_id, type, actor_user_id,"
        " related_join_request_id, title, body, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, space_id, type_, actor_user_id, join_request_id, title, body,
         created_at or _now()),
    )
    return int(cursor.lastrowid)


def _row_to_notification(row: sqlite3.Row) -> dict[str, Any]:
    actor = get_user(int(row["actor_user_id"])) if row["actor_user_id"] else None
    space = get_space(int(row["space_id"])) if row["space_id"] else None
    return {
        "id": row["id"],
        "type": row["type"],
        "title": row["title"] or "",
        "body": row["body"] or "",
        "spaceId": row["space_id"],
        "spaceName": space["name"] if space else "",
        "actorName": actor["display_name"] if actor else "",
        "joinRequestId": row["related_join_request_id"],
        "createdAt": row["created_at"],
        "readAt": row["read_at"],
        "unread": row["read_at"] is None,
    }


def list_notifications(user_id: int, unread_only: bool = False,
                       limit: int = 50) -> list[dict[str, Any]]:
    """This account's own notifications, newest first.

    Deliberately not filtered by the current space: a message about a group
    somebody was removed from still has to reach them, and a message about
    another space still matters while they are working in this one.
    """
    ensure_schema()
    sql = "SELECT * FROM notifications WHERE user_id = ?"
    if unread_only:
        sql += " AND read_at IS NULL"
    sql += " ORDER BY id DESC LIMIT ?"

    with connect() as conn:
        rows = conn.execute(sql, (user_id, int(limit))).fetchall()
    return [_row_to_notification(row) for row in rows]


def unread_notification_count(user_id: int) -> int:
    ensure_schema()
    with connect() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        ).fetchone()[0])


def mark_notification_read(notification_id: int, user_id: int) -> bool:
    """Mark one of YOUR OWN notifications as read. Somebody else's does not
    exist as far as this call is concerned."""
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?"
            " AND read_at IS NULL",
            (_now(), notification_id, user_id),
        )
        return cursor.rowcount > 0


def mark_all_notifications_read(user_id: int) -> int:
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
            (_now(), user_id),
        )
        return cursor.rowcount


def pairing_status(space_id: int | None) -> str:
    """DEPRECATED — legacy compatibility with the pairing-era front-end.

    This used to mean "is this two-person space full yet", and the pages used
    it as an entry gate. Spaces are no longer two-person and no account is
    "unpaired": a person has a space from the moment they register.

    Kept only so the current front-end keeps working until its next revision.
    It now answers one question — does this session have a space it can look
    at — and Phase 3's UI update removes it.

    The real state lives in the space itself: its type and its member count.
    """
    return "paired" if space_id is not None else "unpaired"


def space_summary(space_id: int, user_id: int | None = None) -> dict[str, Any] | None:
    """A space as the pages may see it: no usernames, no account internals."""
    space = get_space(space_id)
    if space is None:
        return None

    members = get_space_members(space_id)
    mine = next((m for m in members if m["userId"] == user_id), None)

    return {
        "id": space["id"],
        "name": space["name"],
        # "personal" or "group" — what the space is for, not who is in it. A
        # space for two and a space for twelve are both groups.
        "type": space["spaceType"],
        "status": space["status"],
        "createdAt": space["createdAt"],
        "membershipRole": mine["memberRole"] if mine else None,
        "memberCount": len(members),
        "members": [
            {
                "id": m["userId"],
                "displayName": m["displayName"],
                "membershipRole": m["memberRole"],
                "joinedAt": m["joinedAt"],
            }
            for m in members
        ],
    }


# --- activity feed ---------------------------------------------------------

def list_activities(limit: int = 20, space_id: int | None = None) -> list[dict[str, Any]]:
    """The event log, with only display-safe identity attached.

    An activity whose memory is private is not returned at all. The rule is on
    the READ rather than on the row, deliberately: a memory that was standard
    for a year and then became private leaves a year of entries behind, and the
    history of a space must not become the way a private memory is discovered.
    The rows stay where they are — they are the space's record — and the filter
    is what keeps them out of sight.

    `memory_id IS NULL` (a plan, an anniversary, a deleted memory) is kept: the
    LEFT JOIN gives NULL, which is not 'private'.
    """
    ensure_schema()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.action_type, a.created_at, a.metadata_json,
                   a.memory_id,
                   u.display_name AS actor_name, u.role AS actor_role,
                   m.title AS memory_title, m.date AS memory_date
              FROM activities a
              LEFT JOIN users u ON u.id = a.actor_user_id
              LEFT JOIN memories m ON m.id = a.memory_id
             WHERE (? IS NULL OR a.space_id = ?)
               AND (m.privacy_mode IS NULL OR m.privacy_mode = 'standard')
             ORDER BY a.id DESC
             LIMIT ?
            """,
            (space_id, space_id, int(limit)),
        ).fetchall()

    out = []
    for row in rows:
        out.append({
            "id": row["id"],
            "type": row["action_type"],
            "actor": ({"displayName": row["actor_name"], "role": row["actor_role"]}
                      if row["actor_name"] else None),
            "memory": ({"id": f"backend-{row['memory_id']}", "title": row["memory_title"]}
                       if row["memory_id"] is not None else None),
            # What the action recorded about itself. A deleted memory has no row
            # left to read a title from, so this is the only place the title it
            # removed still exists. It never holds account details.
            "metadata": (json.loads(row["metadata_json"])
                         if row["metadata_json"] else None),
            "createdAt": row["created_at"],
        })
    return out


def unread_activity_count(user_id: int) -> int:
    ensure_schema()
    with connect() as conn:
        row = conn.execute(
            "SELECT last_seen_activity_id FROM notification_state WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        last = row["last_seen_activity_id"] if row and row["last_seen_activity_id"] else 0
        # Your own actions are never "unread" to you — and neither is anything
        # the reader cannot see, because a count is a discovery surface too: a
        # badge reading "3" over a list of one would be the private archive
        # announcing itself through arithmetic.
        count = conn.execute(
            """
            SELECT COUNT(*)
              FROM activities a
              LEFT JOIN memories m ON m.id = a.memory_id
             WHERE a.id > ?
               AND (a.actor_user_id IS NULL OR a.actor_user_id != ?)
               AND (m.privacy_mode IS NULL OR m.privacy_mode = 'standard')
            """,
            (last, user_id),
        ).fetchone()[0]
    return int(count)


def mark_activities_read(user_id: int) -> int:
    """Record how far this editor has read. One row per person, not one row per
    activity — the log itself is the only copy of what happened."""
    ensure_schema()
    with connect() as conn:
        top = conn.execute("SELECT COALESCE(MAX(id), 0) FROM activities").fetchone()[0]
        conn.execute(
            "INSERT INTO notification_state (user_id, last_seen_activity_id, updated_at)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(user_id) DO UPDATE SET"
            " last_seen_activity_id = excluded.last_seen_activity_id,"
            " updated_at = excluded.updated_at",
            (user_id, top, _now()),
        )
    return int(top)


# --- editing (the permission layer exists; the UI comes later) -------------

def delete_memory(memory_id: int, actor_user_id: int | None = None,
                  space_id: int | None = None) -> list[str]:
    """Remove a memory and report which files the caller must delete.

    The row goes first, in one transaction; the photographs' rows follow it
    through `ON DELETE CASCADE`, and so does the private ACL. Only after that
    commit does the caller touch the disk, so an unreferenced file is the worst
    case — never a row pointing at a photograph that is already gone.

    Deleting a PRIVATE memory also removes every activity that mentions it. That
    is the one case the read-side filter cannot cover: once the memory's row is
    gone, an old activity for it has no privacy_mode left to be filtered by, and
    its metadata still holds the title. A private memory writes no activity of
    its own, so this only ever cleans up entries from before it was private.

    Returns the filenames, which is everything main.py needs to clean up.
    """
    ensure_schema()
    guard, guard_params = _space_guard("memories", memory_id, space_id)

    with connect() as conn:
        rows = conn.execute(
            "SELECT id, filename FROM photos WHERE memory_id = ?", (memory_id,)
        ).fetchall()
        filenames = [r["filename"] for r in rows]
        title_row = conn.execute(
            f"SELECT title, privacy_mode FROM memories WHERE id = ?{guard}",
            (memory_id, *guard_params),
        ).fetchone()
        if title_row is None:
            # Not this space's memory — or not a memory at all. Either way
            # there is nothing here for this caller to delete.
            return []

        was_private = title_row["privacy_mode"] == PRIVATE

        conn.execute(f"DELETE FROM memories WHERE id = ?{guard}", (memory_id, *guard_params))

        if was_private:
            conn.execute("DELETE FROM activities WHERE memory_id = ?", (memory_id,))
            return filenames

        # The memory is gone, so memory_id is NULL here — the activity keeps the
        # title instead, which is the only way to say what was removed.
        # activities.memory_id is ON DELETE SET NULL for exactly this case.
        _insert_activity(
            conn, actor_user_id, "memory_deleted", None, _now(),
            {
                "memoryTitle": title_row["title"] if title_row else "",
                "photoCount": len(filenames),
            },
            space_id=space_id,
        )
    return filenames


def set_cover_photo(memory_id: int, photo_id: int, space_id: int | None = None) -> bool:
    """Make one of a memory's own photographs its cover.

    Both statements run in one transaction, so there is no moment at which the
    memory has two covers or none. A photograph belonging to another memory
    matches nothing, and the call reports failure.
    """
    ensure_schema()
    # Reached through the memory, so the memory's space is the check — a
    # photograph does not carry one of its own.
    owned_sql = ("SELECT p.id FROM photos p JOIN memories m ON m.id = p.memory_id"
                 " WHERE p.id = ? AND p.memory_id = ?")
    owned_params: list[Any] = [photo_id, memory_id]
    if space_id is not None:
        owned_sql += " AND m.space_id = ?"
        owned_params.append(space_id)

    with connect() as conn:
        owned = conn.execute(owned_sql, owned_params).fetchone()
        if owned is None:
            return False

        conn.execute("UPDATE photos SET is_cover = 0 WHERE memory_id = ?", (memory_id,))
        conn.execute(
            "UPDATE photos SET is_cover = 1 WHERE id = ? AND memory_id = ?",
            (photo_id, memory_id),
        )
    return True


def update_memory(memory_id: int, changes: dict[str, Any], actor_user_id: int | None,
                  space_id: int | None = None, log_activity: bool = True) -> bool:
    """Update the fields a form may change. Attribution is set here, never sent.

    With a space given, a memory belonging to another space matches nothing and
    the call reports failure without changing a single field.

    `log_activity` is False for the private archive. A private memory has no
    entry in the space's shared history — not when it is made, and not when it
    is edited — because the history is read by everybody in the space and the
    memory is not."""
    ensure_schema()
    allowed = ("title", "date", "time", "country", "city", "place_name",
               "latitude", "longitude", "weather", "temperature", "mood",
               "description", "favorite", "show_on_timeline")
    sets, values = [], []
    for key in allowed:
        if key in changes:
            sets.append(f"{key} = ?")
            values.append(changes[key])
    if not sets:
        return False

    sets.append("updated_by_user_id = ?")
    values.append(actor_user_id)
    sets.append("updated_at = ?")
    values.append(_now())
    values.append(memory_id)
    guard, guard_params = _space_guard("memories", memory_id, space_id)
    values.extend(guard_params)

    with connect() as conn:
        cursor = conn.execute(
            f"UPDATE memories SET {', '.join(sets)} WHERE id = ?{guard}", values
        )
        if cursor.rowcount == 0:
            return False
        if log_activity:
            _insert_activity(conn, actor_user_id, "memory_updated", memory_id, _now(),
                             None, space_id=space_id)
    return True


# ===========================================================================
# Plan the Future
#
# Duration and status are derived, never stored: a plan's length is its dates,
# and whether it is upcoming or completed is a question about today.
# ===========================================================================

PLAN_SELECT = """
SELECT p.*,
       c.id           AS creator_id,
       c.display_name AS creator_name,
       c.role         AS creator_role,
       e.id           AS editor_id,
       e.display_name AS editor_name,
       e.role         AS editor_role
  FROM future_plans p
  LEFT JOIN users c ON c.id = p.created_by_user_id
  LEFT JOIN users e ON e.id = p.updated_by_user_id
"""


def _plan_duration(start_date: str, end_date: str) -> int:
    """Inclusive: the 12th to the 18th is seven days, not six."""
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except (TypeError, ValueError):
        return 0
    return max(0, (end - start).days + 1)


def _plan_status(end_date: str, today: str | None = None) -> str:
    """Upcoming while its last day is today or later, completed after that."""
    today = today or date.today().isoformat()
    return "upcoming" if str(end_date) >= today else "completed"


def _row_to_plan(row: sqlite3.Row, days: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The shape the front-end reads. Duration and status are computed here."""
    start_date = row["start_date"] or ""
    end_date = row["end_date"] or ""
    return {
        "id": row["id"],
        "title": row["title"],
        "location": row["location"],
        "startDate": start_date,
        "endDate": end_date,
        "duration": _plan_duration(start_date, end_date),
        "status": _plan_status(end_date),
        "description": row["description"] or "",
        "transportation": row["transportation"] or "",
        "accommodation": row["accommodation"] or "",
        "notes": row["notes"] or "",
        "days": days if days is not None else [],
        "createdBy": _who(row, "creator"),
        "updatedBy": _who(row, "editor"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"] if "updated_at" in row.keys() else None,
    }


def _days_for_plans(conn: sqlite3.Connection, plan_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    """Every day of every plan asked for, with its activities, in two queries."""
    if not plan_ids:
        return {}

    marks = ",".join("?" for _ in plan_ids)
    day_rows = conn.execute(
        f"SELECT * FROM future_plan_days WHERE plan_id IN ({marks})"
        " ORDER BY plan_id, day_number",
        plan_ids,
    ).fetchall()

    day_ids = [row["id"] for row in day_rows]
    by_day: dict[int, list[dict[str, Any]]] = {}
    if day_ids:
        marks = ",".join("?" for _ in day_ids)
        for activity in conn.execute(
            f"SELECT * FROM future_plan_activities WHERE day_id IN ({marks})"
            " ORDER BY day_id, sort_order, id",
            day_ids,
        ):
            by_day.setdefault(activity["day_id"], []).append(
                {"id": activity["id"], "text": activity["text"],
                 "sortOrder": activity["sort_order"]}
            )

    out: dict[int, list[dict[str, Any]]] = {}
    for row in day_rows:
        out.setdefault(row["plan_id"], []).append({
            "id": row["id"],
            "dayNumber": row["day_number"],
            "date": row["date"],
            "activities": by_day.get(row["id"], []),
        })
    return out


def list_future_plans(space_id: int | None = None) -> list[dict[str, Any]]:
    """Every plan of one space, each with its days. Ordering is the caller's."""
    ensure_schema()
    sql = PLAN_SELECT
    params: tuple[Any, ...] = ()
    if space_id is not None:
        sql += " WHERE p.space_id = ?"
        params = (space_id,)

    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
        days = _days_for_plans(conn, [row["id"] for row in rows])
    return [_row_to_plan(row, days.get(row["id"], [])) for row in rows]


def get_future_plan(plan_id: int, space_id: int | None = None) -> dict[str, Any] | None:
    ensure_schema()
    sql = PLAN_SELECT + " WHERE p.id = ?"
    params: list[Any] = [plan_id]
    if space_id is not None:
        sql += " AND p.space_id = ?"
        params.append(space_id)

    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
        if row is None:
            return None
        days = _days_for_plans(conn, [plan_id])
    return _row_to_plan(row, days.get(plan_id, []))


def _write_days(
    conn: sqlite3.Connection,
    plan_id: int,
    days: Iterable[dict[str, Any]],
) -> None:
    """Replace a plan's days and activities with exactly what was sent."""
    conn.execute("DELETE FROM future_plan_days WHERE plan_id = ?", (plan_id,))
    for day in days:
        cursor = conn.execute(
            "INSERT INTO future_plan_days (plan_id, day_number, date) VALUES (?, ?, ?)",
            (plan_id, int(day.get("dayNumber", 0)), str(day.get("date") or "")),
        )
        day_id = int(cursor.lastrowid)
        for order, activity in enumerate(day.get("activities") or []):
            text = str((activity or {}).get("text") or "").strip()
            if not text:
                continue
            conn.execute(
                "INSERT INTO future_plan_activities (day_id, text, sort_order)"
                " VALUES (?, ?, ?)",
                (day_id, text, order),
            )


def create_future_plan(plan: dict[str, Any], actor_user_id: int | None,
                       space_id: int | None = None) -> dict[str, Any]:
    """One plan, its days and their activities, in a single transaction.

    A failure part-way through leaves nothing behind: the whole insert rolls
    back with the connection, so a half-written itinerary cannot exist.
    """
    ensure_schema()
    created_at = _now()

    with connect() as conn:                       # commits on success
        cursor = conn.execute(
            """
            INSERT INTO future_plans (
                title, location, start_date, end_date, description,
                transportation, accommodation, notes,
                created_by_user_id, created_at, space_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan["title"], plan["location"], plan["start_date"], plan["end_date"],
                plan["description"], plan.get("transportation") or "",
                plan.get("accommodation") or "", plan.get("notes") or "",
                actor_user_id, created_at, space_id,
            ),
        )
        plan_id = int(cursor.lastrowid)
        _write_days(conn, plan_id, plan.get("days") or [])

    created = get_future_plan(plan_id)
    assert created is not None
    return created


def update_future_plan(
    plan_id: int,
    plan: dict[str, Any],
    actor_user_id: int | None,
    space_id: int | None = None,
) -> dict[str, Any] | None:
    """Change a plan. Its days are replaced wholesale, so shortening a trip
    removes the days that no longer exist rather than leaving them behind."""
    ensure_schema()
    with connect() as conn:
        guard, guard_params = _space_guard("future_plans", plan_id, space_id)
        existing = conn.execute(
            f"SELECT id FROM future_plans WHERE id = ?{guard}", (plan_id, *guard_params)
        ).fetchone()
        if existing is None:
            return None

        conn.execute(
            """
            UPDATE future_plans
               SET title = ?, location = ?, start_date = ?, end_date = ?,
                   description = ?, transportation = ?, accommodation = ?,
                   notes = ?, updated_by_user_id = ?, updated_at = ?
             WHERE id = ?
            """,
            (
                plan["title"], plan["location"], plan["start_date"], plan["end_date"],
                plan["description"], plan.get("transportation") or "",
                plan.get("accommodation") or "", plan.get("notes") or "",
                actor_user_id, _now(), plan_id,
            ),
        )
        if "days" in plan:
            _write_days(conn, plan_id, plan.get("days") or [])

    return get_future_plan(plan_id)


def delete_future_plan(plan_id: int, space_id: int | None = None) -> bool:
    """Remove a plan. Its days and their activities go with it, by cascade."""
    ensure_schema()
    guard, guard_params = _space_guard("future_plans", plan_id, space_id)
    with connect() as conn:
        cursor = conn.execute(
            f"DELETE FROM future_plans WHERE id = ?{guard}", (plan_id, *guard_params)
        )
        if cursor.rowcount == 0:
            return False
    return True


# =============================================================================
# Anniversaries
#
# A date that comes round every year, created on purpose. `original_date` is
# the only fact stored; the next occurrence, the days remaining, the
# anniversary number and the list of past anniversaries are all derived from it
# and today's date, in one place, so no two callers can disagree about what a
# row means.
# =============================================================================

ANNIVERSARY_SELECT = """
SELECT a.*,
       c.id           AS creator_id,
       c.display_name AS creator_name,
       c.role         AS creator_role,
       e.id           AS editor_id,
       e.display_name AS editor_name,
       e.role         AS editor_role
  FROM anniversaries a
  LEFT JOIN users c ON c.id = a.created_by_user_id
  LEFT JOIN users e ON e.id = a.updated_by_user_id
"""


def _row_to_anniversary(row: sqlite3.Row) -> dict[str, Any]:
    """The stored facts only.

    Nothing here is computed: the front-end derives the next occurrence and
    everything that follows from it. The server deliberately does not send a
    second opinion about which anniversary is next.
    """
    return {
        "id": row["id"],
        "title": row["title"],
        "originalDate": row["original_date"] or "",
        "note": row["note"] or "",
        "createdBy": _who(row, "creator"),
        "updatedBy": _who(row, "editor"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"] if "updated_at" in row.keys() else None,
    }


def list_anniversaries(space_id: int | None = None) -> list[dict[str, Any]]:
    """Every anniversary of one space. Ordering is the caller's business — the
    order that matters is by *next occurrence*, which depends on today."""
    ensure_schema()
    sql = ANNIVERSARY_SELECT
    params: tuple[Any, ...] = ()
    if space_id is not None:
        sql += " WHERE a.space_id = ?"
        params = (space_id,)
    sql += " ORDER BY a.id"

    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_row_to_anniversary(row) for row in rows]


def get_anniversary(anniversary_id: int, space_id: int | None = None) -> dict[str, Any] | None:
    ensure_schema()
    sql = ANNIVERSARY_SELECT + " WHERE a.id = ?"
    params: list[Any] = [anniversary_id]
    if space_id is not None:
        sql += " AND a.space_id = ?"
        params.append(space_id)

    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return _row_to_anniversary(row) if row is not None else None


def create_anniversary(
    anniversary: dict[str, Any], actor_user_id: int | None,
    space_id: int | None = None,
) -> dict[str, Any]:
    ensure_schema()
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO anniversaries (
                title, original_date, note,
                created_by_user_id, created_at, space_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                anniversary["title"], anniversary["original_date"],
                anniversary.get("note") or "", actor_user_id, _now(), space_id,
            ),
        )
        anniversary_id = int(cursor.lastrowid)

    created = get_anniversary(anniversary_id)
    assert created is not None
    return created


def update_anniversary(
    anniversary_id: int,
    anniversary: dict[str, Any],
    actor_user_id: int | None,
    space_id: int | None = None,
) -> dict[str, Any] | None:
    """Change a title, a date or a note.

    Moving the date moves everything the page shows, because nothing derived
    from it was ever stored: the next occurrence, the countdown and the past
    anniversaries are recomputed on the next read.
    """
    ensure_schema()
    with connect() as conn:
        guard, guard_params = _space_guard("anniversaries", anniversary_id, space_id)
        existing = conn.execute(
            f"SELECT id FROM anniversaries WHERE id = ?{guard}",
            (anniversary_id, *guard_params),
        ).fetchone()
        if existing is None:
            return None

        conn.execute(
            """
            UPDATE anniversaries
               SET title = ?, original_date = ?, note = ?,
                   updated_by_user_id = ?, updated_at = ?
             WHERE id = ?
            """,
            (
                anniversary["title"], anniversary["original_date"],
                anniversary.get("note") or "", actor_user_id, _now(),
                anniversary_id,
            ),
        )

    return get_anniversary(anniversary_id)


def delete_anniversary(anniversary_id: int, space_id: int | None = None) -> bool:
    """Remove a date. There is nothing hanging off it to cascade — history is
    computed, never stored as rows."""
    ensure_schema()
    guard, guard_params = _space_guard("anniversaries", anniversary_id, space_id)
    with connect() as conn:
        cursor = conn.execute(
            f"DELETE FROM anniversaries WHERE id = ?{guard}",
            (anniversary_id, *guard_params),
        )
        if cursor.rowcount == 0:
            return False
    return True
