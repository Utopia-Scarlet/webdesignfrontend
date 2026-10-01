/* ==========================================================================
   LoveStory — Memory Map

   The full-screen world, as its own page. It reuses the Hub's globe renderer
   over the same LoveStoryData the Library, the Timeline and the Hub read.

   This page only ever LOOKS at memories. Creating one belongs to the Library,
   so there is no upload control here at all — the map explores, the Library
   manages. A memory added in the Library appears here on the next arrival,
   because boot() waits on data.ready before it draws.

   The opening is automatic and lasts about a second: the title states where
   you are, fades, and the globe rises into place behind it. There is nothing
   to click, and returning within the same session skips most of it.
   ========================================================================== */

(function () {
    "use strict";

    /* Reading the map is public, like the rest of the archive. */
    var auth = window.LoveStoryAuth;

    var data = window.LoveStoryData;
    if (!data) return;

    var globe = window.LoveStoryGlobe;

    var INTRO_SEEN_KEY = "memoryMapIntroSeen";
    var INTRO_FIRST = 900;      /* the whole opening, first time in */
    var INTRO_AGAIN = 380;      /* merely a breath, after that */

    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var intro = document.getElementById("mapIntro");
    var back = document.getElementById("mapBack");

    /* --------------------------------------------------------------- opening */
    function introDuration() {
        if (reducedMotion) return 0;
        try {
            return window.sessionStorage.getItem(INTRO_SEEN_KEY) ? INTRO_AGAIN : INTRO_FIRST;
        } catch (error) {
            return INTRO_FIRST;
        }
    }

    function rememberIntro() {
        try {
            window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
        } catch (error) {
            /* Private mode, or storage full. The opening is only a courtesy. */
        }
    }

    /* ------------------------------------------------------- deep links */
    /* The album hands over a place key, which resolves to exactly one city. */
    function applyIncomingTarget() {
        var params = new URLSearchParams(window.location.search);

        var place = params.get("place");
        if (place && globe && globe.focusPlace(place)) return;

        /* A numeric ISO code, plus the name purely for the label. */
        var country = params.get("country");
        if (country && globe) {
            globe.focusCountry(country, params.get("countryName") || "");
        }
    }

    /* This page never writes a memory, so nothing here can invalidate the map.
       A memory added in the Library is picked up by the next arrival, because
       boot() waits on data.ready before drawing. */

    /* ------------------------------------------------------------ the chrome */
    if (back) {
        back.addEventListener("click", function () {
            document.body.classList.add("is-leaving");
            window.setTimeout(function () {
                window.location.href = "index.html";
            }, reducedMotion ? 0 : 260);
        });
    }

    /* ------------------------------------------------------------------ go */
    /* Who is reading is answered by its own request, and can land after the
       world has drawn. The panel speaks in that visitor's voice, so it is
       drawn again once the answer is known. */
    if (auth && auth.ready && auth.ready.then) {
        auth.ready.then(function () {
            if (globe && globe.refreshPanel) globe.refreshPanel();
        });
    }

    function boot() {
        /* The globe draws its markers from the archive, so read it first.
           With nothing to plot it still opens — an empty world is a truthful
           picture of an empty archive. */
        var reading = data.loadMemories();

        reading.then(function () {
            if (globe) globe.open();
            applyIncomingTarget();
        }, function () {
            if (globe) globe.open();
        });

        var wait = introDuration();

        if (!wait) {
            if (intro) intro.hidden = true;
            document.body.classList.remove("map-intro");
            rememberIntro();
            return;
        }

        window.setTimeout(function () {
            /* Removing the gate is what lets the globe rise: the stylesheet
               holds it at opacity 0 / scale .92 while the title is up. */
            document.body.classList.remove("map-intro");
            if (intro) intro.classList.add("is-leaving");
            rememberIntro();
        }, wait);

        window.setTimeout(function () {
            if (intro) intro.hidden = true;
        }, wait + 520);
    }

    /* Same reasoning as the album: wait for anything saved in this browser
       before drawing, so a place added earlier is already on the map. */
    if (data.ready && typeof data.ready.then === "function") {
        data.ready.then(boot, boot);
    } else {
        boot();
    }
})();
