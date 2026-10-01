"""LoveStory — first backend phase.

The single job of this service is to make an upload real:

    a photograph chosen in the Photo Library is written to disk,
    its memory is written to SQLite,
    and both survive a browser refresh, a browser restart and a server restart.

Login is untouched (still the front-end passphrase gate). The Hub, the Memory
Map and the Timeline keep reading their existing data for now.

Run it either way:

    cd backend && python -m uvicorn main:app --reload --port 8000
    python -m uvicorn backend.main:app --reload --port 8000
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import date as _date, datetime, timedelta, timezone
from typing import Any

from fastapi import (Body, Cookie, Depends, FastAPI, File, Form, HTTPException,
                     Request, Response, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

try:                       # running as `uvicorn backend.main:app` from the root
    from backend import auth
    from backend import database as db
except ImportError:        # running as `uvicorn main:app` from backend/
    import auth           # type: ignore[no-redef]
    import database as db  # type: ignore[no-redef]

# --- the front-end is served statically, this API by uvicorn -----------------
# Deliberately NOT a wildcard: the photographs and memories are private, and a
# wildcard origin together with credentialed requests is both unsafe and, by
# the spec, not something a browser will honour.
#
# Development matches any loopback port, because the static server's port is not
# fixed — Live Server picks one and it changes. Production reads an explicit
# list from the environment, because a relaxed loopback rule is only ever right
# on the machine you are developing on. With no list configured in production
# the API answers same-origin requests only, which is exactly what a reverse
# proxy at /api needs.
DEVELOPMENT_ORIGINS = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:5501",
    "http://localhost:5501",
]
LOOPBACK_ORIGIN_PATTERN = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"

FRONTEND_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in (os.environ.get("LOVE_STORY_FRONTEND_ORIGINS") or "").split(",")
    if origin.strip()
]

if FRONTEND_ORIGINS:
    ALLOWED_ORIGINS = FRONTEND_ORIGINS
    ALLOWED_ORIGIN_PATTERN = None          # an explicit list is honoured exactly
elif auth.IS_PRODUCTION:
    ALLOWED_ORIGINS = []
    ALLOWED_ORIGIN_PATTERN = None
else:
    ALLOWED_ORIGINS = DEVELOPMENT_ORIGINS
    ALLOWED_ORIGIN_PATTERN = LOOPBACK_ORIGIN_PATTERN

# Declared type AND the bytes themselves are both checked, so renaming a text
# file to .jpg does not get it stored.
ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
ALIASED_TYPES = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg"}

MAX_PHOTO_BYTES = 25 * 1024 * 1024      # 25 MB per photograph
MAX_PHOTOS_PER_MEMORY = 20              # the same ceiling the form offers
CHUNK = 1024 * 1024

# The media route serves files out of this directory, and it checks that it
# exists at import time — before lifespan runs — so make sure it is there first.
db.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# The schema is created here as well as in lifespan. Both are safe and
# additive, and doing it at import means the tables exist even if a server is
# started in a way that never runs the lifespan. It is NEVER destructive: only
# CREATE ... IF NOT EXISTS runs, so an existing archive is untouched.
db.init_db()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Confirm the archive is ready, then say where it is.

    Re-running init_db() here is what repairs a database that was deleted,
    replaced or truncated while a previous server was still running — the
    cause of "no such table: memories" on a long-lived process.
    """
    db.init_db()
    status = db.schema_status()

    print("Love Story API")
    print(f"  database : {status['path']}")
    print(f"  tables   : {', '.join(status['tables']) or '(none)'}")
    print(f"  uploads  : {db.UPLOAD_DIR}")
    # The startup line is a server diagnostic, not an interface: it counts every
    # memory, including the private ones no page is ever told about. It goes to
    # the terminal of whoever runs the archive, which is the one place allowed
    # to know.
    print(f"  memories : {db.count_memories(privacy=None)}"
          f" ({db.count_memories()} standard)")
    print(f"  privacy  : unlock {auth.PRIVACY_UNLOCK_MINUTES} min,"
          f" {auth.PRIVACY_MAX_ATTEMPTS} tries then {auth.PRIVACY_COOLDOWN_SECONDS}s")
    print(f"  ready    : {'yes' if status['ready'] else 'NO — CHECK PERMISSIONS'}")
    print(f"  env      : {auth.ENVIRONMENT}")
    print(f"  origins  : {', '.join(ALLOWED_ORIGINS) or '(same-origin only)'}")
    print(f"  cookie   : secure={'yes' if auth.COOKIE_SECURE else 'no'}"
          f" samesite={auth.COOKIE_SAMESITE}")
    print(f"  started  : {datetime.now().isoformat(timespec='seconds')}", flush=True)
    yield


app = FastAPI(title="Love Story API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_PATTERN,
    # The session lives in an HttpOnly cookie, so credentials must be allowed.
    # That is safe only because the origin is always a specific list: a wildcard
    # origin together with credentials is the combination that must never ship,
    # and a browser will refuse it in any case.
    allow_credentials=True,
    # PATCH and DELETE matter: without them the browser's preflight for an
    # edit or a delete is refused, and the request is never even sent.
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# The photographs are NOT a static directory any more.
#
# They used to be mounted here with StaticFiles, which meant /uploads/<name>
# answered anybody who knew the name — no session, no membership, no privacy.
# That was survivable while every memory was shared with everybody in the
# archive. With a private archive it is not: a private photograph that can be
# fetched by URL is a private photograph that is not private, whatever the
# interface does with it.
#
# So the mount is gone and GET /uploads/{filename} below is the only way to a
# file. The URL shape is unchanged, which is the point: every <img> in the
# front-end keeps working, and the authorisation happens behind it.


# --- helpers -----------------------------------------------------------------

def _sniff_image(header: bytes) -> str | None:
    """Identify a real image from its magic bytes, not from its filename."""
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _number(value: Any) -> float | None:
    """Empty strings from a form arrive as None already; anything else must
    parse, and a value that does not parse is simply not recorded."""
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _discard(saved: list[dict[str, Any]]) -> None:
    """Remove photographs already written, so a failed save leaves nothing."""
    for photo in saved:
        try:
            (db.UPLOAD_DIR / photo["filename"]).unlink(missing_ok=True)
        except OSError:
            pass


async def _store_photo(upload: UploadFile) -> dict[str, Any]:
    """Validate one upload and write it under a generated name."""
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    declared = ALIASED_TYPES.get(declared, declared)

    header = await upload.read(32)

    if not header:
        raise HTTPException(
            status_code=400,
            detail=f"'{upload.filename or 'file'}' is an empty file.",
        )

    sniffed = _sniff_image(header)

    if sniffed is None or declared not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"'{upload.filename or 'file'}' is not a JPEG, PNG or WebP image. "
                "Only those three are accepted."
            ),
        )

    extension = ALLOWED_TYPES[sniffed]
    filename = f"{uuid.uuid4().hex}{extension}"
    target = db.UPLOAD_DIR / filename

    written = 0
    try:
        with target.open("wb") as out:
            out.write(header)
            written += len(header)
            while True:
                chunk = await upload.read(CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_PHOTO_BYTES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"'{upload.filename or 'file'}' is larger than 25 MB.",
                    )
                out.write(chunk)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except OSError as error:
        target.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500, detail=f"Could not write the photograph: {error}"
        ) from error

    if written <= len(header):
        target.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=f"'{upload.filename or 'file'}' is empty.",
        )

    return {
        "filename": filename,
        "original_name": upload.filename or "",
    }


# A space id that cannot exist, for "this reader gets nothing".
NO_SPACE = -1


def _absolute(memory: dict[str, Any], request: Request) -> dict[str, Any]:
    """Photo URLs are returned absolute, so the front-end can use them as-is.

    The URL is the same one it has always been — /uploads/<name> — because the
    media route now does the authorising. Nothing in the front-end has to change
    for a photograph to go from public to permitted.
    """
    base = str(request.base_url).rstrip("/")
    for photo in memory["photos"]:
        if photo["url"].startswith("/"):
            photo["url"] = base + photo["url"]
    return memory


# --- the private archive's request shapes ------------------------------------

def _private_access_payload(raw: str | None) -> list[dict[str, Any]]:
    """Read a private ACL from a form field.

    It arrives as JSON in one field because the rest of the form is
    multipart — a memory is created with its photographs in the same request,
    and there is no second JSON body to put a list in. Bad JSON is the caller's
    mistake and is answered as one.
    """
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400,
                            detail="That access list could not be read.") from None
    if not isinstance(parsed, list):
        raise HTTPException(status_code=400,
                            detail="That access list could not be read.")
    try:
        return db.normalize_private_access(parsed)
    except db.PrivacyRefused as refusal:
        raise _privacy_http(refusal) from refusal


def _check_private_targets(space, entries: list[dict[str, Any]],
                           actor_id: int) -> None:
    """Everybody named must be an ACTIVE member of THIS space, and the owner
    need not be named at all.

    Two rules in one place, because both are about the same sentence: a private
    memory of a space may only be shared with the people in that space.

      · a personal space has nobody else in it, so an access list for one is
        refused rather than quietly emptied — silence there would look like it
        had worked;
      · naming the owner is allowed and simply ignored: ownership is a fact
        about the memory, not a row somebody may hand out.
    """
    if not entries:
        return
    if space["spaceType"] != "group":
        raise HTTPException(
            status_code=400,
            detail="A personal space has nobody else to share a private memory with.",
        )
    members = db.active_member_ids(int(space["id"]))
    for entry in entries:
        if int(entry["userId"]) == int(actor_id):
            continue
        if int(entry["userId"]) not in members:
            raise HTTPException(
                status_code=400,
                detail="Only people who are in this space can be given access.",
            )


def _privacy_http(refusal) -> HTTPException:
    """A refused privacy operation as an HTTP answer.

    404 hides the resource, 403 says the caller is known and the action is not
    theirs, 400 is a request that does not make sense. The store raises the
    reason; the status codes are decided here, once.
    """
    codes = {
        "not_private": 404,
        "not_found": 404,
        "not_owner": 403,
        "invalid_access": 400,
        "duplicate_user": 400,
        "not_member": 400,
    }
    return HTTPException(status_code=codes.get(refusal.reason, 400),
                         detail=refusal.message)


# --- routes ------------------------------------------------------------------

def _safe_upload_path(filename: str):
    """The file on disk for a name that came out of the database.

    The name has already been matched against a `photos` row, so it is a name
    this server wrote. This is the second lock on the same door: it refuses
    anything that is not a plain filename, and it refuses a path that resolves
    outside the upload directory — so even a row somehow holding `../../etc/…`
    cannot be turned into a file read. Returns None instead of raising, because
    the caller answers every refusal the same way.
    """
    if not filename or filename != os.path.basename(filename):
        return None
    if filename in (".", "..") or "/" in filename or "\\" in filename:
        return None
    directory = db.UPLOAD_DIR.resolve()
    candidate = (directory / filename).resolve()
    if candidate.parent != directory:
        return None
    if not candidate.is_file():
        return None
    return candidate


