/* ==========================================================================
   LoveStory — the privacy lock

   The Private Archive has two passwords and the project already had one. This
   file is the second: the thing that knows whether the private archive is
   configured, whether THIS sign-in has it open, and how to open it.

   It is deliberately small and deliberately shared. Three pages need it — the
   Hub (to say whether the archive is locked), the memory form (to set it up or
   unlock it without losing a half-written memory), and the private archive
   itself — and three copies of a password prompt is three places for the copy,
   the autocomplete hint or the error handling to drift apart.

   WHAT THIS FILE NEVER DOES

     · it never fetches a private memory. Only the private archive page does
       that, with the private store, in the one page that has one;
     · it never stores the password, the status, or anything else in
       localStorage, sessionStorage or a cookie. The status is memoised in a
       module variable for the life of one page load and thrown away with it;
     · it never polls. Asking repeatedly would be pointless — the status
       endpoint does not extend the unlock — and the front-end should not be
       the thing that decides when a timeout has passed. The server compares the
       timestamp; the page is told the answer.

   THE ONE THING IT DOES FOR EVERYONE

   `onLock(fn)` is how a page gets told that the archive closed — because
   somebody pressed LOCK, or because the ten minutes ran out and a request came
   back 423. Every part of the interface that is holding a private memory
   registers here, and clearing it is then one call rather than a search through
   the DOM for things that should not still be there.
   ========================================================================== */

