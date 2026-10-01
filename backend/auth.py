"""LoveStory — who is asking, and what they are allowed to do.

Three kinds of visitor:

    owner    the person who set the archive up. Everything.
    partner  the second person. Everything except inviting a third.
    guest    no session at all. Read everything, change nothing.

A guest is not a row anywhere — being signed out IS being a guest.

Passwords are bcrypt hashes. Session tokens are random, and only their SHA-256
is stored, so the database file alone cannot be used to sign in as anyone.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from typing import Any

import bcrypt
from fastapi import Cookie, Depends, HTTPException, Request, Response, status

try:
    from backend import database as db
except ImportError:                       # running from inside backend/
    import database as db                 # type: ignore[no-redef]

SESSION_COOKIE = "lovestory_session"

# --- which world are we in --------------------------------------------------
# Development (the default) and production differ in exactly two places: whether
# a Secure cookie is sent, and whether the front-end may sit on another origin.
# Both are decided from the environment here, so the same code runs locally over
# plain http and later behind HTTPS without being edited.
ENVIRONMENT = (os.environ.get("LOVE_STORY_ENV") or "development").strip().lower()
IS_PRODUCTION = ENVIRONMENT == "production"


def _flag(name: str, default: bool) -> bool:
    """A boolean from the environment, or `default` when it is unset. Unset is
    not the same as an explicit "false"."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Secure must be on over HTTPS. Locally the front-end is plain http on
# 127.0.0.1, where a Secure cookie is simply never sent back — so hard-coding it
# true would break every local sign-in. Production defaults on, development
# defaults off, the variable overrides either.
COOKIE_SECURE = _flag("LOVE_STORY_COOKIE_SECURE", IS_PRODUCTION)

# SameSite is a topology question rather than a preference: "lax" is right when
# the front-end and the API share a site (including one behind a reverse proxy
# at /api), while "none" is only for genuinely different sites — which browsers
# accept only together with Secure. That pairing is enforced here rather than
# left to whoever sets the variable.
_ALLOWED_SAMESITE = {"lax", "strict", "none"}
COOKIE_SAMESITE = (os.environ.get("LOVE_STORY_COOKIE_SAMESITE") or "lax").strip().lower()
if COOKIE_SAMESITE not in _ALLOWED_SAMESITE:
    COOKIE_SAMESITE = "lax"
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    COOKIE_SAMESITE = "lax"

MIN_PASSWORD_LENGTH = 8

# --- the private archive ----------------------------------------------------
#
# A second, separate answer to "may this browser see the private memories".
# The account password signs a person in and lasts a month; this one opens the
# private archive and lasts minutes. Neither implies the other: an unlocked
# account is not an unlocked archive, and locking the archive is not signing
# out.
PRIVACY_UNLOCK_MINUTES = max(1, int(os.environ.get("LOVE_STORY_PRIVACY_UNLOCK_MINUTES")
                                   or 10))
# Five wrong tries on this sign-in cost it a minute. Deliberately small: enough
# that guessing is slower than thinking, small enough that it is not a lockout
# somebody else can inflict on you.
PRIVACY_MAX_ATTEMPTS = 5
PRIVACY_COOLDOWN_SECONDS = 60

# bcrypt only reads the first 72 bytes, and raises on anything longer in v5.
BCRYPT_MAX_BYTES = 72


# --- passwords --------------------------------------------------------------

