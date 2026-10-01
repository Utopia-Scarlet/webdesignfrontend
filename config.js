/* ==========================================================================
   LoveStory — where the API is

   One file, loaded before anything that talks to the server, that answers the
   only question the front-end cannot answer for itself: where does /api live?

   There is no build step in this project, and there is not going to be one, so
   the answer is worked out at load time from the one fact that is already
   true — the hostname the page was served from:

     · on localhost / 127.0.0.1 / [::1]  →  http://127.0.0.1:8000
       Development: the static front-end is on one loopback port, uvicorn on
       another, so the API is a different origin and must be named.

     · anywhere else                     →  "" (the page's own origin)
       Production: the API is expected to be served from the same site,
       typically behind a reverse proxy that sends /api and /uploads to the
       backend. An empty base means every request is a relative one, which is
       what makes that topology work without a single URL being rewritten —
       and what keeps the site working when the domain changes.

   To point a deployment somewhere unusual, set the base explicitly in the
   page, or replace this file, before anything else loads:

       <script>window.LOVE_STORY_API_BASE = "https://api.ourstory.example";</script>
       <script src="config.js"></script>

   Nothing here is a secret. The API base is public by definition: the browser
   has to be told it. Passwords, session cookies and invitation tokens are
   never written into a file the browser downloads — the session lives in an
   HttpOnly cookie the page cannot read, and invitation tokens come back once,
   in a response, and are never stored in the front-end.
   ========================================================================== */

(function (global) {
    "use strict";

    var LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0|)$/;

    var host = "";
    try {
        host = String((global.location && global.location.hostname) || "");
    } catch (error) {
        host = "";
    }

    var isDevelopment = LOOPBACK.test(host);

    /* The development backend. One place, and the only place. */
    var DEVELOPMENT_API = "http://127.0.0.1:8000";

    var base;
    if (typeof global.LOVE_STORY_API_BASE === "string") {
        /* An explicit override always wins — a production config file, or a
           test harness pointing the pages at another archive. */
        base = global.LOVE_STORY_API_BASE;
    } else {
        base = isDevelopment ? DEVELOPMENT_API : "";
    }

    global.LoveStoryConfig = {
        API_BASE: String(base).replace(/\/+$/, ""),
        IS_DEVELOPMENT: isDevelopment,
        /* The path the API is expected to answer on when it shares this
           origin. Read by nothing yet; it documents the contract. */
        API_PREFIX: "/api"
    };
})(window);
