/* ==========================================================================
   LoveStory — arriving with an invitation

   Somebody followed a link, or was given a short code. Either way this page
   asks ONE question and does not pretend to answer it: may I join?

   That is the whole change this phase makes. Following an invitation used to
   put you in the space; it now sends a request to the person who made the
   space, and they decide. So the page has two endings, and only two:

     the invitation cannot be used   -> said plainly, in the API's own words
     a request has been sent         -> "waiting to be let in", and where to go

   Between those it may have to hand over to the Entrance first, because an
   account comes before joining: an invitation gets you into a space, it does
   not create your account for you. The token waits in the URL throughout and
   is never written to localStorage — it is a way into a private space, and it
   should not outlive the visit that used it.
   ========================================================================== */

(function () {
    "use strict";

    var Auth = window.LoveStoryAuth;
    var Api = window.LoveStoryApi;
    var Entry = window.LoveStoryEntry;
    var routes = window.LoveStoryRoutes;

    var panel = document.getElementById("joinPanel");

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function page(name, fallback) {
        if (routes && typeof routes.page === "function") return routes.page(name);
        return fallback;
    }

    function entrance(invite) {
        var url = page("entrance", "../gallery/index.html");
        return invite && Entry ? Entry.withInvite(url, invite) : url;
    }

    function hub() {
        return routes && typeof routes.hub === "function"
            ? routes.hub() : page("hub", "../hub/index.html");
    }

    function show(nodes) {
        panel.textContent = "";
        nodes.filter(Boolean).forEach(function (node) { panel.appendChild(node); });
    }

    function link(className, href, text) {
        var a = el("a", className, text);
        a.href = href;
        return a;
    }

    function heading(eyebrow, title, note) {
        return [
            el("p", "join__eyebrow", eyebrow),
            el("h1", "join__title", title),
            note ? el("p", "join__note", note) : null
        ];
    }

    /* Say plainly why an invitation cannot be used, in the words the API uses,
       rather than showing a button that would only fail. */
    function refuse(state, invite) {
        var messages = {
            invalid: "That invitation is not recognised. Ask for a new one.",
            expired: "That invitation has expired. Ask for a new one.",
            used: "That invitation has already been used. Ask for a new one.",
            revoked: "That invitation has been withdrawn. Ask for a new one."
        };
        show(heading("Love / Story", "This invitation cannot be used.",
                     messages[state] || "Ask for a new one.")
            .concat([link("join__back", entrance(invite), "Go to Our Story \u2192")]));
    }

    /* The ending that matters: the ask has been made, and nothing else happens
       until a person answers it. No spinner, no polling, no second button. */
    function requestSent(options) {
        var spaceName = options.spaceName || "the space";
        var who = options.inviterName || "the person who invited you";

        show(heading(options.existing ? "Already requested" : "Request sent",
                     options.existing
                        ? "You have already asked to join " + spaceName + "."
                        : "Waiting to be let in.",
                     options.existing
                        ? "Nothing more to do — " + who + " has your request."
                        : who + " will see your request, and you will be told "
                          + "when they answer it.")
            .concat([
                el("p", "join__lead",
                   "You can carry on in your own space meanwhile."),
                link("join__action", hub(), "Go to Our Space \u2192")
            ]));
    }

    function askToJoin(token, inviterName, spaceName) {
        var button = el("button", "join__submit", "Request to join");
        button.type = "button";
        var errorLine = el("p", "join__error");
        errorLine.setAttribute("role", "alert");
        errorLine.setAttribute("aria-live", "polite");

        button.addEventListener("click", function () {
            errorLine.textContent = "";
            button.disabled = true;
            button.textContent = "Asking\u2026";

            Api.acceptInvitation(token).then(function (result) {
                requestSent({
                    existing: !!(result && result.existing),
                    inviterName: inviterName,
                    spaceName: spaceName
                });
            }, function (error) {
                button.disabled = false;
                button.textContent = "Request to join";

                /* Already in it — an invitation is not a second door. The
                   API's own sentence is the right one to show. */
                if (error && error.status === 409 &&
                    /already a member/i.test(error.message || "")) {
                    show(heading("You're already in", spaceName,
                                 "You are a member of this space, so there is "
                                 + "nothing to ask for.")
                        .concat([link("join__action", hub(), "Go to Our Space \u2192")]));
                    return;
                }
                errorLine.textContent = (error && error.message)
                    || "That request could not be sent. Please try again.";
            });
        });

        show(heading("You have been invited by", inviterName,
                     "Ask to join " + spaceName + ". "
                     + inviterName + " decides who comes in.")
            .concat([button, errorLine,
                     link("join__back", hub(), "Not now, go to Our Space \u2192")]));
    }

    /* No link: an invitation may also have arrived as a short code. Asking for
       it here keeps the code path alive after the pairing page stopped being
       the place for it. */
    function askByCode() {
        var label = el("label", "join__label", "Invitation code");
        label.setAttribute("for", "joinCode");

        var input = el("input", "join__input");
        input.id = "joinCode";
        input.type = "text";
        input.autocomplete = "off";
        input.autocapitalize = "characters";
        input.spellcheck = false;
        input.placeholder = "ABC123";

        var button = el("button", "join__submit", "Request to join");
        button.type = "button";

        var errorLine = el("p", "join__error");
        errorLine.setAttribute("role", "alert");
        errorLine.setAttribute("aria-live", "polite");

        function send() {
            var code = String(input.value || "").trim();
            if (!code) { input.focus(); return; }

            errorLine.textContent = "";
            button.disabled = true;
            button.textContent = "Asking\u2026";

            Api.acceptInvitationCode(code).then(function (result) {
                requestSent({
                    existing: !!(result && result.existing),
                    spaceName: (result && result.joinRequest && result.joinRequest.spaceName)
                        || "that space"
                });
            }, function (error) {
                button.disabled = false;
                button.textContent = "Request to join";
                errorLine.textContent = (error && error.message)
                    || "That code could not be used. Please check it and try again.";
            });
        }

        button.addEventListener("click", send);
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter") { event.preventDefault(); send(); }
        });

        show([
            el("p", "join__eyebrow", "Love / Story"),
            el("h1", "join__title", "Join a space."),
            el("p", "join__note",
                 "Type the invitation code the person who invited you sent. "
                 + "They decide who comes in."),
            label, input, button, errorLine,
            link("join__back", entrance(""), "Go to Our Story \u2192")
        ]);
        input.focus();
    }

    function begin() {
        var invite = Entry ? Entry.inviteFromUrl() : "";

        if (!invite) {
            /* Whether there is a session is the server's answer, and it arrives
               asynchronously. Asking the client before it has answered would
               send a signed-in person to sign in again — so wait for it. */
            if (!Auth) { askByCode(); return; }
            Auth.ready.then(function () {
                if (!Auth.isAuthenticated()) {
                    show(heading("Love / Story", "Join a space.",
                                 "Sign in first, then use the invitation code or link.")
                        .concat([link("join__back", entrance(""), "Sign in \u2192")]));
                    return;
                }
                askByCode();
            });
            return;
        }

        Api.readInvitation(invite).then(function (result) {
            if (!result || !result.valid) {
                refuse((result && result.state) || "invalid", invite);
                return;
            }

            var inviter = (result.inviter && result.inviter.displayName) || "someone";
            var spaceName = (result.space && result.space.name) || "their space";

            Auth.ready.then(function () {
                if (!Auth.isAuthenticated()) {
                    /* Account first. The invitation waits in the URL. */
                    show(heading("You have been invited by", inviter,
                                 "Join " + spaceName + ". Sign in, or create your "
                                 + "account, and the invitation will be waiting.")
                        .concat([
                            link("join__action", entrance(invite), "Sign in \u2192"),
                            link("join__action join__action--quiet", entrance(invite),
                                 "Create account \u2192")
                        ]));
                    return;
                }

                askToJoin(invite, inviter, spaceName);
            });
        }, function () {
            show(heading("Love / Story", "The archive could not be reached.",
                         "Please try again in a moment.")
                .concat([link("join__back", entrance(invite), "Go to Our Story \u2192")]));
        });
    }

    if (!Api || !Entry) return;
    begin();
})();