def hash_password(password: str) -> str:
    raw = password.encode("utf-8")[:BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    raw = password.encode("utf-8")[:BCRYPT_MAX_BYTES]
    try:
        return bcrypt.checkpw(raw, password_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


def password_problem(password: str) -> str | None:
    """Deliberately simple: length only. No forced symbols or digits."""
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return f"Please use at least {MIN_PASSWORD_LENGTH} characters."
    return None


# --- tokens -----------------------------------------------------------------

def new_token() -> str:
    """A strong random token. This is the only moment the real value exists on
    the server — from here on, only its hash is kept."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --- cookies ----------------------------------------------------------------

def set_session_cookie(response: Response, token: str, max_age: int) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=max_age,
        httponly=True,          # JavaScript can never read it
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE,
        httponly=True,
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        path="/",
    )


# --- who is asking ----------------------------------------------------------

# "Is this somebody with an account?" — the authentication half of the answer.
#
# It deliberately no longer reads `users.role`. That column is a legacy
# compatibility value (owner / partner) and the schema guarantees every account
# holds one of the two, so testing it here was always true and only obscured
# where permission actually comes from. Authorisation is membership:
# require_space() resolves the caller's space and refuses without one.
def may_edit(user) -> bool:
    """True when this account may attempt a write. Not the whole answer —
    require_space() is the other half, and the half that carries the rule."""
    return bool(user)


def current_user(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
    """The signed-in account, or None. Never raises — used for optional auth."""
    if not session:
        return None
    return db.user_for_session(hash_token(session))


def require_editor(user=Depends(current_user)):
    """Somebody with an account. A guest has no session, so this is a 401.

    Named for a time when an account's role decided this. It now means "signed
    in", and the space decides the rest — see require_space.
    """
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Please sign in to change the archive.",
        )
    return user


def current_session(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
    """The raw session token.

    Almost nothing wants this — the account is what matters. It exists for the
    two questions that are about the SIGN-IN rather than the person: which
    space this session is looking at, and how to change it.
    """
    return session


def require_reader(user=Depends(current_user),
                   session=Depends(current_session)):
    """The space a READ should look at, as (user, space_id).

    There is no guest read. This archive holds people's private life, and
    "anyone may look" stopped being true the moment accounts existed. So:

      · nobody signed in -> 401. The Hub is not public.
      · signed in        -> the space this session is looking at, resolved
        through the session and checked against a live membership. An account
        with no space at all gets `NO_SPACE`, which matches no rows: an empty
        archive, not everybody's.

    Returning NO_SPACE rather than None matters — None means "no filter" to the
    query layer, which would hand a signed-in stranger the whole database.
    """
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Please sign in to view this.",
        )
    space = db.current_space_for_session(hash_token(session)) if session else None
    return user, (int(space["id"]) if space else db.NO_SPACE)


def require_space(user=Depends(require_editor),
                  session=Depends(current_session)):
    """The space this SIGN-IN is looking at, as (user, space).

    Resolved from the session, not from the account: a person may be in several
    spaces, and which one they are working in is a property of this sign-in.
    The stored choice is verified against a live membership on every request,
    so a stale or forged value cannot reach another space's data.
    """
    space = db.current_space_for_session(hash_token(session)) if session else None
    if space is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is not part of a space yet.",
        )
    return user, space


def require_group_space(context=Depends(require_space)):
    """A shared space. A personal space cannot be invited into or joined."""
    user, space = context
    if space["spaceType"] != "group":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A personal space cannot be shared.",
        )
    return user, space


def require_space_creator(context=Depends(require_space)):
    """The space and the account, if that account created it.

    `users.role` is a legacy compatibility field and is deliberately not
    consulted: who may run a space is a fact about the space, recorded in
    space_members.
    """
    user, space = context
    if not db.is_space_creator(int(user["id"]), int(space["id"])):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the person who created this space can do that.",
        )
    return user, space


def require_group_manager(context=Depends(require_group_space)):
    """Creator or admin: whoever may run a shared space.

    The invitation endpoints use this. Phase 2 builds member management on the
    same pair of questions, so that "who may invite" and "who may approve" are
    decided in one place rather than two.
    """
    user, space = context
    if not db.is_space_manager(int(user["id"]), int(space["id"])):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the space's creator or an admin can do that.",
        )
    return user, space


# --- managing a space named in the URL ---------------------------------------
#
# Management is always about a PARTICULAR space: the members of Group B are
# managed from a page that may be open while the session is looking at Group A.
# So these resolve the space from the path, and check the caller's membership
# of THAT space — not of whatever the session happens to be showing.

def addressed_space(space_id: int, user=Depends(require_editor)):
    """(user, space) for a space named in the path, or 404.

    A space the caller is not an active member of is answered exactly as one
    that does not exist: knowing an id must not reveal that it is real.
    """
    if not db.is_space_member(int(user["id"]), space_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="That space is not in your archive.")
    space = db.get_space(space_id)
    if space is None or space["status"] != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="That space is not in your archive.")
    return user, space


def addressed_group(space_id: int, user=Depends(require_editor)):
    """A group space named in the path. Personal spaces have no members to
    manage, no invitations and nothing to join."""
    user, space = addressed_space(space_id, user)
    if space["spaceType"] != "group":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="A personal space cannot be shared.")
    return user, space


def addressed_manager(space_id: int, user=Depends(require_editor)):
    """Creator or admin of the addressed group."""
    user, space = addressed_group(space_id, user)
    if not db.is_space_manager(int(user["id"]), int(space["id"])):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the space's creator or an admin can do that.",
        )
    return user, space


def addressed_creator(space_id: int, user=Depends(require_editor)):
    """The creator of the addressed group, and nobody else."""
    user, space = addressed_group(space_id, user)
    if not db.is_space_creator(int(user["id"]), int(space["id"])):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the person who created this space can do that.",
        )
    return user, space


# --- rules ------------------------------------------------------------------

def session_hash(session: str | None) -> str:
    """The stored identity of a sign-in. Empty when there is no session, which
    no row can match — so a missing cookie can never look like an unlock."""
    return hash_token(session) if session else ""


def privacy_unlocked(session: str | None) -> bool:
    """Is the private archive open for THIS sign-in, right now?

    Read-only. It never extends the unlock, so asking the question — on a
    status page, on every page load, in a poll — cannot keep the archive open.
    Only using the private archive does that; see touch_privacy().
    """
    if not session:
        return False
    return db.is_privacy_unlocked(session_hash(session))


def require_privacy_unlocked(session: str | None) -> None:
    """423 unless this sign-in has the private archive open.

    423 Locked rather than 403: the caller is allowed to do this and has proved
    who they are — they simply have not opened the archive in this sign-in yet,
    and can. 403 would say "never", which is the wrong sentence and the wrong
    hint.
    """
    if not privacy_unlocked(session):
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="The private archive is locked.",
        )


def touch_privacy(session: str | None) -> None:
    """Push the unlock's expiry back, because the archive was just used.

    Called only from requests that returned private content, never from a
    status check. The timeout is meant to measure inactivity, and a page asking
    "am I still unlocked?" is not activity in any sense the person would
    recognise.
    """
    if session:
        db.touch_privacy_unlock(session_hash(session), PRIVACY_UNLOCK_MINUTES)


def require_privacy_session(context=Depends(require_space),
                            session=Depends(current_session)):
    """(user, space, token_hash) for the private archive, or 423.

    Three things have to be true before a private memory is even looked for:
    somebody is signed in, this sign-in is looking at a space they are an active
    member of, and the private archive is open in this sign-in. This dependency
    is all three, so no route has to remember them.

    What it deliberately does NOT decide: which memories the person may see.
    That is per memory, it is decided by private_memory_permission(), and an
    admin of the space has no more of it than a stranger.
    """
    user, space = context
    require_privacy_unlocked(session)
    touch_privacy(session)
    return user, space, session_hash(session)


def editor_slots() -> dict[str, Any]:
    """How the archive currently stands, for the Entrance to read.

    `partnerExists` used to mean "an account somewhere holds the partner role".
    With spaces it means the thing the Entrance actually cares about: that the
    space this archive began as is full, so there is no room left in it.
    """
    space_id = db.legacy_space_id()
    return {
        "needsOwnerSetup": db.count_users_with_role("owner") == 0,
        "partnerExists": space_id is not None and not db.can_join_space(space_id),
    }
