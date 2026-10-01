/* ==========================================================================
   LoveStory — the Profile

   One drawer, opened from the Hub header, that answers "who am I, which space
   am I in, and how do I run it". It used to be an account card: a name, a
   partner, a way out. Now that an account has a personal space and any number
   of groups, that card is the obvious place to stand while moving between
   them.

   Its shape follows from one rule — a space is not a page. So the Profile has
   a home view (who you are, your spaces, what you can do here) and four views
   you step into and back out of:

     home         the account, My Spaces, and what this space offers
     create       open a new group and become its creator
     members      who is in this group, and what may be done about them
     invitations  the live ways in, and how to make or withdraw one
     requests     the people waiting to be let in

   EVERY DECISION ABOUT PERMISSION COMES FROM THE SERVER. This file decides
   what to DRAW — an admin is not shown the approval buttons, because the API
   would refuse them — and nothing else. The rules themselves live in
   db.can_manage_member and in the addressed guards, in one place each.

   SWITCHING SPACES RELOADS THE PAGE, deliberately. Every store in the Hub is
   loaded once, for one space. Re-pointing them silently would leave half the
   screen showing the space you just left — the one failure mode this whole
   phase exists to avoid. A reload is honest and instant.
   ========================================================================== */

(function (global) {
    "use strict";

    var bound = null;
    var pointerOpened = false;

    /* Which view is showing, and what it last read. Kept here so a re-render
       after an action does not send the person back to the home view. */
    var view = "home";
    var busy = false;
    var spaces = [];
    var currentSpaceId = null;
    var invitations = null;      /* the list for the open group */
    var freshInvitation = null;  /* the one just made, whose link exists once */
    var members = null;
    var requests = null;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function shortDate(iso) {
        var date = new Date(iso);
        if (isNaN(date.getTime())) return "";
        return date.getUTCDate() + " " +
               date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" }) +
               " " + date.getUTCFullYear();
    }

    /* How long is left, in words a person would use. Nothing here counts in
       seconds: an invitation lives for hours. */
    function untilText(iso) {
        var when = new Date(iso).getTime();
        if (isNaN(when)) return "";
        var minutes = Math.round((when - Date.now()) / 60000);
        if (minutes <= 0) return "expiring now";
        if (minutes < 60) return minutes + " min left";
        var hours = Math.round(minutes / 60);
        if (hours < 48) return hours + (hours === 1 ? " hour left" : " hours left");
        return shortDate(iso);
    }

    function auth() { return global.LoveStoryAuth || null; }
    function api() { return global.LoveStoryApi || null; }

    function snapshot() {
        if (global.LoveStoryEntry && global.LoveStoryEntry.state) {
            return global.LoveStoryEntry.state;
        }
        return auth() ? auth().snapshot() : null;
    }

    function byId(id) { return id ? document.getElementById(id) : null; }

    function roleWord(role) {
        return role === "creator" ? "Creator"
            : (role === "admin" ? "Admin" : "Member");
    }

    function spaceName(space) {
        if (!space) return "this space";
        return space.type === "personal" ? "My Space" : space.name;
    }

    /* ------------------------------------------------------------- the pieces */

    function label(text, extra) {
        return el("p", "account__label" + (extra ? " " + extra : ""), text);
    }

    function row(className) {
        return el("div", "account__row" + (className ? " " + className : ""));
    }

    /* A button that carries the drawer's own weight. `quiet` for the second
       thing in a pair, never for the main action. */
    function button(text, options) {
        options = options || {};
        var node = el("button", "account__button" +
                      (options.quiet ? " account__button--quiet" : "") +
                      (options.danger ? " account__button--danger" : ""), text);
        node.type = "button";
        if (options.title) node.title = options.title;
        return node;
    }

    function note(text, className) {
        return el("p", "account__note" + (className ? " " + className : ""), text);
    }

    /* An action that cannot be undone asks first, in the row itself rather than
       in a browser dialog: the question sits where the button was, so the
       person can see exactly what it is about. */
    function confirmRow(question, confirmText, onConfirm, onCancel) {
        var wrap = row("account__row--confirm");
        wrap.appendChild(el("p", "account__question", question));

        var actions = el("div", "account__actions");
        var yes = button(confirmText, { danger: true });
        var no = button("Cancel", { quiet: true });
        yes.addEventListener("click", onConfirm);
        no.addEventListener("click", onCancel);
        actions.appendChild(yes);
        actions.appendChild(no);
        wrap.appendChild(actions);
        return wrap;
    }

    /* ---------------------------------------------------------------- errors */

    function failure(error, fallback) {
        return (error && error.message) || fallback;
    }

    function report(message) {
        var line = byId("profileError");
        if (!line) return;
        line.textContent = message || "";
    }

    function run(action, onDone, fallbackMessage) {
        if (busy) return;
        busy = true;
        report("");
        action().then(function (result) {
            busy = false;
            if (onDone) onDone(result);
        }, function (error) {
            busy = false;
            report(failure(error, fallbackMessage));
        });
    }

    /* ------------------------------------------------------------------ home */

    function renderAccount(state) {
        var box = el("div", "account__block");

        box.appendChild(label("My Account"));
        box.appendChild(el("p", "account__name",
            (state.account && state.account.displayName) ||
            (state.user && state.user.displayName) || "\u2014"));
        if (state.account && state.account.username) {
            box.appendChild(el("p", "account__meta", state.account.username));
        }
        if (state.account && state.account.memberSince) {
            box.appendChild(el("p", "account__meta account__meta--since",
                "Member since " + shortDate(state.account.memberSince)));
        }
        return box;
    }

    function currentSpace() {
        for (var i = 0; i < spaces.length; i++) {
            if (spaces[i].id === currentSpaceId) return spaces[i];
        }
        return null;
    }

    function renderSpaces(state) {
        var box = el("div", "account__block");
        box.appendChild(label(spaces.length === 1 ? "My Space" : "My Spaces",
                              "account__label--space"));

        if (!spaces.length) {
            box.appendChild(note("No spaces yet."));
            return box;
        }

        var list = el("ul", "account__members");
        spaces.forEach(function (space) {
            var here = space.id === currentSpaceId;
            var item = el("li", "account__member account__member--space" +
                           (here ? " is-current" : ""));

            var name = el("span", "account__member-name", spaceName(space));
            var meta = el("span", "account__member-role",
                (space.type === "personal" ? "Personal" : "Group") +
                " \u00b7 " + roleWord(space.membershipRole) +
                " \u00b7 " + space.memberCount +
                (space.memberCount === 1 ? " member" : " members"));
            item.appendChild(name);
            item.appendChild(meta);

            if (here) {
                item.appendChild(el("span", "account__current", "Current"));
            } else {
                var open = button("Switch", { quiet: true });
                open.addEventListener("click", function () {
                    run(function () {
                        return api().selectSpace(space.id);
                    }, function () {
                        /* A different space is a different archive: every
                           store in the Hub has to be read again, from the
                           top. Reloading is the only honest way to do that. */
                        global.location.reload();
                    }, "That space could not be opened.");
                });
                item.appendChild(open);
            }
            list.appendChild(item);
        });
        box.appendChild(list);

        var create = button("Create a group space", { quiet: true });
        create.addEventListener("click", function () { go("create"); });
        var bar = el("div", "account__actions");
        bar.appendChild(create);
        box.appendChild(bar);

        return box;
    }

    /* What may be done to THIS space, if it is a group. A personal space has no
       members to manage, nobody to invite, and nobody waiting: it is one
       person's, and it says so by offering none of it. */
    function renderManagement(state) {
        var space = currentSpace();
        var box = el("div", "account__block");

        if (!space || space.type !== "group") {
            box.appendChild(label("This Space", "account__label--space"));
            box.appendChild(note(
                "A personal space is yours alone. Create a group space to "
                + "share the archive with other people."));
            return box;
        }

        var role = space.membershipRole;
        var manages = role === "creator" || role === "admin";

        box.appendChild(label("This Space", "account__label--space"));

        if (!manages) {
            box.appendChild(note(
                "You are a member of this space. You can add to everything in "
                + "it; its members and invitations are looked after by "
                + "its creator."));
            return box;
        }

        var membersButton = button("Members", { quiet: true });
        membersButton.addEventListener("click", function () { go("members"); });

        var invitesButton = button("Invitations", { quiet: true });
        invitesButton.addEventListener("click", function () { go("invitations"); });

        var pending = space.pendingJoinRequestCount;
        var requestsButton = button(
            pending ? "Join requests \u00b7 " + pending : "Join requests",
            { quiet: true });
        requestsButton.addEventListener("click", function () { go("requests"); });

        /* One under the other, each the width of the drawer: three outline
           buttons side by side in a 400px panel either wrap raggedly or read
           as a single control. */
        var bar = el("div", "account__actions account__actions--stack");
        bar.appendChild(membersButton);
        bar.appendChild(invitesButton);
        bar.appendChild(requestsButton);
        box.appendChild(bar);

        return box;
    }

    function renderHome() {
        var state = snapshot() || {};
        var body = document.createDocumentFragment();

        body.appendChild(renderAccount(state));
        body.appendChild(renderSpaces(state));
        body.appendChild(renderManagement(state));
        body.appendChild(renderPrivacySecurity());

        return body;
    }

    /* One quiet row, at the bottom of the Profile: the private archive, whether
       it has a password, and the way to the screen that changes it. It says
       configured or not configured and never whether it is open right now —
       that is the private archive's own business, on its own screen. */
    function renderPrivacySecurity() {
        var box = el("div", "account__block");
        box.appendChild(label("Privacy & Security", "account__label--space"));

        var row = el("div", "account__row");
        var line = el("p", "account__note");
        line.id = "profilePrivacySummary";
        line.textContent = privacyConfigured()
            ? "Private Archive \u00b7 configured"
            : "Private Archive \u00b7 not set up";
        row.appendChild(line);
        box.appendChild(row);

        var bar = el("div", "account__actions");
        var open = button("Privacy & security", { quiet: true });
        open.addEventListener("click", function () { go("privacy"); });
        bar.appendChild(open);
        box.appendChild(bar);

        if (global.LoveStoryPrivacy) {
            global.LoveStoryPrivacy.status().then(function (next) {
                var node = byId("profilePrivacySummary");
                if (!node) return;
                node.textContent = next.configured
                    ? "Private Archive \u00b7 configured"
                    : "Private Archive \u00b7 not set up";
            });
        }

        return box;
    }

    /* ---------------------------------------------------------------- create */

    function renderCreate() {
        var body = document.createDocumentFragment();
        body.appendChild(label("New Group Space"));

        var field = el("label", "account__field");
        field.appendChild(el("span", "account__field-label", "Name"));
        var input = el("input", "account__input");
        input.type = "text";
        input.id = "profileSpaceName";
        input.maxLength = 80;
        input.placeholder = "Our Space";
        input.autocomplete = "off";
        field.appendChild(input);
        body.appendChild(field);

        body.appendChild(note(
            "You will be its creator, and this sign-in will move into it. "
            + "Invite the people you want in it afterwards."));

        var actions = el("div", "account__actions");
        var create = button("Create space");
        var cancel = button("Cancel", { quiet: true });
        create.addEventListener("click", function () {
            var name = String(input.value || "").trim();
            /* Refused here rather than by the server: a round trip to be told
               what the page can already see is not a courtesy. It says so,
               though — a button that simply does nothing looks broken. */
            if (!name) {
                report("A space needs a name.");
                input.focus();
                return;
            }
            run(function () {
                return api().createSpace(name);
            }, function () {
                /* Creating a group moves this sign-in into it on the server,
                   so the page has to be read again for the same reason a
                   switch does. */
                global.location.reload();
            }, "That space could not be created.");
        });
        cancel.addEventListener("click", function () { go("home"); });
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter") { event.preventDefault(); create.click(); }
        });

        actions.appendChild(create);
        actions.appendChild(cancel);
        body.appendChild(actions);

        global.requestAnimationFrame(function () { input.focus(); });
        return body;
    }

    /* --------------------------------------------------------------- members */

    /* What THIS viewer may do to THAT member, decided by the same rule the API
       applies: a creator may promote a member and demote an admin; an admin may
       promote a member and remove one; nobody may touch the creator, and an
       admin is not another admin's to remove. */
    function memberActions(space, member, meId) {
        var acts = [];
        var mine = space.membershipRole;
        var target = member.membershipRole;

        if (member.userId === meId) return acts;
        if (target === "creator") return acts;
        if (mine === "member") return acts;

        if (target === "admin") {
            if (mine === "creator") {
                acts.push({ label: "Make member", role: "member" });
                acts.push({ label: "Remove", remove: true });
            }
            return acts;
        }

        acts.push({ label: "Make admin", role: "admin" });
        acts.push({ label: "Remove", remove: true });
        return acts;
    }

    function renderMemberRow(space, member, meId, rerender) {
        var item = el("li", "account__member account__member--managed");
        var head = el("div", "account__member-head");
        head.appendChild(el("span", "account__member-name", member.displayName));
        head.appendChild(el("span", "account__member-role",
            (member.userId === meId ? "You \u00b7 " : "") + roleWord(member.membershipRole)));
        item.appendChild(head);

        if (member.joinedAt) {
            item.appendChild(el("p", "account__meta", "Joined " + shortDate(member.joinedAt)));
        }

        var actions = memberActions(space, member, meId);
        if (!actions.length) return item;

        var bar = el("div", "account__actions");

        actions.forEach(function (action) {
            var control = button(action.label, {
                quiet: !action.remove,
                danger: !!action.remove
            });

            control.addEventListener("click", function () {
                if (!action.remove) {
                    run(function () {
                        return api().changeMemberRole(space.id, member.userId, action.role);
                    }, function () {
                        reloadView(rerender, function () {
                            return api().listMembers(space.id).then(function (data) {
                                members = (data && data.members) || [];
                            });
                        });
                    }, "That role could not be changed.");
                    return;
                }

                /* Taking somebody out of a space cannot be undone from here, so
                   it asks first — and the question stays in the row. */
                item.replaceChild(confirmRow(
                    "Remove " + member.displayName + " from " + spaceName(space) + "?",
                    "Remove",
                    function () {
                        run(function () {
                            return api().removeMember(space.id, member.userId);
                        }, function () {
                            reloadView(rerender, function () {
                                return api().listMembers(space.id).then(function (data) {
                                    members = (data && data.members) || [];
                                });
                            });
                        }, "They could not be removed.");
                    },
                    function () { rerender(); }
                ), bar);
            });

            bar.appendChild(control);
        });

        item.appendChild(bar);
        return item;
    }

    function renderMembers() {
        var body = document.createDocumentFragment();
        var space = currentSpace();
        var meId = (snapshot() || {}).user && snapshot().user.id;

        body.appendChild(label("Members"));

        if (!space) { body.appendChild(note("This space is not readable.")); return body; }

        if (members === null) {
            body.appendChild(note("Reading\u2026"));
            loadMembers(function () { render(); });
            return body;
        }

        body.appendChild(note(space.memberCount +
            (space.memberCount === 1 ? " person" : " people") + " in " + spaceName(space) + "."));

        var list = el("ul", "account__members");
        members.forEach(function (member) {
            list.appendChild(renderMemberRow(space, member, meId, render));
        });
        body.appendChild(list);

        return body;
    }

    function loadMembers(done) {
        var space = currentSpace();
        if (!space || members !== null) { if (done) done(); return; }
        api().listMembers(space.id).then(function (data) {
            members = (data && data.members) || [];
            if (done) done();
        }, function (error) {
            members = [];
            report(failure(error, "The members could not be read."));
            if (done) done();
        });
    }

    /* ----------------------------------------------------------- invitations */

    function renderInvitationBox() {
        var space = currentSpace();
        var box = el("div", "account__block");

        if (freshInvitation) {
            /* Shown exactly once, in this panel, because the server keeps only
               a fingerprint of it and genuinely cannot show it again. */
            box.appendChild(label("Your invitation", "account__label--space"));
            box.appendChild(note(
                "Send this to one person. It works once, then it is spent. "
                + "This is the only time it can be copied."));

            var field = el("label", "account__field");
            field.appendChild(el("span", "account__field-label", "Invitation link"));
            var link = el("input", "account__input");
            link.type = "text";
            link.readOnly = true;
            link.id = "profileInviteLink";
            /* One place knows where pages live; the API's own path is the
               fallback for a page loaded without routes.js. */
            link.value = (global.LoveStoryRoutes && global.LoveStoryRoutes.join
                    ? global.LoveStoryRoutes.join(freshInvitation.token)
                    : global.location.origin + (freshInvitation.inviteUrl || ""));
            field.appendChild(link);
            box.appendChild(field);

            var codeField = el("label", "account__field");
            codeField.appendChild(el("span", "account__field-label", "Or the code"));
            var code = el("input", "account__input");
            code.type = "text";
            code.readOnly = true;
            code.id = "profileInviteCode";
            code.value = freshInvitation.pairingCode || "";
            codeField.appendChild(code);
            box.appendChild(codeField);

            var actions = el("div", "account__actions");
            var copy = button("Copy link");
            copy.addEventListener("click", function () {
                link.focus();
                link.select();
                var copied = false;
                try { copied = global.document.execCommand("copy"); } catch (error) { copied = false; }
                copy.textContent = copied ? "Copied" : "Press \u2318C";
            });
            var done = button("Done", { quiet: true });
            done.addEventListener("click", function () {
                freshInvitation = null;
                render();
            });
            actions.appendChild(copy);
            actions.appendChild(done);
            box.appendChild(actions);
            return box;
        }

        var make = button("Create an invitation link");
        make.addEventListener("click", function () {
            run(function () {
                return api().createInvitationFor(space.id);
            }, function (result) {
                freshInvitation = result;
                invitations = null;
                render();
            }, "An invitation could not be created.");
        });
        var bar = el("div", "account__actions");
        bar.appendChild(make);
        box.appendChild(bar);

        return box;
    }

    function renderInvitations() {
        var body = document.createDocumentFragment();
        var space = currentSpace();
        body.appendChild(label("Invitations"));

        if (!space) { body.appendChild(note("This space is not readable.")); return body; }

        body.appendChild(renderInvitationBox());

        if (invitations === null) {
            body.appendChild(note("Reading\u2026"));
            loadInvitations(function () { render(); });
            return body;
        }

        if (!invitations.length) {
            body.appendChild(note("Nobody has an invitation to this space at the moment."));
            return body;
        }

        var list = el("ul", "account__members");
        invitations.forEach(function (invitation) {
            var item = el("li", "account__member account__member--invite");
            item.appendChild(el("span", "account__member-name",
                invitation.createdByName
                    ? invitation.createdByName + "\u2019s invitation"
                    : "An invitation"));
            item.appendChild(el("span", "account__member-role",
                "Waiting \u00b7 " + untilText(invitation.expiresAt)));
            item.appendChild(el("p", "account__meta",
                "Made " + shortDate(invitation.createdAt)));
            list.appendChild(item);
        });
        body.appendChild(list);

        /* The API withdraws every live invitation for a space at once, so the
           button says so rather than pretending to be per-invitation. */
        var withdraw = button("Withdraw all invitations", { quiet: true, danger: true });
        withdraw.addEventListener("click", function () {
            var actions = withdraw.parentNode;
            actions.replaceChild(confirmRow(
                "Withdraw every live invitation to " + spaceName(space) + "?",
                "Withdraw",
                function () {
                    run(function () {
                        return api().revokeInvitationsFor(space.id);
                    }, function () {
                        reloadView(render, function () {
                            return api().listInvitations(space.id).then(function (data) {
                                invitations = (data && data.invitations) || [];
                            });
                        });
                    }, "The invitations could not be withdrawn.");
                },
                function () { render(); }
            ), withdraw);
        });
        var withdrawBar = el("div", "account__actions");
        withdrawBar.appendChild(withdraw);
        body.appendChild(withdrawBar);

        return body;
    }

    function loadInvitations(done) {
        var space = currentSpace();
        if (!space || invitations !== null) { if (done) done(); return; }
        api().listInvitations(space.id).then(function (data) {
            invitations = (data && data.invitations) || [];
            if (done) done();
        }, function (error) {
            invitations = [];
            report(failure(error, "The invitations could not be read."));
            if (done) done();
        });
    }

    /* -------------------------------------------------------- join requests */

    function renderRequestRow(space, request, creator, rerender) {
        var item = el("li", "account__member account__member--managed");
        var head = el("div", "account__member-head");
        head.appendChild(el("span", "account__member-name", request.requesterName));
        head.appendChild(el("span", "account__member-role", "Asking"));
        item.appendChild(head);
        item.appendChild(el("p", "account__meta",
            "Asked " + shortDate(request.requestedAt)));

        if (!creator) {
            /* Seen, not decided. An admin can invite and can see who is
               waiting; letting somebody in is the creator's alone. */
            item.appendChild(note("Only the creator of this space can answer."));
            return item;
        }

        var bar = el("div", "account__actions");

        var approve = button("Let them in");
        approve.addEventListener("click", function () {
            run(function () {
                return api().reviewJoinRequest(space.id, request.id, "approve");
            }, function () {
                reloadView(rerender, function () {
                    return api().listJoinRequests(space.id, "pending").then(function (data) {
                        requests = (data && data.joinRequests) || [];
                    });
                });
            }, "That request could not be approved.");
        });

        var decline = button("Decline", { quiet: true, danger: true });
        decline.addEventListener("click", function () {
            item.replaceChild(confirmRow(
                "Turn down " + request.requesterName + "? They can be invited again later.",
                "Decline",
                function () {
                    run(function () {
                        return api().reviewJoinRequest(space.id, request.id, "decline");
                    }, function () {
                        reloadView(rerender, function () {
                            return api().listJoinRequests(space.id, "pending")
                                .then(function (data) {
                                    requests = (data && data.joinRequests) || [];
                                });
                        });
                    }, "That request could not be declined.");
                },
                function () { rerender(); }
            ), bar);
        });

        bar.appendChild(approve);
        bar.appendChild(decline);
        item.appendChild(bar);
        return item;
    }

    function renderRequests() {
        var body = document.createDocumentFragment();
        var space = currentSpace();
        var creator = !!space && space.membershipRole === "creator";

        body.appendChild(label("Join Requests"));

        if (!space) { body.appendChild(note("This space is not readable.")); return body; }

        if (requests === null) {
            body.appendChild(note("Reading\u2026"));
            loadRequests(function () { render(); });
            return body;
        }

        if (!requests.length) {
            body.appendChild(note(
                creator ? "Nobody is waiting to be let in."
                        : "Nobody is waiting to be let in. Only the creator "
                          + "can answer a request."));
            return body;
        }

        var list = el("ul", "account__members");
        requests.forEach(function (request) {
            list.appendChild(renderRequestRow(space, request, creator, render));
        });
        body.appendChild(list);

        return body;
    }

    function loadRequests(done) {
        var space = currentSpace();
        if (!space || requests !== null) { if (done) done(); return; }
        api().listJoinRequests(space.id, "pending").then(function (data) {
            requests = (data && data.joinRequests) || [];
            if (done) done();
        }, function (error) {
            requests = [];
            report(failure(error, "The requests could not be read."));
            if (done) done();
        });
    }

    /* -------------------------------------------------------- privacy views

       Two views, both deliberately small. The first says one thing — whether a
       privacy password exists — and offers the one action that follows from it:
       set it up, or change it. It does NOT report whether the archive is open
       right now: "unlocked until 20:15" is a fact about this browser that
       belongs on the private archive's own screen, not in a profile that
       somebody may be looking at with a friend beside them. */

    function privacyConfigured() {
        var known = (global.LoveStoryPrivacy && global.LoveStoryPrivacy.knownStatus())
            || null;
        return !!(known && known.configured);
    }

    function renderPrivacy() {
        var body = document.createDocumentFragment();
        body.appendChild(label("Privacy & Security"));

        var box = el("div", "account__block");
        box.appendChild(el("p", "account__name", "Private Archive"));

        var state = el("p", "account__meta");
        state.id = "profilePrivacyState";
        state.textContent = privacyConfigured() ? "Configured" : "Not set";
        box.appendChild(state);

        box.appendChild(note(
            "Private memories are kept out of Moments, the Timeline, Our World "
            + "and the gallery. They open with a password of their own, for ten "
            + "minutes at a time."));

        var bar = el("div", "account__actions account__actions--stack");
        var manage = button(privacyConfigured()
            ? "Change privacy password"
            : "Set up the Private Archive");
        manage.addEventListener("click", function () {
            go(privacyConfigured() ? "privacyPassword" : "privacyPassword");
        });
        bar.appendChild(manage);
        box.appendChild(bar);

        body.appendChild(box);

        /* The question is asked of the server rather than assumed from whatever
           this page happened to know, so a password set in another tab is not
           reported as missing. Status only — nothing about the contents. */
        if (global.LoveStoryPrivacy) {
            global.LoveStoryPrivacy.status({ force: true }).then(function (next) {
                var line = byId("profilePrivacyState");
                if (!line) return;
                line.textContent = next.configured ? "Configured" : "Not set";
            });
        }

        return body;
    }

    function renderPrivacyPassword() {
        var body = document.createDocumentFragment();
        var configured = privacyConfigured();
        body.appendChild(label(configured ? "Change Privacy Password"
                                          : "Set Up the Private Archive"));

        var host = el("div", "account__privacy-form");
        host.id = "profilePrivacyForm";
        body.appendChild(host);

        /* The same forms the private archive uses, mounted here so the copy,
           the validation and the error handling cannot drift apart. */
        global.requestAnimationFrame(function () {
            mountProfilePrivacy(configured);
        });
        return body;
    }

    function mountProfilePrivacy(configured) {
        var host = byId("profilePrivacyForm");
        if (!host || !global.LoveStoryPrivacy) return;

        if (!configured) {
            global.LoveStoryPrivacy.mount(host, "setup", {
                onDone: function (result) {
                    if (!result || !result.ok) return;
                    var line = byId("profilePrivacyState");
                    if (line) line.textContent = "Configured";
                    render();
                }
            });
            return;
        }

        /* Changing it needs the account password as well, and that is the whole
           point: a computer left signed in must not be able to replace the
           secret that guards the private archive. */
        var form = el("form", "privacy__inner");
        host.appendChild(form);

        var account = el("label", "privacy__field");
        account.appendChild(el("span", "privacy__field-label", "Account password"));
        var accountInput = el("input", "privacy__input");
        accountInput.type = "password";
        accountInput.autocomplete = "current-password";
        accountInput.id = "profileAccountPassword";
        account.appendChild(accountInput);
        form.appendChild(account);

        var fresh = el("label", "privacy__field");
        fresh.appendChild(el("span", "privacy__field-label", "New privacy password"));
        var freshInput = el("input", "privacy__input");
        freshInput.type = "password";
        freshInput.autocomplete = "new-password";
        freshInput.id = "profileNewPrivacy";
        fresh.appendChild(freshInput);
        form.appendChild(fresh);

        var again = el("label", "privacy__field");
        again.appendChild(el("span", "privacy__field-label", "Confirm new password"));
        var againInput = el("input", "privacy__input");
        againInput.type = "password";
        againInput.autocomplete = "new-password";
        againInput.id = "profileConfirmPrivacy";
        again.appendChild(againInput);
        form.appendChild(again);

        var error = el("p", "privacy__error");
        error.id = "profilePrivacyError";
        error.setAttribute("role", "alert");
        error.setAttribute("aria-live", "polite");
        form.appendChild(error);

        var actions = el("div", "privacy__actions");
        var submit = el("button", "privacy__submit", "Change password \u2192");
        submit.type = "submit";
        actions.appendChild(submit);
        form.appendChild(actions);

        var done = el("p", "account__note");
        done.id = "profilePrivacyDone";
        form.appendChild(done);

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            error.textContent = "";
            done.textContent = "";

            if (!accountInput.value) {
                error.textContent = "Please enter your account password.";
                accountInput.focus();
                return;
            }
            if ((freshInput.value || "").length < 8) {
                error.textContent = "Please use at least 8 characters.";
                freshInput.focus();
                return;
            }
            if (freshInput.value !== againInput.value) {
                error.textContent = "The two passwords are not the same.";
                againInput.focus();
                return;
            }

            submit.disabled = true;
            submit.textContent = "Changing\u2026";
            global.LoveStoryApi.privacyChangePassword(accountInput.value, freshInput.value)
                .then(function () {
                    /* The server locks every sign-in when the password changes,
                       including this one. Saying so is kinder than letting the
                       next private request be the thing that explains it. */
                    if (global.LoveStoryPrivacy) global.LoveStoryPrivacy.expired();
                    accountInput.value = "";
                    freshInput.value = "";
                    againInput.value = "";
                    submit.disabled = false;
                    submit.textContent = "Change password \u2192";
                    done.textContent = "Privacy password updated. "
                        + "The Private Archive has been locked \u2014 open it again "
                        + "with the new password when you need it.";
                }, function (failure) {
                    submit.disabled = false;
                    submit.textContent = "Change password \u2192";
                    error.textContent = (failure && failure.message)
                        || "That password could not be changed.";
                    if (failure && failure.status === 401) accountInput.focus();
                });
        });

        accountInput.focus();
    }

    /* ------------------------------------------------------------ the drawer */

    var TITLES = {
        home: "Profile",
        create: "New Group Space",
        members: "Members",
        invitations: "Invitations",
        requests: "Join Requests",
        privacy: "Privacy & Security",
        privacyPassword: "Change Privacy Password"
    };

    function go(next) {
        view = TITLES[next] ? next : "home";
        /* A fresh view reads afresh: the lists are small and the answer must
           not be a stale one. */
        if (view === "members") members = null;
        if (view === "invitations") invitations = null;
        if (view === "requests") requests = null;
        render();
    }

    /* Re-read the current view's data, then draw it.
    
       The space list is read again too, not just the list being looked at:
       letting somebody in or taking them out changes how many people are in
       the space, and that number is written in three places (the row in My
       Spaces, the line above the member list, and the heading itself). One
       request, one answer, nothing left saying "2" over a list of one. */
    function reloadView(rerender, read) {
        read().then(function () {
            return loadSpaces();
        }).then(function () {
            rerender();
        }, function (error) {
            report(failure(error, "That could not be read."));
            rerender();
        });
    }

    function backBar() {
        var bar = el("div", "account__back");
        var back = button("\u2190 Profile", { quiet: true });
        back.addEventListener("click", function () { go("home"); });
        bar.appendChild(back);
        return bar;
    }

    function draw() {
        if (!bound || !bound.body) return;
        var state = snapshot() || {};

        if (bound.name) {
            bound.name.textContent = (state.account && state.account.displayName) ||
                (state.user && state.user.displayName) || "Account";
        }

        if (bound.title) bound.title.textContent = TITLES[view] || "Profile";

        bound.body.textContent = "";
        if (view !== "home") bound.body.appendChild(backBar());

        var content = view === "create" ? renderCreate()
            : view === "members" ? renderMembers()
            : view === "invitations" ? renderInvitations()
            : view === "requests" ? renderRequests()
            : view === "privacy" ? renderPrivacy()
            : view === "privacyPassword" ? renderPrivacyPassword()
            : renderHome();

        var wrap = el("div", "account__view");
        wrap.appendChild(content);
        bound.body.appendChild(wrap);

        var error = el("p", "account__error");
        error.id = "profileError";
        error.setAttribute("role", "alert");
        error.setAttribute("aria-live", "polite");
        bound.body.appendChild(error);
    }

    /* The spaces this account is in, and which one this sign-in is looking at.
       Read when the drawer opens and after anything that changes them. */
    function loadSpaces() {
        var state = snapshot() || {};
        currentSpaceId = (state.currentSpace && state.currentSpace.id) ||
            (state.space && state.space.id) || null;

        if (!api() || !state.authenticated) {
            spaces = currentSpaceId ? [state.currentSpace || state.space] : [];
            return Promise.resolve();
        }

        return api().listSpaces().then(function (data) {
            spaces = (data && data.spaces) || [];
            if (typeof data.currentSpaceId === "number") currentSpaceId = data.currentSpaceId;
        }, function () {
            /* Unreachable: show what the session already told us rather than an
               empty list. */
            spaces = (state.currentSpace || state.space) ? [state.currentSpace || state.space] : [];
        });
    }

    function render() {
        if (!bound) return;
        if (view === "home") {
            loadSpaces().then(draw, draw);
            return;
        }
        draw();
    }

    function open() {
        if (!bound) return;
        view = view || "home";
        /* One panel at a time. The bell and the Profile both cover the page,
           and two scrims stacked is a page nobody can use. */
        document.dispatchEvent(new CustomEvent("lovestory:panel-open",
            { detail: { panel: "profile" } }));

        /* Opening on the home view is the right default every time: the person
           came to see who they are and where they are, not to resume a
           half-finished list. */
        if (view !== "home" && view !== "create") view = "home";
        members = null;
        requests = null;
        invitations = null;
        freshInvitation = null;

        render();
        bound.panel.hidden = false;
        if (bound.button) bound.button.setAttribute("aria-expanded", "true");
        global.requestAnimationFrame(function () {
            bound.panel.classList.add("is-open");
            if (bound.close) bound.close.focus();
        });
    }

    function close() {
        if (!bound) return;
        bound.panel.classList.remove("is-open");
        if (bound.button) bound.button.setAttribute("aria-expanded", "false");
        global.setTimeout(function () { bound.panel.hidden = true; }, 320);

        /* Returning focus to the trigger is right; leaving a keyboard ring on
           it after a mouse click is not. The gesture decides. */
        if (bound.button) {
            if (pointerOpened) bound.button.classList.add("is-quiet-focus");
            bound.button.focus();
        }
    }

    function bind(options) {
        options = options || {};
        bound = {
            button: byId(options.button),
            name: byId(options.name),
            title: byId(options.title),
            panel: byId(options.panel),
            body: byId(options.body),
            close: byId(options.close),
            scrim: byId(options.scrim),
            signOut: byId(options.signOut),
            redirect: options.redirect || null
        };
        if (!bound.panel || !bound.body) return null;

        if (bound.button) {
            bound.button.addEventListener("pointerdown", function () {
                pointerOpened = true;
            });
            bound.button.addEventListener("keydown", function () {
                pointerOpened = false;
            });
            bound.button.addEventListener("blur", function () {
                bound.button.classList.remove("is-quiet-focus");
            });
            bound.button.addEventListener("click", open);
        }
        if (bound.close) bound.close.addEventListener("click", close);
        if (bound.scrim) bound.scrim.addEventListener("click", close);

        if (bound.signOut) {
            bound.signOut.addEventListener("click", function () {
                var session = auth();
                if (!session) return;
                /* The session is ended on the server. Clearing the page's own
                   state would leave the cookie alive and the person still
                   signed in. */
                session.logout().then(function () {
                    global.location.href = bound.redirect ||
                        (global.LoveStoryRoutes
                            ? global.LoveStoryRoutes.page("entrance")
                            : "../gallery/index.html");
                });
            });
        }

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && bound && !bound.panel.hidden) close();
        });

        /* The bell was opened, so this one stands down. */
        document.addEventListener("lovestory:panel-open", function (event) {
            if (!bound || !event.detail || event.detail.panel === "profile") return;
            if (!bound.panel.hidden) close();
        });

        /* Anything the page does that changes who is here redraws it. */
        document.addEventListener("lovestory:auth-changed", function () {
            if (bound && !bound.panel.hidden) render();
            else if (bound && bound.name) draw();
        });

        return { open: open, close: close, render: render };
    }

    global.LoveStoryAccount = { bind: bind, open: open, close: close, render: render };
})(window);