@app.get("/uploads/{filename}")
def read_upload(filename: str,
                user=Depends(auth.current_user),
                session=Depends(auth.current_session)):
    """A photograph, to somebody allowed to see it.

    The order of the refusals is the point:

      1. no session at all -> 401, WITHOUT looking at the filename. A stranger
         guessing names learns nothing, not even whether a file exists.
      2. the name must belong to a photograph this server recorded -> 404.
      3. the photograph's memory must be in a space the caller is an ACTIVE
         member of -> 404. Membership, not ownership: an archive's photographs
         are for the people in the space.
      4. a PRIVATE memory needs, in addition, permission on that memory and an
         unlocked private archive -> 404 either way, because a media URL is a
         thing people copy and paste: whether it fails because you were never
         trusted with it or because the archive is locked is not something the
         URL should say.

    Cache-Control is where the lock is made to mean something beyond the moment
    it is checked. A private photograph is `no-store`, so closing the archive
    also closes the copy in the browser's cache; a standard one may be kept
    privately, which is what stops every scroll through the gallery being a
    round trip, without ever letting a shared cache hold it.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in to view this.")

    user_id = int(user["id"])
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=404, detail="That photograph is not in the archive.")

    photo = db.photo_for_media(filename)
    if photo is None or photo["spaceId"] is None:
        raise HTTPException(status_code=404, detail="That photograph is not in the archive.")

    if not db.is_space_member(user_id, int(photo["spaceId"])):
        raise HTTPException(status_code=404, detail="That photograph is not in the archive.")

    private = photo["privacyMode"] == db.PRIVATE
    if private:
        if db.private_memory_permission(int(photo["memoryId"]), user_id) == "none":
            raise HTTPException(status_code=404,
                                detail="That photograph is not in the archive.")
        if not auth.privacy_unlocked(session):
            # PART 71: a copied URL must fail for the person who was not given
            # the memory, and for the person whose archive is closed.
            raise HTTPException(status_code=404,
                                detail="That photograph is not in the archive.")
        # Using the private archive is what keeps it open. Fetching the
        # photograph is using it.
        auth.touch_privacy(session)

    path = _safe_upload_path(photo["filename"])
    if path is None:
        raise HTTPException(status_code=404, detail="That photograph is not in the archive.")

    headers = {
        "Cache-Control": ("private, no-store" if private else "private, max-age=300"),
        # The answer depends on a cookie, so nothing in between may reuse it.
        "Vary": "Cookie",
    }
    if private:
        headers["Pragma"] = "no-cache"
    return FileResponse(path, headers=headers)


@app.get("/")
def health() -> dict[str, Any]:
    """A quick way to confirm the server, and that the archive is usable.

    Reports whether the tables are present — never any memory content, and
    never the absolute path, which is not the front-end's business.
    """
    status = db.schema_status()
    return {
        "status": "ok",
        "service": "Love Story API",
        "database": "ready" if status["ready"] else "missing schema",
        "tables": status["tables"],
    }


@app.get("/api/memories")
def read_memories(request: Request, reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """The memories of the reader's own space. Not a public endpoint.

    STANDARD memories only, always — including while the private archive is
    unlocked, and including for the person who owns the private ones. This is
    the endpoint behind Moments, the Timeline, Our World, the Gallery and every
    count on the Hub; if a private memory could arrive here, all of them would
    leak it at once.
    """
    _user, space_id = reader
    memories = [_absolute(m, request) for m in db.list_memories(space_id)]
    return {"count": len(memories), "memories": memories}


@app.get("/api/memories/{memory_id}")
def read_memory(memory_id: int, request: Request,
                reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """One STANDARD memory, from the ordinary archive.

    A private memory is 404 here — not 403, and not for anybody, including the
    person who owns it and while their private archive is unlocked. This route is
    the ordinary content layer, and the ordinary content layer must never be a
    way into the private one: an interface cannot leak what it is never given,
    and "we would only return it to the owner" is one bug away from being wrong.
    """
    _user, space_id = reader
    memory = db.get_memory(memory_id, space_id)
    if memory is None:
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")
    return _absolute(memory, request)


@app.post("/api/memories", status_code=201)
async def create_memory(
    request: Request,
    context=Depends(auth.require_space),
    session=Depends(auth.current_session),
    photos: list[UploadFile] = File(default=[]),
    title: str = Form(""),
    date: str = Form(""),
    time: str = Form(""),
    country: str = Form(""),
    city: str = Form(""),
    place_name: str = Form(""),
    latitude: str = Form(""),
    longitude: str = Form(""),
    weather: str = Form(""),
    temperature: str = Form(""),
    mood: str = Form(""),
    description: str = Form(""),
    favorite: str = Form(""),
    show_on_timeline: str = Form(""),
    cover: str = Form("0"),
    privacy_mode: str = Form(""),
    privacyMode: str = Form(""),
    private_access: str = Form(""),
    privateAccess: str = Form(""),
) -> dict[str, Any]:
    # 1. required fields ------------------------------------------------------
    title = title.strip()
    date = date.strip()

    if not title:
        raise HTTPException(status_code=400, detail="A title is required.")
    if not date:
        raise HTTPException(status_code=400, detail="A date is required.")
    if not photos:
        raise HTTPException(
            status_code=400, detail="At least one photograph is required."
        )
    if len(photos) > MAX_PHOTOS_PER_MEMORY:
        raise HTTPException(
            status_code=400,
            detail=f"You can add up to {MAX_PHOTOS_PER_MEMORY} photographs to one memory.",
        )

    # 1b. privacy ------------------------------------------------------------
    # The default is standard: a client that says nothing gets the behaviour it
    # had before this existed.
    user, space = context
    # The field is accepted under either spelling. The rest of this form is
    # snake_case (show_on_timeline, cover_photo_id) and the new fields are
    # camelCase in the interface, so both are read and neither is a second
    # implementation — this is one line, not two routes.
    privacy = (privacy_mode or privacyMode or db.STANDARD).strip().lower()
    if privacy not in (db.STANDARD, db.PRIVATE):
        raise HTTPException(status_code=400,
                            detail="A memory is either standard or private.")
    access: list[dict[str, Any]] = []
    if privacy == db.PRIVATE:
        # Making a private memory is a decision taken inside the unlocked
        # archive, and the archive has to be open at the moment it is taken.
        auth.require_privacy_unlocked(session)
        access = _private_access_payload(private_access or privateAccess)
        _check_private_targets(space, access, int(user["id"]))

    cover_index = 0
    try:
        cover_index = max(0, int(str(cover).strip() or "0"))
    except ValueError:
        cover_index = 0

    # 2. photographs first, so a failure here leaves no database record -------
    saved: list[dict[str, Any]] = []
    try:
        for upload in photos:
            saved.append(await _store_photo(upload))
    except HTTPException:
        _discard(saved)
        raise
    except Exception as error:                                  # noqa: BLE001
        _discard(saved)
        print(f"[error] storing photographs failed: {type(error).__name__}: {error}",
              flush=True)
        raise HTTPException(
            status_code=500,
            detail="Could not save this memory. Please try again.",
        ) from error

    for index, photo in enumerate(saved):
        photo["cover_index"] = cover_index if cover_index < len(saved) else 0

    # 3. one transaction for the memory and its rows --------------------------
    metadata = {
        "title": title,
        "date": date,
        "time": time,
        "country": country,
        "city": city,
        "place_name": place_name,
        "latitude": _number(latitude),
        "longitude": _number(longitude),
        "weather": weather,
        "temperature": _number(temperature),
        "mood": mood,
        "description": description,
        "favorite": _truthy(favorite),
        "show_on_timeline": _truthy(show_on_timeline),
    }

    try:
        # The uploader is taken from the session, never from the form: a
        # browser cannot claim a memory belongs to someone else.
        user, space = context
        memory = db.create_memory(metadata, saved, actor_user_id=user["id"],
                                 space_id=space["id"], privacy_mode=privacy,
                                 access=access)
    except Exception as error:                                  # noqa: BLE001
        # The transaction rolled back, so remove the files it would have owned.
        _discard(saved)
        # The detail belongs in the terminal, not on the visitor's screen.
        print(f"[error] saving a memory failed: {type(error).__name__}: {error}",
              flush=True)
        raise HTTPException(
            status_code=500,
            detail="Could not save this memory. Please try again.",
        ) from error

    memory = _absolute(memory, request)
    if privacy == db.PRIVATE:
        # The creator of a private memory is its owner, so the response carries
        # the shape the private archive would give them — permission, and the
        # ACL they may edit.
        memory["privacyMode"] = db.PRIVATE
        memory["privatePermission"] = "owner"
        memory["privateAccess"] = db.private_access_for_memory(int(memory["id"]))
    return memory


# ===========================================================================
# Authentication
# ===========================================================================

@app.get("/api/auth/setup-status")
def setup_status() -> dict[str, Any]:
    """Tells the Entrance what to offer: set up the archive, join it, or
    simply sign in. Public, and reveals nothing but those three facts."""
    return auth.editor_slots()


@app.post("/api/auth/setup-owner", status_code=201)
def setup_owner(
    response: Response,
    username: str = Form(""),
    display_name: str = Form(""),
    password: str = Form(""),
) -> dict[str, Any]:
    """Create THE owner. Only possible while no owner exists."""
    if db.count_users_with_role("owner") > 0:
        raise HTTPException(
            status_code=409,
            detail="This archive already has an owner. Please sign in instead.",
        )

    username = username.strip()
    display_name = display_name.strip() or username

    if not username:
        raise HTTPException(status_code=400, detail="A username is required.")
    problem = auth.password_problem(password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if db.get_user_by_username(username) is not None:
        raise HTTPException(status_code=409, detail="That username is already taken.")

    user_id = db.create_user(username, display_name, auth.hash_password(password), "owner")
    # The account and the space it opens are created together, so a fresh
    # archive is in exactly the state a migrated one is in. The archive's own
    # space is a GROUP named "Our Space" — the same shape every existing
    # archive was migrated into — and the owner also gets a personal space,
    # because every account has one.
    space_id = db.create_group_space(db.LEGACY_SPACE_NAME, user_id)
    with db.connect() as conn:
        db.open_personal_space(conn, user_id)
    # Account-level, not space-level: this is about a person existing.
    db.log_activity(user_id, "owner_created", None, {"displayName": display_name})

    token = auth.new_token()
    # The session opens on the archive's space, which is where the owner's
    # content is (and will be).
    expires = db.create_session(user_id, auth.hash_token(token),
                                current_space_id=space_id)
    auth.set_session_cookie(response, token, db.SESSION_DAYS * 24 * 3600)

    return {"user": db.public_user(db.get_user(user_id)), "expiresAt": expires,
            "currentSpace": db.space_summary(space_id, user_id),
            "space": db.space_summary(space_id, user_id),
            "pairingStatus": db.pairing_status(space_id)}


@app.post("/api/auth/login")
def login(
    response: Response,
    username: str = Form(""),
    password: str = Form(""),
) -> dict[str, Any]:
    row = db.get_user_by_username(username.strip())
    # One message for both failures, so this cannot be used to discover
    # which usernames exist.
    if row is None or not auth.verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="That username or password is not right.")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="This account is not active.")

    user_id = int(row["id"])
    token = auth.new_token()
    # Continue where they left off: the space of their previous sign-in, or the
    # shared space they are in, or their own. Never nothing — an account always
    # has somewhere to be.
    space_id = (db.last_space_for_user(user_id)
                or db.preferred_space_for_user(user_id))
    expires = db.create_session(user_id, auth.hash_token(token),
                                current_space_id=space_id)
    auth.set_session_cookie(response, token, db.SESSION_DAYS * 24 * 3600)
    return {"user": db.public_user(row), "expiresAt": expires,
            "currentSpace": db.space_summary(space_id, user_id) if space_id else None}


@app.post("/api/auth/logout")
def logout(
    response: Response,
    session: str | None = Cookie(default=None, alias=auth.SESSION_COOKIE),
) -> dict[str, Any]:
    if session:
        db.delete_session(auth.hash_token(session))
    auth.clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user=Depends(auth.current_user),
       session=Depends(auth.current_session)) -> dict[str, Any]:
    """Who is asking. `authenticated: false` is a guest — a perfectly normal
    state in this archive, not an error.

    `can.edit` is the server's own answer, taken from the same rule the write
    endpoints enforce, so a page can never offer a control the server would
    refuse.

    The space's creator also gets the state of the second place — empty,
    invited, or filled. It is reported to the creator alone, and it never
    contains the invitation token: that value exists once, in the reply that
    created it.

    "Creator" means the creator of the space, read from space_members. It used
    to be read from users.role, which was wrong in a way that showed: somebody
    who registered through the new flow holds the legacy role `partner`, so a
    space's own creator was not being told about their own invitation.
    """
    # Which space this SIGN-IN is looking at. A person may be in several; the
    # session decides which one they are working in, and that choice is checked
    # against a live membership every time it is read.
    membership = None
    space = None
    space_count = 0
    if user is not None:
        space = (db.current_space_for_session(auth.hash_token(session))
                 if session else None)
        space_count = len(db.list_spaces_for_user(int(user["id"])))
        if space is not None:
            members = db.get_space_members(int(space["id"]))
            mine = next((m for m in members if m["userId"] == int(user["id"])), None)
            membership = {
                "id": space["id"],
                "name": space["name"],
                "type": space["spaceType"],
                "status": space["status"],
                "membershipRole": mine["memberRole"] if mine else None,
                "memberCount": len(members),
                "members": [
                    {"id": m["userId"], "displayName": m["displayName"],
                     "membershipRole": m["memberRole"], "joinedAt": m["joinedAt"]}
                    for m in members
                ],
            }

    space_id = int(space["id"]) if space else None
    is_creator = membership is not None and membership["membershipRole"] == "creator"

    # Whether the second place is taken is a fact about the space, and it is
    # told to the person who can do something about it.
    partner = db.partner_status(space_id) if is_creator else None
    mine = None
    if membership is not None and user is not None:
        mine = next((m for m in membership["members"] if m["id"] == int(user["id"])), None)

    return {
        "authenticated": user is not None,
        "user": db.public_user(user),
        # The account's own details, told to nobody but the account itself.
        # `public_user` is deliberately not extended: it also attributes
        # memories, and a username must not leak into another member's view.
        "account": ({
            "username": user["username"],
            "displayName": user["display_name"],
            "memberSince": mine["joinedAt"] if mine else None,
        } if user is not None else None),
        # Which world this server is running in. The front-end uses it to decide
        # whether to offer the development-only way past the waiting screen; the
        # rule itself is not secret, and it is never offered in production.
        "environment": auth.ENVIRONMENT,
        "can": {
            # Editing shared content needs a space. The legacy role alone is not
            # enough: an account that has not been paired has nothing to edit,
            # and saying otherwise would light up controls the API refuses.
            "edit": auth.may_edit(user) and space_id is not None,
            # Offered only while the space is genuinely free. Once two people
            # are in it, the button would be a lie.
            "invite": is_creator and not (partner and partner["connected"]),
        },
        "partner": partner,
        # The real shape: which space this session is in, and how many the
        # account has. `space` below is the same object under its old name,
        # kept until the front-end is next revised and then removed.
        "currentSpace": membership,
        "spaceCount": space_count,
        "space": membership,
        # DEPRECATED legacy field. It used to mean "is this two-person space
        # full"; it now only says whether this session has a space at all, so
        # the pairing-era pages keep working. Removed with the UI update.
        "pairingStatus": db.pairing_status(space_id),
    }


# ===========================================================================
# Accounts, spaces and pairing
#
# Three separate ideas, and the API keeps them separate:
#
#   an ACCOUNT   is a person: a username, a display name, a password, sessions.
#   a SPACE      is what two people share: members, and everything inside.
#   PAIRING      is how the second person gets into a space.
#
# An account may exist with no space at all. That is `unpaired`, and it is a
# normal state rather than a broken one — the pages show a choice, not an error.
# ===========================================================================


@app.post("/api/auth/register", status_code=201)
def register(
    response: Response,
    display_name: str = Form(""),
    username: str = Form(""),
    password: str = Form(""),
) -> dict[str, Any]:
    """Create a personal account. Public — this is the front door.

    Deliberately does NOT create a space. A new account is signed in and
    unpaired: the next thing it does is either create its own space or accept
    an invitation into somebody else's, and choosing for it here would be
    guessing at the single most important decision the product asks.

    `users.role` is set to its legacy value for schema compatibility and is not
    consulted for authorisation anywhere. Who may do what is decided by
    space_members.
    """
    username = username.strip()
    display_name = display_name.strip() or username

    if not display_name:
        raise HTTPException(status_code=400, detail="A display name is required.")
    if not username:
        raise HTTPException(status_code=400, detail="A username is required.")
    problem = auth.password_problem(password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if db.get_user_by_username(username) is not None:
        # Stated plainly, and the same for every taken name — it says nothing
        # about who holds it.
        raise HTTPException(status_code=409, detail="Username is not available.")

    # The account and the space it calls its own are made together, so nobody
    # registers into nothing. There is no "unpaired" state any more: a person
    # can use the archive from their first moment.
    with db.connect() as conn:
        user_id = db.create_user(username, display_name,
                                 auth.hash_password(password), "partner")
        personal_id = db.open_personal_space(conn, user_id)[0]

    token = auth.new_token()
    expires = db.create_session(user_id, auth.hash_token(token),
                                current_space_id=personal_id)
    auth.set_session_cookie(response, token, db.SESSION_DAYS * 24 * 3600)

    return {
        "authenticated": True,
        "user": db.public_user(db.get_user(user_id)),
        "currentSpace": db.space_summary(personal_id, user_id),
        "spaceCount": len(db.list_spaces_for_user(user_id)),
        # Legacy alias and legacy field, kept so the current pages do not break.
        "space": db.space_summary(personal_id, user_id),
        "pairingStatus": db.pairing_status(personal_id),
        "expiresAt": expires,
    }


# --- Our Space --------------------------------------------------------------

@app.get("/api/spaces")
def read_spaces(user=Depends(auth.current_user),
                session=Depends(auth.current_session)) -> dict[str, Any]:
    """Every space this account is in.

    Only the caller's own: a space somebody else is in is not mentioned, not
    counted, and not hinted at.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    spaces = db.list_spaces_for_user(int(user["id"]))
    # How many people are waiting to be let in — told only to the people who
    # can see the answer, and only for spaces where the question means
    # something.
    for space in spaces:
        if space["type"] != "group":
            space["pendingJoinRequestCount"] = None
            continue
        if db.is_space_manager(int(user["id"]), int(space["id"])):
            space["pendingJoinRequestCount"] = db.pending_join_request_count(
                int(space["id"]))
        else:
            space["pendingJoinRequestCount"] = None

    current = db.current_space_for_session(auth.hash_token(session))
    return {
        "count": len(spaces),
        "spaces": spaces,
        "currentSpaceId": int(current["id"]) if current else None,
    }


