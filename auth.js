/* ==========================================================================
   LoveStory — who is looking at the archive

   This used to be a passphrase compared in the browser: `scarlett` /
   `lovedream`, readable by anyone who opened the source. It is now a client
   for real accounts on the server — bcrypt passwords, a server-side session in
   an HttpOnly cookie, and any number of spaces behind one account.

   A guest is not a lesser state to be corrected. Reading this archive is
   public only where the space allows it; changing it needs an account. So the
   pages load for everyone, and the editing controls appear only when the
   server says this visitor may edit.

   Every answer about permission comes from the server. isEditor() is a
   convenience for hiding buttons, never the security boundary — the API
   refuses an unauthorised write whatever the page happens to believe.
   ========================================================================== */

(function (global) {
    "use strict";

    /* The API address comes from the shared client, which takes it from
       config.js. Nothing here decides it a second time. */
    var BASE = (global.LoveStoryApi && global.LoveStoryApi.BASE) ||
               (global.LoveStoryConfig && global.LoveStoryConfig.API_BASE) || "";

    var state = {
        user: null,
        authenticated: false,
        can: { edit: false, invite: false },
        /* Kept because the server still reports it, and the page that used to
           read it is now a redirect. Nothing routes on this. */
        partner: null,
        pairingStatus: "unpaired",
        /* The space this SIGN-IN is looking at — verified against a live
           membership by the server on every read. */
        space: null,
        /* How many spaces the ACCOUNT is in (its own, plus any groups). */
        spaceCount: 0,
        /* The account's own details — its username and when it joined. Told to
           the account itself and to nobody else. */
        account: null,
        /* "development" or "production", as the server sees itself. */
        environment: "development"
    };

    function url(path) { return BASE + path; }

    /* Every call carries the session cookie. The cookie is HttpOnly, so the
       browser is the only thing that can send it — and nothing in JavaScript
       can read it back. */
    function request(path, options) {
        var settings = Object.assign({ credentials: "include" }, options || {});

        return global.fetch(url(path), settings).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
                if (!response.ok) {
                    var message = (body && typeof body.detail === "string")
                        ? body.detail
                        : "That did not work. Please try again.";
                    var error = new Error(message);
                    error.status = response.status;
                    throw error;
                }
                return body;
            });
        });
    }

    function form(fields) {
        var body = new FormData();
        Object.keys(fields).forEach(function (key) { body.append(key, fields[key]); });
        return body;
    }

    function apply(payload) {
        state.authenticated = !!(payload && payload.authenticated);
        state.user = (payload && payload.user) || null;
        state.can = (payload && payload.can) || { edit: false, invite: false };
        state.partner = (payload && payload.partner) || null;
        state.pairingStatus = (payload && payload.pairingStatus) || "unpaired";
        /* The current space is what the pages route on now. `space` is the
           same object: /api/auth/me sends it under both names while the older
           pages are retired. */
        state.space = (payload && (payload.currentSpace || payload.space)) || null;
        state.spaceCount = (payload && typeof payload.spaceCount === "number")
            ? payload.spaceCount
            : (state.space ? 1 : 0);
        state.account = (payload && payload.account) || null;
        state.environment = (payload && payload.environment) || "development";

        document.dispatchEvent(new CustomEvent("lovestory:auth-changed", {
            detail: {
                user: state.user,
                authenticated: state.authenticated,
                can: state.can,
                partner: state.partner
            }
        }));

        return state;
    }

    /* Ask the server who this is. Once on load, and again after any change. */
    function refresh() {
        return request("/api/auth/me").then(apply, function () {
            /* An unreachable server means "not signed in". The archive still
               reads, and nothing about editing is offered. */
            return apply({ authenticated: false, user: null, can: {} });
        });
    }

    var ready = refresh();

    global.LoveStoryAuth = {
        get user() { return state.user; },
        get ready() { return ready; },

        /* A guest is simply a visitor with no session. */
        isAuthenticated: function () { return state.authenticated; },
        isGuest: function () { return !state.authenticated; },
        /* The partner's place. Only the space's creator is ever told, so this
           is null for a member, a guest, and on any server that does not
           report it. */
        get partner() { return state.partner; },

        get pairingStatus() { return state.pairingStatus; },
        get space() { return state.space; },
        get currentSpace() { return state.space; },
        get spaceCount() { return state.spaceCount; },
        get account() { return state.account; },
        get environment() { return state.environment; },

        /* Everything a page needs to decide where somebody belongs, in one
           object. This is what the entry resolver reads: one session, one
           answer, no page asking the server a second time. */
        snapshot: function () {
            var authenticated = state.authenticated;
            return {
                authenticated: authenticated,
                user: state.user,
                account: state.account,
                space: state.space,
                currentSpace: state.space,
                spaceCount: state.spaceCount,
                can: state.can,
                partner: state.partner,
                pairingStatus: state.pairingStatus,
                environment: state.environment,
                /* Two states, named once. Every account is in a space — its
                   own at the very least — so being signed in is the whole of
                   being ready. */
                state: authenticated ? "ready" : "signed-out"
            };
        },

        isEditor: function () { return !!state.can.edit; },
        /* Whether this account may invite anybody to the space it is looking
           at. The server decides it; the page only reflects it. */
        canInvite: function () { return !!state.can.invite; },
        displayName: function () { return state.user ? state.user.displayName : ""; },

        refresh: refresh,

        setupStatus: function () { return request("/api/auth/setup-status"); },

        setupOwner: function (username, displayName, password) {
            return request("/api/auth/setup-owner", {
                method: "POST",
                body: form({ username: username, display_name: displayName, password: password })
            }).then(refresh);
        },

        /* A personal account: signed in afterwards, and already at home — the
           server makes the person's own space in the same transaction, so
           there is nothing to pair, match or wait for. */
        registerAccount: function (displayName, username, password) {
            return request("/api/auth/register", {
                method: "POST",
                body: form({
                    display_name: displayName,
                    username: username,
                    password: password
                })
            }).then(refresh);
        },

        login: function (username, password) {
            return request("/api/auth/login", {
                method: "POST",
                body: form({ username: username, password: password })
            }).then(refresh);
        },

        logout: function () {
            return request("/api/auth/logout", { method: "POST" }).then(refresh);
        },

    };

    /* The old login() returned a boolean synchronously. It is now asynchronous
       and server-backed, so every caller must await it. */
})(window);
