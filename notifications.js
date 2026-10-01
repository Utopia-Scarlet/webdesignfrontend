/* ==========================================================================
   LoveStory — the bell

   Notifications are about the ACCOUNT, not about the space on screen: they say
   that somebody asked to join a space you run, that you were let into one, that
   your role changed, or that you were removed from somewhere. That last one is
   exactly why they cannot be filtered by the current space — a message about a
   space you are no longer in still has to reach you.

   So this is deliberately not a feed. The activity feed is the other thing, the
   one that says what happened INSIDE a space; it lives in the Hub and it is not
   this. Nothing here is about a memory, a photograph or a date.

   The bell is one button with one honest number on it. Opening the panel reads
   the list; reading the list marks it read, rather than a separate button the
   person has to find. The unread dot disappears at that moment and not before.
   ========================================================================== */

(function (global) {
    "use strict";

    var bound = null;
    var pointerOpened = false;
    var items = null;
    var unread = 0;
    /* True when the page supplied its own close control, in which case the
       panel must not draw a second one. */
    var externalClose = false;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function byId(id) { return id ? document.getElementById(id) : null; }
    function api() { return global.LoveStoryApi || null; }

    /* "just now", "20 minutes ago", "3 hours ago", "12 June 2025". A relative
       phrase only while it is genuinely easier to read than a date. */
    function ago(iso) {
        var when = new Date(iso).getTime();
        if (isNaN(when)) return "";
        var minutes = Math.round((Date.now() - when) / 60000);
        if (minutes < 1) return "just now";
        if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
        var hours = Math.round(minutes / 60);
        if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
        var days = Math.round(hours / 24);
        if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
        var date = new Date(when);
        return date.getUTCDate() + " " +
               date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" }) +
               " " + date.getUTCFullYear();
    }

    function setUnread(count) {
        unread = Math.max(0, count | 0);
        if (bound && bound.dot) {
            bound.dot.hidden = unread === 0;
            bound.dot.textContent = unread > 9 ? "9+" : String(unread);
            /* Said aloud as well as drawn, because a dot is invisible to a
               screen reader. */
            bound.dot.setAttribute("aria-label",
                unread === 1 ? "1 unread notification"
                             : unread + " unread notifications");
        }
        if (bound && bound.button) {
            bound.button.classList.toggle("has-unread", unread > 0);
            bound.button.title = unread
                ? (unread === 1 ? "1 unread notification"
                                : unread + " unread notifications")
                : "Notifications";
        }
    }

    /* Ask only for the number. Cheap enough to ask on every load, and it is
       what the bell actually needs. */
    function refresh() {
        if (!api()) return Promise.resolve(0);
        return api().unreadNotifications().then(function (data) {
            setUnread((data && data.unreadCount) || 0);
            return unread;
        }, function () { return unread; });
    }

    function iconFor(type) {
        /* A small mark, not an illustration. Each notification kind gets one
           so the list can be scanned rather than read. */
        switch (type) {
            case "join_request_created": return "\u2192";
            case "join_request_approved": return "\u2713";
            case "join_request_declined": return "\u2715";
            case "role_promoted": return "\u2191";
            case "role_demoted": return "\u2193";
            case "member_removed": return "\u2715";
            default: return "\u00b7";
        }
    }

    function buildList() {
        var box = el("div", "notifications__scroll");

        if (items === null) {
            box.appendChild(el("p", "notifications__note", "Reading\u2026"));
            return box;
        }

        if (!items.length) {
            box.appendChild(el("p", "notifications__note",
                "Nothing yet. When somebody asks to join a space you run, "
                + "or your own place changes, it will appear here."));
            return box;
        }

        var list = el("ul", "notifications__list");
        items.forEach(function (item) {
            var row = el("li", "notifications__item" +
                         (item.unread ? " is-unread" : ""));
            row.appendChild(el("span", "notifications__icon", iconFor(item.type)));
            var text = el("div", "notifications__text");
            text.appendChild(el("p", "notifications__title", item.title || ""));
            if (item.body) {
                text.appendChild(el("p", "notifications__body", item.body));
            }
            var meta = (item.spaceName ? item.spaceName + " \u00b7 " : "") +
                       ago(item.createdAt);
            text.appendChild(el("p", "notifications__meta", meta));
            row.appendChild(text);
            list.appendChild(row);
        });
        box.appendChild(list);
        return box;
    }

    function render() {
        if (!bound || !bound.body) return;
        var body = bound.body;
        body.textContent = "";

        var head = el("div", "notifications__head");
        head.appendChild(el("p", "notifications__eyebrow", "Notifications"));

        var controls = el("div", "notifications__controls");

        var mark = el("button", "notifications__mark", "Mark all read");
        mark.type = "button";
        mark.hidden = unread === 0;
        mark.addEventListener("click", function () {
            if (!api()) return;
            mark.disabled = true;
            api().markAllNotificationsRead().then(function () {
                (items || []).forEach(function (item) { item.unread = false; });
                setUnread(0);
                render();
            }, function () {
                mark.disabled = false;
            });
        });
        controls.appendChild(mark);

        /* The close control belongs to the panel rather than to the page that
           owns the drawer, so the two components stay interchangeable. A page
           that supplies its own keeps it. */
        if (!externalClose) {
            var shut = el("button", "notifications__close", "\u00d7");
            shut.type = "button";
            shut.setAttribute("aria-label", "Close");
            shut.addEventListener("click", close);
            shut.addEventListener("pointerdown", function () { pointerOpened = true; });
            shut.addEventListener("keydown", function () { pointerOpened = false; });
            controls.appendChild(shut);
            bound.close = shut;
        }

        head.appendChild(controls);
        body.appendChild(head);

        body.appendChild(buildList());
    }

    /* Read the list, then mark it read: the person has seen these, so the dot
       goes — but only after they are actually on the screen. */
    function load() {
        if (!api()) return Promise.resolve();
        if (items === null) render();
        return api().listNotifications().then(function (data) {
            items = (data && data.notifications) || [];
            setUnread((data && data.unreadCount) || 0);
            render();
            if (unread > 0) {
                return api().markAllNotificationsRead().then(function () {
                    setUnread(0);
                    render();
                }, function () { /* the number stays; the list is still right */ });
            }
        }, function () {
            items = [];
            render();
        });
    }

    function open() {
        if (!bound) return;
        /* One panel at a time: the Profile and the bell both cover the page. */
        document.dispatchEvent(new CustomEvent("lovestory:panel-open",
            { detail: { panel: "notifications" } }));

        items = null;
        render();
        bound.panel.hidden = false;
        if (bound.button) bound.button.setAttribute("aria-expanded", "true");
        global.requestAnimationFrame(function () {
            bound.panel.classList.add("is-open");
            if (bound.close) bound.close.focus();
        });
        load();
    }

    function close() {
        if (!bound) return;
        bound.panel.classList.remove("is-open");
        if (bound.button) bound.button.setAttribute("aria-expanded", "false");
        global.setTimeout(function () { bound.panel.hidden = true; }, 320);

        /* The gesture decides whether the trigger keeps a keyboard ring. */
        if (bound.button) {
            if (pointerOpened) bound.button.classList.add("is-quiet-focus");
            bound.button.focus();
        }
    }

    function toggle() {
        if (!bound) return;
        if (bound.panel.hidden) open();
        else close();
    }

    function bind(options) {
        options = options || {};
        bound = {
            button: byId(options.button),
            dot: byId(options.dot),
            panel: byId(options.panel),
            body: byId(options.body),
            close: byId(options.close),
            scrim: byId(options.scrim)
        };
        if (!bound.panel || !bound.body) return null;
        externalClose = !!bound.close;

        /* The bell and the Profile are both triggers in the header; the same
           pointer-versus-keyboard rule keeps either from leaving a ring. */
        [bound.button, bound.close].forEach(function (trigger) {
            if (!trigger) return;
            trigger.addEventListener("pointerdown", function () { pointerOpened = true; });
            trigger.addEventListener("keydown", function () { pointerOpened = false; });
            trigger.addEventListener("blur", function () {
                if (bound.button) bound.button.classList.remove("is-quiet-focus");
            });
        });

        if (bound.button) bound.button.addEventListener("click", toggle);
        if (bound.close) bound.close.addEventListener("click", close);
        if (bound.scrim) bound.scrim.addEventListener("click", close);

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && bound && !bound.panel.hidden) close();
        });

        /* The Profile was opened, so this one stands down. */
        document.addEventListener("lovestory:panel-open", function (event) {
            if (!bound || !event.detail || event.detail.panel === "notifications") return;
            if (!bound.panel.hidden) close();
        });

        /* A notification is produced by an action — approving somebody,
           promoting them — so anything that changes the session may have
           changed the count. */
        document.addEventListener("lovestory:auth-changed", function () {
            if (bound && !bound.panel.hidden) load();
            else refresh();
        });

        refresh();
        return { open: open, close: close, refresh: refresh };
    }

    global.LoveStoryNotifications = { bind: bind, refresh: refresh };
})(window);
