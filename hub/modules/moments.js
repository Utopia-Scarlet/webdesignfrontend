/* ==========================================================================
   LoveStory — Moments / Album behaviour

   The page is a view over LoveStoryData; it never owns any memory of its own.
   Everything it shows — and everything Add Memory writes — is the same record
   the Map, the Timeline and the Entrance films read.
   ========================================================================== */

(function () {
    "use strict";

    var data = window.LoveStoryData;
    if (!data) return;

    function photoSrc(file) {
        if (!file) return "";
        if (/^(data:|blob:|https?:)/.test(file)) return file;
        return "../../" + data.imageDir + file;
    }

    var MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                        "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ------------------------------------------------------------------ elements */
    var album = document.getElementById("album");
    var sidebarNav = document.getElementById("sidebarNav");
    var sidebarToggle = document.getElementById("sidebarToggle");
    var library = document.getElementById("library");
    var libraryEyebrow = document.getElementById("libraryEyebrow");
    var libraryTitle = document.getElementById("libraryTitle");
    var libraryStats = document.getElementById("libraryStats");
    var libraryScroll = document.getElementById("libraryScroll");
    var libraryEmpty = document.getElementById("libraryEmpty");

    var detail = document.getElementById("detail");
    var detailBack = document.getElementById("detailBack");
    var detailCount = document.getElementById("detailCount");
    var detailFrame = document.getElementById("detailFrame");
    var detailImage = document.getElementById("detailImage");
    var detailNoPhoto = document.getElementById("detailNoPhoto");
    var detailInfo = document.getElementById("detailInfo");
    var detailPrev = document.getElementById("detailPrev");
    var detailNext = document.getElementById("detailNext");

    var addButton = document.getElementById("addMemoryButton");
    var auth = window.LoveStoryAuth;

    /* --------------------------------------------------------------------- state */
    var state = {
        filter: { kind: "all" },
        heading: { eyebrow: "Library", title: "All Memories" },
        photos: [],            /* the frames currently on screen, in order */
        /* The detail follows an id, never a stored object: the store replaces
           its records on every refresh, so a remembered object would go stale
           the moment anything was saved or deleted. */
        currentMemoryId: null,
        photoIndex: -1,          /* which of the open memory's photographs is shown */
        originEl: null,
        touchX: 0,
        confirming: false      /* the delete confirmation is on screen */
    };

    /* ------------------------------------------------------------------- helpers */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function formatDate(iso, withYear) {
        if (!iso) return "";
        var d = new Date(iso + "T00:00:00");
        if (isNaN(d.getTime())) return iso;
        var text = d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
        return withYear === false ? text : text + " " + d.getFullYear();
    }

    function conditionText(weather) {
        if (!weather) return "";
        var parts = [];
        if (weather.condition) parts.push(weather.condition);
        if (weather.temperature !== null && weather.temperature !== undefined && weather.temperature !== "") {
            parts.push(weather.temperature + "\u00b0C");
        }
        return parts.join(" \u00b7 ");
    }

    /* ------------------------------------------------------------------ sidebar */
    function sidebarGroup(title) {
        var group = el("div", "sidebar__group");
        group.appendChild(el("p", "sidebar__group-title", title));
        return group;
    }

    function sidebarItem(label, filter, heading) {
        var button = el("button", "sidebar__item");
        button.type = "button";
        button.textContent = label;
        button.dataset.kind = filter.kind;

        if (filter.kind === "year") button.dataset.year = String(filter.year);
        /* Recorded for every kind that has one, so the current filter can be
           marked. Places and collections were silently never highlighted. */
        if (filter.value !== undefined) button.dataset.value = filter.value;

        button.setAttribute("aria-current", "false");
        button.addEventListener("click", function () {
            state.filter = filter;
            state.heading = heading;
            renderSidebar();
            renderLibrary();
            closeDrawer();
        });

        return button;
    }

    function renderSidebar() {
        sidebarNav.textContent = "";

        /* LIBRARY */
        var libraryGroup = sidebarGroup("Library");
        libraryGroup.appendChild(sidebarItem("All Memories", { kind: "all" },
            { eyebrow: "Library", title: "All Memories" }));
        libraryGroup.appendChild(sidebarItem("Recently Added", { kind: "recent" },
            { eyebrow: "Library", title: "Recently Added" }));
        sidebarNav.appendChild(libraryGroup);

        /* YEARS — newest first */
        var yearsGroup = sidebarGroup("Years");
        data.years.slice().sort(function (a, b) { return b - a; }).forEach(function (year) {
            yearsGroup.appendChild(sidebarItem(String(year), { kind: "year", year: year },
                { eyebrow: "A year of us", title: String(year) }));
        });
        sidebarNav.appendChild(yearsGroup);

        /* COLLECTIONS */
        var collectionsGroup = sidebarGroup("Collections");
        data.collections.forEach(function (collection) {
            collectionsGroup.appendChild(sidebarItem(collection.label, collection.filter,
                { eyebrow: "Collection", title: collection.label }));
        });
        sidebarNav.appendChild(collectionsGroup);

        /* PLACES — derived from the memories themselves. A place with no
           memory never appears, and adding one adds its place here. */
        var placesGroup = sidebarGroup("Places");
        data.placesAll().forEach(function (place) {
            placesGroup.appendChild(sidebarItem(place.label,
                { kind: "place", value: place.key },
                { eyebrow: "Place", title: place.label }));
        });
        sidebarNav.appendChild(placesGroup);

        /* FAVORITES */
        var favoritesGroup = sidebarGroup("Favorites");
        favoritesGroup.appendChild(sidebarItem("Favorites", { kind: "favorite" },
            { eyebrow: "Library", title: "Favorites" }));
        sidebarNav.appendChild(favoritesGroup);

        markCurrent();
    }

    function markCurrent() {
        var items = sidebarNav.querySelectorAll(".sidebar__item");
        Array.prototype.forEach.call(items, function (item) {
            var kind = item.dataset.kind;
            var hasValue = kind === "year" ? item.dataset.year === String(state.filter.year)
                : (state.filter.value === undefined ? true
                    : item.dataset.value === state.filter.value);
            var current = kind === state.filter.kind && hasValue;
            item.setAttribute("aria-current", current ? "true" : "false");
        });
    }

    /* ------------------------------------------------------------------ editing */
    function openEditor(memory) {
        if (!window.LoveStoryMemoryForm) return;

        /* The form is handed the record as it is now, and told which memory it
           is editing by id — the store may replace the object underneath it. */
        var memoryId = memory.id;

        window.LoveStoryMemoryForm.open({
            memory: memory,
            onSaved: function () {
                /* Read the server's state back rather than trusting a local
                   edit, then show the memory again. */
                data.refreshMemories().then(function () {
                    renderSidebar();
                    renderLibrary();
                    revealMemory(memoryId);
                    /* Reopened on the cover: the memory may have been
                       given a different one while the editor was open. */
                    openDetail(memoryId, null, null);
                });
            }
        });
    }

    /* A confirmation in the archive's own voice, not window.confirm. */
    function askToDelete(memory) {
        if (!detailFrame || !detailInfo) return;

        /* Which record this is about, kept by id so the panel can be redrawn
           from the store if anything changes while it is open. */
        var memoryId = memory.id;

        var panel = el("div", "confirm");
        panel.setAttribute("role", "alertdialog");
        panel.setAttribute("aria-label", "Delete this memory");

        var question = el("p", "confirm__question", "Delete this memory?");
        var note = el("p", "confirm__note",
            "This will remove the memory and its photographs from Our Story.");
        var error = el("p", "confirm__error");

        var row = el("div", "confirm__row");
        var cancel = el("button", "confirm__cancel", "Cancel");
        cancel.type = "button";
        var confirm = el("button", "confirm__delete", "Delete memory");
        confirm.type = "button";

        /* Back to the memory itself, not out of it: cancelling a confirmation
           should cost nothing and lose nothing. */
        cancel.addEventListener("click", function () {
            state.confirming = false;
            redrawDetail();
        });
        confirm.addEventListener("click", function () {
            confirm.disabled = true;
            confirm.textContent = "Deleting\u2026";
            state.confirming = false;

            window.LoveStoryApi.remove(memoryId).then(function () {
                /* Gone from the archive: drop the detail and repaint from the
                   server, so an empty archive shows its empty state. */
                closeDetail();
                return data.refreshMemories();
            }).then(function () {
                renderSidebar();
                renderLibrary();
            }, function (failure) {
                confirm.disabled = false;
                confirm.textContent = "Delete memory";
                console.error("Love Story: deleting failed.", failure);
                error.textContent = "Could not delete this memory. Please try again.";
            });
        });

        row.appendChild(cancel);
        row.appendChild(confirm);
        panel.appendChild(question);
        panel.appendChild(note);
        panel.appendChild(error);
        panel.appendChild(row);

        detailInfo.textContent = "";
        detailInfo.appendChild(panel);

        state.confirming = true;
        /* Focus lands on Cancel, so a stray Return or Space cannot delete. */
        cancel.focus();
    }

    /* --------------------------------------------------------------- the states
       Four things can be true of the archive, and they must not look alike:
       still loading, genuinely empty, broken, or fine. Flashing "no memories"
       before the answer arrives is its own small lie.

       Returns true when it has taken over the library, so the caller knows not
       to draw a grid underneath. */
    function renderArchiveState() {
        var status = data.status;

        if (status === "idle" || status === "loading") {
            libraryEmpty.textContent = "Loading archive\u2026";
            libraryEmpty.hidden = false;
            return true;
        }

        if (status === "error") {
            libraryEmpty.textContent = "";
            libraryEmpty.appendChild(el("span", "library__state",
                "Archive temporarily unavailable. "));
            var retry = el("button", null, "Retry");
            retry.type = "button";
            retry.addEventListener("click", function () {
                libraryEmpty.textContent = "Loading archive\u2026";
                data.refreshMemories().then(function () {
                    renderSidebar();
                    renderLibrary();
                });
            });
            libraryEmpty.appendChild(retry);
            libraryEmpty.appendChild(el("span", "library__state", " \u2192"));
            libraryEmpty.hidden = false;
            return true;
        }

        /* Empty is only ever claimed once the server has actually answered. */
        if (status === "empty" && !data.allMemories().length) {
            libraryEmpty.textContent = "";
            if (auth && auth.isEditor()) {
                libraryEmpty.appendChild(el("span", "library__state", "Our archive is empty. "));
                var add = el("button", null, "Add the first memory");
                add.type = "button";
                add.addEventListener("click", openAddMemory);
                libraryEmpty.appendChild(add);
                libraryEmpty.appendChild(el("span", "library__state", " \u2192"));
            } else {
                libraryEmpty.appendChild(el("span", "library__state", "Our archive is waiting."));
                libraryEmpty.appendChild(el("span", "library__state",
                    " No memories have been added yet."));
            }
            libraryEmpty.hidden = false;
            return true;
        }

        return false;
    }

    /* ------------------------------------------------------------------ library */
    /* One tile per memory, showing its cover.
       A memory may hold many photographs; the Library still gives it a single
       place. The others wait behind the cover and fan out on hover — never a
       grid of thumbnails, never a second tile. */
    var FAN_LIMIT = 3;                 /* the most that ever fan out */

    function buildFan(memory) {
        var others = data.extraPhotos(memory);
        if (!others.length) return null;

        var fan = el("span", "frame-item__fan");
        fan.setAttribute("aria-hidden", "true");

        /* Drawn back to front so the nearest card sits on top of the stack. */
        var shown = others.slice(0, FAN_LIMIT);
        shown.slice().reverse().forEach(function (file, back) {
            var depth = shown.length - back;         /* 3, 2, 1 */
            var card = el("span", "frame-item__card frame-item__card--" + depth);
            var img = document.createElement("img");
            img.src = photoSrc(file);
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            card.appendChild(img);
            fan.appendChild(card);
        });

        var hidden = others.length - shown.length;
        if (hidden > 0) {
            fan.appendChild(el("span", "frame-item__more", "+" + hidden));
        }
        return fan;
    }

    function buildFrame(memory) {
        var photos = memory.photos || [];
        var cover = data.coverUrl(memory);
        var hasPhoto = !!cover;

        var item = el("button", "frame-item");
        item.type = "button";
        item.dataset.memory = memory.id;
        item.dataset.photo = String(Math.max(0, data.coverIndex(memory)));

        var place = data.placeKey(memory.location);
        item.setAttribute("aria-label",
            (memory.title || "Memory") +
            (memory.date ? ", " + formatDate(memory.date) : "") +
            (place ? ", " + place : "") +
            (photos.length > 1 ? ", " + photos.length + " photographs" : ""));

        /* Behind the cover: the rest of the memory's photographs. */
        var fan = buildFan(memory);
        if (fan) item.appendChild(fan);

        var inner = el("span", "frame-item__inner");

        if (hasPhoto) {
            var img = document.createElement("img");
            img.src = photoSrc(cover);
            img.alt = "";
            img.loading = "lazy";              /* never load hundreds at once */
            img.decoding = "async";
            inner.appendChild(img);
        } else {
            /* A memory with no photograph still belongs in the library. */
            var blank = el("span", "frame-item__blank", memory.title || "");
            blank.style.cssText = "display:grid;place-items:center;aspect-ratio:4 / 3;" +
                "border:1px solid rgba(232,227,216,.08);color:#6F706A;" +
                "font-size:10px;letter-spacing:.2em;text-transform:uppercase;padding:1rem";
            inner.appendChild(blank);
        }

        /* Hover information: the facts only. The story is the reward for
           opening the memory, so it is never spent on the grid. */
        var meta = el("span", "frame-item__meta");
        meta.appendChild(el("span", "frame-item__title", memory.title || "Untitled"));

        var line = el("span", "frame-item__line");
        var bits = [];
        if (place) bits.push(place);
        if (memory.date) bits.push(formatDate(memory.date));
        line.textContent = bits.join(" \u00b7 ");

        var condition = conditionText(memory.weather);
        if (condition || memory.mood) {
            line.appendChild(document.createTextNode(" \u00b7 "));
            line.appendChild(el("em", null, [condition, memory.mood].filter(Boolean).join(" \u00b7 ")));
        }
        meta.appendChild(line);

        /* Said once, quietly: how many photographs this memory holds. */
        if (photos.length > 1) {
            meta.appendChild(el("span", "frame-item__count",
                photos.length + " PHOTOS"));
        }

        /* Every tile opens the memory here, in the Library, so the wording no
           longer has to guess where a memory might lead. */
        meta.appendChild(el("span", "frame-item__go", "Open memory \u2192"));

        inner.appendChild(meta);

        if (data.isFavorite(memory.id)) {
            inner.appendChild(el("span", "frame-item__favorite", "\u2665"));
        }

        item.appendChild(inner);

        item.addEventListener("click", function () {
            /* Wherever on the tile the click landed — the cover or a fanned
               card — it opens the memory, at its cover. */
            openDetail(item.dataset.memory, null, item);
        });

        return item;
    }

    /* With nothing in the archive there is nothing to have open. This is what
       stops a deleted — or never existing — memory from still being on screen
       after a refresh. */
    function closeDetailIfEmpty(memories) {
        if (memories.length) return;
        if (!detail.hidden) closeDetail();
        state.photoIndex = -1;
        state.originEl = null;
    }

    function renderLibrary() {
        if (renderArchiveState()) {
            /* A state message has taken the library over, so the grid and the
               count line it was drawn beside are no longer backed by anything
               the store holds. They have to go with it — otherwise deleting the
               last memory leaves its frame and "1 MEMORY" sitting above the
               line that says the archive is empty.

               Loading is the exception: the grid on screen is still the truth
               while the next answer is on its way, and wiping it would blink
               the album out on every save. */
            if (data.status !== "loading" && data.status !== "idle") {
                libraryScroll.textContent = "";
                libraryStats.textContent = "";
                state.photos = [];
            }
            library.classList.toggle("is-peeking", false);
            return;
        }

        var memories = data.filterMemories(state.filter);
        var list = memories.filter(function (m) { return (m.photos || []).length; });
        var counts = data.stats(memories);

        libraryEyebrow.textContent = state.heading.eyebrow;
        libraryTitle.textContent = state.heading.title;
        libraryStats.textContent =
            counts.memories + (counts.memories === 1 ? " MEMORY" : " MEMORIES") +
            " \u00b7 " + counts.photos + " PHOTOS" +
            " \u00b7 " + counts.places + (counts.places === 1 ? " PLACE" : " PLACES");

        libraryScroll.textContent = "";
        state.photos = [];

        /* Month groups, newest first — a year reads as time, not as a wall.
           One memory is one item, however many photographs it holds. */
        data.groupByMonth(memories).forEach(function (group) {
            var section = el("section", "month");

            var head = el("header", "month__head");
            head.appendChild(el("span", "month__label", group.year ? group.label + " " + group.year : group.label));
            var count = group.memories.length;
            head.appendChild(el("span", "month__count",
                count + (count === 1 ? " ITEM" : " ITEMS")));
            section.appendChild(head);

            var grid = el("div", "month__grid");
            group.memories.forEach(function (memory) {
                var frame = buildFrame(memory);
                state.photos.push({
                    memory: memory,
                    index: Math.max(0, data.coverIndex(memory)),
                    el: frame
                });
                grid.appendChild(frame);
            });

            section.appendChild(grid);
            libraryScroll.appendChild(section);
        });

        libraryEmpty.hidden = memories.length > 0;
        library.classList.toggle("is-peeking", false);
        closeDetailIfEmpty(memories);
    }

    /* -------------------------------------------------------------------- hover */
    /* Peeking dims the other photographs through CSS, so this only has to
       report that a frame is being pointed at. */
    function bindPeek() {
        libraryScroll.addEventListener("pointerover", function (event) {
            if (!(event.target instanceof Element)) return;
            var frame = event.target.closest(".frame-item");
            if (frame) library.classList.add("is-peeking");
        });

        libraryScroll.addEventListener("pointerout", function (event) {
            if (!(event.target instanceof Element)) return;
            if (event.relatedTarget instanceof Element &&
                event.relatedTarget.closest(".frame-item")) return;
            library.classList.remove("is-peeking");
        });

        libraryScroll.addEventListener("pointerleave", function () {
            library.classList.remove("is-peeking");
        });
    }

    /* ------------------------------------------------------------------- detail */
    function memoryById(id) {
        return data.allMemories().filter(function (m) { return m.id === id; })[0] || null;
    }

    function renderDetailInfo(memory) {
        /* A full redraw replaces whatever was here, confirmation included. */
        state.confirming = false;
        detailInfo.textContent = "";

        detailInfo.appendChild(el("h2", "detail__title", memory.title || "Untitled"));

        var facts = el("div", "detail__facts");

        if (memory.date || memory.time) {
            var when = el("span", "detail__fact",
                [formatDate(memory.date), memory.time].filter(Boolean).join(" \u00b7 "));
            /* A hook for the Timeline: the data it needs is already here. */
            when.dataset.date = memory.date || "";
            when.dataset.memoryId = memory.id;
            when.dataset.timelineTarget = "timeline.html#" + memory.id;
            facts.appendChild(when);
        }

        var place = data.placeKey(memory.location);
        if (place) {
            var where = el("button", "detail__fact detail__fact--link", place + " \u2197");
            where.type = "button";
            /* This is the one place the Library links out to the Map — from a
               memory's own location, not from the sidebar. The place key is
               authoritative, so the map lands on the exact city rather than
               guessing from a name. */
            where.addEventListener("click", function () {
                var query = "?place=" + encodeURIComponent(data.placeKey(memory.location));
                window.location.href = "../memory-map.html" + query;
            });
            facts.appendChild(where);
        }

        var condition = conditionText(memory.weather);
        var feel = [condition, memory.mood].filter(Boolean).join(" \u00b7 ");
        if (feel) facts.appendChild(el("span", "detail__fact", feel));

        detailInfo.appendChild(facts);

        if (memory.description) {
            detailInfo.appendChild(el("p", "detail__story", memory.description));
        }

        if ((memory.tags || []).length) {
            var tags = el("div", "detail__tags");
            memory.tags.forEach(function (tag) {
                tags.appendChild(el("span", "detail__tag", tag));
            });
            detailInfo.appendChild(tags);
        }

        /* Who brought this memory here. Deliberately one quiet line, not a
           profile card. A memory from before accounts existed says so rather
           than inventing an owner. */
        var uploader = el("p", "detail__uploader");
        if (memory.createdBy && memory.createdBy.displayName) {
            uploader.textContent = "Added by " + memory.createdBy.displayName;
            if (memory.createdAt) {
                var when = new Date(memory.createdAt);
                if (!isNaN(when.getTime())) {
                    uploader.textContent += " \u00b7 " + formatDate(
                        when.toISOString().slice(0, 10));
                }
            }
        } else {
            uploader.textContent = "Archive memory \u2014 added before accounts";
        }
        detailInfo.appendChild(uploader);

        /* Editing belongs to the two people who keep this archive. A guest
           simply does not see the controls — the server would refuse them
           anyway. */
        if (auth && auth.isEditor()) {
            var actions = el("div", "detail__actions");

            var edit = el("button", "detail__action", "Edit memory");
            edit.type = "button";
            edit.addEventListener("click", function () {
                var current = currentMemory();
                if (current) openEditor(current);
            });
            actions.appendChild(edit);

            var remove = el("button", "detail__action detail__action--danger", "Delete memory");
            remove.type = "button";
            remove.addEventListener("click", function () {
                var current = currentMemory();
                if (current) askToDelete(current);
            });
            actions.appendChild(remove);

            detailInfo.appendChild(actions);
        }

        var favorite = el("button", "detail__favorite");
        favorite.type = "button";
        var favoriteId = memory.id;
        favorite.setAttribute("aria-pressed", data.isFavorite(favoriteId) ? "true" : "false");
        favorite.textContent = data.isFavorite(favoriteId) ? "\u2665 Favorite" : "\u2661 Favorite";
        favorite.addEventListener("click", function () {
            data.toggleFavorite(favoriteId);
            /* Redraw from the store rather than from the object this closure
               captured, which may already be a version out of date. */
            if (!redrawDetail()) renderDetailInfo(data.allMemories().filter(function (m) {
                return m.id === favoriteId;
            })[0] || memory);
            renderLibrary();
        });
        detailInfo.appendChild(favorite);

        /* There used to be an "Open in the story" link here, pointing at the
           story page. That page is gone and nothing replaced it, so the link is
           gone too rather than left to 404. */
    }

    /* The detail walks the photographs of the memory it is showing, nothing
       else. Arrows at either end wrap round, so a memory with five photographs
       is a loop rather than a dead end. */
    function showPhoto(offset) {
        var memory = currentMemory();
        var photos = (memory && memory.photos) || [];
        if (photos.length < 2) return;

        var next = state.photoIndex + offset;
        if (next < 0) next = photos.length - 1;
        if (next >= photos.length) next = 0;

        state.photoIndex = next;
        paintPhoto();
        settleFrame();
    }

    function paintPhoto() {
        var memory = currentMemory();
        if (!memory) return;

        var photos = memory.photos || [];
        var index = state.photoIndex;
        if (index < 0 || index >= photos.length) index = Math.max(0, data.coverIndex(memory));
        state.photoIndex = index;

        var hasPhoto = photos.length > 0;

        detailImage.src = hasPhoto ? photoSrc(photos[index]) : "";
        detailImage.alt = hasPhoto ? (memory.title || "") : "";

        /* An empty mount would read as a broken photograph, so the frame is
           withdrawn and the view falls back to the memory's words. */
        detail.classList.toggle("is-photoless", !hasPhoto);
        if (detailNoPhoto) detailNoPhoto.hidden = hasPhoto;

        /* The count is only worth the space when there is more than one. */
        var many = photos.length > 1;
        detailCount.textContent = many ? (index + 1) + " / " + photos.length : "";

        detailPrev.hidden = !many;
        detailNext.hidden = !many;

        renderDetailInfo(memory);
    }

    /* A very light change of photograph: the frame settles in rather than
       sliding across. Skipped entirely when motion is reduced. */
    function settleFrame() {
        if (reducedMotion || !detailFrame) return;
        detailFrame.classList.remove("is-settling");
        /* Reading offsetWidth is what restarts the animation. */
        void detailFrame.offsetWidth;
        detailFrame.classList.add("is-settling");
    }

    function openDetail(memoryId, photoIndex, originEl) {
        var memory = memoryById(memoryId);
        if (!memory) return;

        var photos = memory.photos || [];

        /* Open on the cover, wherever it sits in the order — a memory whose
           cover is the third photograph must not open on the first. */
        var index = typeof photoIndex === "number" && photoIndex >= 0 && photoIndex < photos.length
            ? photoIndex
            : Math.max(0, data.coverIndex(memory));

        state.photoIndex = index;
        state.currentMemoryId = memoryId;
        state.originEl = originEl || null;

        detail.hidden = false;
        window.requestAnimationFrame(function () {
            detail.classList.add("is-open");
            paintPhoto();

            /* Grow the frame out of the thumb it came from — a light FLIP
               rather than a hard cut. Skipped when motion is reduced. */
            if (!reducedMotion && originEl && detailFrame) {
                var from = originEl.getBoundingClientRect();
                var to = detailFrame.getBoundingClientRect();
                if (to.width) {
                    detailFrame.style.transition = "none";
                    detailFrame.style.transformOrigin =
                        ((from.left + from.width / 2 - to.left) / to.width * 100) + "% " +
                        ((from.top + from.height / 2 - to.top) / to.height * 100) + "%";
                    detailFrame.style.transform = "scale(" + (from.width / to.width).toFixed(3) + ")";
                    detailFrame.style.opacity = ".45";

                    window.requestAnimationFrame(function () {
                        detailFrame.style.transition = "";
                        detailFrame.style.transform = "";
                        detailFrame.style.opacity = "";
                    });
                }
            }

            if (detailBack) detailBack.focus();
        });
    }

    function closeDetail() {
        if (detail.hidden) return;

        detail.classList.remove("is-open");
        var origin = state.originEl;
        state.currentMemoryId = null;

        window.setTimeout(function () {
            detail.hidden = true;
            detailImage.removeAttribute("src");
            if (origin && typeof origin.focus === "function") origin.focus();
        }, reducedMotion ? 20 : 520);
    }

    /* Draw the open detail again from the store. Called after anything that
       changes the record underneath it, so the panel always shows the server's
       current version rather than the one it was opened with. */
    function redrawDetail() {
        if (!state.currentMemoryId || detail.hidden) return false;
        var memory = memoryById(state.currentMemoryId);
        if (!memory) return false;
        renderDetailInfo(memory);
        paintPhoto();
        return true;
    }

    /* The current record, freshly resolved — never a captured object. */
    function currentMemory() {
        return state.currentMemoryId ? memoryById(state.currentMemoryId) : null;
    }

    /* --------------------------------------------------------------------- sheet */
    /* The sheet itself lives in memory-form.js so the album and the Memory Map
       write memories through exactly the same form. All the album has to say
       is what to do afterwards. */


    /* ------------------------------------------------ the archive on the server
       The Library reads the one memory store, like every other page. There is
       no second fetch here: loadMemories() is shared, reports its own state,
       and never falls back to anything the browser once remembered. */
    function readArchive(force) {
        /* After a save or a delete the cached store is stale by definition, so
           those callers force a re-read. The first paint does not. */
        return data.loadMemories(!!force);
    }

    /* The album does not care who wrote the memory — only that one now exists.
       Listening for the shared event means any future writer shows up here too,
       without either page knowing about the other. */
    document.addEventListener("lovestory:memory-added", function (event) {
        var memory = event.detail && event.detail.memory;
        var target = memory ? memory.id : null;

        state.filter = { kind: "all" };
        state.heading = { eyebrow: "Library", title: "All Memories" };

        /* Re-read the archive before drawing, so the grid shows the server's
           own record rather than whatever the response happened to claim. */
        readArchive(true).then(function () {
            renderSidebar();
            renderLibrary();
            if (target) revealMemory(target);
        });
    });

    /* Bring a memory into view, wherever it landed in the grid. */
    function revealMemory(id) {
        var frame = libraryScroll.querySelector('[data-memory="' + id + '"]');
        if (!frame) return;
        frame.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
        frame.classList.add("is-peeking");
        window.setTimeout(function () { frame.classList.remove("is-peeking"); }, 2200);
    }


    /* --------------------------------------------------------------------- drawer */
    function openDrawer() {
        album.classList.add("is-drawer-open");
        sidebarToggle.setAttribute("aria-expanded", "true");
    }

    function closeDrawer() {
        album.classList.remove("is-drawer-open");
        sidebarToggle.setAttribute("aria-expanded", "false");
    }

    /* ------------------------------------------------------------------- wiring */
    sidebarToggle.addEventListener("click", function () {
        if (album.classList.contains("is-drawer-open")) closeDrawer(); else openDrawer();
    });

    var libraryAdd = document.getElementById("libraryAddButton");
    if (addButton) addButton.addEventListener("click", openAddMemory);
    if (libraryAdd) libraryAdd.addEventListener("click", openAddMemory);

    detailBack.addEventListener("click", closeDetail);
    detailPrev.addEventListener("click", function () { showPhoto(-1); });
    detailNext.addEventListener("click", function () { showPhoto(1); });

    detail.addEventListener("click", function (event) {
        if (event.target === detail || event.target.classList.contains("detail__scrim")) closeDetail();
    });

    /* Swipe, for phones. */
    detail.addEventListener("touchstart", function (event) {
        state.touchX = event.changedTouches[0].clientX;
    }, { passive: true });

    detail.addEventListener("touchend", function (event) {
        var dx = event.changedTouches[0].clientX - state.touchX;
        if (Math.abs(dx) > 50) showPhoto(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener("keydown", function (event) {
        if (!detail.hidden) {
            /* Arrow keys belong to whatever the visitor is typing in, so the
               detail keeps its hands off them while a field has focus. */
            var active = document.activeElement;
            var typing = active && (active.tagName === "INPUT" ||
                                    active.tagName === "TEXTAREA" ||
                                    active.isContentEditable);
            if (typing) return;

            if (event.key === "Escape") {
                /* Esc backs out one step at a time: first the confirmation,
                   then the memory. Neither deletes anything. */
                if (state.confirming) {
                    state.confirming = false;
                    redrawDetail();
                } else {
                    closeDetail();
                }
            }
            if (event.key === "ArrowLeft") showPhoto(-1);
            if (event.key === "ArrowRight") showPhoto(1);
            return;
        }
    });

    /* ------------------------------------------------------------- who may edit
       The archive is public to read, so a guest sees exactly the same library
       and the same detail view. Editing controls are not disabled — they are
       simply absent, which keeps the reading experience clean.

       This is presentation only. The server refuses an unauthorised write no
       matter what this page decides to draw. */

    /* Said once, in the library's own state line, when a write came back 401.
       The archive still reads — only the writing has stopped — so this is a
       notice, not an error page. */
    function showSessionEnded() {
        libraryEmpty.textContent = "";
        libraryEmpty.appendChild(el("span", "library__state",
            "Your session has ended. Sign in again to change the archive. "));
        var signIn = el("a", "library__state", "Sign in");
        signIn.setAttribute("href", "../../gallery/index.html");
        libraryEmpty.appendChild(signIn);
        libraryEmpty.hidden = false;
    }

    function applyEditorState() {
        var editor = !!(auth && auth.isEditor());

        album.classList.toggle("is-editor", editor);
        album.classList.toggle("is-guest", !editor);

        /* A guest should not arrive with the Add Memory sheet half-open. */
        if (!editor && window.LoveStoryMemoryForm && window.LoveStoryMemoryForm.isOpen) {
            window.LoveStoryMemoryForm.close();
        }

        /* The empty state speaks in the reader's voice: it offers an editor the
           first Add button and tells a guest the archive is waiting. "Who is
           reading" is answered by a request of its own, so it can lose the race
           against the archive — and then an owner is shown the guest line with
           no way in. The library is drawn again here, once the answer is known,
           so the copy on screen always matches the visitor. */
        renderLibrary();
    }

    function openAddMemory() {
        if (auth && !auth.isEditor()) return;
        if (window.LoveStoryMemoryForm) window.LoveStoryMemoryForm.open();
    }

    /* -------------------------------------------------------------------- go */
    /* The map can hand a place over in the query string, so "View memories"
       there lands on the album already filtered. */
    function applyIncomingPlace() {
        var match = /[?&]place=([^&]+)/.exec(window.location.search);
        if (!match) return false;

        var key = decodeURIComponent(match[1].replace(/\+/g, " "));
        var place = data.placesAll().filter(function (p) { return p.key === key; })[0];
        if (!place) return false;

        state.filter = { kind: "place", value: place.key };
        state.heading = { eyebrow: "Place", title: place.label };
        return true;
    }

    /* The Entrance hands a memory over by ID, so clicking a film photograph
       there opens that memory rather than the library at large. The detail
       walks the on-screen frames, so this must run AFTER a render. */
    function applyIncomingMemory() {
        var match = /[?&]memory=([^&]+)/.exec(window.location.search);
        if (!match) return false;

        /* Before the archive has answered, every memory looks missing. Saying
           so — and dropping the parameter — would break a link to a memory
           that is simply still on its way. */
        if (data.status === "idle" || data.status === "loading") return false;

        var id = decodeURIComponent(match[1].replace(/\+/g, " "));

        if (!memoryById(id)) {
            /* The link names a memory this archive does not have. Say so, and
               drop the dead parameter so a refresh is not confusing. */
            libraryEmpty.hidden = false;
            libraryEmpty.textContent = "";
            var gone = el("span", "library__missing",
                "This memory is no longer in the archive. ");
            var back = el("button", null, "Back to All Memories");
            back.type = "button";
            back.addEventListener("click", function () {
                try { window.history.replaceState(null, "", window.location.pathname); }
                catch (error) { /* harmless */ }
                libraryEmpty.hidden = true;
                renderSidebar();
                renderLibrary();
            });
            gone.appendChild(back);
            libraryEmpty.appendChild(gone);
            try { window.history.replaceState(null, "", window.location.pathname); }
            catch (error) { /* harmless */ }
            return false;
        }

        /* The tile it grew out of, when there is one. */
        var frame = libraryScroll.querySelector('[data-memory="' + id + '"]');
        openDetail(id, null, frame || null);
        return true;
    }

    function boot() {
        /* Retire anything an earlier version of this page left in the browser.
           Two places, deleted once: no memory can come from here again. */
        if (data.purgeLegacyBrowserStore) {
            var retired = data.purgeLegacyBrowserStore();
            if (retired.legacyCount) {
                console.info(
                    "Love Story: retired " + retired.legacyCount +
                    " memory record(s) an earlier version had saved in this browser. " +
                    "The archive now comes only from the server."
                );
            }
        }

        bindPeek();
        applyEditorState();
        applyIncomingPlace();

        /* Paint the bundled memories first — the page is never empty, even if
           the server is slow or absent — then fold in the archive and repaint. */
        renderSidebar();
        renderLibrary();
        applyIncomingMemory();

        readArchive().then(function () {
            /* A place — or a memory — that exists only in the archive could not
               be resolved on the first pass, so the incoming link gets a second
               look. state.currentMemoryId is null while nothing is open. */
            if (state.filter.kind === "all") applyIncomingPlace();
            renderSidebar();
            renderLibrary();
            if (!state.currentMemoryId) applyIncomingMemory();
        });
    }

    /* Wait for IndexedDB before the first paint, so a memory saved on an
       earlier visit is already in the grid rather than appearing a beat later. */
    if (auth && auth.ready) {
        auth.ready.then(applyEditorState, applyEditorState);
        document.addEventListener("lovestory:auth-changed", applyEditorState);

        /* A session can end while the page is open. The next call comes back
           401, and the page becomes a guest instead of breaking — but it says
           so, rather than silently dropping the controls the visitor was just
           using. */
        document.addEventListener("lovestory:session-expired", function () {
            function becomeGuest() {
                applyEditorState();
                renderSidebar();
                renderLibrary();
                /* An open detail was drawn while this visitor could edit; drawn
                   again now, Edit and Delete are simply absent. */
                redrawDetail();
                showSessionEnded();
            }
            if (auth && auth.refresh) {
                auth.refresh().then(becomeGuest, becomeGuest);
            } else {
                becomeGuest();
            }
        });
    }

    if (data.ready && typeof data.ready.then === "function") {
        data.ready.then(boot, boot);
    } else {
        boot();
    }
})();