@app.post("/api/spaces", status_code=201)
def create_space(payload: dict[str, Any] = Body(...),
                 user=Depends(auth.current_user),
                 session=Depends(auth.current_session)) -> dict[str, Any]:
    """Open a shared space and become its creator.

    Signing in is the only requirement — an account may already have a personal
    space, and any number of groups. What it may not do is create a second
    personal space: that one is made for it, not by it.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    name = str((payload or {}).get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A name is required.")
    if len(name) > 80:
        raise HTTPException(status_code=400,
                            detail="Please use a shorter name (80 characters at most).")

    # The space and its creator are written together, so a space with nobody in
    # it cannot exist.
    space_id = db.create_group_space(name, int(user["id"]))
    # Making a space is a decision to work in it.
    db.set_session_space(auth.hash_token(session), space_id)

    return {
        "currentSpace": db.space_summary(space_id, int(user["id"])),
        "space": db.space_summary(space_id, int(user["id"])),
        "spaceCount": len(db.list_spaces_for_user(int(user["id"]))),
    }


@app.get("/api/spaces/current")
def read_current_space(user=Depends(auth.current_user),
                       session=Depends(auth.current_session)) -> dict[str, Any]:
    """The space this SIGN-IN is looking at.

    Resolved through the session and verified against a live membership, with
    the account's own space as the fallback — never an arbitrary group.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    space = db.current_space_for_session(auth.hash_token(session))
    if space is None:
        return {"currentSpace": None, "space": None,
                "pairingStatus": "unpaired", "pendingInvitation": None}

    space_id = int(space["id"])
    pending = db.pending_invitation_for_space(space_id)
    return {
        "currentSpace": db.space_summary(space_id, int(user["id"])),
        # Legacy alias: the pages read `space`. It means the same thing now and
        # is removed when the front-end is next revised.
        "space": db.space_summary(space_id, int(user["id"])),
        "spaceCount": len(db.list_spaces_for_user(int(user["id"]))),
        "pairingStatus": db.pairing_status(space_id),
        "pendingInvitation": ({"expiresAt": pending["expires_at"]}
                              if pending is not None else None),
    }


