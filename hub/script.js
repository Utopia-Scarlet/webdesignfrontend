/* ==========================================================================
   LoveStory — Main Hub behaviour (V4)

   The HTML owns the structure of the five elements; this file fills them with
   data, switches the year filter, connects a Timeline event to the place it
   happened, and opens the interactive world.

   No CRUD here — the hub is preview + entry only.
   ========================================================================== */

(function () {
    "use strict";

    /* ---------------------------------------------------------------------
       The archive gate. The Hub is only reachable once the Entrance has been
       unlocked; anything else sends the visitor back to the Entrance, which
       is the only page that can open the archive.

       This is the one thing this file adds for the entry-flow change. No
       layout, no styling and no module behaviour is touched.
       --------------------------------------------------------------------- */
    /* The archive is public to read. A guest — a visitor with no session — is
       welcome here; what changes is only whether the editing controls appear.
       The server refuses any unauthorised write regardless of what this page
       chooses to show. */
    var auth = window.LoveStoryAuth;

    var data = window.LoveStoryData;
    /* The archive answers asynchronously, and years are derived from the
       memories it returns — so "no years yet" at this point means "no answer
       yet", not "nothing to draw". The boot at the foot of this file waits for
       the first answer and builds the year selector from whatever it holds.
       Stopping here instead would leave the whole Hub blank on every load. */
    if (!data) return;

    var geo = window.LoveStoryGeo;
    var SVG_NS = "http://www.w3.org/2000/svg";

    var IMAGE_BASE = "../image/";

    /* A photograph is either a bundled file name or a URL the server handed
       over whole. Only the bundled kind needs the base in front of it —
       prefixing an absolute URL builds a path that cannot exist. */
    function photoSrc(file) {
        if (!file) return "";
        if (/^(data:|blob:|https?:)/.test(file)) return file;
        return IMAGE_BASE + file;
    }
    var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    var MONTH_MARKERS = [0, 2, 5, 8, 11];

    var MAX_TIMELINE_NODES = 5;
    /* The combined view spans every year, so its line may hold two more
       events than a single year's. */
    var ALL_TIMELINE_NODES = 7;
    var MAX_STACK = 3;
    var MAX_PLANS = 3;
    var UPCOMING_COUNT = 3;

    /* The hub's own small globe: the same projection the big one uses, centred
       where their places actually are, so markers sit on the real grid. */
    var MINI = { size: 240, cx: 120, cy: 120, radius: 92, lon: 115, lat: 10 };

    var yearsBox = document.getElementById("hubYears");
    var space = document.getElementById("hubSpace");
    var linkSvg = document.getElementById("hubLink");
    var linkPath = document.getElementById("hubLinkPath");

    var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ------------------------------------------------------------------ state */
    /* The Hub opens on the whole archive: the selector's ALL button. */
    function defaultYear() {
        return data.ALL_YEARS;
    }

    var state = { year: defaultYear() };
    var upcomingState = { index: 0 };

    /* Live references, rebuilt on every render. */
    var live = { months: [], nodes: [], zones: [], positions: [] };

    /* Exactly one event is "current" at any moment. Zone, dot, ring, month,
       preview, map highlight and the connection line all read this single
       piece of state — which is why moving onto the dot can no longer end the
       hover: there is no per-element enter/leave left to misfire. */
    var activeIndex = -1;

    /* ------------------------------------------------------------------ utils */
    function pick(selector) { return document.querySelector(selector); }

    function plural(count, singular, pluralForm) {
        var word = count === 1 ? singular : (pluralForm || singular + "S");
        return count + " " + word;
    }

    function pad2(value) { return value < 10 ? "0" + value : String(value); }

    function formatDateObj(date) {
        return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear();
    }

    function formatDate(iso) {
        if (!iso) return "";
        var date = new Date(iso + "T00:00:00");
        return isNaN(date.getTime()) ? "" : formatDateObj(date);
    }

    function fractionOfYear(memory, index, total) {
        if (memory.date) {
            var date = new Date(memory.date + "T00:00:00");
            if (!isNaN(date.getTime())) {
                var start = new Date(date.getFullYear(), 0, 1);
                var end = new Date(date.getFullYear() + 1, 0, 1);
                return (date - start) / (end - start);
            }
        }
        return total > 1 ? index / (total - 1) : 0.5;
    }

    /* The combined Timeline runs on one axis: 1 Jan of the earliest year
       through 31 Dec of the latest. The year ticks and the events both use
       these boundaries, so they always share the same scale. */
    function spanBounds(yearList) {
        return {
            start: new Date(yearList[0], 0, 1).getTime(),
            end: new Date(yearList[yearList.length - 1], 11, 31).getTime()
        };
    }

    function fractionWithin(start, end, time) {
        var span = end - start;
        if (span <= 0) return 0.5;

        var fraction = (time - start) / span;
        if (fraction < 0) fraction = 0;
        if (fraction > 1) fraction = 1;
        return fraction;
    }

    /* Where a memory sits across every year at once. A date in the middle of
       2025 in a 2025–2026 span lands near 0.25, because 2025 is the first half
       of the whole span. */
    function fractionOfSpan(memory, index, total, yearList) {
        var bounds = spanBounds(yearList);

        if (memory.date) {
            var date = new Date(memory.date + "T00:00:00");
            if (!isNaN(date.getTime())) {
                return fractionWithin(bounds.start, bounds.end, date.getTime());
            }
        }
        return total > 1 ? index / (total - 1) : 0.5;
    }

    /* The centre of a year on that same axis, for the year ticks. */
    function yearCentreFraction(year, yearList) {
        var bounds = spanBounds(yearList);
        var start = new Date(year, 0, 1).getTime();
        var end = new Date(year + 1, 0, 1).getTime();
        return fractionWithin(bounds.start, bounds.end, start + (end - start) / 2);
    }

    /* The Timeline arc, in percent of the timeline box — the exact quadratic
       of the SVG path  M 0 50 Q 50 18 100 50 , so an event always lands on the
       drawn curve. */
    function curveAt(t) { return 50 - 64 * t + 64 * t * t; }

    /* -------------------------------------------------------------- the years */

    /* THE YEAR FILTER IS A MEMORY FILTER, and nothing else.

       A year appears in this selector only when a STANDARD MEMORY of the
       CURRENT SPACE was written in it. Not because an anniversary falls in it,
       not because a plan does, not because it is the current year, and not
       because some list once declared it. The store behind this is fed by
       GET /api/memories, which is standard-only and scoped to the space the
       session is looking at — so a private memory cannot invent a year here
       either. A tab with nothing behind it would say "there is something in
       2025 you are not being shown", which is exactly what must never be said.

       This used to read LoveStoryTimeline.years(), which adds every year an
       anniversary falls in. That is why a space whose only memories were from
       2026 offered a 2025 tab and then showed nothing under it. */
    function memoryYears() {
        return data.years.slice().sort(function (a, b) { return a - b; });
    }

    /* The years the combined view's LINE is drawn across: the memory years,
       plus any year an event being drawn actually falls in.

       This is the Timeline's own question, not the filter's. An anniversary in
       2025 is still drawn in the ALL view — the selector simply does not offer
       a year that holds no memory. Without this the line would be scaled to the
       memory years alone and a date outside them would be pinned to the edge of
       the axis, which is a worse answer than a tick with one event on it. */
    function axisYears(events) {
        var seen = Object.create(null);
        memoryYears().forEach(function (year) { seen[year] = true; });
        (events || []).forEach(function (event) {
            if (event && event.year) seen[Number(event.year)] = true;
        });
        var years = Object.keys(seen).map(Number);
        /* An archive with no dates at all still draws an axis. */
        if (!years.length) years.push(new Date().getFullYear());
        return years.sort(function (a, b) { return a - b; });
    }

    /* A selected year that no longer exists — the last memory in it deleted,
       re-dated, or made private, or the space changed underneath — falls back
       to ALL. Leaving the tab selected would be a page showing nothing with no
       way to understand why. Returns true when it moved. */
    function reconcileYear() {
        if (data.isAllYears(state.year)) return false;
        if (memoryYears().indexOf(Number(state.year)) !== -1) return false;
        state.year = data.ALL_YEARS;
        return true;
    }

    function appendYearButton(year, label) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "hub__year";
        button.textContent = label;
        button.dataset.year = String(year);
        button.setAttribute("aria-pressed",
            String(year) === String(state.year) ? "true" : "false");
        button.addEventListener("click", function () { selectYear(year); });
        yearsBox.appendChild(button);
    }

    function renderYears() {
        if (!yearsBox) return;

        /* Whatever happened while this page was open — a memory saved, deleted,
           re-dated, moved to the private archive, or a different space — the
           selected year is checked against the years that actually exist before
           anything is drawn. */
        reconcileYear();

        yearsBox.textContent = "";

        /* ALL leads, then every year this space has a memory in. */
        appendYearButton(data.ALL_YEARS, "ALL");
        memoryYears().forEach(function (year) {
            appendYearButton(year, String(year));
        });
    }

    function selectYear(year) {
        /* A year this space has no memory in is not a state this page can be
           in, so choosing one lands on ALL rather than on an empty album. */
        if (!data.isAllYears(year) && memoryYears().indexOf(Number(year)) === -1) {
            year = data.ALL_YEARS;
        }
        if (year === state.year) return;
        state.year = year;

        if (yearsBox) {
            Array.prototype.forEach.call(
                yearsBox.querySelectorAll(".hub__year"),
                function (button) {
                    button.setAttribute("aria-pressed",
                        button.dataset.year === String(year) ? "true" : "false");
                }
            );
        }

        renderAll();
    }

    /* ------------------------------------------- contextual link (data-driven) */
    function clearLink() {
        if (linkSvg) linkSvg.classList.remove("is-visible");
        if (linkPath) linkPath.removeAttribute("d");
    }

    function findPlaceDot(key) {
        var box = pick("[data-map-dots]");
        if (!box || !key) return null;
        var dots = box.querySelectorAll(".globe__dot");
        for (var i = 0; i < dots.length; i++) {
            if (dots[i].dataset.place === key) return dots[i];
        }
        return null;
    }

    function drawLink(nodeEl, dotEl) {
        if (!space || !linkPath || !linkSvg || !nodeEl || !dotEl) return;

        var box = space.getBoundingClientRect();
        var from = nodeEl.getBoundingClientRect();
        var to = dotEl.getBoundingClientRect();

        var x1 = from.left + from.width / 2 - box.left;
        var y1 = from.top + from.height / 2 - box.top;
        var x2 = to.left + to.width / 2 - box.left;
        var y2 = to.top + to.height / 2 - box.top;

        var dx = x2 - x1;
        var dy = y2 - y1;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;

        var bow = Math.min(length * 0.2, 80);
        var cx = (x1 + x2) / 2 - (dy / length) * bow;
        var cy = (y1 + y2) / 2 + (dx / length) * bow;

        linkPath.setAttribute("d",
            "M" + x1.toFixed(1) + "," + y1.toFixed(1) +
            " Q" + cx.toFixed(1) + "," + cy.toFixed(1) +
            " " + x2.toFixed(1) + "," + y2.toFixed(1));

        linkSvg.classList.add("is-visible");
    }

    function linkPlace(nodeEl, memory) {
        var key = data.placeKey(memory.location);
        var dot = findPlaceDot(key);
        if (!dot) return;
        dot.classList.add("is-linked");
        drawLink(nodeEl, dot);
    }

    function unlinkPlace(memory) {
        var dot = findPlaceDot(data.placeKey(memory.location));
        if (dot) dot.classList.remove("is-linked");
        clearLink();
    }

    function setActiveEvent(index) {
        if (index === activeIndex) return;

        var previous = activeIndex >= 0 ? live.nodes[activeIndex] : null;
        if (previous) {
            previous.classList.remove("is-open");
            if (previous._memory) unlinkPlace(previous._memory);
        }
        clearLink();

        activeIndex = index;

        var node = index >= 0 ? live.nodes[index] : null;
        if (!node) {
            Array.prototype.forEach.call(live.months, function (month) {
                month.classList.remove("is-active");
            });
            return;
        }

        node.classList.add("is-open");

        Array.prototype.forEach.call(live.months, function (month) {
            month.classList.toggle("is-active",
                month.dataset.month === node.dataset.markerMonth);
        });

        if (node._memory) linkPlace(node, node._memory);
    }

    function clearActiveEvent() { setActiveEvent(-1); }

    /* Which event owns a horizontal position: boundaries sit at the midpoints
       between neighbours, so the whole span is meaningful. */
    function zoneIndexFor(x) {
        var last = live.positions.length - 1;
        for (var i = 0; i < live.positions.length; i++) {
            var right = i === last ? 1 : (live.positions[i] + live.positions[i + 1]) / 2;
            if (x <= right) return i;
        }
        return last;
    }

    /* ------------------------------------------------- 1. OUR WORLD (mini) */
    function renderMiniGlobe() {
        if (!geo || !geo.graticule) return;

        var group = pick("[data-globe-graticule]");
        if (!group) return;

        var project = geo.projector(MINI.lon, MINI.lat, MINI.radius, MINI.cx, MINI.cy);

        group.textContent = "";
        geo.graticule(30).forEach(function (line, index) {
            var d = geo.lineToPath(line, project);
            if (!d) return;

            var path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", d);
            path.setAttribute("class",
                index % 3 === 0 ? "globe__line globe__line--major" : "globe__line");
            group.appendChild(path);
        });
    }

    function renderMap(year) {
        var memories = data.memoriesIn(year);
        var places = data.placesIn(year);

        var counts = pick("[data-map-counts]");
        if (counts) {
            counts.textContent =
                plural(places.length, "PLACE") + " \u00b7 " +
                plural(memories.length, "MEMORY", "MEMORIES");
        }

        var box = pick("[data-map-dots]");
        if (!box) return;
        box.textContent = "";

        var project = geo
            ? geo.projector(MINI.lon, MINI.lat, MINI.radius, MINI.cx, MINI.cy)
            : null;

        places.forEach(function (place) {
            var dot = document.createElement("span");
            dot.className = "globe__dot";
            dot.dataset.place = place.key;

            /* Real coordinates, projected with the same maths as the grid. */
            if (project) {
                var point = project(place.longitude, place.latitude);
                dot.style.setProperty("--x", (point.x / MINI.size * 100).toFixed(2) + "%");
                dot.style.setProperty("--y", (point.y / MINI.size * 100).toFixed(2) + "%");
                dot.classList.toggle("globe__dot--flip", point.x > MINI.cx + 30);
            }

            var label = document.createElement("span");
            label.className = "globe__label";
            label.textContent = place.label;

            dot.appendChild(label);
            box.appendChild(dot);
        });
    }

    /* ------------------------------------------------------------- 2. TIMELINE */
    function renderMonths(axis) {
        var box = pick("[data-timeline-months]");
        if (!box) return;
        box.textContent = "";
        live.months = [];

        /* The combined view names years instead of months. Each tick carries
           its year in dataset.month, so setActiveEvent's matching still works.
           The years are the LINE's, which may include a year an anniversary
           falls in — the filter above offers no such year, and this draws the
           tick its event needs. */
        if (data.isAllYears(state.year)) {
            var yearList = axis;
            yearList.forEach(function (year) {
                var yearMark = document.createElement("span");
                yearMark.className = "timeline__month";
                yearMark.style.setProperty("--x",
                    (yearCentreFraction(year, yearList) * 100).toFixed(2) + "%");
                yearMark.textContent = String(year);
                yearMark.dataset.month = String(year);
                box.appendChild(yearMark);
                live.months.push(yearMark);
            });
            return;
        }

        MONTH_MARKERS.forEach(function (monthIndex) {
            var mark = document.createElement("span");
            mark.className = "timeline__month";
            mark.style.setProperty("--x", ((monthIndex + 0.5) / 12 * 100).toFixed(2) + "%");
            mark.textContent = MONTHS[monthIndex];
            mark.dataset.month = String(monthIndex);
            box.appendChild(mark);
            live.months.push(mark);
        });
    }

    /* One event on the line, from whichever collection it came from. A memory
       carries its cover and its place; an anniversary carries neither, so its
       preview is words only. */
    function buildEventPreview(event) {
        var preview = document.createElement("span");
        preview.className = "timeline__preview";

        var isMemory = event.type === "memory";

        /* The memory's cover, chosen where covers are chosen. */
        var photo = isMemory && event.memory ? data.coverUrl(event.memory) : "";
        if (photo) {
            var media = document.createElement("span");
            media.className = "timeline__preview-media";

            var image = document.createElement("img");
            image.src = photoSrc(photo);
            image.alt = "";
            image.decoding = "async";
            image.draggable = false;

            media.appendChild(image);
            preview.appendChild(media);
        }

        var body = document.createElement("span");
        body.className = "timeline__preview-body";

        var dateText = formatDate(event.date);
        if (dateText) {
            var dateLine = document.createElement("span");
            dateLine.className = "timeline__preview-date";
            dateLine.textContent = dateText;
            body.appendChild(dateLine);
        }

        var title = document.createElement("span");
        title.className = "timeline__preview-title";
        title.textContent = event.title;
        body.appendChild(title);

        /* A place for a memory; "1ST ANNIVERSARY" or "ORIGINAL DATE" for an
           anniversary. Never a database field — only words a person would
           say. */
        if (event.subtitle && event.subtitle !== event.title) {
            var subtitle = document.createElement("span");
            subtitle.className = "timeline__preview-place" +
                (isMemory ? "" : " timeline__preview-place--date");
            subtitle.textContent = event.subtitle;
            body.appendChild(subtitle);
        }

        /* Each opens where it actually lives: a memory in the Photo Library, an
           anniversary on its own page. Nothing here writes an address down —
           see routes.js. */
        var action = document.createElement("a");
        action.className = "timeline__preview-link";

        if (isMemory) {
            action.href = window.LoveStoryRoutes
                ? window.LoveStoryRoutes.memory(event.sourceId)
                : "modules/moments.html?memory=" + encodeURIComponent(event.sourceId);
            action.textContent = "View memory \u2192";
        } else {
            action.href = window.LoveStoryRoutes
                ? window.LoveStoryRoutes.anniversary(event.sourceId)
                : "modules/anniversary.html?anniversary=" + encodeURIComponent(event.sourceId);
            action.textContent = "View date \u2192";
        }

        body.appendChild(action);

        preview.appendChild(body);
        return preview;
    }

    function renderTimeline(year) {
        var isAll = data.isAllYears(year);

        /* The line is drawn from every source that has a date — memories and
           anniversaries both. Which collection an event came from is carried on
           the event, never guessed from its shape. */
        var all = window.LoveStoryTimeline
            ? window.LoveStoryTimeline.events(year)
            : data.timelineMemories(year);

        /* The axis follows what is actually being drawn. The year FILTER is a
           different list, and a much shorter one: only years with a memory. */
        var yearList = isAll ? axisYears(all) : memoryYears();

        clearActiveEvent();
        renderMonths(yearList);

        var count = pick("[data-timeline-count]");
        if (count) {
            count.textContent = (isAll ? "ALL" : String(year)) + " \u00b7 " +
                plural(all.length, "EVENT");
        }

        var nodeBox = pick("[data-timeline-nodes]");
        var zoneBox = pick("[data-timeline-zones]");
        if (!nodeBox) return;

        nodeBox.textContent = "";
        if (zoneBox) zoneBox.textContent = "";
        live.nodes = [];
        live.zones = [];

        /* A single year keeps its five events; the combined line may hold two
           more, one for each year the archive spans. Which events are chosen
           does not change — only how many of them are drawn.

           An anniversary is a milestone by definition, so when there are more
           events than the line can hold, the dates are kept and memories fill
           what is left. A birthday quietly missing while a Tuesday snapshot was
           drawn would be the wrong way round. */
        var cap = isAll ? ALL_TIMELINE_NODES : MAX_TIMELINE_NODES;
        var shown = trimToFit(all, cap);
        var fractions = shown.map(function (event, index) {
            return isAll
                ? fractionOfSpan(event, index, shown.length, yearList)
                : fractionOfYear(event, index, shown.length);
        });
        live.positions = fractions;

        /* --- the zones: every point on the line belongs to the nearest event.
           Boundaries sit at the midpoints, so the whole span is meaningful. */
        if (zoneBox) {
            shown.forEach(function (memory, index) {
                var left = index === 0 ? 0 : (fractions[index - 1] + fractions[index]) / 2;
                var right = index === shown.length - 1
                    ? 1
                    : (fractions[index] + fractions[index + 1]) / 2;

                var zone = document.createElement("span");
                zone.className = "timeline__zone";
                zone.dataset.index = String(index);
                zone.style.setProperty("--from", (left * 100).toFixed(2) + "%");
                zone.style.setProperty("--width", ((right - left) * 100).toFixed(2) + "%");

                /* Hover is handled once for the whole timeline below; a tap
                   picks the event, because touch has no pointermove. */
                zone.addEventListener("click", function () {
                    if (!canHover) setActiveEvent(index);
                });

                zoneBox.appendChild(zone);
                live.zones.push(zone);
            });
        }

        /* --- the events themselves ------------------------------------------ */
        shown.forEach(function (event, index) {
            var t = fractions[index];
            var isLatest = index === shown.length - 1;
            var isAnniversary = event.type === "anniversary";

            var node = document.createElement("span");
            node.className = "timeline__node" +
                (event.photos && event.photos.length ? " timeline__node--filled" : "") +
                (isAnniversary ? " timeline__node--anniversary" : "") +
                (isLatest ? " timeline__node--latest" : "");
            node.style.setProperty("--x", (t * 100).toFixed(2) + "%");
            node.style.setProperty("--y", curveAt(t).toFixed(2) + "%");

            /* The tick this event lights up: the nearest month in a single
               year, the event's own year in the combined view. */
            var markerMonth;
            if (isAll) {
                markerMonth = String(event.year);
            } else {
                var nearest = 0;
                MONTH_MARKERS.forEach(function (month, i) {
                    if (Math.abs((month + 0.5) / 12 - t) <
                        Math.abs((MONTH_MARKERS[nearest] + 0.5) / 12 - t)) nearest = i;
                });
                markerMonth = String(MONTH_MARKERS[nearest]);
            }
            node.dataset.markerMonth = markerMonth;
            /* Only a memory has a place to point the connection line at; the
               guards in setActiveEvent already allow for its absence. */
            if (event.type === "memory") node._memory = event.memory;

            var hit = document.createElement("button");
            hit.type = "button";
            hit.className = "timeline__hit";
            hit.setAttribute("aria-label",
                event.title + (event.date ? ", " + formatDate(event.date) : "") +
                " \u2014 " + (isAnniversary ? "show this date" : "show this memory"));

            var pulse = document.createElement("span");
            pulse.className = "timeline__pulse";
            pulse.setAttribute("aria-hidden", "true");

            var dot = document.createElement("span");
            dot.className = "timeline__dot";

            hit.appendChild(pulse);
            hit.appendChild(dot);

            /* Keyboard and touch reach the same state as hover. */
            hit.addEventListener("focus", function () { setActiveEvent(index); });
            hit.addEventListener("click", function () { setActiveEvent(index); });
            hit.addEventListener("blur", clearActiveEvent);

            node.appendChild(hit);
            node.appendChild(buildEventPreview(event));
            nodeBox.appendChild(node);
            live.nodes.push(node);
        });
    }

    /* At most `cap` events, dates first and memories after them. The kept
       events are put back in date order, so the line still reads as a
       chronology rather than as two groups. */
    function trimToFit(all, cap) {
        if (all.length <= cap) return all;

        var kept = all.filter(function (event) {
            return event.type === "anniversary";
        }).slice(0, cap);

        if (kept.length < cap) {
            all.forEach(function (event) {
                if (kept.length >= cap) return;
                if (event.type !== "anniversary") kept.push(event);
            });
        }

        return kept.sort(function (a, b) {
            if (a.date !== b.date) return a.date < b.date ? -1 : 1;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
    }

    /* One pointer handler for the entire timeline. It decides the current
       event from the pointer's x, and deliberately keeps that event while the
       pointer is over its preview — the preview sits above the timeline box,
       so a per-element handler would drop it exactly when you reach for it. */
    (function bindTimelinePointer() {
        var timelineEl = pick(".timeline");
        var timelineModule = pick(".module--timeline");
        if (!timelineEl || !timelineModule) return;

        timelineModule.addEventListener("pointermove", function (event) {
            if (!live.positions.length) return;

            if (event.target instanceof Element &&
                event.target.closest(".timeline__preview")) return;

            var rect = timelineEl.getBoundingClientRect();
            if (!rect.width) return;

            /* Above or below the band, nothing is being pointed at. */
            if (event.clientY < rect.top - 10 || event.clientY > rect.bottom + 10) {
                clearActiveEvent();
                return;
            }

            setActiveEvent(zoneIndexFor((event.clientX - rect.left) / rect.width));
        });

        timelineModule.addEventListener("pointerleave", clearActiveEvent);
    })();

    /* -------------------------------------------------------------- 3. MOMENTS */
    function renderMoments(year) {
        var memories = data.memoriesIn(year);

        var count = pick("[data-moments-count]");
        if (count) count.textContent = plural(memories.length, "STORY", "STORIES");

        var box = pick("[data-moments-stack]");
        if (!box) return;
        box.textContent = "";

        /* stackPhotos returns them back → front, which is also DOM order, so
           the deepest photograph is painted first and needs no z-index. */
        var photos = data.stackPhotos(year, MAX_STACK);

        if (!photos.length) {
            var empty = document.createElement("span");
            empty.className = "stack__empty";
            box.appendChild(empty);
            return;
        }

        photos.forEach(function (item) {
            /* A photograph is deliberately NOT its own link any more. The whole
               module is one link to the photo library, and an <a> inside an
               <a> is invalid — worse, these used to point at each memory's own
               href, which is how two dead links ended up covering the stack.
               The image is decorative inside the module's link. */
            var photo = document.createElement("span");
            photo.className = "stack__photo";
            photo.setAttribute("aria-hidden", "true");

            var image = document.createElement("img");
            image.src = photoSrc(item.file);
            image.alt = "";
            image.decoding = "async";
            image.draggable = false;

            photo.appendChild(image);
            box.appendChild(photo);
        });
    }

    /* --------------------------------------------------------- 4. PLAN AHEAD
       Planned things, read from the archive itself.

       This module used to show three invented plans. It now shows the next
       three real ones, soonest first, and nothing is invented when there are
       none — an empty module that tells the truth is better than a full one
       that lies.

       The year filter does not apply here. Every other module looks back at
       a year of memories; this one looks forward, and "the future, in 2019"
       is not a question worth answering. */
    function renderFuture() {
        var plans = window.LoveStoryPlans ? window.LoveStoryPlans.upcoming() : [];
        var status = window.LoveStoryPlans ? window.LoveStoryPlans.status : "idle";
        var failed = status === "error";

        var count = pick("[data-future-count]");
        if (count) {
            if (failed) count.textContent = "Unavailable";
            else if (!plans.length) count.textContent = "Nothing yet";
            else count.textContent = plural(plans.length, "THING") + " AHEAD";
        }

        var box = pick("[data-future-list]");
        if (!box) return;
        box.textContent = "";

        if (!plans.length) {
            var empty = document.createElement("span");
            empty.className = "future-list__empty";
            empty.textContent = failed
                ? "Plans could not be read"
                : "Nothing planned yet";
            box.appendChild(empty);
            return;
        }

        plans.slice(0, MAX_PLANS).forEach(function (plan, index) {
            var item = document.createElement("span");
            item.className = "future-list__item";

            var number = document.createElement("span");
            number.className = "future-list__num";
            number.textContent = pad2(index + 1);

            var body = document.createElement("span");
            body.className = "future-list__body";

            var title = document.createElement("span");
            title.className = "future-list__title";
            title.textContent = plan.title;
            body.appendChild(title);

            var note = document.createElement("span");
            note.className = "future-list__note";
            note.textContent = plan.location
                ? plan.location + " · " + formatPlanRange(plan)
                : formatPlanRange(plan);
            body.appendChild(note);

            item.appendChild(number);
            item.appendChild(body);
            box.appendChild(item);
        });
    }

    /* The date range, written small. The full editorial form lives in
       data/future-plans.js, which the plan page uses; the Hub only needs the
       two ends of it. */
    function formatPlanRange(plan) {
        if (window.LoveStoryPlans) {
            return window.LoveStoryPlans.formatRange(plan.startDate, plan.endDate);
        }
        return plan.startDate || "";
    }

    /* ---------------------------------------------------------- 5. ANNIVERSARY

       The dates that come round every year, read from their own collection.

       This module used to be built out of memories: anything marked for the
       Timeline had its date counted down to, so a holiday photograph appeared
       here as though it were the day we met. A memory is something that
       happened once; an anniversary is a date someone declared. Nothing in
       this function looks at a memory.

       The nearest date leads; the next two wait underneath. */
    function renderUpcoming() {
        var Dates = window.LoveStoryAnniversaries;
        var events = Dates ? Dates.upcoming() : [];
        var status = Dates ? Dates.status : "idle";
        var failed = status === "error" || !Dates;

        var eyebrow = pick("[data-countdown-eyebrow]");
        var titleEl = pick("[data-countdown-title]");
        var daysEl = pick("[data-countdown-days]");
        var unitEl = pick("[data-countdown-unit]");
        var dateEl = pick("[data-countdown-date]");
        var hintEl = pick("[data-countdown-hint]");
        var listEl = pick("[data-countdown-upcoming]");
        var addEl = document.getElementById("countdownAdd");

        /* No dates at all. Say so, and never fall back to a memory. */
        if (!events.length) {
            var editor = auth && auth.isEditor();
            var waiting = status === "loading" || status === "idle";

            if (eyebrow) eyebrow.textContent = "Next Anniversary";
            if (titleEl) {
                titleEl.textContent = failed ? "Unavailable"
                    : (waiting ? "\u2014" : "No dates yet");
            }
            if (daysEl) daysEl.textContent = "\u2014";
            if (unitEl) unitEl.textContent = "";
            if (dateEl) dateEl.textContent = "";
            if (hintEl) {
                hintEl.className = "countdown__hint";
                hintEl.textContent = (failed || waiting)
                    ? ""
                    : (editor ? "" : "No anniversaries have been added yet.");
            }
            if (addEl) addEl.hidden = !editor || failed || waiting;
            if (listEl) listEl.textContent = "";
            return;
        }

        if (addEl) addEl.hidden = true;

        if (upcomingState.index >= events.length) upcomingState.index = 0;
        var primary = events[upcomingState.index];

        if (eyebrow) eyebrow.textContent = "Next Anniversary";
        if (titleEl) titleEl.textContent = primary.title;

        /* On the day itself the number is the word TODAY. "0 Days" is not a
           countdown, it is arithmetic left on the screen. */
        if (daysEl) daysEl.textContent = primary.isToday
            ? "TODAY" : String(primary.daysRemaining);
        if (unitEl) {
            unitEl.textContent = primary.isToday
                ? "" : (primary.daysRemaining === 1 ? "Day" : "Days");
        }
        if (dateEl) dateEl.textContent = Dates.formatShort(primary.nextDate);

        if (hintEl) {
            hintEl.className = "countdown__hint" +
                (primary.nextLabel ? " countdown__hint--ordinal" : "");
            hintEl.textContent = primary.nextLabel || "the day itself";
        }

        if (!listEl) return;
        listEl.textContent = "";

        events.slice(0, UPCOMING_COUNT).forEach(function (event, index) {
            if (index === upcomingState.index) return;

            var item = document.createElement("li");

            var button = document.createElement("button");
            button.type = "button";
            button.className = "upcoming__item";
            button.setAttribute("aria-label",
                event.title + " \u2014 " + event.daysRemaining + " days \u2014 bring forward");

            button.addEventListener("click", function () {
                upcomingState.index = index;
                renderUpcoming();
            });

            var name = document.createElement("span");
            name.className = "upcoming__name";
            name.textContent = event.title;

            var days = document.createElement("span");
            days.className = "upcoming__days";
            days.textContent = event.isToday ? "\u2014" : String(event.daysRemaining);

            var unit = document.createElement("span");
            unit.className = "upcoming__unit";
            unit.textContent = event.isToday ? "today" : "d";
            days.appendChild(unit);

            button.appendChild(name);
            button.appendChild(days);
            item.appendChild(button);
            listEl.appendChild(item);
        });
    }

    /* ----------------------------------------------------------------- render */
    function renderAll() {
        renderMap(state.year);
        renderTimeline(state.year);
        renderMoments(state.year);
        renderFuture();
    }

    /* ------------------------------------------------------- the interactive world */
    var globeButton = document.getElementById("globeButton");

    function openWorld(event) {
        if (!window.LoveStoryGlobe) return;
        if (event) event.preventDefault();
        window.LoveStoryGlobe.open(globeButton);
    }

    /* The small globe opens the world in place, which is the nicer gesture.
       The "Memory Map" foot is a real destination and goes to the full page —
       it used to hijack the click and open the overlay instead. */
    if (globeButton) globeButton.addEventListener("click", openWorld);

    /* ------------------------------------------------------------------- menu */
    var menu = document.getElementById("hubMenu");
    var menuButton = document.getElementById("hubMenuButton");
    var menuClose = document.getElementById("hubMenuClose");

    /* Closing the menu hands focus back to the trigger, which the browser
       treats as keyboard focus and answers with a focus ring — a rectangle
       left sitting on the header after an ordinary mouse click. The ring is
       right for somebody who tabbed here and wrong for somebody who clicked,
       so the gesture is remembered for exactly one restore. */
    var menuOpenedWithPointer = false;

    if (menuButton) {
        menuButton.addEventListener("pointerdown", function () {
            menuOpenedWithPointer = true;
        });
        menuButton.addEventListener("keydown", function () {
            menuOpenedWithPointer = false;
        });
        menuButton.addEventListener("blur", function () {
            menuButton.classList.remove("is-quiet-focus");
        });
    }

    function openMenu() {
        if (!menu) return;
        /* Looking at the archive's activity is what "read" means. */
        if (auth && auth.isEditor()) {
            fetch(apiBase() + "/api/notifications/mark-read",
                  { method: "POST", credentials: "include" })
                .then(renderUnread, function () {});
        }
        menu.hidden = false;
        if (menuButton) menuButton.setAttribute("aria-expanded", "true");
        if (menuClose) menuClose.focus();
    }

    function closeMenu() {
        if (!menu) return;
        menu.hidden = true;
        if (menuButton) {
            menuButton.setAttribute("aria-expanded", "false");
            if (menuOpenedWithPointer) menuButton.classList.add("is-quiet-focus");
            menuButton.focus();
        }
    }

    if (menuButton) menuButton.addEventListener("click", openMenu);
    if (menuClose) menuClose.addEventListener("click", closeMenu);

    if (menu) {
        menu.addEventListener("click", function (event) {
            if (event.target === menu) closeMenu();
        });
    }

    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        if (menu && !menu.hidden) closeMenu();
        clearActiveEvent();
    });

    /* ------------------------------------------------------- touch behaviour */
    /* Without hover, the first tap opens and the second one follows. */
    var momentsModule = pick(".module--moments");

    if (!canHover && momentsModule) {
        momentsModule.addEventListener("click", function (event) {
            if (!(event.target instanceof Element)) return;
            if (event.target.closest(".module__foot")) return;
            if (momentsModule.classList.contains("is-expanded")) return;

            momentsModule.classList.add("is-expanded");
            if (event.target.closest(".stack__photo")) event.preventDefault();
        });
    }

    /* ---------------------------------------------------------------------
       Pointer parallax. The environment drifts a few pixels against the
       pointer; typography never moves. Desktop only, motion permitted only.
       --------------------------------------------------------------------- */
    (function parallax() {
        if (!canHover || reducedMotion) return;

        var MAX = 6;
        var pointerX = 0;
        var pointerY = 0;
        var ticking = false;

        window.addEventListener("pointermove", function (event) {
            pointerX = (event.clientX / window.innerWidth) * 2 - 1;
            pointerY = (event.clientY / window.innerHeight) * 2 - 1;

            if (ticking) return;
            ticking = true;

            window.requestAnimationFrame(function () {
                ticking = false;
                document.body.style.setProperty("--px", (pointerX * -MAX).toFixed(2) + "px");
                document.body.style.setProperty("--py", (pointerY * -MAX).toFixed(2) + "px");
            });
        });
    })();

    /* -------------------------------------------------------- recent activity
       Read-only, and public: a guest sees the same list. Each line that names a
       memory opens it in the Library, through the one route helper. */
    function renderActivity() {
        var box = document.getElementById("hubActivity");
        if (!box) return;

        fetch(apiBase() + "/api/activities?limit=4")
            .then(function (r) { return r.ok ? r.json() : { activities: [] }; })
            .then(function (body) {
                var items = (body && body.activities) || [];
                box.textContent = "";
                if (!items.length) {
                    var empty = document.createElement("li");
                    empty.className = "activity-list__empty";
                    empty.textContent = "Nothing yet";
                    box.appendChild(empty);
                    return;
                }
                items.forEach(function (item) {
                    box.appendChild(activityLine(item));
                });
            })
            .catch(function () {
                box.textContent = "";
            });
    }

    function apiBase() {
        return (window.LoveStoryApi && window.LoveStoryApi.BASE) ||
               (window.LoveStoryConfig && window.LoveStoryConfig.API_BASE) || "";
    }

    /* "Jianshuo added a memory / The First Trip · 12 min ago" */
    function activityLine(item) {
        var li = document.createElement("li");
        li.className = "activity-list__item";

        var verb = document.createElement("span");
        verb.className = "activity-list__verb";
        var who = (item.actor && item.actor.displayName) || "Someone";
        /* The stored type names are the ones the log has always used, and they
           are kept: the archive's history is not rewritten because the
           vocabulary changed. The words on screen are the current ones, and
           they are about a SPACE rather than about a partner — a group of
           twelve invites a member the same way a space of two does. */
        var what = item.type === "memory_created" ? "added a memory"
                 : item.type === "memory_updated" ? "edited a memory"
                 : item.type === "memory_deleted" ? "removed a memory"
                 : item.type === "partner_joined" ? "joined the space"
                 : item.type === "partner_invited" ? "invited someone"
                 : item.type === "partner_invite_revoked" ? "withdrew an invitation"
                 : item.type === "join_requested" ? "asked to join"
                 : item.type === "join_request_approved" ? "let somebody in"
                 : item.type === "join_request_declined" ? "turned somebody down"
                 : item.type === "role_promoted" ? "made somebody an admin"
                 : item.type === "role_demoted" ? "made somebody a member"
                 : item.type === "member_removed" ? "removed somebody"
                 : item.type === "owner_created" ? "set up the archive"
                 : "made a change";
        verb.textContent = who + " " + what;

        var when = document.createElement("span");
        when.className = "activity-list__when";
        when.textContent = relativeTime(item.createdAt);

        if (item.memory && item.memory.id && window.LoveStoryRoutes) {
            var link = document.createElement("a");
            link.className = "activity-list__memory";
            link.href = window.LoveStoryRoutes.memory(item.memory.id);
            link.textContent = item.memory.title || "a memory";
            li.appendChild(verb);
            li.appendChild(link);
        } else if (item.metadata && item.metadata.memoryTitle) {
            /* A removed memory has no page left to open, so the title is said
               plainly — it is still worth knowing which one it was. */
            var gone = document.createElement("span");
            gone.className = "activity-list__memory activity-list__memory--gone";
            gone.textContent = item.metadata.memoryTitle;
            li.appendChild(verb);
            li.appendChild(gone);
        } else {
            li.appendChild(verb);
        }
        li.appendChild(when);
        return li;
    }

    function relativeTime(iso) {
        if (!iso) return "";
        var then = Date.parse(iso);
        if (isNaN(then)) return "";
        var mins = Math.round((Date.now() - then) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return mins + " min ago";
        var hours = Math.round(mins / 60);
        if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
        var days = Math.round(hours / 24);
        if (days === 1) return "Yesterday";
        if (days < 30) return days + " days ago";
        return formatDate(iso.slice(0, 10));
    }

    /* The unread marker is for editors only, and is muted gold — never red. */
    function renderUnread() {
        var badge = document.getElementById("hubUnread");
        if (!badge) return;
        if (!auth || !auth.isEditor()) { badge.hidden = true; return; }

        fetch(apiBase() + "/api/notifications/status", { credentials: "include" })
            .then(function (r) { return r.ok ? r.json() : { unread: 0 }; })
            .then(function (body) {
                var n = (body && body.unread) || 0;
                badge.hidden = n === 0;
                badge.textContent = n ? "\u00b7 " + n : "";
            })
            .catch(function () { badge.hidden = true; });
    }

    /* ------------------------------------------------------- private archive
       The sixth module says two things and nothing else: whether a privacy
       password exists, and whether this sign-in has the archive open.

       Never a count, a title, a date or a cover. The status endpoint is
       explicitly allowed to be asked while the archive is closed — it is the
       question "is it locked", which is not about what is inside it — and it
       deliberately does not extend the unlock, so asking it on every page load
       costs the private archive nothing.

       While it IS open, the module offers LOCK. That is the whole point of
       putting it here: somebody about to lend their laptop does not have to
       open the private archive in order to close it again. There is deliberately
       no unlock on the Hub — a password field in the middle of Our Space would
       be the loudest thing in the room, and the archive page is one click away. */
    function renderPrivateState() {
        var state = document.querySelector("[data-private-state]");
        var action = document.querySelector("[data-private-action]");
        var lock = document.getElementById("hubPrivateLock");
        if (!state || !window.LoveStoryPrivacy) return;

        if (lock && !lock.dataset.bound) {
            lock.dataset.bound = "1";
            lock.addEventListener("click", quickLock);
        }

        window.LoveStoryPrivacy.status().then(function (next) {
            if (!next.configured) {
                state.textContent = "Not set up";
                if (action) action.textContent = "Set up";
                if (lock) lock.hidden = true;
                return;
            }
            if (!next.unlocked) {
                state.textContent = "Locked";
                if (action) action.textContent = "Open";
                if (lock) lock.hidden = true;
                return;
            }
            state.textContent = "Open";
            if (action) action.textContent = "Open";
            if (lock) {
                lock.hidden = false;
                lock.disabled = false;
                lock.innerHTML = "Lock <span aria-hidden=\"true\">\u2192</span>";
            }
        });
    }

    /* Close the private archive from the Hub, in one click.

       privacy.js owns the lock: it tells the server, then tells everything in
       this document that was holding a private memory to let go of it. The
       module redraws from the answer rather than assuming it worked. */
    function quickLock(event) {
        if (event) event.preventDefault();
        var button = document.getElementById("hubPrivateLock");
        if (!button || button.disabled) return;

        button.disabled = true;
        button.textContent = "Locking\u2026";

        window.LoveStoryPrivacy.lock().then(function () {
            renderPrivateState();
        }, function () {
            /* The server could not be reached, so the page must not claim the
               archive is closed. privacy.js has cleared the local state anyway;
               the module asks again rather than guessing. */
            window.LoveStoryPrivacy.forget();
            renderPrivateState();
        });
    }

    /* --------------------------------------------------------------- profile
       The Profile drawer and the Notification Center are both components; the
       Hub supplies only their markup and where they hang. */
    if (window.LoveStoryAccount) {
        window.LoveStoryAccount.bind({
            button: "hubAccountButton",
            name: "hubAccountName",
            title: "hubAccountTitle",
            panel: "hubAccountPanel",
            body: "hubAccountBody",
            close: "hubAccountClose",
            scrim: "hubAccountScrim",
            signOut: "hubAccountSignOut"
        });
    }

    if (window.LoveStoryNotifications) {
        window.LoveStoryNotifications.bind({
            button: "hubBellButton",
            dot: "hubBellDot",
            panel: "hubNotificationsPanel",
            body: "hubNotificationsBody",
            scrim: "hubNotificationsScrim"
        });
    }

    /* ---------------------------------------------------------------- guard
       Where does this visitor belong? Asked before anything is drawn, and
       answered by the server. A guest is sent to the Entrance; anybody signed
       in belongs here, because every account is in a space — its own, if
       nothing else. There is no matching to complete first. */
    if (window.LoveStoryEntry) {
        window.LoveStoryEntry.guard().then(function (state) {
            /* Not allowed: the guard has already sent them somewhere else, and
               nothing was fetched in the meantime. Asking the API for a
               private archive we are not going to show would only produce a
               row of error states on the way out. */
            if (window.LoveStoryEntry.mayEnterHub(state)) start();
        });
    } else {
        start();
    }

    /* -------------------------------------------------------------------- go */
    /* One fetch for the whole page. Every module below reads the same store, so
       nothing draws before the archive has answered — and nothing draws seed
       data or a stale browser copy in the meantime. */
    function start() {
    renderMiniGlobe();
    renderActivity();
    renderPrivateState();
    if (auth && auth.ready) {
        auth.ready.then(renderUnread, renderUnread);
    }

    /* The countdown draws once with the dates and once more when the answer
       about who is looking arrives. The two are separate requests and either
       can land first: without this, an editor who happens to load the page
       while the dates arrive first is never told they may add one. */
    document.addEventListener("lovestory:auth-changed", renderUpcoming);

    data.loadMemories().then(function () {
        renderYears();
        renderAll();
        renderUpcoming();
        renderActivity();
    });

    /* The plans are a second collection with a second store. The module draws
       the moment anything arrives, and is told when the store is loading or
       has failed so it never keeps showing a stale list as if it were
       current. */
    if (window.LoveStoryPlans) {
        window.LoveStoryPlans.onChange(renderFuture);
        window.LoveStoryPlans.load();
    }

    /* Anniversaries are a third. They drive two things here: the countdown,
       which is theirs alone, and the Timeline, which they share with the
       memories.

       They do NOT add a year to the selector. A year is offered when this space
       has a memory in it and for no other reason; an anniversary in a year with
       no memory is drawn on the line in the ALL view and is not a filter of its
       own. The selector is still rebuilt here, because the reconciliation it
       performs costs nothing and keeps one path rather than two. */
    if (window.LoveStoryAnniversaries) {
        window.LoveStoryAnniversaries.onChange(function () {
            renderYears();
            renderUpcoming();
            renderAll();
        });
        window.LoveStoryAnniversaries.load();
    }

    }

    /* A small hook so future pages (or the CRUD screens) can drive the same
       state instead of inventing their own. */
    window.LoveStoryHub = {
        get year() { return state.year; },
        setYear: selectYear,
        refresh: function () {
            renderMiniGlobe();
            /* A memory can invent a year, so the selector is rebuilt too. */
            renderYears();
            renderAll();
            renderUpcoming();
        }
    };
})();
