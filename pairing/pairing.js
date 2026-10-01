/* ==========================================================================
   LoveStory — the old pairing address

   This page used to be the pairing room: choose how to begin, wait for the
   other person, type a code, watch it work. All four of those steps have gone,
   because none of them is a step any more. An account has its own space from
   the moment it is made, and a shared space is joined by asking the person who
   made it — not by pairing with them.

   So this file is a door, and deliberately nothing else. It decides nothing
   about who belongs where; it asks the one resolver that does and then hands
   over:

     signed in                 -> Our Space
     signed out                -> the Entrance (which is where signing in is)
     arrived with a link       -> the invitation page, to ask to join

   The third case matters: links already sent in a message point here, and a
   person who follows one should land on the request they set out to make
   rather than on a door that only says "after you".

   It holds no state, makes no requests of its own, and has no copy worth
   keeping. When nothing loads it still has to be safe, so the fallback is a
   plain link rather than a promise that something will happen.
   ========================================================================== */

(function (global) {
    "use strict";

    var Entry = global.LoveStoryEntry;
    var routes = global.LoveStoryRoutes;

    function page(name, fallback) {
        if (routes && typeof routes.page === "function") return routes.page(name);
        return fallback;
    }

    function say(message) {
        var stage = document.getElementById("pairingStage");
        if (!stage) return;
        stage.textContent = "";
        var note = document.createElement("p");
        note.className = "pairing__loading";
        note.textContent = message;
        stage.appendChild(note);
    }

    function leave(to) {
        /* replace, not assign: the pairing address should not sit in the
           history between a person and the page they actually wanted. */
        global.location.replace(to);
    }

    function start() {
        /* The entrance is the safe answer to every failure below: it is the
           one page that can always say what to do next. */
        var entrance = page("entrance", "../gallery/index.html");
        var hub = routes && typeof routes.hub === "function"
            ? routes.hub() : page("hub", "../hub/index.html");

        if (!Entry) {
            say("Taking you to Our Story\u2026");
            leave(entrance);
            return;
        }

        Entry.resolve().then(function (next) {
            var invite = Entry.inviteFromUrl();

            /* An invitation outranks the door: the person holding it is trying
               to join a particular space, signed in or not. */
            if (invite) {
                leave(Entry.withInvite(page("join", "../join/index.html"), invite));
                return;
            }

            if (next && next.authenticated) {
                leave(hub);
                return;
            }

            leave(entrance);
        }, function () {
            leave(entrance);
        });
    }

    start();
})(window);