@app.post("/api/spaces/{space_id}/select")
def select_space(space_id: int, user=Depends(auth.current_user),
                 session=Depends(auth.current_session)) -> dict[str, Any]:
    """Work in this space from now on, for this sign-in only.

    A space the caller is not in is answered exactly as a space that does not
    exist: 404, with nothing to learn from the difference.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    if not db.is_space_member(int(user["id"]), space_id):
        raise HTTPException(status_code=404, detail="That space is not in your archive.")

    space = db.get_space(space_id)
    if space is None or space["status"] != "active":
        raise HTTPException(status_code=404, detail="That space is not in your archive.")

    db.set_session_space(auth.hash_token(session), space_id)
    return {
        "currentSpace": db.space_summary(space_id, int(user["id"])),
        "space": db.space_summary(space_id, int(user["id"])),
        "pairingStatus": db.pairing_status(space_id),
    }


# --- pairing invitations ----------------------------------------------------

def _invitation_view(invitation) -> dict[str, Any]:
    """What a person may be told about an invitation they are holding.

    The inviter's display name so the page can say who is asking, and the
    NAME of the space being offered — "Scarlett invited you to Our Space" is
    the plainest way to say what the link is for. Never a username, a user id,
    a space id, a session, or anything else from the account's inside.
    """
    inviter = db.get_user(int(invitation["created_by_user_id"])) \
        if invitation["created_by_user_id"] is not None else None
    space_id = invitation["space_id"] if "space_id" in invitation.keys() else None
    space = db.space_summary(int(space_id), None) if space_id is not None else None

    return {
        "state": db.invitation_state_by_token(invitation["token_hash"]),
        "inviter": {"displayName": inviter["display_name"]} if inviter else None,
        "space": ({"name": space["name"], "memberCount": space["memberCount"]}
                  if space else None),
        "expiresAt": invitation["expires_at"],
    }


def _mint_invitation(user, space) -> dict[str, Any]:
    """Make one invitation for a group. The only place one is ever made.

    Both raw values — the link token and the code — are returned here and
    nowhere else, ever again. The database keeps only their hashes.
    """
    space_id = int(space["id"])

    # A group invites as many people as it likes, so there is no "one at a
    # time" rule. What there is instead is a ceiling that exists only to stop
    # an accident becoming a hundred live ways in.
    if db.active_invitation_count(space_id) >= db.MAX_ACTIVE_INVITATIONS:
        raise HTTPException(
            status_code=409,
            detail=f"This space already has {db.MAX_ACTIVE_INVITATIONS} invitations"
                   " waiting to be used.",
        )

    invitation = db.create_pairing_invitation(int(user["id"]), space_id)
    db.log_activity(int(user["id"]), "partner_invited", None, None, space_id=space_id)

    return {
        "spaceId": space_id,
        # An explicit path rather than "/join": a directory URL makes the
        # static server answer 301 and rely on the redirect preserving the
        # query string. It does, but a link somebody pastes into a chat should
        # not depend on that.
        "inviteUrl": f"/join/index.html?invite={invitation['token']}",
        "token": invitation["token"],
        "pairingCode": invitation["code"],
        "expiresAt": invitation["expiresAt"],
        "expiresInHours": invitation["expiresInHours"],
    }


@app.post("/api/spaces/{space_id}/invitations", status_code=201)
def create_invitation_for(space_id: int,
                          context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """Invite somebody to THIS group, named in the path.

    The session may be looking at a different space entirely — a group's
    members are managed from wherever the person happens to be standing.
    """
    user, space = context
    return _mint_invitation(user, space)


@app.get("/api/spaces/{space_id}/invitations")
def read_invitations(space_id: int,
                     context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """Invitations for this group that can still be used.

    Managers only: an invitation is a way in, and listing them is part of
    running the space.
    """
    _user, space = context
    invitations = db.list_active_invitations(int(space["id"]))
    return {
        "count": len(invitations),
        "invitations": invitations,
        # The raw link and code are gone for ever after they are made; the page
        # shows what is left rather than pretending otherwise.
        "recoverable": False,
    }


@app.delete("/api/spaces/{space_id}/invitations")
def revoke_invitations_for(space_id: int,
                           context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """Withdraw this group's live invitations. A manager's to do."""
    user, space = context
    removed = db.revoke_pending_invitation(int(space["id"]))
    if removed:
        db.log_activity(int(user["id"]), "partner_invite_revoked", None, None,
                        space_id=int(space["id"]))
    return {"ok": True, "revoked": removed}


@app.post("/api/spaces/invitations", status_code=201)
def create_invitation(context=Depends(auth.require_group_manager)) -> dict[str, Any]:
    """Invite somebody to the group this session is looking at.

    Kept for the page that is already written against it; the addressed route
    above is the one new work should use, and both make the invitation through
    the same function.
    """
    user, space = context
    return _mint_invitation(user, space)


@app.delete("/api/spaces/invitations")
def revoke_invitation(context=Depends(auth.require_group_manager)) -> dict[str, Any]:
    """Withdraw the live invitation. The creator's to do, and nobody else's."""
    user, space = context
    removed = db.revoke_pending_invitation(int(space["id"]))
    if removed:
        db.log_activity(int(user["id"]), "partner_invite_revoked", None, None,
                        space_id=int(space["id"]))
    return {"ok": True, "revoked": removed}


@app.post("/api/spaces/invitations/lookup")
def look_up_invitation(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """What a pairing code refers to, so a page can say who is asking.

    A POST rather than a GET: a short code in a URL ends up in logs and in
    browser history, and this one is a way into a private space.
    """
    code = str((payload or {}).get("pairingCode") or "")
    invitation = db.invitation_for_code(code)
    state = db.invitation_state_by_code(code)

    if state != "ok" or invitation is None:
        return {"valid": False, "state": state,
                "reason": db.INVITE_MESSAGES.get(state, "")}

    view = _invitation_view(invitation)
    return {"valid": True, "state": "ok", "reason": "",
            "inviter": view["inviter"], "space": view["space"],
            "expiresAt": view["expiresAt"]}


@app.get("/api/spaces/invitations/{token}")
def read_invitation(token: str) -> dict[str, Any]:
    """What an invitation link refers to, before anyone commits to anything."""
    invitation = db.invitation_for_token(token)
    state = db.invitation_state_by_token(auth.hash_token(token))

    if state != "ok" or invitation is None:
        return {"valid": False, "state": state,
                "reason": db.INVITE_MESSAGES.get(state, "")}

    view = _invitation_view(invitation)
    return {"valid": True, "state": "ok", "reason": "",
            "inviter": view["inviter"], "space": view["space"],
            "expiresAt": view["expiresAt"]}


def _request_to_join(invitation_token: str | None, pairing_code: str | None,
                     user) -> dict[str, Any]:
    """The single way to ASK to join a group, whichever invitation arrived.

    It used to make somebody a member. It now makes a request, because the
    person who made the space is the one who decides who is in it.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    try:
        result = db.create_join_request(
            int(user["id"]), token=invitation_token, code=pairing_code)
    except db.PairingRefused as refusal:
        code = 409 if refusal.reason in {"already_member", "reviewed"} else 403
        if refusal.reason == "personal_space":
            code = 403
        raise HTTPException(status_code=code, detail=refusal.message) from refusal

    # Membership is not a change to the space's content, so this is an
    # activity, not a notification to everybody.
    db.log_activity(int(user["id"]), "join_requested", None,
                    {"displayName": user["display_name"]},
                    space_id=result["joinRequest"]["spaceId"])

    return result


@app.post("/api/spaces/invitations/accept-code")
def accept_by_code(payload: dict[str, Any] = Body(...),
                   user=Depends(auth.current_user)) -> dict[str, Any]:
    """Ask to join, by typing the code somebody sent. Signed in."""
    code = str((payload or {}).get("pairingCode") or "")
    return _request_to_join(None, code, user)


@app.post("/api/spaces/invitations/{token}/accept")
def accept_by_token(token: str, user=Depends(auth.current_user)) -> dict[str, Any]:
    """Ask to join, from an invitation link. Signed in."""
    return _request_to_join(token, None, user)


# ===========================================================================
# Managing a group
#
# Everything here is addressed by an explicit space id, never by "the current
# space": the members of one group are managed from a page that may be open
# while the session is looking at another. Who may do what is decided by
# auth.addressed_manager / addressed_creator, against THAT space.
# ===========================================================================


@app.get("/api/spaces/{space_id}/members")
def read_space_members(space_id: int,
                       context=Depends(auth.addressed_group)) -> dict[str, Any]:
    """Who is in this space. Any member may see the list.

    Display names, roles and dates only — never a username, a session or
    anything from an account's private side.
    """
    _user, space = context
    members = db.get_space_members(int(space["id"]))
    return {
        "count": len(members),
        "members": [
            {"userId": m["userId"], "displayName": m["displayName"],
             "membershipRole": m["memberRole"], "joinedAt": m["joinedAt"]}
            for m in members
        ],
    }


