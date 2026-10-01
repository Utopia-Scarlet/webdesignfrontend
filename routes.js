/* ==========================================================================
   LoveStory — the one place that knows where a page lives

   A memory is identified by its ID ("first-trip"), never by a URL. Pages ask
   this module for an address; no other file writes a path down.

   That is the whole point. The bug this file prevents: a film photograph in
   the Entrance carried a hard-coded "../mainpage/index.html#first-trip", so
   when that page was deleted the link kept pointing at it — for the locked
   path (via pendingDestination) and for the already-unlocked path (via the
   <a href>) alike.

   Loaded by the Entrance and the Hub. It finds the site root from its own
   <script src>, so the routes it returns are correct no matter how deep the
   page using it happens to sit.
   ========================================================================== */

(function (global) {
    "use strict";

    /* Where this file lives is the site root. */
    function scriptURL() {
        var current = document.currentScript;
        if (current && current.src) return current.src;

        /* A deferred script is not always currentScript by the time it runs. */
        var scripts = document.getElementsByTagName("script");
        for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || "";
            if (/routes\.js(\?|#|$)/.test(src)) return src;
        }
        return "";
    }

    var ROOT = scriptURL().replace(/[^/]*$/, "");

    /* Every page of the archive, named once. */
    var PAGES = {
        entrance: "gallery/index.html",
        pairing: "pairing/index.html",
        hub: "hub/index.html",
        library: "hub/modules/moments.html",
        memoryMap: "hub/memory-map.html",
        join: "join/index.html",
        timeline: "hub/modules/timeline.html",
        future: "hub/modules/future.html",
        anniversary: "hub/modules/anniversary.html",
        /* The private archive is a destination of its own, never a filter on
           the Library: a private memory must not be one query parameter away
           from the ordinary pages. */
        privateArchive: "hub/private/index.html"
    };

    function page(name) {
        return ROOT + (PAGES[name] || PAGES.hub);
    }

    function hub() {
        return page("hub");
    }

    /* A memory always opens in the Photo Library, which knows how to show one
       by ID. There is no per-memory page, so there is nothing to fall out of
       date when the archive is reorganised. */
    function memory(memoryId) {
        var url = page("library");
        return memoryId ? url + "?memory=" + encodeURIComponent(memoryId) : url;
    }

    /* An anniversary opens on its own page, which shows one date from the
       ?anniversary= id. Accepts either the Timeline's namespaced id
       ("anniversary-3") or the bare number the API knows it by. */
    function anniversary(anniversaryId) {
        var url = page("anniversary");
        if (!anniversaryId) return url;
        var numeric = String(anniversaryId).replace(/^anniversary-/, "");
        return url + "?anniversary=" + encodeURIComponent(numeric);
    }

    /* The invitation link. The token is the only secret in the URL, and it is
       single-use — the session token is never here. */
    function join(inviteToken) {
        var url = page("join");
        return inviteToken ? url + "?invite=" + encodeURIComponent(inviteToken) : url;
    }

    /* A memory ID is a slug, never a path: letters, digits, dot, dash and
       underscore. Anything else is not an ID and is refused. */
    var LOOKS_LIKE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    /* Old links were written as "../mainpage/index.html#first-trip". The page
       is gone, but the fragment still names the memory, so it is salvaged
       rather than thrown away. Returns null when nothing can be trusted. */
    function memoryIdFrom(text) {
        if (typeof text !== "string") return null;

        var query = /[?&]memory=([^&#]+)/.exec(text);
        if (query) {
            var fromQuery = decodeURIComponent(query[1]);
            if (LOOKS_LIKE_ID.test(fromQuery)) return fromQuery;
        }

        /* Only a fragment is worth trusting on a legacy link. */
        if (/mainpage\//i.test(text)) {
            var hash = /#([^#?]+)/.exec(text);
            if (hash) {
                var fromHash = decodeURIComponent(hash[1]);
                if (LOOKS_LIKE_ID.test(fromHash)) return fromHash;
            }
        }

        return null;
    }

    /* Turn whatever was remembered into a real address.
       Accepts the structured form {type:"memory", memoryId} / {type:"hub"},
       a legacy URL string, or nothing at all. */
    function resolve(pending) {
        if (!pending) return hub();

        if (typeof pending === "string") {
            /* The deleted landing page, at any depth, is the one case that is
               rewritten. Anything else is an address the caller meant. */
            if (/mainpage\//i.test(pending)) {
                var id = memoryIdFrom(pending);
                return id ? memory(id) : hub();
            }

            var wanted = memoryIdFrom(pending);
            return wanted ? memory(wanted) : pending;
        }

        if (pending.type === "memory" && pending.memoryId) {
            return memory(pending.memoryId);
        }

        return hub();
    }

    global.LoveStoryRoutes = {
        ROOT: ROOT,
        PAGES: PAGES,
        page: page,
        hub: hub,
        memory: memory,
        anniversary: anniversary,
        join: join,
        memoryIdFrom: memoryIdFrom,
        resolve: resolve
    };
})(window);
