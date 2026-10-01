/* ==========================================================================
   LoveStory — the page guard

   One line, loaded by every page that holds private content. It asks the entry
   resolver where this visitor belongs and, if the answer is not "here",
   redirects before the page has drawn anything.

   It exists so that no page has to write its own rule. A second copy of "is
   this person allowed" is a second answer waiting to disagree with the first.

   This is a courtesy, not the boundary. The API refuses shared content without
   a session and scopes every query to the caller's own space, so a page that
   somehow skipped this would show empty rooms, not somebody else's archive.
   ========================================================================== */

(function (global) {
    "use strict";

    function run() {
        if (!global.LoveStoryEntry) return;
        /* No options: the rule is the same everywhere, and the invitation in
           the URL — if there is one — is picked up by the resolver itself. */
        global.LoveStoryEntry.guard();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run);
    } else {
        run();
    }
})(window);