@app.get("/api/spaces/{space_id}/join-requests")
def read_join_requests(space_id: int, status: str = "pending",
                       context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """The people waiting to be let in. Managers may look; only the creator
    may decide, which is why this is not the creator-only guard."""
    _user, space = context
    if status not in ("pending", "approved", "declined", "cancelled"):
        raise HTTPException(status_code=400, detail="Unknown request status.")

    requests = db.list_join_requests(int(space["id"]), status)
    return {"count": len(requests), "status": status, "joinRequests": requests}


@app.post("/api/spaces/{space_id}/join-requests/{request_id}/approve")
def approve_join_request(space_id: int, request_id: int,
                         context=Depends(auth.addressed_creator)) -> dict[str, Any]:
    """Let somebody in. Only the space's creator may do this.

    An admin can invite, and can see who is waiting, but the decision is not
    theirs — which is what stops a shared space drifting away from the person
    who made it.
    """
    user, space = context
    request = db.get_join_request(request_id)
    if request is None or request["spaceId"] != int(space["id"]):
        raise HTTPException(status_code=404, detail="That request is not in this space.")

    try:
        updated = db.review_join_request(request_id, int(user["id"]), approve=True)
    except db.PairingRefused as refusal:
        code = 409 if refusal.reason in {"reviewed", "already_member"} else 403
        raise HTTPException(status_code=code, detail=refusal.message) from refusal

    db.log_activity(int(user["id"]), "join_request_approved", None,
                    {"displayName": request["requesterName"]}, space_id=int(space["id"]))
    return {"joinRequest": updated}


@app.post("/api/spaces/{space_id}/join-requests/{request_id}/decline")
def decline_join_request(space_id: int, request_id: int,
                         context=Depends(auth.addressed_creator)) -> dict[str, Any]:
    """Turn somebody down. Not a ban: a new invitation can be sent, and asking
    again is a new request."""
    user, space = context
    request = db.get_join_request(request_id)
    if request is None or request["spaceId"] != int(space["id"]):
        raise HTTPException(status_code=404, detail="That request is not in this space.")

    try:
        updated = db.review_join_request(request_id, int(user["id"]), approve=False)
    except db.PairingRefused as refusal:
        code = 409 if refusal.reason in {"reviewed", "already_member"} else 403
        raise HTTPException(status_code=code, detail=refusal.message) from refusal

    db.log_activity(int(user["id"]), "join_request_declined", None,
                    {"displayName": request["requesterName"]}, space_id=int(space["id"]))
    return {"joinRequest": updated}


@app.patch("/api/spaces/{space_id}/members/{member_user_id}/role")
def change_member_role(space_id: int, member_user_id: int,
                       payload: dict[str, Any] = Body(...),
                       context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """Promote a member to admin, or — for the creator alone — demote an admin.

    The rules live in db.can_manage_member, so "who may change whose role" is
    answered in one place rather than here and in the pages.
    """
    user, space = context
    actor_id = int(user["id"])
    role = str((payload or {}).get("role") or "").strip()

    if role not in db.MANAGEABLE_ROLES:
        raise HTTPException(status_code=400,
                            detail="A role can only be admin or member.")
    if member_user_id == actor_id:
        raise HTTPException(status_code=409,
                            detail="You cannot change your own role.")

    target = db.member_row(int(space["id"]), member_user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="They are not a member of this space.")

    actor_role = db.space_role_of(actor_id, int(space["id"]))
    action = "promote" if role == "admin" else "demote"
    if not db.can_manage_member(actor_role, target["member_role"], action):
        raise HTTPException(
            status_code=403,
            detail=("The space's creator is the only person who can do that."
                    if target["member_role"] in ("creator", "admin")
                    else "You cannot change that role."),
        )

    db.change_member_role(int(space["id"]), member_user_id, role, actor_id)
    return {"ok": True, "userId": member_user_id, "membershipRole": role}


@app.delete("/api/spaces/{space_id}/members/{member_user_id}")
def remove_space_member(space_id: int, member_user_id: int,
                        context=Depends(auth.addressed_manager)) -> dict[str, Any]:
    """Take somebody out of a space.

    The membership is marked as left rather than deleted, the content they
    added stays in the space, and their sign-ins are moved to their own space —
    all in one transaction.
    """
    user, space = context
    actor_id = int(user["id"])

    if member_user_id == actor_id:
        raise HTTPException(
            status_code=409,
            detail="Leaving a space is not something you can do yet.",
        )

    target = db.member_row(int(space["id"]), member_user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="They are not a member of this space.")

    actor_role = db.space_role_of(actor_id, int(space["id"]))
    if not db.can_manage_member(actor_role, target["member_role"], "remove"):
        if target["member_role"] == "creator":
            raise HTTPException(
                status_code=403,
                detail="The person who created this space cannot be removed.",
            )
        raise HTTPException(status_code=403,
                            detail="Only the space's creator can remove an admin.")

    db.remove_space_member(int(space["id"]), member_user_id, actor_id)
    return {"ok": True, "userId": member_user_id}


@app.get("/api/notifications")
def read_notifications(unread: str = "",
                       user=Depends(auth.current_user)) -> dict[str, Any]:
    """This account's own notifications.

    Not filtered by the current space: a message about a group somebody has
    been removed from still has to reach them, and a message about one space
    still matters while they are working in another.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    only_unread = str(unread).lower() in ("1", "true", "yes")
    items = db.list_notifications(int(user["id"]), unread_only=only_unread)
    return {
        "count": len(items),
        "unreadCount": db.unread_notification_count(int(user["id"])),
        "notifications": items,
    }


@app.get("/api/notifications/unread-count")
def read_unread_count(user=Depends(auth.current_user)) -> dict[str, Any]:
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    return {"unreadCount": db.unread_notification_count(int(user["id"]))}


@app.post("/api/notifications/read-all")
def mark_all_notifications_read(user=Depends(auth.current_user)) -> dict[str, Any]:
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    return {"ok": True, "markedRead": db.mark_all_notifications_read(int(user["id"]))}


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int,
                           user=Depends(auth.current_user)) -> dict[str, Any]:
    """Mark one of your own as read. Somebody else's is not found, which is the
    same answer as one that does not exist."""
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in first.")

    if not db.mark_notification_read(notification_id, int(user["id"])):
        raise HTTPException(status_code=404, detail="That notification is not yours.")
    return {"ok": True, "id": notification_id,
            "unreadCount": db.unread_notification_count(int(user["id"]))}


# --- the partner ------------------------------------------------------------

@app.post("/api/auth/invite-partner", status_code=201)
def invite_partner(context=Depends(auth.require_group_manager)) -> dict[str, Any]:
    """DEPRECATED. One single-use invitation, for the pairing room.

    Nothing calls this any more: the Profile makes invitations through
    POST /api/spaces/{id}/invitations, which is the addressed, per-group form
    of the same thing, and both mint through _mint_invitation. It is kept
    because a route is a promise to whoever already holds the address, and
    removing it would break nothing except somebody else's client.

    Only the token comes back, and only from here. The link the owner copies is
    assembled by the page: the front-end is the side that knows where its own
    pages live, so the API never has to guess an origin it cannot see.
    """
    user, space = context
    # The space decides whether there is room. Not the database, which may hold
    # more than one space, and not a global count of accounts.
    if not db.can_join_space(int(space["id"])):
        raise HTTPException(
            status_code=409,
            detail="This space already has two people in it.",
        )

    # One pending invitation per space, and one implementation that makes it.
    pending = db.pending_invitation_for_space(int(space["id"]))
    if pending is not None:
        raise HTTPException(status_code=409,
                            detail="An invitation is already pending.")

    invitation = db.create_pairing_invitation(int(user["id"]), int(space["id"]))
    db.log_activity(int(user["id"]), "partner_invited", None, None,
                    space_id=int(space["id"]))

    # The legacy shape is kept so the existing page keeps working; the pairing
    # code rides along and is simply ignored by it.
    return {
        "token": invitation["token"],
        "pairingCode": invitation["code"],
        "expiresAt": invitation["expiresAt"],
        "expiresInDays": db.INVITE_DAYS,
    }


@app.delete("/api/auth/invite-partner")
def revoke_partner_invite(context=Depends(auth.require_group_manager)) -> dict[str, Any]:
    """DEPRECATED, and the counterpart of the route above. Withdraws the live
    invitation for the session's group; DELETE /api/spaces/{id}/invitations is
    the same thing addressed by id, and is what the Profile uses.

    A spent invitation is never touched — it is the record of how the partner
    came to exist — and an existing partner is unaffected either way.
    """
    user, space = context
    status_now = db.partner_status(int(space["id"]))
    if status_now["connected"]:
        raise HTTPException(
            status_code=409,
            detail="A partner has already joined, so there is nothing to revoke.",
        )

    removed = db.revoke_pending_invitation(int(space["id"]))
    if removed:
        db.log_activity(int(user["id"]), "partner_invite_revoked", None, None,
                        space_id=space["id"] if space else None)
    return {"ok": True, "revoked": removed}


@app.get("/api/locations/cities")
def find_cities(country: str = "", q: str = "", limit: int = 8) -> dict[str, Any]:
    """Cities in one country, for the form's City field.

    Public, like reading the archive itself: a place name is not a secret, and
    the form is filled in before anything is saved. Only the country's own
    cities come back, so a search for "S" in Australia can never offer Salem.
    """
    country = country.strip().upper()
    if len(country) != 2 or not country.isalpha():
        raise HTTPException(status_code=400, detail="A two-letter country code is required.")

    query = " ".join(q.split())
    if not query:
        return {"query": query, "country": country, "cities": []}
    if len(query) > 64:
        raise HTTPException(status_code=400, detail="That search is too long.")

    limit = max(1, min(int(limit), 20))

    cache_key = (country, query.lower(), limit)
    now = datetime.now().timestamp()
    cached = _CITY_CACHE.get(cache_key)
    if cached and now - cached[0] < _CITY_CACHE_SECONDS:
        return {"query": query, "country": country, "cities": cached[1], "cached": True}

    found: list[dict[str, Any]] = []
    failures: list[str] = []

    if len(query) >= CITY_MIN_FOR_FULL_SEARCH:
        try:
            found = _ask_open_meteo(query, country)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            failures.append(f"open-meteo: {error}")

    if len(found) < limit:
        try:
            found = found + _ask_photon(query, country)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            failures.append(f"photon: {error}")

    if not found and failures:
        # Every provider that was asked failed, so this is a broken search
        # rather than an empty one. The page says so and keeps manual entry.
        print("[error] city lookup failed: " + "; ".join(failures), flush=True)
        raise HTTPException(status_code=502, detail="Could not reach the place lookup service.")

    cities = _dedupe_cities(found, limit)
    _CITY_CACHE[cache_key] = (now, cities)
    return {"query": query, "country": country, "cities": cities}


# ===========================================================================
# Activity and notifications
# ===========================================================================

@app.get("/api/activities")
def read_activities(limit: int = 20,
                    reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """The reader's own space. Only display names appear — never a username or
    an account detail."""
    _user, space_id = reader
    limit = max(1, min(int(limit), 100))
    items = db.list_activities(limit, space_id)
    return {"count": len(items), "activities": items}


@app.get("/api/notifications/status")
def notification_status(user=Depends(auth.require_editor)) -> dict[str, Any]:
    """How much has happened since this editor last looked."""
    return {"unread": db.unread_activity_count(int(user["id"]))}


@app.post("/api/notifications/mark-read")
def mark_read(user=Depends(auth.require_editor)) -> dict[str, Any]:
    return {"lastSeenActivityId": db.mark_activities_read(int(user["id"]))}


# ===========================================================================
# Editing and removing a memory
#
# Both are editor-only. The uploader's identity and the timestamps are set by
# the server from the session, never taken from the form.
# ===========================================================================

def _validate_memory_fields(title: str, date: str) -> None:
    """The rules a memory has always had, plus a real date.

    The browser will happily hand over a six-digit year — `<input type="date">`
    accepts `202000-02-03` and reports it as valid — so the date is checked
    here as well, and a date the archive cannot mean is refused before it is
    stored.
    """
    if not title.strip():
        raise HTTPException(status_code=400, detail="A title is required.")
    if not date.strip():
        raise HTTPException(status_code=400, detail="A date is required.")

    problem = _date_problem(date.strip())
    if problem:
        raise HTTPException(status_code=400, detail=problem)


# A date the archive accepts: four digits, a real month and day, and a year a
# memory could plausibly be from. The front-end offers the same range.
EARLIEST_DATE = "1900-01-01"
LATEST_DATE = "2099-12-31"
_DATE_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _date_problem(value: str) -> str | None:
    """Why this text is not a date the archive can hold, or None if it is."""
    match = _DATE_PATTERN.match(value)
    if not match:
        # Covers a five- or six-digit year, a missing part, and free text.
        return "Please enter a valid date, as YYYY-MM-DD."

    year, month, day = (int(part) for part in match.groups())
    try:
        _date(year, month, day)
    except ValueError:
        return "Please enter a real calendar date."

    if value < EARLIEST_DATE or value > LATEST_DATE:
        return f"Please enter a date between {EARLIEST_DATE} and {LATEST_DATE}."
    return None


def _coordinate(value: Any, low: float, high: float, label: str) -> float | None:
    number = _number(value)
    if number is None:
        return None
    if number < low or number > high:
        raise HTTPException(
            status_code=400,
            detail=f"{label} must be between {low:g} and {high:g}.",
        )
    return number


def _memory_changes(title: str, date: str, time: str, country: str, city: str,
                    place_name: str, latitude: str, longitude: str, weather: str,
                    temperature: str, mood: str, description: str, favorite: str,
                    show_on_timeline: str) -> dict[str, Any]:
    """The fields a memory form may change, checked and converted.

    Shared by the ordinary edit and the private one, so an editor of a private
    memory can change exactly what an editor of a standard memory can change —
    no more, and no less. Privacy adds a question about WHO may edit; it must
    never quietly add or remove a question about WHAT may be edited.
    """
    _validate_memory_fields(title, date)
    return {
        "title": title.strip(),
        "date": date.strip(),
        "time": time,
        "country": country,
        "city": city,
        "place_name": place_name,
        "latitude": _coordinate(latitude, -90, 90, "Latitude"),
        "longitude": _coordinate(longitude, -180, 180, "Longitude"),
        "weather": weather,
        "temperature": _number(temperature),
        "mood": mood,
        "description": description,
        "favorite": 1 if _truthy(favorite) else 0,
        "show_on_timeline": 1 if _truthy(show_on_timeline) else 0,
    }


@app.patch("/api/memories/{memory_id}")
async def edit_memory(
    memory_id: int,
    request: Request,
    context=Depends(auth.require_space),
    session=Depends(auth.current_session),
    title: str = Form(""),
    date: str = Form(""),
    time: str = Form(""),
    country: str = Form(""),
    city: str = Form(""),
    place_name: str = Form(""),
    latitude: str = Form(""),
    longitude: str = Form(""),
    weather: str = Form(""),
    temperature: str = Form(""),
    mood: str = Form(""),
    description: str = Form(""),
    favorite: str = Form(""),
    show_on_timeline: str = Form(""),
    cover_photo_id: str = Form(""),
    privacy_mode: str = Form(""),
    privacyMode: str = Form(""),
) -> dict[str, Any]:
    """Change what a form may change.

    `created_by_user_id` and `created_at` are not parameters at all, so a
    browser cannot ask for them; `updated_by_user_id` and `updated_at` are
    written from the session and the clock.

    The photographs themselves are not editable here. The only thing a form may
    say about them is which one is the cover, and only one of the memory's own.

    A PRIVATE memory is not found here at all — 404, for everybody, including
    the person who owns it. The ordinary content layer is not a way into the
    private archive, and allowing an edit through it would make it one.

    The one privacy change that belongs on this route is standard -> private,
    because at the moment it is asked for the memory is still standard. After it
    succeeds the memory is private, and from then on it is only reachable
    through /api/private-archive.
    """
    user, space = context
    # Scoped: a memory in another space is not found, so it cannot be edited
    # even by somebody who is signed in. And standard-only, so a private memory
    # is not found either.
    existing = db.get_memory(memory_id, space["id"])
    if existing is None:
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")

    wants_private = (privacy_mode or privacyMode or "").strip().lower()
    if wants_private == db.PRIVATE:
        # Two things are required, and both are about the PERSON rather than
        # about the space: they made this memory, and their private archive is
        # open. An admin or a member who may edit every standard memory in the
        # space still cannot turn somebody else's memory private — that would
        # hide another person's memory from the space it belongs to.
        if existing["createdBy"] is None \
                or int((existing["createdBy"] or {}).get("id") or 0) != int(user["id"]):
            raise HTTPException(
                status_code=403,
                detail="Only the person who made this memory can make it private.",
            )
        auth.require_privacy_unlocked(session)
    elif wants_private not in ("", db.STANDARD):
        raise HTTPException(status_code=400,
                            detail="A memory is either standard or private.")

    changes = _memory_changes(title, date, time, country, city, place_name,
                              latitude, longitude, weather, temperature, mood,
                              description, favorite, show_on_timeline)

    user, space = context
    if not db.update_memory(memory_id, changes, int(user["id"]), space_id=space["id"]):
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")

    # Which photograph represents the memory, when the form says so. The id must
    # belong to THIS memory: another memory's photograph is refused rather than
    # quietly ignored.
    wanted_cover = str(cover_photo_id or "").strip()
    if wanted_cover:
        try:
            photo_id = int(wanted_cover)
        except ValueError:
            raise HTTPException(status_code=400, detail="That photograph is not in this memory.")

        if not db.set_cover_photo(memory_id, photo_id, space["id"]):
            raise HTTPException(status_code=400, detail="That photograph is not in this memory.")

    # The privacy change goes last, in its own statement: it is the point at
    # which the memory leaves this route for good, so everything the ordinary
    # form asks for is applied first and the move happens once, at the end.
    if wants_private == db.PRIVATE:
        db.set_memory_privacy(memory_id, db.PRIVATE, space["id"], int(user["id"]))
        private = db.get_memory(memory_id, space["id"], privacy=db.PRIVATE)
        assert private is not None
        private = _absolute(private, request)
        private["privatePermission"] = "owner"
        private["privateAccess"] = db.private_access_for_memory(memory_id)
        return private

    updated = db.get_memory(memory_id, space["id"])
    assert updated is not None
    return _absolute(updated, request)


@app.delete("/api/memories/{memory_id}")
def remove_memory(
    memory_id: int,
    request: Request,
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Remove a memory, its rows and its photographs.

    The database goes first, in one transaction. Only once that has committed
    are the files removed — so a failure can leave an unreferenced file, but
    never a row pointing at a file that is already gone.

    A PRIVATE memory is not found here: not by an admin, not by the space's
    creator, not even by the person who owns it. Deleting one is possible only
    through the private archive, which is where ownership is checked.
    """
    user, space = context
    if db.get_memory(memory_id, space["id"]) is None:
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")

    user, space = context
    filenames = db.delete_memory(memory_id, actor_user_id=int(user["id"]),
                                space_id=space["id"])

    failed = []
    for name in filenames:
        try:
            (db.UPLOAD_DIR / name).unlink(missing_ok=True)
        except OSError as error:
            failed.append(name)
            print(f"[error] could not remove upload {name}: {error}", flush=True)

    return {"ok": True, "deletedPhotos": len(filenames) - len(failed),
            "leftOnDisk": failed}


# ===========================================================================
# Plan the Future
#
# A plan is a trip we mean to take. Reading is public, like the rest of the
# archive; writing belongs to the two people who keep it.
#
# The days of a plan are DERIVED from its date range on the way in — a client
# sends activities per day number, and the server works out the dates. That way
# a plan's days can never disagree with its own dates, and shortening a trip
# cannot leave a day behind.
# ===========================================================================

def _plan_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate what a form may set, and derive the day list from the range.

    Kept apart from the routes so create and edit enforce exactly the same
    rules — a plan cannot be edited into a shape it could not have been
    created in.
    """
    title = str(payload.get("title") or "").strip()
    location = str(payload.get("location") or "").strip()
    description = str(payload.get("description") or "").strip()
    start_date = str(payload.get("startDate") or payload.get("start_date") or "").strip()
    end_date = str(payload.get("endDate") or payload.get("end_date") or "").strip()

    if not title:
        raise HTTPException(status_code=400, detail="A plan name is required.")
    if not location:
        raise HTTPException(status_code=400, detail="A location is required.")
    if not description:
        raise HTTPException(status_code=400, detail="An overall plan is required.")
    if not start_date:
        raise HTTPException(status_code=400, detail="A start date is required.")
    if not end_date:
        raise HTTPException(status_code=400, detail="An end date is required.")

    for label, value in (("start", start_date), ("end", end_date)):
        problem = _date_problem(value)
        if problem:
            raise HTTPException(status_code=400, detail=problem)

    if end_date < start_date:
        raise HTTPException(
            status_code=400,
            detail="Please choose an end date after the start date.",
        )

    # How many days the range holds, counted inclusively.
    span = (_date.fromisoformat(end_date) - _date.fromisoformat(start_date)).days + 1

    sent: dict[int, list[str]] = {}
    for day in payload.get("days") or []:
        try:
            number = int((day or {}).get("dayNumber") or 0)
        except (TypeError, ValueError):
            continue
        if number < 1 or number > span:
            continue
        texts = []
        for activity in (day or {}).get("activities") or []:
            text = str((activity or {}).get("text") or "").strip()
            if text:
                texts.append(text)
        sent[number] = texts

    days = []
    for number in range(1, span + 1):
        days.append({
            "dayNumber": number,
            "date": (_date.fromisoformat(start_date) + timedelta(days=number - 1)).isoformat(),
            "activities": [{"text": text} for text in sent.get(number, [])],
        })

    return {
        "title": title,
        "location": location,
        "description": description,
        "start_date": start_date,
        "end_date": end_date,
        "transportation": str(payload.get("transportation") or "").strip(),
        "accommodation": str(payload.get("accommodation") or "").strip(),
        "notes": str(payload.get("notes") or "").strip(),
        "days": days,
    }


@app.get("/api/future-plans")
def read_future_plans(reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """The plans of the reader's own space."""
    _user, space_id = reader
    plans = db.list_future_plans(space_id)
    plans.sort(key=lambda plan: (plan["startDate"], plan["id"]))
    return {"count": len(plans), "plans": plans}


@app.get("/api/future-plans/{plan_id}")
def read_future_plan(plan_id: int,
                     reader=Depends(auth.require_reader)) -> dict[str, Any]:
    _user, space_id = reader
    plan = db.get_future_plan(plan_id, space_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="That plan is not in the archive.")
    return plan


@app.post("/api/future-plans", status_code=201)
def add_future_plan(
    payload: dict[str, Any] = Body(...),
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Create a plan, its days and their activities in one transaction."""
    plan = _plan_payload(payload or {})
    user, space = context
    return db.create_future_plan(plan, actor_user_id=int(user["id"]),
                                 space_id=space["id"])


@app.patch("/api/future-plans/{plan_id}")
def edit_future_plan(
    plan_id: int,
    payload: dict[str, Any] = Body(...),
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Change a plan. The days sent replace the days stored."""
    plan = _plan_payload(payload or {})
    user, space = context
    updated = db.update_future_plan(plan_id, plan, actor_user_id=int(user["id"]),
                                    space_id=space["id"])
    if updated is None:
        raise HTTPException(status_code=404, detail="That plan is not in the archive.")
    return updated


@app.delete("/api/future-plans/{plan_id}")
def remove_future_plan(
    plan_id: int,
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Remove a plan; its days and activities go with it (ON DELETE CASCADE)."""
    _user, space = context
    if not db.delete_future_plan(plan_id, space_id=space["id"]):
        raise HTTPException(status_code=404, detail="That plan is not in the archive.")
    return {"ok": True, "id": plan_id}


# =============================================================================
# Anniversaries
#
# A separate collection from memories, on purpose. A memory is something that
# happened once and is kept; an anniversary is a date that comes round every
# year and is declared. Nothing derives one from the other — a memory's date
# never becomes an anniversary, and an anniversary never points at a memory.
# =============================================================================


def _anniversary_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate what a form may set. Nothing derived gets in.

    Kept apart from the routes so create and edit enforce exactly the same
    rules. `next_date`, `days_remaining`, the anniversary number and the
    completed count are absent by design: they are answers about today, and a
    stored answer is wrong tomorrow.
    """
    title = str(payload.get("title") or "").strip()
    original_date = str(
        payload.get("originalDate") or payload.get("original_date") or ""
    ).strip()
    note = str(payload.get("note") or "").strip()

    if not title:
        raise HTTPException(status_code=400, detail="A title is required.")
    if not original_date:
        raise HTTPException(status_code=400, detail="A date is required.")

    problem = _date_problem(original_date)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    return {"title": title, "original_date": original_date, "note": note}


@app.get("/api/anniversaries")
def read_anniversaries(reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """Public: a guest may read the dates that matter.

    Returned in the order they were added. The order the page shows is by next
    occurrence, which only the client can work out — it is the client's today
    that decides it.
    """
    _user, space_id = reader
    anniversaries = db.list_anniversaries(space_id)
    return {"count": len(anniversaries), "anniversaries": anniversaries}


@app.get("/api/anniversaries/{anniversary_id}")
def read_anniversary(anniversary_id: int,
                     reader=Depends(auth.require_reader)) -> dict[str, Any]:
    """One date, for its detail page."""
    _user, space_id = reader
    anniversary = db.get_anniversary(anniversary_id, space_id)
    if anniversary is None:
        raise HTTPException(status_code=404, detail="That date is not in the archive.")
    return anniversary


@app.post("/api/anniversaries", status_code=201)
def add_anniversary(
    payload: dict[str, Any] = Body(...),
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Create a date. Editors only — the API refuses anyone else whatever the
    page happens to be showing."""
    anniversary = _anniversary_payload(payload or {})
    # The actor is the session, never the request body: a client cannot write
    # someone else's name onto a record.
    user, space = context
    return db.create_anniversary(anniversary, actor_user_id=int(user["id"]),
                                  space_id=space["id"])


@app.patch("/api/anniversaries/{anniversary_id}")
def edit_anniversary(
    anniversary_id: int,
    payload: dict[str, Any] = Body(...),
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    """Change a title, a date or a note. Moving the date silently recomputes
    everything the pages show, because none of it was ever stored."""
    user, space = context
    anniversary = _anniversary_payload(payload or {})
    updated = db.update_anniversary(
        anniversary_id, anniversary, actor_user_id=int(user["id"]),
        space_id=space["id"]
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="That date is not in the archive.")
    return updated


@app.delete("/api/anniversaries/{anniversary_id}")
def remove_anniversary(
    anniversary_id: int,
    context=Depends(auth.require_space),
) -> dict[str, Any]:
    _user, space = context
    if not db.delete_anniversary(anniversary_id, space_id=space["id"]):
        raise HTTPException(status_code=404, detail="That date is not in the archive.")
    return {"ok": True, "id": anniversary_id}


# ===========================================================================
# The Private Archive
#
# A second lock on the same door, and a second question about every memory.
#
#   POST   /api/privacy/setup          set the privacy password
#   GET    /api/privacy/status         is it set, and is it open right now
#   POST   /api/privacy/unlock         open it for THIS sign-in
#   POST   /api/privacy/lock           close it now
#   PATCH  /api/privacy/password       change it, with the account password
#
#   GET    /api/private-archive/memories
#   GET    /api/private-archive/memories/{id}
#   PATCH  /api/private-archive/memories/{id}
#   DELETE /api/private-archive/memories/{id}
#   PUT    /api/private-archive/memories/{id}/access
#
# Three status codes carry the whole of it, and they mean specific things:
#
#   401  nobody is signed in
#   423  signed in, but the private archive is LOCKED in this sign-in
#   403  signed in, unlocked, known — and the action is not theirs
#   404  and this one must hide whether the memory exists at all
#
# The order the checks run in is deliberate. Permission is decided BEFORE the
# lock, so somebody with no access to a memory gets 404 whether the archive is
# open or closed — they cannot even learn that a private memory exists by
# watching 423 turn into 404.
#
# What this is NOT: not encryption, not zero-knowledge, not a vault whose
# contents the server cannot read. It is a second, server-verified lock on
# access, plus per-memory authorisation. Describing it as anything else would be
# a lie told to the person relying on it.
# ===========================================================================

def _account_password_ok(user, account_password: str) -> bool:
    """Re-verify the PRIMARY account password.

    Both setup and change require it, and for the same reason: a computer left
    signed in must not be enough to install or replace the password that guards
    the private archive. Whoever is sitting at it may be the person who owns the
    account, or may be somebody they lent the laptop to for an afternoon, and
    the only thing that can tell the two apart is the password that person
    knows and the other one does not.
    """
    stored = db.get_user(int(user["id"]))
    if stored is None:
        return False
    return auth.verify_password(account_password or "", stored["password_hash"])


def _privacy_password_problem(privacy_password: str) -> None:
    """The same length rule as an account password, enforced here rather than
    only in the page: a privacy password is a secret, and a secret three
    characters long is not one."""
    problem = auth.password_problem(privacy_password or "")
    if problem:
        raise HTTPException(status_code=400, detail=problem)


@app.get("/api/privacy/status")
def privacy_status(user=Depends(auth.require_editor),
                   session=Depends(auth.current_session)) -> dict[str, Any]:
    """Is a privacy password set, and is this sign-in unlocked?

    Deliberately nothing else. Not how many private memories there are, not
    their titles, not when one was last opened, not how long the password is,
    not how many attempts have failed — a status endpoint is the most-called
    endpoint in any interface, and it must be safe to call from anywhere.

    It also does not refresh the unlock. If it did, a page that polls it would
    hold the private archive open for ever, which is the exact failure the
    timeout exists to prevent.
    """
    state = db.session_privacy_state(auth.session_hash(session))
    return {
        "configured": db.is_privacy_configured(int(user["id"])),
        "unlocked": bool(state["unlocked"]),
        "unlockedUntil": state["unlockedUntil"],
        "timeoutMinutes": auth.PRIVACY_UNLOCK_MINUTES,
    }


@app.post("/api/privacy/setup", status_code=201)
def privacy_setup(payload: dict[str, Any] = Body(...),
                  user=Depends(auth.require_editor),
                  session=Depends(auth.current_session)) -> dict[str, Any]:
    """Set the privacy password for the first time.

    Requires the account password. This is the whole point of the endpoint: a
    session that merely exists must not be able to install a NEW secret, or
    somebody who borrowed an unlocked laptop could lock the owner out of their
    own private archive — or, worse, set a password they know.
    """
    user_id = int(user["id"])
    if db.is_privacy_configured(user_id):
        raise HTTPException(
            status_code=409,
            detail="A privacy password is already set. Use change instead.",
        )

    account_password = str((payload or {}).get("accountPassword") or "")
    privacy_password = str((payload or {}).get("privacyPassword") or "")

    if not _account_password_ok(user, account_password):
        raise HTTPException(status_code=401, detail="That account password is not correct.")
    _privacy_password_problem(privacy_password)

    db.set_privacy_credentials(user_id, auth.hash_password(privacy_password))
    # Setting the password is also the first unlock: the person has just proved
    # the account password and chosen the new one, and asking them to type it
    # again immediately would be a ceremony, not a security boundary.
    until = db.unlock_privacy_session(auth.session_hash(session),
                                      auth.PRIVACY_UNLOCK_MINUTES)
    return {"configured": True, "unlocked": True, "unlockedUntil": until,
            "timeoutMinutes": auth.PRIVACY_UNLOCK_MINUTES}


@app.post("/api/privacy/unlock")
def privacy_unlock(payload: dict[str, Any] = Body(...),
                   user=Depends(auth.require_editor),
                   session=Depends(auth.current_session)) -> dict[str, Any]:
    """Open the private archive — for THIS sign-in, and for ten minutes.

    Not for the account: the laptop left on the kitchen table and the phone in
    a pocket are different sign-ins, and unlocking one is not a statement about
    the other.
    """
    user_id = int(user["id"])
    token_hash = auth.session_hash(session)

    credentials = db.privacy_credentials_for_user(user_id)
    if credentials is None:
        raise HTTPException(status_code=409,
                            detail="No privacy password has been set yet.")

    state = db.session_privacy_state(token_hash)
    if state["retryAfter"]:
        wait = _seconds_until(state["retryAfter"])
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Please wait {wait} seconds and try again.",
        )

    password = str((payload or {}).get("privacyPassword") or "")
    if not auth.verify_password(password, credentials["password_hash"]):
        db.register_privacy_failure(token_hash, auth.PRIVACY_MAX_ATTEMPTS,
                                    auth.PRIVACY_COOLDOWN_SECONDS)
        after = db.session_privacy_state(token_hash)
        detail = "That privacy password is not correct."
        if after["retryAfter"]:
            detail = ("That privacy password is not correct. Please wait a minute"
                      " before trying again.")
        raise HTTPException(status_code=401, detail=detail)

    until = db.unlock_privacy_session(token_hash, auth.PRIVACY_UNLOCK_MINUTES)
    return {"unlocked": True, "unlockedUntil": until,
            "timeoutMinutes": auth.PRIVACY_UNLOCK_MINUTES}


@app.post("/api/privacy/lock")
def privacy_lock(user=Depends(auth.require_editor),
                 session=Depends(auth.current_session)) -> dict[str, Any]:
    """Close the private archive now, and leave the sign-in alone.

    Locking is not signing out. The account stays signed in — the archive is
    still readable, the Hub still works — and only the private memories become
    unreachable until the password is given again.
    """
    db.lock_privacy_session(auth.session_hash(session))
    return {"unlocked": False, "unlockedUntil": None,
            "timeoutMinutes": auth.PRIVACY_UNLOCK_MINUTES}


@app.patch("/api/privacy/password")
def privacy_change_password(payload: dict[str, Any] = Body(...),
                            user=Depends(auth.require_editor),
                            session=Depends(auth.current_session)) -> dict[str, Any]:
    """Change the privacy password, with the account password as the proof.

    Same reasoning as setup: the account password is what makes this the
    owner's decision rather than whoever happens to be sitting here.

    Changing it locks EVERY sign-in of this account, including this one. The
    old password may have been typed on a computer somebody else can reach, and
    an unlock granted under it should not outlive it. The person changing it can
    unlock again with the password they have just chosen.
    """
    user_id = int(user["id"])
    credentials = db.privacy_credentials_for_user(user_id)
    if credentials is None:
        raise HTTPException(
            status_code=409,
            detail="No privacy password has been set yet. Set one first.",
        )

    account_password = str((payload or {}).get("accountPassword") or "")
    new_password = str((payload or {}).get("newPrivacyPassword") or "")

    if not _account_password_ok(user, account_password):
        raise HTTPException(status_code=401, detail="That account password is not correct.")
    _privacy_password_problem(new_password)

    db.set_privacy_credentials(user_id, auth.hash_password(new_password))
    return {"configured": True, "unlocked": False, "unlockedUntil": None,
            "timeoutMinutes": auth.PRIVACY_UNLOCK_MINUTES}


def _seconds_until(iso: str) -> int:
    try:
        when = datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return 0
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    remaining = int((when - datetime.now(timezone.utc)).total_seconds())
    return max(0, remaining)


# --- the private memories themselves ----------------------------------------

def _private_memory_or_404(memory_id: int, context) -> dict[str, Any]:
    """The private memory, if this account may see it AT ALL.

    Decided before the lock is consulted, so that "you have no access" and
    "there is no such memory" are the same answer — 404 — whether or not the
    private archive happens to be open. Anything else would let somebody with no
    access feel around for which ids exist.
    """
    user, space = context
    memory = db.get_private_memory(memory_id, int(space["id"]), int(user["id"]))
    if memory is None:
        # The same sentence the ordinary layer uses for a memory that is not
        # there, because to this caller it is not.
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")
    return memory


@app.get("/api/private-archive/memories")
def read_private_memories(request: Request,
                          context=Depends(auth.require_privacy_session)
                          ) -> dict[str, Any]:
    """The private memories of the CURRENT space that this account may see.

    The current space, exactly as the ordinary archive works: somebody in three
    groups sees the private memories of the group they are looking at, not all
    of them at once. Switching space does not need the password again — the
    unlock belongs to the sign-in — but every memory's permission is decided
    again for the space being looked at.

    Locked is 423 here: there is no id in the request, so answering "locked"
    reveals nothing that the caller does not already know.
    """
    user, space, _token = context
    memories = [_absolute(m, request) for m in
                db.list_private_memories(int(space["id"]), int(user["id"]))]
    return {"count": len(memories), "spaceId": int(space["id"]),
            "memories": memories}


@app.get("/api/private-archive/memories/{memory_id}")
def read_private_memory(memory_id: int, request: Request,
                        context=Depends(auth.require_space),
                        session=Depends(auth.current_session)) -> dict[str, Any]:
    """One private memory, for its owner, an editor or a viewer."""
    memory = _private_memory_or_404(memory_id, context)
    auth.require_privacy_unlocked(session)
    auth.touch_privacy(session)
    return _absolute(memory, request)


@app.patch("/api/private-archive/memories/{memory_id}")
async def edit_private_memory(
    memory_id: int,
    request: Request,
    context=Depends(auth.require_space),
    session=Depends(auth.current_session),
    title: str = Form(""),
    date: str = Form(""),
    time: str = Form(""),
    country: str = Form(""),
    city: str = Form(""),
    place_name: str = Form(""),
    latitude: str = Form(""),
    longitude: str = Form(""),
    weather: str = Form(""),
    temperature: str = Form(""),
    mood: str = Form(""),
    description: str = Form(""),
    favorite: str = Form(""),
    show_on_timeline: str = Form(""),
    cover_photo_id: str = Form(""),
    privacy_mode: str = Form(""),
    privacyMode: str = Form(""),
) -> dict[str, Any]:
    """Edit a private memory's ordinary content.

    An EDITOR may do exactly what an editor of a standard memory may do: change
    what the memory says. They may not change who may see it, may not take it
    out of the private archive, and may not delete it — those are the owner's,
    and they are refused with 403 rather than ignored.

    The owner may also send privacyMode=standard, which is the only way a
    private memory becomes ordinary again. It deletes the ACL with it: the list
    of people trusted with a secret stops meaning anything once it is not one.

    No activity is written, in any of these cases. The space's history is read
    by everybody in the space, and this memory is not in everybody's archive.
    """
    user, space = context
    memory = _private_memory_or_404(memory_id, context)
    auth.require_privacy_unlocked(session)
    auth.touch_privacy(session)

    permission = memory["privatePermission"]
    if permission == "viewer":
        raise HTTPException(status_code=403,
                            detail="You can view this memory, but not change it.")

    wanted = (privacy_mode or privacyMode or "").strip().lower()
    if wanted and wanted not in (db.STANDARD, db.PRIVATE):
        raise HTTPException(status_code=400,
                            detail="A memory is either standard or private.")
    if wanted and permission != "owner":
        # An editor asking for either direction is asking for something that is
        # not theirs. Refused even when it is a no-op, so the rule is a rule
        # rather than a rule-with-exceptions.
        raise HTTPException(
            status_code=403,
            detail="Only the person who made this memory can change who sees it.",
        )

    changes = _memory_changes(title, date, time, country, city, place_name,
                              latitude, longitude, weather, temperature, mood,
                              description, favorite, show_on_timeline)

    if wanted == db.STANDARD:
        db.set_memory_privacy(memory_id, db.STANDARD, int(space["id"]),
                              int(user["id"]))
        db.update_memory(memory_id, changes, int(user["id"]),
                         space_id=int(space["id"]))
        became = db.get_memory(memory_id, int(space["id"]))
        assert became is not None
        return _absolute(became, request)

    # The ordinary content change, through the ordinary store — the same fields,
    # the same validation, the same cover-photo rule — with the history entry it
    # would normally write suppressed.
    if not db.update_memory(memory_id, changes, int(user["id"]),
                            space_id=int(space["id"]), log_activity=False):
        raise HTTPException(status_code=404, detail="That memory is not in the archive.")

    wanted_cover = str(cover_photo_id or "").strip()
    if wanted_cover:
        try:
            photo_id = int(wanted_cover)
        except ValueError:
            raise HTTPException(status_code=400,
                                detail="That photograph is not in this memory.") from None
        if not db.set_cover_photo(memory_id, photo_id, int(space["id"])):
            raise HTTPException(status_code=400,
                                detail="That photograph is not in this memory.")

    updated = db.get_private_memory(memory_id, int(space["id"]), int(user["id"]))
    assert updated is not None
    return _absolute(updated, request)


@app.delete("/api/private-archive/memories/{memory_id}")
def remove_private_memory(memory_id: int,
                          context=Depends(auth.require_space),
                          session=Depends(auth.current_session)) -> dict[str, Any]:
    """Delete a private memory. The OWNER, and nobody else.

    Not an editor, not an admin of the space, not the person who created the
    space. Somebody else's memory is not a thing a role can delete, and a
    privacy feature that let a group's admin delete the memories it cannot even
    read would be a privacy feature in name only.
    """
    user, space = context
    memory = _private_memory_or_404(memory_id, context)
    auth.require_privacy_unlocked(session)

    if memory["privatePermission"] != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only the person who made this memory can delete it.",
        )

    filenames = db.delete_memory(memory_id, actor_user_id=int(user["id"]),
                                space_id=int(space["id"]))
    failed = []
    for name in filenames:
        try:
            (db.UPLOAD_DIR / name).unlink(missing_ok=True)
        except OSError as error:
            failed.append(name)
            print(f"[error] could not remove upload {name}: {error}", flush=True)

    return {"ok": True, "deletedPhotos": len(filenames) - len(failed),
            "leftOnDisk": failed}


@app.put("/api/private-archive/memories/{memory_id}/access")
def replace_private_access(memory_id: int,
                           payload: dict[str, Any] = Body(...),
                           context=Depends(auth.require_space),
                           session=Depends(auth.current_session)) -> dict[str, Any]:
    """Replace who may see a private memory. The OWNER, and nobody else.

    Replace rather than merge: the list that comes back from an edit screen is
    the list that is saved, so removing somebody is expressed by leaving them
    out. An editor or a viewer calling this is refused — being trusted with a
    memory is not being trusted with the list of who else is.

    Every check happens before anything is written, and the write is one
    transaction: a list naming somebody from another space changes nothing at
    all rather than emptying the ACL and then failing.
    """
    user, space = context
    memory = _private_memory_or_404(memory_id, context)
    auth.require_privacy_unlocked(session)

    permission = memory["privatePermission"]
    if permission != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only the person who made this memory can change who sees it.",
        )

    entries = payload.get("access") if isinstance(payload, dict) else None
    if entries is None:
        entries = []
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="That access list could not be read.")

    try:
        normalized = db.normalize_private_access(entries)
    except db.PrivacyRefused as refusal:
        raise _privacy_http(refusal) from refusal

    # A personal space has nobody else in it, so a private memory there is
    # always "only me" — and asking for anything else is refused rather than
    # silently accepted and dropped. The same helper the create route uses, so
    # both answer the same way to the same request.
    _check_private_targets(space, normalized, int(user["id"]))

    try:
        stored = db.replace_private_memory_access(
            memory_id, int(space["id"]), normalized, int(user["id"]))
    except db.PrivacyRefused as refusal:
        raise _privacy_http(refusal) from refusal

    return {"ok": True, "memoryId": memory_id, "privateAccess": stored,
            "count": len(stored)}
