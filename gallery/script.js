/* ==========================================================================
   LoveStory — Entrance behaviour

   This page is now the only way in. It does three jobs:

     1. the opening sequence — the old landing page's arrival, kept but moved
        inside this page, and only ever run once per visit
     2. two films of photographs, watchable by anyone
     3. the gate: photographs and UNLOCK both open the same overlay, and a
        successful unlock continues to wherever the visitor was already going

   All photographs and destinations come from LoveStoryData, so nothing here
   is written down twice.
   ========================================================================== */

(function () {
    "use strict";

    var data = window.LoveStoryData;
    var auth = window.LoveStoryAuth;

    var IMAGE_BASE = "../image/";

    /* A photograph is either a bundled file name or a URL the server handed
       over whole. Only the bundled kind needs the base in front of it —
       prefixing an absolute URL builds a path that cannot exist. */
    function photoSrc(file) {
        if (!file) return "";
        if (/^(data:|blob:|https?:)/.test(file)) return file;
        return IMAGE_BASE + file;
    }

    /* Where a photograph leads is not written down here. Every address comes
       from LoveStoryRoutes, so a memory moving page cannot break a link. */
    var routes = window.LoveStoryRoutes;
    var HUB_URL = routes ? routes.hub() : "../hub/index.html";

    var COPIES = 3;
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* Per-frame character: the background film carries a slow wave, the
       primary film is straighter because you are meant to read it. */
    var TILT_MAIN = [1.6, -1.1, 2.0, -1.4, 1.2, -1.8];
    var SCALE_MAIN = [1, 1.02, .99, 1.01, 1, 1.02];
    var WAVE_BG = [0, .85, .85, 0, -.85, -.85];
    var TURN_BG = [-2.6, -1.3, 1.3, 2.6, 1.3, -1.3];
    var GAP_BG = [1, 1.2, .9, 1.1, 1.25, .88];
    var SCALE_BG = [1, 1.05, .97, 1.03, .98, 1.04];

    var STRIPS = [
        { selector: ".strip--bg", order: [0, 2, 4, 1, 3, 5], wave: WAVE_BG, turn: TURN_BG, gap: GAP_BG, scale: SCALE_BG, interactive: false },
        { selector: ".strip--main", order: [3, 5, 1, 4, 0, 2], turn: TILT_MAIN, scale: SCALE_MAIN, interactive: true }
    ];

    /* ------------------------------------------------------------------ elements */
    var overlay = document.getElementById("unlockOverlay");
    var scrim = document.getElementById("unlockScrim");
    var closeButton = document.getElementById("unlockClose");
    var form = document.getElementById("unlockForm");
    var userInput = document.getElementById("unlockUser");
    var passInput = document.getElementById("unlockPass");
    var errorLine = document.getElementById("unlockError");
    var submitLabel = document.querySelector("[data-submit-label]");
    var unlockButton = document.getElementById("unlockButton");
    var unlockLabel = document.querySelector("[data-unlock-label]");
    var unlockArrow = document.querySelector(".unlock-button__arrow");
    var accountNote = document.querySelector("[data-account-note]");
    var hint = document.querySelector("[data-hint]");
    var note = document.getElementById("galleryNote");

    /* Account surfaces. All optional — the Entrance works without them. */
    var lead = document.getElementById("unlockLead");
    var userLabel = document.getElementById("unlockUserLabel");
    var nameInput = document.getElementById("unlockName");
    var guestButton = document.getElementById("unlockGuest");
    var passConfirm = document.getElementById("unlockConfirm");
    var confirmLabel = document.getElementById("unlockConfirmLabel");
    var modeSwitch = document.getElementById("unlockModeSwitch");
    var modeCurrent = document.getElementById("unlockModeCurrent");
    var modeAction = document.getElementById("unlockModeAction");
    var panel = document.querySelector(".unlock__panel");
    var accountPanel = document.getElementById("accountPanel");
    var accountName = document.getElementById("accountName");
    var accountRole = document.getElementById("accountRole");
    /* The space this sign-in is looking at. Space management itself lives in
       the Profile inside Our Space — there is no second copy of it here. */
    var accountSpace = document.getElementById("accountSpace");
    var accountSignOut = document.getElementById("accountSignOut");

    /* "setup" while the archive has no owner, "signin" ever after. */
    var mode = "signin";

    /* Where the visitor was heading when they were asked to unlock. */
    var pendingDestination = null;

    /* What to give focus back to when the overlay closes. */
    var lastTrigger = null;

    /* --------------------------------------------------------------- the note */
    var noteTimer = null;

    function showNote(message) {
        if (!note) return;
        note.textContent = message;
        note.classList.add("is-visible");
        window.clearTimeout(noteTimer);
        noteTimer = window.setTimeout(function () {
            note.classList.remove("is-visible");
        }, 3200);
    }

    /* ----------------------------------------------------------- the opening */
    /* LOVE / STORY arrives out of black, then the room appears, and only then
       do the films start to move. Nothing overlaps. */
    function runOpening() {
        if (reducedMotion) {
            document.body.classList.add("is-revealed", "is-running");
            return;
        }

        window.setTimeout(function () {
            document.body.classList.add("is-revealed");
        }, 1100);

        window.setTimeout(function () {
            document.body.classList.add("is-running");
        }, 1900);
    }

    /* ------------------------------------------------------------ the films */
    /* The film is the opening experience and the way in — not a set of links
       into individual memories. Every photograph leads to the same place: Our
       Space. Which memory a frame shows is still recorded, because the caption
       and the film itself read it, but it deliberately decides nothing about
       where a click goes. */
    /* The film is built from the archive: favourites first, then the most
       recent, using each memory's cover photograph. With nothing in the
       archive it returns empty frames — never a demonstration photograph, and
       never a broken image. */
    function collectPhotos() {
        var memories = (data.memories || []).slice();

        var favourites = memories.filter(function (m) { return m.favorite; });
        var rest = memories.filter(function (m) { return !m.favorite; });
        var ordered = favourites.concat(rest);

        var out = [];
        ordered.forEach(function (memory) {
            /* The memory's cover, wherever the archive decided it is. */
            var cover = data.coverUrl ? data.coverUrl(memory) : "";
            if (!cover) return;
            out.push({ file: cover, title: memory.title, memoryId: memory.id });
        });

        if (out.length) return out;

        /* An empty archive still needs a film. Six blank frames keep the strip
           moving and the silhouette intact. */
        for (var i = 0; i < 6; i++) {
            out.push({ file: "", title: "Our Story", memoryId: null, empty: true });
        }
        return out;
    }

    /* A frame opens Our Space, never the memory it happens to show. */
    function actionWord() {
        return isUnlocked() ? "Enter Our Space" : "Unlock Our Story";
    }

    function createFrame(photo, character, isDuplicate) {
        var frame = document.createElement("a");
        frame.className = "frame";

        /* Every frame is a door into Our Space, so the href is the Hub — for
           the unlocked click, and for anyone opening it in a new tab. The
           memory id stays on the element purely as data. */
        frame.href = hubURL();
        if (photo.memoryId) frame.dataset.memoryId = photo.memoryId;

        frame.setAttribute("aria-label", photo.title + " \u2014 " + actionWord());

        if (isDuplicate) {
            frame.setAttribute("aria-hidden", "true");
            frame.tabIndex = -1;
        }

        if (character.y) frame.style.setProperty("--ym", character.y);
        frame.style.setProperty("--rm", character.r);
        frame.style.setProperty("--fwm", character.fwm);
        if (character.gap !== undefined) frame.style.setProperty("--gapmul", character.gap);

        var inner = document.createElement("span");
        inner.className = "frame__inner";

        if (photo.file) {
            var image = document.createElement("img");
            image.src = photoSrc(photo.file);
            image.alt = isDuplicate ? "" : photo.title;
            image.loading = "lazy";
            image.decoding = "async";
            image.draggable = false;
            inner.appendChild(image);
        } else {
            /* An empty frame: no photograph, just the mount. */
            inner.classList.add("frame__inner--empty");
        }

        var caption = document.createElement("span");
        caption.className = "frame__caption";

        var action = document.createElement("span");
        action.className = "frame__action";
        action.dataset.action = "";
        action.textContent = actionWord();

        var arrow = document.createElement("span");
        arrow.className = "frame__arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "\u2197";

        caption.appendChild(action);
        caption.appendChild(arrow);

        frame.appendChild(inner);
        frame.appendChild(caption);
        return frame;
    }

    function buildStrip(config) {
        var strip = document.querySelector(config.selector);
        if (!strip) return;

        var track = strip.querySelector(".strip__track");
        var photos = collectPhotos();
        var fragment = document.createDocumentFragment();

        for (var copy = 0; copy < COPIES; copy++) {
            config.order.forEach(function (photoIndex, i) {
                var photo = photos[photoIndex % photos.length];
                if (!photo) return;

                fragment.appendChild(createFrame(photo, {
                    y: config.wave ? config.wave[i] : 0,
                    r: config.turn[i],
                    fwm: config.scale[i],
                    gap: config.gap ? config.gap[i] : undefined
                }, copy > 0 && config.interactive));
            });
        }

        track.appendChild(fragment);
    }

    function hubURL() {
        return routes ? routes.hub() : HUB_URL;
    }

    /* Where this visitor belongs now, asked of the one resolver that knows.
       Signing in means Our Space — every account has one, its own, from the
       moment it exists — except for somebody who arrived with an invitation,
       who goes to the request they came to make. */
    function destinationNow() {
        if (!window.LoveStoryEntry || !auth) return hubURL();
        return window.LoveStoryEntry.destinationFor(auth.snapshot(), {
            invite: window.LoveStoryEntry.inviteFromUrl(),
            whenPaired: hubURL()
        });
    }

    /* The single way in, used by the UNLOCK button and by every photograph.
       Signed out it opens the gate; signed in it goes straight through. */
    function enterOurSpace(trigger) {
        if (isUnlocked()) {
            /* Signed in: "Enter Our Space" means Our Space, or the invitation
               they arrived holding. */
            window.location.href = destinationNow();
            return;
        }

        /* No memory is carried, because none was asked for: the Entrance leads
           to Our Space, and the visitor chooses a memory from there. */
        openUnlock({ type: "hub" }, trigger);
    }

    /* ------------------------------------------------------------ auth state */
    /* Signed in as an editor — not "may look at the archive", which everyone
       may do. The wording and the account button follow from this. */
    function isUnlocked() {
        return !!(auth && auth.isAuthenticated());
    }

    /* The whole interface reads from one place. */
    function applyAuthState() {
        var unlocked = isUnlocked();

        document.body.classList.toggle("is-unlocked", unlocked);

        if (unlockLabel) unlockLabel.textContent = unlocked ? "Our Space" : "Unlock";
        if (unlockArrow) unlockArrow.textContent = unlocked ? "\u00b7" : "\u2197";
        if (accountNote) accountNote.textContent = unlocked ? "" : "Private archive";
        if (hint) {
            /* "Enter" means Our Space — not an individual memory. */
            hint.textContent = unlocked
                ? "Click a memory to enter"
                : "Click a memory to unlock";
        }

        Array.prototype.forEach.call(
            document.querySelectorAll("[data-action]"),
            function (element) { element.textContent = actionWord(); }
        );
    }

    /* ---------------------------------------------------------- account state
       The header shows who is here. Signed out it is an invitation to sign in;
       signed in it is the person's name, and behind it the two things they can
       actually do. */
    function applyAccountState() {
        var signedIn = !!(auth && auth.isAuthenticated());
        var user = auth && auth.user;

        if (unlockLabel) unlockLabel.textContent = signedIn ? (user ? user.displayName : "Our Space") : "Unlock";
        if (unlockArrow) unlockArrow.textContent = signedIn ? "\u00b7" : "\u2197";
        if (accountNote) {
            /* The name of the space this sign-in is looking at, not a part in
               a pair: "Owner" and "Partner" were the two-person model's words
               and the archive no longer has two-person spaces. */
            var where = auth && auth.currentSpace;
            accountNote.textContent = signedIn
                ? ((where && (where.type === "personal" ? "My Space" : where.name))
                   || "Our Space")
                : "Private archive";
        }

        if (accountName) accountName.textContent = user ? user.displayName : "\u2014";
        if (accountRole) {
            /* The account, not a role in a pair. Anyone signed in may read and
               write the spaces they are in, so "Partner" and "Owner" are words
               the page has no business using. */
            accountRole.textContent = user ? "Signed in" : "";
        }

        /* Which space this sign-in is looking at, and what the person is in
           it. Read from the session the server answered with — the pages do
           not work it out for themselves. */
        var space = auth && auth.currentSpace;
        if (accountSpace) {
            if (!space) {
                accountSpace.hidden = true;
                accountSpace.textContent = "";
            } else {
                var role = space.membershipRole === "creator" ? "Creator"
                    : (space.membershipRole === "admin" ? "Admin" : "Member");
                accountSpace.hidden = false;
                accountSpace.textContent = (space.type === "personal" ? "My Space" : space.name) +
                    " \u00b7 " + role;
            }
        }
    }

    /* Which form the overlay shows. Same room either way. */
    /* Three ways into the same room:
         signin    an account exists and this is it
         register  a new personal account — signed in, not yet paired
         setup     the very first visit, when the archive has no owner at all */
    var MODES = {
        signin:   { lead: "Unlock our archive.",      submit: "Enter",          names: false },
        register: { lead: "Create your account.",     submit: "Create account", names: true },
        setup:    { lead: "Create our archive.",      submit: "Create archive", names: true }
    };

    /* The two words the switch can show. "Sign in" is what the form above is
       doing; the OTHER one is the only thing this line can do. */
    var MODE_LABELS = {
        signin: "Sign in",
        register: "Create account",
        setup: "Create archive"
    };

    /* Which is current and which is the way out, from the mode rather than from
       the order of two spans. The current mode is never the gold one. */
    function renderModeSwitch() {
        if (!modeAction) return;
        var other = mode === "register" ? "signin" : "register";
        if (modeCurrent) {
            modeCurrent.textContent = MODE_LABELS[mode] || MODE_LABELS.signin;
        }
        modeAction.textContent = MODE_LABELS[other];
        modeAction.setAttribute("data-target", other);
    }

    function setMode(next) {
        mode = MODES[next] ? next : "signin";
        var shape = MODES[mode];

        if (panel) panel.setAttribute("data-mode", mode);
        if (lead) lead.textContent = shape.lead;
        if (userLabel) userLabel.textContent = "Username";
        if (submitLabel) submitLabel.textContent = shape.submit;
        if (errorLine) errorLine.textContent = "";
        if (passConfirm) passConfirm.value = "";

        /* Immediately, as part of the same change — never after a blur, a
           hover or a second click. */
        renderModeSwitch();
    }

    function askSetupStatus() {
        if (!auth || !auth.setupStatus) return;
        auth.setupStatus().then(function (status) {
            setMode(status && status.needsOwnerSetup ? "setup" : "signin");
        }, function () {
            setMode("signin");
        });
    }

    /* -------------------------------------------------------- the unlock gate */
    function openUnlock(destination, trigger) {
        if (!overlay) return;

        pendingDestination = destination || null;
        askSetupStatus();
        lastTrigger = trigger || document.activeElement;

        errorLine.textContent = "";
        overlay.hidden = false;
        document.body.classList.add("is-unlocking");

        window.requestAnimationFrame(function () {
            overlay.classList.add("is-open");
        });

        if (userInput) userInput.focus();
    }

    function closeUnlock() {
        if (!overlay) return;

        overlay.classList.remove("is-open", "is-unlocked", "is-leaving");
        document.body.classList.remove("is-unlocking");

        window.setTimeout(function () {
            overlay.hidden = true;
        }, reducedMotion ? 20 : 450);

        if (passInput) passInput.value = "";
        errorLine.textContent = "";
        if (submitLabel) submitLabel.textContent = "Enter";
        pendingDestination = null;

        if (lastTrigger && typeof lastTrigger.focus === "function") lastTrigger.focus();
    }

    function unlockFieldsEmpty() {
        return (!userInput || !userInput.value) && (!passInput || !passInput.value);
    }

    /* One sequence for success: the rule draws, the form withdraws, the room
       sinks, and only then do we leave. */
    function succeed() {
        /* Resolved once, at the moment of leaving.

           The pending destination is a memory somebody clicked before signing
           in; if there is none, Our Space is the answer. An invitation in the
           URL outranks both — they have already said where they are going. */
        var invite = window.LoveStoryEntry
            ? window.LoveStoryEntry.inviteFromUrl() : "";
        var destination = invite
            ? destinationNow()
            : (routes ? routes.resolve(pendingDestination)
                      : (pendingDestination || HUB_URL));

        if (overlay) overlay.classList.add("is-unlocked");
        if (submitLabel) submitLabel.textContent = "Unlocked";

        window.setTimeout(applyAuthState, 300);

        window.setTimeout(function () {
            if (overlay) overlay.classList.add("is-leaving");
        }, 420);

        window.setTimeout(function () {
            document.body.classList.add("is-leaving");
        }, 620);

        window.setTimeout(function () {
            /* Consumed, so a later unlock never repeats this journey. */
            pendingDestination = null;
            window.location.href = destination;
        }, reducedMotion ? 150 : 1050);

        /* A safety net. The page fades before it navigates, so if the jump
           does not happen — a blocked navigation, an extension, anything — the
           visitor would be left staring at an empty dark screen with no way
           forward. If we are still here shortly after, put the page back and
           offer the door explicitly. */
        window.setTimeout(function () {
            if (document.body.classList.contains("is-leaving")) {
                document.body.classList.remove("is-leaving");
            }
            if (overlay) overlay.classList.remove("is-leaving");

            if (document.getElementById("afterAuth")) return;

            var panel = document.querySelector(".unlock__panel");
            if (!panel) return;

            var done = document.createElement("div");
            done.id = "afterAuth";
            done.className = "unlock__done";

            var line = document.createElement("p");
            line.className = "unlock__lead";
            line.textContent = "Your account is ready.";

            var open = document.createElement("a");
            open.className = "unlock__guest";
            open.href = destination;
            open.textContent = "Open Our Space";
            var arrow = document.createElement("span");
            arrow.setAttribute("aria-hidden", "true");
            arrow.textContent = " \u2192";
            open.appendChild(arrow);

            done.appendChild(line);
            done.appendChild(open);
            panel.appendChild(done);
        }, reducedMotion ? 900 : 2600);
    }

    if (form) {
        form.addEventListener("submit", function (event) {
            event.preventDefault();

            if (!auth) return;

            var username = userInput ? userInput.value : "";
            var password = passInput ? passInput.value : "";

            /* Signing in is a request to the server, so it is awaited. It used
               to be a synchronous compare here; when it became a Promise, every
               password would have looked like a success. */
            if (submitLabel) submitLabel.textContent = "Checking\u2026";

            /* Checked here so a typo is caught before a round trip; the server
               validates everything again and its answer is what is shown. */
            if (MODES[mode].names && passConfirm &&
                password !== passConfirm.value) {
                errorLine.textContent = "The two passwords are not the same.";
                if (submitLabel) submitLabel.textContent = MODES[mode].submit;
                passConfirm.focus();
                return;
            }

            var attempt = mode === "signin"
                ? auth.login(username, password)
                : (mode === "setup"
                    ? auth.setupOwner(username, nameInput ? nameInput.value : "", password)
                    : auth.registerAccount(
                        nameInput ? nameInput.value : "", username, password));

            attempt.then(function () {
                succeed();
            }, function (error) {
                /* The server's words, which are written for people. */
                errorLine.textContent = (error && error.message)
                    || (mode === "signin"
                        ? "Unable to unlock the archive."
                        : "That account could not be created.");
                setMode(mode);
                if (MODES[mode].names && nameInput && !nameInput.value) nameInput.focus();
                else if (passInput) { passInput.value = ""; passInput.focus(); }
            });
        });
    }

    /* Every way in goes through openUnlock — one overlay, one code path. */
    if (unlockButton) {
        unlockButton.addEventListener("click", function () {
            /* Signed in: this button is the account, not a way in. */
            if (isUnlocked()) {
                openAccount();
                return;
            }
            enterOurSpace(unlockButton);
        });
    }

    /* Every photograph goes through the same door, locked or not. Which memory
       a frame shows is not part of the decision. */
    document.addEventListener("click", function (event) {
        if (!(event.target instanceof Element)) return;

        var frame = event.target.closest("a.frame[href]");
        if (!frame) return;

        /* A modified click is the visitor asking the browser for a new tab, a
           window or a download — leave it alone; the href is already the Hub. */
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
            event.button > 0) return;

        event.preventDefault();
        enterOurSpace(frame);
    });

    /* There is no guest door any more. The archive holds two people's private
       life; the API refuses shared content to anyone without a session, so a
       "continue as guest" button would lead only to empty pages. */

    /* The way between signing in and creating an account, without leaving the
       room.

       One control, and it goes to whichever mode is not the current one. Focus
       moves to the first field of the form that appeared, so the click leaves
       nothing behind on the switch itself: the point underneath the pointer
       becomes the muted current label, and the new action is a different word
       in a different place. */
    if (modeAction) {
        modeAction.addEventListener("click", function () {
            var target = modeAction.getAttribute("data-target") || "register";
            setMode(target);

            /* The first field of the form that is now on screen — asked for
               rather than assumed. This used to be "the name field when
               registering", but the name field belongs to the very first run
               alone, so on a register form it is hidden and focusing it does
               nothing: the focus stayed on the switch, which is precisely the
               decoration this control is not supposed to keep. */
            var first = null;
            [nameInput, userInput, passInput].forEach(function (field) {
                if (!first && field && field.offsetParent !== null) first = field;
            });
            if (first) first.focus();
        });
    }

    /* -------------------------------------------------------------- account */
    function openAccount() {
        if (!accountPanel) return;
        applyAccountState();
        accountPanel.hidden = false;
        window.requestAnimationFrame(function () {
            accountPanel.classList.add("is-open");
        });
    }

    function closeAccount() {
        if (!accountPanel) return;
        accountPanel.classList.remove("is-open");
        window.setTimeout(function () { accountPanel.hidden = true; }, reducedMotion ? 20 : 350);
    }

    if (accountSignOut) {
        accountSignOut.addEventListener("click", function () {
            if (!auth) return;
            auth.logout().then(function () {
                closeAccount();
                applyAccountState();
                applyAuthState();
                showNote("Signed out");
            });
        });
    }

    document.getElementById("accountScrim").addEventListener("click", closeAccount);

    /* Inviting, being invited and every other piece of space management belongs
       to the Profile inside Our Space. The Entrance keeps only the way in and
       the way out — there is no second invitation panel here to drift out of
       step with the real one. */

    if (closeButton) closeButton.addEventListener("click", closeUnlock);

    if (scrim) {
        scrim.addEventListener("click", function () {
            /* Do not throw away something half-typed. */
            if (unlockFieldsEmpty()) closeUnlock();
        });
    }

    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        if (overlay && !overlay.hidden) closeUnlock();
    });

    /* -------------------------------------------------------------------- go */
    /* Read the archive before building the film, so it is drawn once from real
       data rather than rebuilt. */
    applyAuthState();
    runOpening();

    data.loadMemories().then(function () {
        buildStrip(STRIPS[0]);
        buildStrip(STRIPS[1]);
    }, function () {
        buildStrip(STRIPS[0]);
        buildStrip(STRIPS[1]);
    });

    /* The session is resolved by the server, so the first paint is a guest and
       the header settles once the answer arrives. */
    if (auth && auth.ready) {
        auth.ready.then(function () { applyAuthState(); applyAccountState(); },
                        function () { applyAuthState(); applyAccountState(); });
        document.addEventListener("lovestory:auth-changed", function () {
            applyAuthState();
            applyAccountState();
        });
        askSetupStatus();
    }
})();
