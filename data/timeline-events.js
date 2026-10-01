/* ==========================================================================
   LoveStory — the Timeline's event model

   The Timeline is not a collection. It is a VIEW: one line, drawn from
   whatever the archive holds that has a date. Memories are one source;
   anniversaries are another; anything added later joins the same list without
   the Timeline being rewritten.

       Memories ───────┐
                       │
       Anniversaries ──┼──→ Timeline
                       │
       Future sources ─┘

   Nothing here is stored and there is no timeline_events table, on purpose.
   A date is written down once — in the memory, or in the anniversary — and the
   Timeline is recomputed from it. Editing that date therefore moves the
   Timeline with it, and deleting the record removes its line, with nothing to
   keep in step.

   Every event, from every source, has the same shape:

     type      "memory" | "anniversary"
     id        unique within the Timeline
     date      "YYYY-MM-DD" — what the line is ordered by
     title     what it is called
     subtitle  the small line under it: a place, or "1ST ANNIVERSARY"
     sourceId  the id of the record it came from, for opening it
     year      the year it happened, as a number

   A memory is never dressed up as an anniversary, and an anniversary is never
   dressed up as a memory. The `type` says which it is, and the page draws each
   one its own way.

   Which anniversaries appear:

     · the original date, always — the day it began is a moment in history;
     · every anniversary that has actually come round (strictly before today);
     · never the next one. A countdown belongs to the Anniversary module. An
       event belongs on a Timeline only once it has happened, which is what
       makes the Timeline a history rather than a plan.
   ========================================================================== */

(function (global) {
    "use strict";

    function data() { return global.LoveStoryData || null; }
    function dates() { return global.LoveStoryAnniversaries || null; }

    function today() {
        var store = dates();
        return store ? store.todayIso() : "";
    }

    function isAllYears(year) {
        var store = data();
        return store ? store.isAllYears(year) : year === "all";
    }

    /* ------------------------------------------------------------- memories */

    /* Unchanged rule: a memory joins the Timeline only when it was explicitly
       marked for it. `undefined` and `null` mean "not chosen", not a silent
       yes. */
    function memoryEvents(year) {
        var store = data();
        if (!store || typeof store.timelineMemories !== "function") return [];

        return store.timelineMemories(year).map(function (memory) {
            var place = "";
            try { place = store.placeKey(memory.location); } catch (error) { place = ""; }

            return {
                type: "memory",
                id: "memory:" + memory.id,
                date: memory.date || "",
                title: memory.title || "Untitled memory",
                subtitle: place || "",
                sourceId: memory.id,
                year: memory.year || (memory.date ? Number(memory.date.slice(0, 4)) : null),
                /* Only a memory has these; the preview reads them. */
                memory: memory,
                photos: memory.photos || []
            };
        }).filter(function (event) { return !!event.date; });
    }

    /* --------------------------------------------------------- anniversaries */

    /* Every event one anniversary produces, newest last. The original date and
       the occasions that have since come round — and nothing that has not
       happened yet. */
    function anniversaryEventsFor(record, from) {
        var store = dates();
        if (!store || !record || !record.originalDate) return [];

        var events = [{
            type: "anniversary",
            id: "anniversary:" + record.backendId + ":original",
            date: record.originalDate,
            title: record.title,
            subtitle: "ORIGINAL DATE",
            sourceId: record.id,
            year: Number(String(record.originalDate).slice(0, 4)),
            number: 0,
            record: record
        }];

        store.completedOccurrences(record.originalDate, from).forEach(function (entry) {
            events.push({
                type: "anniversary",
                id: "anniversary:" + record.backendId + ":" + entry.date,
                date: entry.date,
                title: record.title,
                /* "1ST ANNIVERSARY", from the same ordinal function the rest
                   of the site uses, so a 21st is never a 21th. */
                subtitle: store.anniversaryLabel(entry.number),
                sourceId: record.id,
                year: entry.year,
                number: entry.number,
                record: record
            });
        });

        return events;
    }

    function anniversaryEvents(year) {
        var store = dates();
        if (!store || typeof store.all !== "function") return [];

        var from = today();
        var all = store.all(from);
        var wanted = isAllYears(year) ? null : Number(year);
        var out = [];

        all.forEach(function (record) {
            anniversaryEventsFor(record, from).forEach(function (event) {
                if (wanted === null || event.year === wanted) out.push(event);
            });
        });

        return out;
    }

    /* ------------------------------------------------------------ the union */

    /* One list, date ascending. Two events on the same day both survive — a
       memory and an anniversary are different things and neither replaces the
       other. The anniversary is listed first: on a day that is both, the date
       is the frame and the memory is what happened in it. */
    var TYPE_RANK = { anniversary: 0, memory: 1 };

    function events(year) {
        var merged = memoryEvents(year).concat(anniversaryEvents(year));

        merged.sort(function (a, b) {
            if (a.date !== b.date) return a.date < b.date ? -1 : 1;

            var rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
            if (rank) return rank;

            if (a.title !== b.title) return a.title < b.title ? -1 : 1;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });

        return merged;
    }

    /* The years the Timeline can be filtered by: every year a memory happened
       and every year an anniversary fell in. A year that holds only an
       anniversary is still a year of this archive. */
    function years() {
        var seen = Object.create(null);
        var store = data();

        if (store) {
            store.years.forEach(function (year) { seen[year] = true; });
        }

        anniversaryEvents("all").forEach(function (event) {
            if (event.year) seen[event.year] = true;
        });

        return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    }

    /* How many events a year holds, without building the nodes. */
    function count(year) {
        return events(year).length;
    }

    global.LoveStoryTimeline = {
        events: events,
        years: years,
        count: count,
        memoryEvents: memoryEvents,
        anniversaryEvents: anniversaryEvents,
        anniversaryEventsFor: anniversaryEventsFor,
        isAllYears: isAllYears
    };
})(window);
