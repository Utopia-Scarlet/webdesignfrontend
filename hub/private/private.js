/* ==========================================================================
   LoveStory — the Private Archive

   One page, three states, and a rule about the order they are decided in.

     1. ask the server whether the private archive is configured and open
     2. if it is not configured          -> the setup form
     3. if it is configured but closed   -> the unlock form
     4. only then                        -> the memories

   The order matters more than it looks. Fetching memories first and discovering
   they are refused would mean the page had already asked for private content
   before it was allowed to, and the answer to "is there anything private here"
   would be in the browser before anybody proved they may see it. So the status
   question comes first, every time, and the list is never even requested while
   the archive is closed.

   What the locked screen knows: that a privacy password exists. Not how many
   private memories there are, not one title, not a date, not a cover. A count
   would be a fact about the archive that the archive has not agreed to give.

   Refusal codes, and what each one does:

     401  the session is gone       -> the entrance, via the entry guard
     423  the ten minutes ran out   -> empty everything, show the unlock screen
     403  the action is not yours   -> say so, reload what is true
     404  the memory is not yours   -> remove it and return to the list
     429  too many wrong passwords  -> the server's own cooldown sentence
   ========================================================================== */

(function (global) {
    "use strict";

    var api = function () { return global.LoveStoryApi; };
    var priv = function () { return global.LoveStoryPrivacy; };
    var store = function () { return global.LoveStoryPrivateStore; };

    /* The whole of this page's private state. Declared in one place so that
       clearing it is one function rather than a hunt. */
    var view = {
        state: "loading",        /* loading | setup | locked | archive */
        memories: [],
        open: null,              /* the memory being shown, if the detail is open */
        photoIndex: 0,
        confirming: null,        /* "delete" | "standard" | null */
        notice: "",
        error: ""
    };

    var els = {};
    var form = null;             /* the mounted setup/unlock form */

    function byId(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    /* ------------------------------------------------------------- helpers */

    function formatDate(value) {
        if (!value) return "";
        var parts = String(value).split("-");
        if (parts.length !== 3) return value;
        var date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
        if (isNaN(date.getTime())) return value;
        return date.getUTCDate() + " " +
               date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" }) +
               " " + date.getUTCFullYear();
    }

    function placeOf(memory) {
        var location = (memory && memory.location) || {};
        return [location.city, location.country].filter(Boolean).join(", ");
    }

    function coverOf(memory) {
        var photos = (memory && memory.photos) || [];
        return photos.filter(function (photo) { return photo.isCover; })[0]
            || photos[0] || null;
    }

    /* The permission label. Three words a person would use, never the data
       model's — "ACL", "editor" and "viewer" are how the archive talks to
       itself, not to the person reading it. */
    function permissionLabel(permission) {
        if (permission === "owner") return "Owner";
        if (permission === "editor") return "Can edit";
        if (permission === "viewer") return "View only";
        return "";
    }

    function spaceName() {
        var auth = global.LoveStoryAuth;
        var space = auth && auth.currentSpace;
        if (!space) return "This space";
        return space.type === "personal" ? "My Space" : (space.name || "Our Space");
    }

    /* Every private request goes through here.

       One place decides what a refusal means, so no button has to remember
       that a 423 must empty the page. `onGone` is for the one case that is
       about a particular memory (404) and needs to return to the list. */
    function guard(promise, options) {
        options = options || {};
        return promise.then(function (result) {
            return result;
        }, function (error) {
            var status = error && error.status;
            if (status === 423) {
                /* The window closed while this page was open. Everything it was
                   holding goes, now — the point of the timeout is that the
                   screen stops showing private things, not that the next
                   request fails. */
                lockEverything();
                return Promise.reject(error);
            }
            if (status === 401) {
                /* The session itself is gone. The entry guard owns that
                   journey; this only makes sure nothing private is left. */
                lockEverything();
                global.location.replace(
                    global.LoveStoryRoutes
                        ? global.LoveStoryRoutes.page("entrance")
                        : "../../gallery/index.html");
                return Promise.reject(error);
            }
            if (status === 403) {
                view.notice = "Your access has changed.";
                view.error = "This memory is no longer yours to change. "
                    + "Reload the private archive to see what is.";
            } else if (status === 404) {
                if (options.onGone) options.onGone();
            }
            return Promise.reject(error);
        });
    }

    /* --------------------------------------------------------- the three states */

    function show(next) {
        view.state = next;
        render();
    }

    function render() {
        if (!els.root) return;
        clear(els.root);

        if (view.state === "loading") {
            els.root.appendChild(el("p", "private__loading", "One moment\u2026"));
            return;
        }
        if (view.state === "setup") return renderSetup();
        if (view.state === "locked") return renderLocked();
        renderArchive();
    }

    function chrome(inner) {
        var wrap = el("div", "private__chrome");
        wrap.appendChild(el("a", "private__brand", "Love / Story")).href =
            global.LoveStoryRoutes
                ? global.LoveStoryRoutes.hub() : "../index.html";

        var actions = el("div", "private__actions");

        /* LOCK lives here, at the top right of the page, and nowhere deeper.
           Somebody about to hand their laptop to a friend should not have to
           find it in a menu. */
        if (view.state === "archive") {
            var lock = el("button", "private__lock", "");
            lock.type = "button";
            lock.id = "privateLock";
            /* The glyph is a NODE, not text: passing it as the text argument
               stringified it, so the button read "Lock [object SVGSVGElement]"
               and the stray word overflowed the header on a narrow screen. */
            var glyph = el("span", "private__lock-glyph");
            glyph.appendChild(lockGlyph());
            lock.appendChild(glyph);
            lock.appendChild(el("span", null, "Lock"));
            lock.addEventListener("click", function () { manualLock(lock); });
            actions.appendChild(lock);
        }
        wrap.appendChild(actions);
        return wrap;
    }

    /* The same outline lock as the Hub module and the same weight as the bell
       and the account glyph. Drawn, not imported, not an emoji. */
    function lockGlyph() {
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        var body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        body.setAttribute("x", "5");
        body.setAttribute("y", "10.5");
        body.setAttribute("width", "14");
        body.setAttribute("height", "9.5");
        body.setAttribute("rx", "1.5");
        body.setAttribute("fill", "none");
        body.setAttribute("stroke", "currentColor");
        body.setAttribute("stroke-width", "1.3");
        var shackle = document.createElementNS("http://www.w3.org/2000/svg", "path");
        shackle.setAttribute("d", "M8.4 10.5V8.2a3.6 3.6 0 0 1 7.2 0v2.3");
        shackle.setAttribute("fill", "none");
        shackle.setAttribute("stroke", "currentColor");
        shackle.setAttribute("stroke-width", "1.3");
        shackle.setAttribute("stroke-linecap", "round");
        svg.appendChild(shackle);
        svg.appendChild(body);
        return svg;
    }

    function renderSetup() {
        els.root.appendChild(chrome());
        var panel = el("section", "private__panel");
        panel.appendChild(el("p", "private__eyebrow", "Private archive"));
        panel.appendChild(el("h1", "private__title",
            "An additional lock for your private memories."));
        panel.appendChild(el("p", "private__note",
            "Private memories never appear in Moments, the Timeline, Our World "
            + "or the gallery. This password opens them, and only for ten "
            + "minutes at a time."));
        panel.appendChild(el("div", "private__form", ""));
        els.root.appendChild(panel);

        form = priv().mount(panel.querySelector(".private__form"), "setup", {
            onDone: function (result) {
                if (result && result.ok) {
                    view.notice = "";
                    show("archive");
                    loadMemories();
                }
            }
        });
        form.focus();
    }

    function renderLocked() {
        els.root.appendChild(chrome());
        var panel = el("section", "private__panel");
        panel.appendChild(el("p", "private__eyebrow", "Private archive"));
        panel.appendChild(el("h1", "private__title",
            "Protected memories require your privacy password."));
        panel.appendChild(el("p", "private__note",
            "Your private memories are closed. Nothing about them \u2014 not how "
            + "many there are \u2014 is shown until you open the archive."));
        panel.appendChild(el("div", "private__form", ""));
        els.root.appendChild(panel);

        form = priv().mount(panel.querySelector(".private__form"), "unlock", {
            settings: settingsLink(),
            onDone: function (result) {
                if (result && result.ok) {
                    view.notice = "";
                    show("archive");
                    loadMemories();
                }
            }
        });
        form.focus();
    }

    function settingsLink() {
        var link = el("a", "private__settings", "Privacy settings \u2192");
        link.href = global.LoveStoryRoutes
            ? global.LoveStoryRoutes.hub() : "../index.html";
        return link;
    }

    /* ------------------------------------------------------------- the archive */

    function renderArchive() {
        els.root.appendChild(chrome());

        var head = el("header", "private__head");
        head.appendChild(el("p", "private__eyebrow", "Private archive"));
        head.appendChild(el("h1", "private__title private__title--space", spaceName()));
        if (view.memories.length) {
            head.appendChild(el("p", "private__count",
                view.memories.length === 1 ? "One memory"
                                           : view.memories.length + " memories"));
        }
        els.root.appendChild(head);

        if (view.notice) {
            els.root.appendChild(el("p", "private__notice", view.notice));
        }

        if (!view.memories.length) {
            var empty = el("p", "private__empty", "Nothing private here yet.");
            els.root.appendChild(empty);
            return;
        }

        var grid = el("div", "private__grid");
        view.memories.forEach(function (memory) {
            grid.appendChild(card(memory));
        });
        els.root.appendChild(grid);
    }

    function card(memory) {
        var button = el("button", "private-card");
        button.type = "button";
        button.dataset.memoryId = memory.id;

        var cover = coverOf(memory);
        var frame = el("figure", "private-card__frame");
        if (cover) {
            var image = el("img", "private-card__image");
            image.src = cover.url;
            image.alt = "";
            image.loading = "lazy";
            /* A photograph that will not load is not an error to shout about;
               the card simply shows its mount. This is what a photograph looks
               like after the archive has locked in another tab. */
            image.addEventListener("error", function () {
                frame.classList.add("is-unavailable");
                image.remove();
            });
            frame.appendChild(image);
        } else {
            frame.classList.add("is-unavailable");
        }
        button.appendChild(frame);

        var info = el("div", "private-card__info");
        info.appendChild(el("h2", "private-card__title", memory.title || "Untitled"));
        var facts = [formatDate(memory.date), placeOf(memory)].filter(Boolean);
        if (facts.length) {
            info.appendChild(el("p", "private-card__fact", facts.join(" \u00b7 ")));
        }
        var label = permissionLabel(memory.privatePermission);
        if (label) {
            info.appendChild(el("p", "private-card__permission", label));
        }
        button.appendChild(info);

        button.addEventListener("click", function () { openDetail(memory.id); });
        return button;
    }

    /* ---------------------------------------------------------------- detail */

    function openDetail(id) {
        var memory = store().get(id);
        if (!memory) return;

        /* The list is what a viewer needs; the detail is what an owner needs to
           edit the access list. Fetching it means the privateAccess array is
           present when it should be — and absent when it should be absent, for
           an editor, because the server decides that and not this page. */
        guard(api().privateMemory(id)).then(function (fresh) {
            store().replace(fresh);
            view.open = fresh;
            view.photoIndex = coverIndexOf(fresh);
            view.confirming = null;
            view.notice = "";
            renderDetail();
        }, function () {
            /* guard() has already said or done the right thing. */
        }).catch(function () { /* handled above */ });
    }

    function coverIndexOf(memory) {
        var photos = memory.photos || [];
        for (var i = 0; i < photos.length; i++) {
            if (photos[i].isCover) return i;
        }
        return 0;
    }

    function renderDetail() {
        if (!els.detail) return;
        var memory = view.open;
        clear(els.detail);

        if (!memory) {
            els.detail.hidden = true;
            els.detail.classList.remove("is-open");
            return;
        }

        var bar = el("header", "private-detail__bar");
        var back = el("button", "private-detail__back", "\u2190 Private archive");
        back.type = "button";
        back.addEventListener("click", closeDetail);
        bar.appendChild(back);

        var photos = memory.photos || [];
        if (photos.length > 1) {
            bar.appendChild(el("span", "private-detail__count",
                (view.photoIndex + 1) + " / " + photos.length));
        }
        els.detail.appendChild(bar);

        var stage = el("div", "private-detail__stage");

        if (photos.length > 1) {
            var prev = el("button", "private-detail__nav", "\u276e");
            prev.type = "button";
            prev.setAttribute("aria-label", "Previous photo");
            prev.addEventListener("click", function () { stepPhoto(-1); });
            stage.appendChild(prev);
        }

        var article = el("article", "private-archive-object");

        var figure = el("figure", "private-detail__frame");
        var photo = photos[view.photoIndex];
        if (photo) {
            var image = el("img", "private-detail__image");
            image.id = "privateDetailImage";
            image.src = photo.url;
            image.alt = "";
            /* If the archive locks, or the memory stops being ours, the
               photograph stops loading. Say that quietly rather than leaving a
               broken frame — and never fall back to a cached copy, because
               there is not meant to be one. */
            image.addEventListener("error", function () {
                figure.classList.add("is-unavailable");
                clear(figure);
                figure.appendChild(el("p", "private-detail__unavailable",
                    "This photograph is not available."));
            });
            figure.appendChild(image);
        } else {
            figure.classList.add("is-unavailable");
            figure.appendChild(el("p", "private-detail__unavailable",
                "No photograph for this memory."));
        }
        article.appendChild(figure);

        article.appendChild(detailInfo(memory));
        stage.appendChild(article);

        if (photos.length > 1) {
            var next = el("button", "private-detail__nav", "\u276f");
            next.type = "button";
            next.setAttribute("aria-label", "Next photo");
            next.addEventListener("click", function () { stepPhoto(1); });
            stage.appendChild(next);
        }

        els.detail.appendChild(stage);
        els.detail.hidden = false;
        global.requestAnimationFrame(function () {
            els.detail.classList.add("is-open");
        });
    }

    function detailInfo(memory) {
        var info = el("div", "private-detail__info");

        var title = el("h2", "private-detail__title", memory.title || "Untitled");
        info.appendChild(title);

        var label = permissionLabel(memory.privatePermission);
        if (label) {
            info.appendChild(el("p", "private-detail__permission", label));
        }

        var facts = el("div", "private-detail__facts");
        if (memory.date || memory.time) {
            facts.appendChild(el("span", "private-detail__fact",
                [formatDate(memory.date), memory.time].filter(Boolean).join(" \u00b7 ")));
        }
        var place = placeOf(memory);
        if (place) facts.appendChild(el("span", "private-detail__fact", place));
        var feel = [memory.weather && memory.weather.condition, memory.mood]
            .filter(Boolean).join(" \u00b7 ");
        if (feel) facts.appendChild(el("span", "private-detail__fact", feel));
        if (facts.childNodes.length) info.appendChild(facts);

        if (memory.description) {
            info.appendChild(el("p", "private-detail__story", memory.description));
        }

        var who = el("p", "private-detail__uploader");
        if (memory.createdBy && memory.createdBy.displayName) {
            who.textContent = "Added by " + memory.createdBy.displayName;
            if (memory.createdAt) {
                who.textContent += " \u00b7 " + formatDate(
                    String(memory.createdAt).slice(0, 10));
            }
        }
        info.appendChild(who);

        var permission = memory.privatePermission;
        var actions = el("div", "private-detail__actions");

        /* What is offered follows the permission, and nothing is offered
           greyed out. A viewer does not see the buttons they may not press:
           an interface that shows a disabled Delete is an interface arguing
           with the person reading it. */
        if (permission === "owner" || permission === "editor") {
            var edit = el("button", "private-detail__action", "Edit memory");
            edit.type = "button";
            edit.addEventListener("click", openEditor);
            actions.appendChild(edit);
        }
        if (permission === "owner") {
            var standard = el("button", "private-detail__action",
                "Make standard");
            standard.type = "button";
            standard.addEventListener("click", function () {
                askConfirm("standard");
            });
            actions.appendChild(standard);

            var remove = el("button", "private-detail__action private-detail__action--danger",
                "Delete memory");
            remove.type = "button";
            remove.addEventListener("click", function () {
                askConfirm("delete");
            });
            actions.appendChild(remove);
        }
        if (actions.childNodes.length) info.appendChild(actions);

        if (view.confirming) info.appendChild(confirmation(memory));
        if (view.error) {
            info.appendChild(el("p", "private-detail__error", view.error));
        }

        /* An owner sees who else can read it, because it is theirs to change.
           Nobody else is shown the list — not even an editor, who may edit the
           memory but not decide who else may see it. */
        if (permission === "owner") {
            info.appendChild(accessSummary(memory));
        }

        return info;
    }

    function accessSummary(memory) {
        var box = el("div", "private-detail__access");
        box.appendChild(el("p", "private-detail__access-title", "Who can access"));

        var access = memory.privateAccess || [];
        if (!access.length) {
            box.appendChild(el("p", "private-detail__access-note",
                "Only you."));
        } else {
            var list = el("ul", "private-detail__access-list");
            access.forEach(function (entry) {
                var item = el("li", "private-detail__access-row");
                item.appendChild(el("span", "private-detail__access-name",
                    entry.displayName || "Someone"));
                item.appendChild(el("span", "private-detail__access-permission",
                    permissionLabel(entry.permission)));
                list.appendChild(item);
            });
            box.appendChild(list);
        }

        var change = el("button", "private-detail__action", "Change access");
        change.type = "button";
        change.addEventListener("click", openEditor);
        box.appendChild(change);
        return box;
    }

    /* Confirmations are part of the page, never window.confirm: the question
       belongs where the button was, and a browser dialog cannot be styled,
       cannot be read by the page's own focus handling, and cannot be undone. */
    function askConfirm(what) {
        view.confirming = what;
        view.error = "";
        renderDetail();
    }

    function confirmation(memory) {
        var box = el("div", "private-confirm");

        if (view.confirming === "delete") {
            box.appendChild(el("p", "private-confirm__question", "Delete private memory?"));
            box.appendChild(el("p", "private-confirm__note",
                "This removes the memory and its photos. This cannot be undone."));
            box.appendChild(confirmButtons("Delete", "Delete", function () {
                removeMemory(memory);
            }, "private-detail__action--danger"));
            return box;
        }

        box.appendChild(el("p", "private-confirm__question", "Make this memory standard?"));
        box.appendChild(el("p", "private-confirm__note",
            "It will become visible normally to members of this space. Its "
            + "private access list will be removed."));
        box.appendChild(confirmButtons("Make standard", "Make standard", function () {
            makeStandard(memory);
        }));
        return box;
    }

    function confirmButtons(label, confirmLabel, onConfirm, extra) {
        var row = el("div", "private-confirm__actions");
        var yes = el("button", "private-detail__action" + (extra ? " " + extra : ""),
                     confirmLabel);
        yes.type = "button";
        yes.id = "privateConfirmYes";
        yes.addEventListener("click", onConfirm);
        var no = el("button", "private-detail__action", "Cancel");
        no.type = "button";
        no.id = "privateConfirmNo";
        no.addEventListener("click", function () {
            view.confirming = null;
            renderDetail();
        });
        row.appendChild(yes);
        row.appendChild(no);
        return row;
    }

    /* Escape, on the private page: the confirmation closes first, then a
       memory, then nothing — the page is not a dialog and Escape must never
       leave the archive. */
    function onEscape(event) {
        if (event.key !== "Escape") return;
        if (view.confirming) {
            view.confirming = null;
            renderDetail();
            return;
        }
        if (view.open) {
            event.preventDefault();
            closeDetail();
        }
    }

    function stepPhoto(offset) {
        var memory = view.open;
        var photos = (memory && memory.photos) || [];
        if (photos.length < 2) return;
        var next = view.photoIndex + offset;
        if (next < 0) next = photos.length - 1;
        if (next >= photos.length) next = 0;
        view.photoIndex = next;
        renderDetail();
    }

    function closeDetail() {
        view.open = null;
        view.photoIndex = 0;
        view.confirming = null;
        view.error = "";
        if (els.detail) {
            els.detail.classList.remove("is-open");
            els.detail.hidden = true;
            clear(els.detail);
        }
        render();
    }

    /* ------------------------------------------------------------ mutations */

    function openEditor() {
        if (!view.open || !global.LoveStoryMemoryForm) return;
        var memory = view.open;
        global.LoveStoryMemoryForm.open({
            memory: memory,
            scope: "private",
            onSaved: function (saved) {
                if (saved && saved.privacyMode === "standard") {
                    /* It is not a private memory any more, so it leaves this
                       page rather than sitting here looking private. */
                    store().remove(memory.id);
                    view.memories = store().all();
                    closeDetail();
                    view.notice = "\u201c" + (memory.title || "That memory")
                        + "\u201d is standard again. It is in your archive.";
                    render();
                    return;
                }
                store().replace(saved);
                view.memories = store().all();
                view.open = saved;
                view.confirming = null;
                view.photoIndex = Math.min(view.photoIndex,
                                           Math.max(0, (saved.photos || []).length - 1));
                renderDetail();
                render();
            }
        });
    }

    function makeStandard(memory) {
        var payload = new FormData();
        /* The private edit route replaces the editable fields, so the fields
           travel with the privacy change. They travel unchanged — this is a
           move, not an edit. */
        payload.append("title", memory.title || "");
        payload.append("date", memory.date || "");
        payload.append("time", memory.time || "");
        payload.append("country", (memory.location || {}).country || "");
        payload.append("city", (memory.location || {}).city || "");
        payload.append("place_name", (memory.location || {}).placeName || "");
        payload.append("latitude", (memory.location || {}).latitude == null
            ? "" : String(memory.location.latitude));
        payload.append("longitude", (memory.location || {}).longitude == null
            ? "" : String(memory.location.longitude));
        payload.append("weather", (memory.weather || {}).condition || "");
        payload.append("temperature", (memory.weather || {}).temperature == null
            ? "" : String(memory.weather.temperature));
        payload.append("mood", memory.mood || "");
        payload.append("description", memory.description || "");
        payload.append("favorite", memory.favorite ? "true" : "");
        payload.append("show_on_timeline", memory.showOnTimeline ? "true" : "");
        payload.append("privacyMode", "standard");

        guard(api().privateUpdate(memory.id, payload)).then(function (saved) {
            store().remove(memory.id);
            view.memories = store().all();
            closeDetail();
            view.notice = "\u201c" + (saved.title || "That memory")
                + "\u201d is standard again. It is in your archive.";
            render();
        }, function () {
            view.confirming = null;
            renderDetail();
        });
    }

    function removeMemory(memory) {
        guard(api().privateRemove(memory.id)).then(function () {
            store().remove(memory.id);
            view.memories = store().all();
            closeDetail();
            view.notice = "That memory has been deleted.";
            render();
        }, function () {
            view.confirming = null;
            renderDetail();
        });
    }

    function manualLock(button) {
        if (button) button.disabled = true;
        priv().lock().then(function () {
            view.notice = "";
            show("locked");
        }, function () {
            /* The lock could not be confirmed by the server. The local state is
               cleared anyway — see privacy.js — and the page shows the locked
               screen, because what a person asked for when they pressed LOCK
               was that nothing private is on the screen any more. */
            show("locked");
        });
    }

    /* Everything private, gone: the store, the detail, the open memory, the
       confirmation, the list on screen. Registered with privacy.js so that a
       423 or an expired session lands here too, not only the LOCK button. */
    function lockEverything() {
        store().clear();
        view.memories = [];
        view.open = null;
        view.photoIndex = 0;
        view.confirming = null;
        view.error = "";
        view.notice = "The private archive locked itself. Nothing private stays "
            + "on the screen after the ten minutes are up.";
        if (els.detail) {
            els.detail.classList.remove("is-open");
            els.detail.hidden = true;
            clear(els.detail);
        }
        show("locked");
    }

    /* -------------------------------------------------------------- loading */

    function loadMemories() {
        guard(store().load()).then(function (memories) {
            view.memories = memories;
            render();
        }, function () {
            /* guard() cleared the page if the archive had closed. */
        });
    }

    /* ------------------------------------------------- coming back to the page

       A browser may keep this document in memory after somebody navigates away,
       and restore it — DOM and all — when they come back. That snapshot could
       contain private memories, and by then the ten minutes may have run out.

       So the page never trusts a restored snapshot:

         · `pageshow` (which fires BEFORE the restored page is painted) hides
           everything private and asks the server whether the archive is still
           open;
         · if it is, the memories are read again rather than reused;
         · if it is not, the page is emptied exactly as a lock empties it.

       `visibilitychange` gets the same question for free when a tab comes back
       to the front. Neither is a poll, and neither can extend the unlock —
       /api/privacy/status never does. */
    function recheck(reason) {
        if (!priv()) return;
        if (view.state !== "archive" && view.state !== "locked") {
            /* Still deciding what this page is; the first answer will do. */
            document.body.classList.remove("is-rechecking");
            return;
        }

        priv().status({ force: true }).then(function (state) {
            document.body.classList.remove("is-rechecking");
            if (!state.configured) {
                lockEverything();
                show("setup");
                return;
            }
            if (!state.unlocked) {
                lockEverything();
                return;
            }
            /* Still open. The DOM may be a snapshot from before the browser
               put it away, so the list is read again and any open memory is
               closed rather than trusted. */
            if (view.open) closeDetail();
            show("archive");
            loadMemories();
        }, function () {
            /* Unreachable is not "still open". Nothing private stays on a
               guess. */
            document.body.classList.remove("is-rechecking");
            lockEverything();
        });
    }

    function begin() {
        els.root = byId("privateRoot");
        els.detail = byId("privateDetail");
        if (!els.root) return;

        if (global.LoveStoryPrivacy) global.LoveStoryPrivacy.onLock(lockEverything);

        document.addEventListener("keydown", onEscape);

        render();   /* the loading state, so the page is never blank */

        priv().status({ force: true }).then(function (state) {
            if (!state.configured) {
                show("setup");
                return;
            }
            if (!state.unlocked) {
                show("locked");
                return;
            }
            show("archive");
            loadMemories();
        });

        /* A restored document is hidden before it is painted, so a snapshot of
           private memories is never on the screen even for a frame. */
        global.addEventListener("pageshow", function (event) {
            if (!event.persisted) return;
            document.body.classList.add("is-rechecking");
            recheck("pageshow");
        });

        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState !== "visible") return;
            recheck("visible");
        });
    }

    /* The entry guard has already decided whether this page may be seen at all.
       The privacy question is the second one, and it is asked here. */
    function start() {
        if (global.LoveStoryEntry) {
            global.LoveStoryEntry.guard().then(function (state) {
                if (global.LoveStoryEntry.mayEnterHub(state)) begin();
            });
        } else {
            begin();
        }
    }

    start();
})(window);
