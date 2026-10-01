/* ==========================================================================
   LoveStory — where does this visitor belong?

   One question, asked in one place. Every protected page loads this and asks
   it before drawing anything; no page decides for itself whether the person
   looking at it is allowed to be there.

   The answer is now about SPACES, not about pairing:

     signed-out   nobody is signed in            -> the Entrance
     ready        signed in, in a space          -> Our Space (the Hub)

   Every account has a personal space from the moment it is made, so "signed
   in" and "in a space" are the same fact, and there is no third state to route
   through. The old pairing-era states — unpaired, waiting, the Matching choice
   — are gone: nobody is ever asked to find a partner before they may look at
   their own archive.

   An invitation is the one thing that redirects. A visitor who arrived with a
   link wants to ask to join THAT space, so the invitation is carried to the
   Entrance and, once they are signed in, to the page that asks.

   It reads the answer from the server, never from the browser. There is no
   role in localStorage and no cached "logged in" flag to go stale: /api/auth/me
   is the single source, and the session lives in an HttpOnly cookie the page
   cannot see or forge.

   WHY THIS IS NOT THE SECURITY BOUNDARY

   It decides which screen you see. What you may actually read or change is
   decided by the API, which refuses shared content to anyone without a
   session and scopes every query to the caller's space. A guard in the browser
   is a courtesy to the visitor — it saves them from a screen that would only
   error — and nothing more.
   ========================================================================== */

(function (global) {
    "use strict";

    var state = null;
    var inFlight = null;

    function auth() { return global.LoveStoryAuth || null; }
    function routes() { return global.LoveStoryRoutes || null; }

    function page(name) {
        var r = routes();
        if (r && typeof r.page === "function") return r.page(name);
        return name === "entrance" ? "../gallery/index.html" : "../hub/index.html";
    }

    function hub() {
        var r = routes();
        if (r && typeof r.hub === "function") return r.hub();
        return page("hub");
    }

    /* The invitation a visitor arrived with, carried in the URL rather than
       stored. An invite token is a way into a private space; the URL is where
       it belongs until the moment it is used, and it never goes to
       localStorage where it would outlive the visit. */
    function inviteFromUrl() {
        var search = String((global.location && global.location.search) || "");
        var match = /[?&](?:invite|token)=([^&#]+)/.exec(search);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function withInvite(url, token) {
        if (!token) return url;
        return url + (url.indexOf("?") === -1 ? "?" : "&") +
               "invite=" + encodeURIComponent(token);
    }

    /* Where a state belongs. `invite` rides along: somebody who followed an
       invitation and then had to sign in should arrive at the request they
       came to make, not at their own space. */
    function destinationFor(next, options) {
        options = options || {};
        var invite = options.invite || "";

        if (next.state === "signed-out") {
            /* Carry the invitation to the Entrance so it survives signing in. */
            return withInvite(page("entrance"), invite);
        }
        /* Signed in, and holding an invitation to somebody else's space. The
           page in between asks; it does not put them in anything. */
        if (invite) {
            var join = routes() && routes().page ? routes().page("join") : "../join/index.html";
            return withInvite(join, invite);
        }
        return options.whenReady || options.whenPaired || hub();
    }

    /* Who is this? The answer comes from the session client, which already
       asked the server once on this page load. Asking again would be a second
       opinion about the same question, and a chance for the two to disagree. */
    function resolve(options) {
        var force = !!(options && options.force);
        var session = auth();

        if (inFlight && !force) return inFlight;

        if (!session || !session.ready) {
            state = { state: "signed-out", authenticated: false, user: null,
                      space: null, currentSpace: null, spaces: [],
                      spaceCount: 0, account: null, environment: "development" };
            return Promise.resolve(state);
        }

        inFlight = session.ready.then(function () {
            inFlight = null;
            state = session.snapshot();
            return state;
        }, function () {
            inFlight = null;
            state = session.snapshot();
            return state;
        });

        return inFlight;
    }

    /* Is this server running in development? Never trust the browser for the
       rule; this only decides whether the UI offers development-only help. */
    function isDevelopment(next) {
        var current = next || state;
        return !current || current.environment !== "production";
    }

    /* May this visitor see a protected page?

       Being signed in is the whole of it. There is no second member to wait
       for and no matching to complete: an account's personal space is its own
       from the moment it exists, and the Hub is that space (or whichever one
       the person has chosen to work in). */
    function mayEnterHub(next) {
        return !!(next && next.authenticated);
    }

    /* Called by every protected page before it draws. Resolves to the state
       when the visitor may stay, and redirects when they may not. */
    function guard(options) {
        options = options || {};
        var invite = options.invite || inviteFromUrl();

        return resolve().then(function (next) {
            if (mayEnterHub(next)) {
                /* Signed in and holding somebody's invitation: the Hub is not
                   where they were going. The request page is. */
                if (invite) {
                    global.location.replace(destinationFor(next, { invite: invite }));
                    return next;
                }
                return next;
            }

            global.location.replace(destinationFor(next, {
                invite: invite,
                whenReady: options.whenReady
            }));
            return next;
        });
    }

    global.LoveStoryEntry = {
        resolve: resolve,
        guard: guard,
        destinationFor: destinationFor,
        inviteFromUrl: inviteFromUrl,
        withInvite: withInvite,
        mayEnterHub: mayEnterHub,
        isDevelopment: isDevelopment,
        get state() { return state; }
    };
})(window);