(function (global) {
    "use strict";

    var PRIVACY_UNLOCK_MINUTES = 10;   /* replaced by the server's answer */

    /* The last status this page was told, and the request that is getting it.
       Both die with the page — which is the whole of the persistence story. */
    var cached = null;
    var inFlight = null;

    var lockListeners = [];

    function api() { return global.LoveStoryApi || null; }
    function byId(id) { return id ? document.getElementById(id) : null; }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    /* --------------------------------------------------------------- status */

    function status(options) {
        options = options || {};
        if (cached && !options.force) return Promise.resolve(cached);
        if (inFlight && !options.force) return inFlight;
        if (!api()) {
            return Promise.resolve({ configured: false, unlocked: false,
                                     unlockedUntil: null,
                                     timeoutMinutes: PRIVACY_UNLOCK_MINUTES });
        }

        inFlight = api().privacyStatus().then(function (data) {
            inFlight = null;
            cached = {
                configured: !!(data && data.configured),
                unlocked: !!(data && data.unlocked),
                unlockedUntil: (data && data.unlockedUntil) || null,
                timeoutMinutes: (data && data.timeoutMinutes) || PRIVACY_UNLOCK_MINUTES
            };
            if (cached.timeoutMinutes) PRIVACY_UNLOCK_MINUTES = cached.timeoutMinutes;
            return cached;
        }, function () {
            inFlight = null;
            /* Unreachable is not the same as unconfigured, but it is the safe
               answer: nothing private is shown on a guess. */
            cached = { configured: false, unlocked: false, unlockedUntil: null,
                       timeoutMinutes: PRIVACY_UNLOCK_MINUTES, unreachable: true };
            return cached;
        });

        return inFlight;
    }

    function forget() { cached = null; inFlight = null; }

    /* The last answer, synchronously, or null if this page has not asked yet.
       Used by the memory sheet, which draws its privacy section from a state it
       already has rather than starting a request to draw a radio button. */
    function knownStatus() { return cached; }

    function remember(next) {
        cached = {
            configured: !!(next && next.configured),
            unlocked: !!(next && next.unlocked),
            unlockedUntil: (next && next.unlockedUntil) || null,
            timeoutMinutes: (next && next.timeoutMinutes) || PRIVACY_UNLOCK_MINUTES
        };
        return cached;
    }

    /* ------------------------------------------------------------- the lock */

    /* A page registers what it must let go of. Returning nothing is fine; the
       point is that the clearing happens in one place, at one moment. */
    function onLock(listener) {
        if (typeof listener === "function") lockListeners.push(listener);
    }

    function forgetEverything() {
        forget();
        lockListeners.forEach(function (listener) {
            try { listener(); } catch (error) { /* one bad listener is not all of them */ }
        });
    }

    /* Called after a LOCK that succeeded.

       The configured flag is carried over from what this page already knew,
       never asserted: locking an archive that has no password would otherwise
       leave the interface claiming one exists. */
    function locked() {
        remember({ configured: !!(cached && cached.configured), unlocked: false,
                   unlockedUntil: null, timeoutMinutes: PRIVACY_UNLOCK_MINUTES });
        lockListeners.forEach(function (listener) {
            try { listener(); } catch (error) { /* as above */ }
        });
    }

    /* Called when the server says the archive is closed: 423 from any private
       request, or an expired window discovered some other way.

       This is the difference between a privacy feature and a privacy feature
       that leaks: the cards already on screen are removed at this moment, not
       left there because they were fetched a minute ago and still look fine. */
    function expired() {
        forgetEverything();
    }

    function lock() {
        if (!api()) return Promise.resolve();
        return api().privacyLock().then(function () {
            locked();
            return true;
        }, function (error) {
            /* The server could not be told, so the page must not pretend. The
               local state is cleared anyway: if the request never arrived, the
               unlock is still running out on its own, and showing private
               memories on the strength of a failed lock call would be the worst
               of both. */
            if (error && error.status === 401) expired();
            throw error;
        });
    }

    /* --------------------------------------------------------------- forms */

    function field(labelText, inputId, autocomplete, options) {
        options = options || {};
        var wrap = el("label", "privacy__field");
        wrap.appendChild(el("span", "privacy__field-label", labelText));
        var input = el("input", "privacy__input");
        input.type = "password";
        input.id = inputId;
        input.autocomplete = autocomplete;
        if (options.placeholder) input.placeholder = options.placeholder;
        wrap.appendChild(input);
        return wrap;
    }

    function errorLine(id) {
        var line = el("p", "privacy__error");
        line.id = id;
        line.setAttribute("role", "alert");
        line.setAttribute("aria-live", "polite");
        return line;
    }

    /* The three forms, in one place, so the copy says the same thing whichever
       page asked for it. */
    function build(kind, options) {
        options = options || {};
        var body = el("div", "privacy__form");
        var ids = {};

        if (kind === "setup") {
            body.appendChild(el("p", "privacy__eyebrow", "Private archive"));
            body.appendChild(el("h2", "privacy__title",
                "An additional lock for your private memories."));
            body.appendChild(el("p", "privacy__note",
                "This password is separate from your sign-in password. It is "
                + "not encryption \u2014 it is a second lock on who may open your "
                + "private archive, and it lasts ten minutes at a time."));

            var account = field("Account password", "privacyAccountPassword",
                                "current-password");
            var fresh = field("New privacy password", "privacyNewPassword",
                              "new-password",
                              { placeholder: "At least 8 characters" });
            var again = field("Confirm privacy password", "privacyConfirmPassword",
                              "new-password");
            body.appendChild(account);
            body.appendChild(fresh);
            body.appendChild(again);

            var accountError = errorLine("privacyAccountError");
            var passwordError = errorLine("privacyPasswordError");
            body.appendChild(accountError);
            body.appendChild(passwordError);

            ids.account = "privacyAccountPassword";
            ids.fresh = "privacyNewPassword";
            ids.again = "privacyConfirmPassword";
            ids.accountError = "privacyAccountError";
            ids.passwordError = "privacyPasswordError";

            body.appendChild(submitRow("Set up private archive",
                                       "privacySubmit", options.cancel));
        } else {
            body.appendChild(el("p", "privacy__eyebrow", "Private archive"));
            body.appendChild(el("h2", "privacy__title",
                "Protected memories require your privacy password."));
            body.appendChild(el("p", "privacy__note",
                "Your private memories stay closed until you open them. This "
                + "lasts ten minutes, and only for this browser."));

            body.appendChild(field("Privacy password", "privacyUnlockPassword",
                                   "off"));
            body.appendChild(errorLine("privacyUnlockError"));
            ids.fresh = "privacyUnlockPassword";
            ids.passwordError = "privacyUnlockError";

            var lockRow = submitRow("Unlock", "privacySubmit", options.cancel);
            if (options.settings) {
                lockRow.appendChild(options.settings);
            }
            body.appendChild(lockRow);
        }

        return { body: body, ids: ids };
    }

    function submitRow(label, id, cancel) {
        var row = el("div", "privacy__actions");
        var submit = el("button", "privacy__submit", label + " \u2192");
        submit.type = "submit";
        submit.id = id;
        row.appendChild(submit);
        if (cancel) {
            var back = el("button", "privacy__cancel", "Cancel");
            back.type = "button";
            back.id = "privacyCancel";
            row.appendChild(back);
        }
        return row;
    }

    function say(id, message) {
        var line = byId(id);
        if (line) line.textContent = message || "";
    }

    /* Mount one of the forms into a container and make it work.

       Returns an object with `destroy()`, because a form that is gone must not
       still be listening for submits. */
    function mount(container, kind, options) {
        options = options || {};
        var built = build(kind, options);
        container.textContent = "";

        /* The fields become a real form, so Enter submits and the browser's own
           password-manager semantics apply to the right inputs. */
        var form = el("form", "privacy__inner");
        while (built.body.firstChild) form.appendChild(built.body.firstChild);
        container.appendChild(form);

        var busy = false;
        var handlers = { submit: null, cancel: null };

        function finish(result) {
            busy = false;
            if (options.onDone) options.onDone(result);
        }

        function failure(error, fallback) {
            busy = false;
            submit(false);
            return (error && error.message) || fallback;
        }

        function submit(busyNow) {
            var button = byId("privacySubmit");
            if (!button) return;
            button.disabled = busyNow;
            button.textContent = busyNow
                ? (kind === "setup" ? "Setting up\u2026" : "Unlocking\u2026")
                : ((kind === "setup" ? "Set up private archive" : "Unlock") + " \u2192");
        }

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            if (busy) return;

            if (kind === "setup") {
                var account = byId(built.ids.account).value;
                var fresh = byId(built.ids.fresh).value;
                var again = byId(built.ids.again).value;
                say(built.ids.accountError, "");
                say(built.ids.passwordError, "");

                /* Checked here so a typo does not cost a round trip. The server
                   validates all of it again and its answer is what is shown. */
                if (!account) {
                    say(built.ids.accountError, "Please enter your account password.");
                    byId(built.ids.account).focus();
                    return;
                }
                if ((fresh || "").length < 8) {
                    say(built.ids.passwordError,
                        "Please use at least 8 characters.");
                    byId(built.ids.fresh).focus();
                    return;
                }
                if (fresh !== again) {
                    say(built.ids.passwordError, "The two passwords are not the same.");
                    byId(built.ids.again).focus();
                    return;
                }
                if (!api()) {
                    say(built.ids.passwordError, "The archive server is not reachable.");
                    return;
                }

                busy = true;
                submit(true);
                api().privacySetup(account, fresh).then(function (result) {
                    remember(result);
                    finish({ ok: true, unlocked: true });
                }, function (error) {
                    /* The account password is the one thing that must not be
                       cleared: it is the proof of who is asking, and it is not
                       the field the person got wrong by accident. */
                    if (error && error.status === 401) {
                        say(built.ids.accountError, "Account password incorrect.");
                        submit(false);
                        busy = false;
                        byId(built.ids.account).focus();
                        return;
                    }
                    if (error && error.status === 409) {
                        /* Somebody set one in another tab. Not an error to
                           argue with — the answer is the unlock form. */
                        finish({ ok: false, reason: "already-configured" });
                        return;
                    }
                    say(built.ids.passwordError,
                        failure(error, "That could not be set up. Please try again."));
                });
                return;
            }

            var password = byId(built.ids.fresh).value;
            say(built.ids.passwordError, "");
            if (!password) {
                say(built.ids.passwordError, "Please enter your privacy password.");
                byId(built.ids.fresh).focus();
                return;
            }
            if (!api()) {
                say(built.ids.passwordError, "The archive server is not reachable.");
                return;
            }

            busy = true;
            submit(true);
            api().privacyUnlock(password).then(function (result) {
                remember({ configured: true, unlocked: true,
                           unlockedUntil: result && result.unlockedUntil,
                           timeoutMinutes: result && result.timeoutMinutes });
                finish({ ok: true, unlocked: true });
            }, function (error) {
                if (error && error.status === 409) {
                    finish({ ok: false, reason: "not-configured" });
                    return;
                }
                /* 429 carries the server's own cooldown sentence, which is
                   worth more than anything this file could invent. */
                say(built.ids.passwordError,
                    failure(error, "That password is not correct."));
                byId(built.ids.fresh).focus();
            });
        });

        var cancel = byId("privacyCancel");
        if (cancel && options.onCancel) {
            cancel.addEventListener("click", function () { options.onCancel(); });
        }
        if (options.settings) {
            /* A second quiet way out for somebody who has forgotten it. */
            options.settings.addEventListener("click", function (event) {
                event.preventDefault();
                if (options.onSettings) options.onSettings();
            });
        }

        return {
            destroy: function () {
                container.textContent = "";
            },
            focus: function () {
                var first = byId(built.ids.fresh) || byId(built.ids.account);
                if (first && first.focus) first.focus();
            }
        };
    }

    /* ------------------------------------------------------------- the modal */

    /* Setup and unlock, over whatever the page was doing.

       Used by the memory form: somebody half-way through writing a memory picks
       PRIVATE, has no password yet, and must be able to deal with that without
       the memory they were writing being thrown away. The modal sits above the
       sheet and never touches it. */
    var modalState = null;

    function openModal(kind, options) {
        options = options || {};
        closeModal(true);

        var overlay = el("div", "privacy-modal");
        overlay.id = "privacyModal";

        var scrim = el("button", "privacy-modal__scrim");
        scrim.type = "button";
        scrim.tabIndex = -1;
        scrim.setAttribute("aria-label", "Close");
        overlay.appendChild(scrim);

        var panel = el("div", "privacy-modal__panel");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "privacyModalTitle");
        overlay.appendChild(panel);

        document.body.appendChild(overlay);

        var inner = el("div", "privacy__form");
        panel.appendChild(inner);

        var mounted = mount(inner, kind, {
            cancel: true,
            onCancel: function () { closeModal(); if (options.onCancel) options.onCancel(); },
            onDone: function (result) {
                if (result && result.ok) {
                    closeModal(true);
                    if (options.onDone) options.onDone(result);
                    return;
                }
                if (result && result.reason === "already-configured") {
                    closeModal(true);
                    openModal("unlock", options);
                    return;
                }
                if (result && result.reason === "not-configured") {
                    closeModal(true);
                    openModal("setup", options);
                }
            }
        });
        inner.id = "privacyModalBody";
        var title = panel.querySelector(".privacy__title");
        if (title) title.id = "privacyModalTitle";

        modalState = { overlay: overlay, mounted: mounted };

        global.requestAnimationFrame(function () {
            overlay.classList.add("is-open");
            mounted.focus();
        });

        function onKey(event) {
            if (!modalState) return;
            if (event.key === "Escape") {
                event.preventDefault();
                closeModal();
                if (options.onCancel) options.onCancel();
                return;
            }
            /* A small focus trap: the form is the only thing to be doing, and
               tabbing out of it lands on the page behind a scrim. */
            if (event.key !== "Tab") return;
            var focusable = overlay.querySelectorAll(
                "input, button:not([tabindex='-1']), [href]");
            if (!focusable.length) return;
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }

        scrim.addEventListener("click", function () { closeModal(); });
        document.addEventListener("keydown", onKey, true);
        modalState.onKey = onKey;

        return { close: closeModal };
    }

    function closeModal(immediate) {
        if (!modalState) return;
        var state = modalState;
        modalState = null;
        document.removeEventListener("keydown", state.onKey, true);
        if (state.mounted) state.mounted.destroy();
        if (immediate) {
            if (state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
            return;
        }
        state.overlay.classList.remove("is-open");
        global.setTimeout(function () {
            if (state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
        }, 260);
    }

    function isModalOpen() { return !!modalState; }

    global.LoveStoryPrivacy = {
        status: status,
        knownStatus: knownStatus,
        remember: remember,
        forget: forget,
        lock: lock,
        locked: locked,
        expired: expired,
        onLock: onLock,
        mount: mount,
        openModal: openModal,
        closeModal: closeModal,
        get isModalOpen() { return isModalOpen(); },
        get timeoutMinutes() { return PRIVACY_UNLOCK_MINUTES; }
    };
})(window);
