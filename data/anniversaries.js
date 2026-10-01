/* ==========================================================================
   LoveStory — shared anniversary data

   An anniversary is NOT a memory. It is a date that comes round every year:
   the day our story began, the day we met, the day we moved in. It is
   created on purpose by one of the two people who own this archive.

   This file exists because of a bug. The Hub used to build its "Next
   Anniversary" module out of memories — any memory marked for the Timeline
   had its date treated as an anniversary, so a Tuesday afternoon of
   snorkelling sat in the Anniversary module counting down to next year. Two
   unrelated ideas had been fused into one list.

   They are separate now, all the way down: a separate table, a separate API,
   a separate store, and no code path from a memory to an anniversary.

   A record, as this module hands it out:

     id             "anniversary-<n>" — namespaced against every other id
     backendId      the integer the API knows it by
     title          "Our Day"
     originalDate   "2025-10-14" — the one stored fact
     note           free text, may be ""
     createdBy / updatedBy / updatedAt / createdAt

   and, computed fresh on every read, never stored:

     nextDate       the next time this date comes round
     nextNumber     which anniversary that will be (0 = the original date)
     nextLabel      "2ND ANNIVERSARY", or "" for the original date
     daysRemaining  0 means today
     completed      [{ year, date, number }], newest first
     completedCount how many have already come round

   Only `originalDate` is a fact. Everything else is a question about today,
   so it is answered today — every time it is asked. A stored `days_remaining`
   would be wrong by tomorrow morning, and a stored "next date" would survive
   the editing of the very date it was derived from.

   Dates are handled in two pieces, deliberately:

     · a stored date is parsed by hand and kept in UTC, so 2025-10-14 is the
       14th everywhere and not the 13th for anyone west of Greenwich;
     · "today" is the reader's own local date, so the countdown matches the
       calendar on the wall in front of them and never moves by a day at
       midnight UTC.
   ========================================================================== */

(function (global) {
    "use strict";

    var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    var MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November",
                       "December"];

    /* ------------------------------------------------------------- dates */

    function parseDay(iso) {
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
        if (!match) return null;

        var date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
        if (date.getUTCFullYear() !== +match[1] ||
            date.getUTCMonth() !== +match[2] - 1 ||
            date.getUTCDate() !== +match[3]) return null;

        return date;
    }

    function isDay(iso) { return parseDay(iso) !== null; }

    function isoOf(date) { return date.toISOString().slice(0, 10); }

    /* Today where the reader is, not where the server is. */
    function todayIso(now) {
        var date = now ? new Date(now) : new Date();
        var month = String(date.getMonth() + 1).padStart(2, "0");
        var day = String(date.getDate()).padStart(2, "0");
        return date.getFullYear() + "-" + month + "-" + day;
    }

    function isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }

    function daysBetween(fromIso, toIso) {
        var from = parseDay(fromIso);
        var to = parseDay(toIso);
        if (!from || !to) return null;
        return Math.round((to - from) / 86400000);
    }

    /* The parts of a stored date, without a timezone attached to any of them. */
    function parts(iso) {
        var date = parseDay(iso);
        if (!date) return null;
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            short: MONTHS[date.getUTCMonth()],
            long: MONTHS_LONG[date.getUTCMonth()]
        };
    }

    /* The day this date falls on in a given year.

       The 29th of February is the one date that does not exist every year.
       In a common year it is observed on the 28th: a leap-day anniversary is
       a day late by at most one day, never a crash and never skipped. */
    function occurrenceIn(year, month, day) {
        var on = day;
        if (month === 2 && day === 29 && !isLeapYear(year)) on = 28;
        return isoOf(new Date(Date.UTC(year, month - 1, on)));
    }

    /* The next time this date comes round, counting today as still to come —
       an anniversary that is today is today's, not last year's. */
    function nextOccurrence(originalDate, today) {
        var p = parts(originalDate);
        if (!p) return null;

        var from = today || todayIso();

        /* A date that has not happened yet is simply itself. It is nobody's
           first anniversary; it has not come round once. */
        if (originalDate >= from) {
            return {
                date: originalDate,
                year: p.year,
                number: 0,
                daysRemaining: daysBetween(from, originalDate)
            };
        }

        var year = Number(from.slice(0, 4));
        var candidate = occurrenceIn(year, p.month, p.day);
        if (candidate < from) candidate = occurrenceIn(year + 1, p.month, p.day);

        var candidateYear = Number(candidate.slice(0, 4));
        return {
            date: candidate,
            year: candidateYear,
            /* How many years have passed since the original date. This is the
               anniversary's number, and it is why 14 OCT 2026 is the 1ST
               anniversary of 14 OCT 2025 rather than the 0th. */
            number: candidateYear - p.year,
            daysRemaining: daysBetween(from, candidate)
        };
    }

    /* Every occurrence that has already come round, newest first.

       The original date itself is not among them: it is the start, not a
       first anniversary. A date that has not yet come round once has no
       history at all, and the list is empty rather than fabricated. */
    function completedOccurrences(originalDate, today) {
        var p = parts(originalDate);
        if (!p) return [];

        var from = today || todayIso();
        if (originalDate >= from) return [];

        var out = [];
        var thisYear = Number(from.slice(0, 4));

        /* Counting down from this year gives newest first for nothing. */
        for (var year = thisYear; year > p.year; year--) {
            var date = occurrenceIn(year, p.month, p.day);
            if (date < from) {
                out.push({ year: year, date: date, number: year - p.year });
            }
        }

        return out;
    }

    /* --------------------------------------------------------- formatting */

    /* 1ST, 2ND, 3RD, 4TH … 11TH, 12TH, 13TH … 21ST, 22ND, 23RD …
       The teens are the whole reason this is a function. */
    function ordinal(number) {
        var value = Math.abs(Number(number) || 0);
        var tens = value % 100;
        var suffix = "TH";

        if (tens < 11 || tens > 13) {
            var last = value % 10;
            if (last === 1) suffix = "ST";
            else if (last === 2) suffix = "ND";
            else if (last === 3) suffix = "RD";
        }

        return value + suffix;
    }

    /* "2ND ANNIVERSARY". Empty for the original date, which is a beginning
       and not an anniversary of itself. */
    function anniversaryLabel(number) {
        var value = Number(number) || 0;
        if (value < 1) return "";
        return ordinal(value) + " ANNIVERSARY";
    }

    /* "14 OCT 2025" — the year is always said, because an anniversary is
       exactly the thing where the year is the point. */
    function formatShort(iso) {
        var p = parts(iso);
        if (!p) return "";
        return p.day + " " + p.short + " " + p.year;
    }

    /* "14 October 2025" — the form that reads as a sentence. */
    function formatLong(iso) {
        var p = parts(iso);
        if (!p) return "";
        return p.day + " " + p.long + " " + p.year;
    }

    function formatMonthDay(iso) {
        var p = parts(iso);
        if (!p) return "";
        return p.day + " " + p.short;
    }

    /* "16 DAYS" — and "TODAY" on the day itself, never "0 DAYS". */
    function daysLabel(days) {
        var count = Math.max(0, Number(days) || 0);
        if (count === 0) return "TODAY";
        return count + (count === 1 ? " DAY" : " DAYS");
    }

    /* "in 16 days" / "today" — for a sentence rather than a readout. */
    function daysPhrase(days) {
        var count = Math.max(0, Number(days) || 0);
        if (count === 0) return "today";
        return "in " + count + (count === 1 ? " day" : " days");
    }

    /* ----------------------------------------------------------- decorate */

    /* The stored facts plus today's answers about them. Computed on every
       read, so a page left open overnight is right again in the morning, and
       editing a date can never leave a stale next-date behind. */
    function decorate(record, today) {
        var from = today || todayIso();
        var next = nextOccurrence(record.originalDate, from);
        var done = completedOccurrences(record.originalDate, from);

        return Object.assign({}, record, {
            nextDate: next ? next.date : "",
            nextYear: next ? next.year : null,
            nextNumber: next ? next.number : 0,
            nextLabel: next ? anniversaryLabel(next.number) : "",
            daysRemaining: next ? next.daysRemaining : null,
            isToday: !!next && next.daysRemaining === 0,
            completed: done,
            completedCount: done.length
        });
    }

    /* The past occurrences of any date, for a record that has not been
       decorated (the detail view of one fetched by id, for instance). */
    function history(originalDate, today) {
        return completedOccurrences(originalDate, today).map(function (entry) {
            return Object.assign({}, entry, { label: anniversaryLabel(entry.number) });
        });
    }

    /* --------------------------------------------------------------- store */

    var state = {
        items: [],
        /* "idle" before the first load, then "loading" | "ready" | "error". */
        status: "idle",
        error: ""
    };

    var listeners = [];
    var inFlight = null;

    function api() { return global.LoveStoryApi || null; }

    function notify() {
        listeners.slice().forEach(function (listener) {
            try { listener(state); } catch (error) { console.error(error); }
        });
    }

    function onChange(listener) {
        listeners.push(listener);
        return function () {
            listeners = listeners.filter(function (item) { return item !== listener; });
        };
    }

    function setItems(items) {
        state.items = items || [];
        notify();
        return state.items;
    }

    /* Every anniversary, decorated for today. Asked afresh each time rather
       than cached, so "16 days" is 16 and not yesterday's 17. */
    function all(today) {
        return state.items.map(function (record) {
            return decorate(record, today);
        });
    }

    /* Soonest first: the anniversary that is nearest is the one that matters.
       Ties broken by id, so the order never flickers between two reads. */
    function upcoming(today) {
        return all(today).sort(function (a, b) {
            if (a.nextDate !== b.nextDate) return a.nextDate < b.nextDate ? -1 : 1;
            return (a.backendId || 0) - (b.backendId || 0);
        });
    }

    /* The one the Hub counts down to. */
    function next(today) {
        return upcoming(today)[0] || null;
    }

    /* The ones after it, for the quiet list underneath. */
    function following(count, today) {
        var list = upcoming(today).slice(1);
        return typeof count === "number" ? list.slice(0, count) : list;
    }

    function byId(id, today) {
        var wanted = String(id || "");
        var found = state.items.filter(function (record) {
            return record.id === wanted ||
                   String(record.backendId) === wanted.replace(/^anniversary-/, "");
        })[0];
        return found ? decorate(found, today) : null;
    }

    /* Read them from the server. The Hub and the page both ask on load, so
       concurrent callers share one request. */
    function load(options) {
        var force = !!(options && options.force);
        var client = api();

        if (inFlight && !force) return inFlight;

        if (!client || typeof client.listAnniversaries !== "function") {
            state.status = "error";
            state.error = "The archive is not reachable.";
            notify();
            return Promise.resolve(state.items);
        }

        state.status = "loading";
        state.error = "";
        notify();

        inFlight = client.listAnniversaries().then(function (items) {
            inFlight = null;
            state.status = "ready";
            state.error = "";
            return setItems(items);
        }, function (error) {
            inFlight = null;
            state.status = "error";
            state.error = (error && error.message) || "The dates could not be read.";
            notify();
            return state.items;
        });

        return inFlight;
    }

    /* The three writes update the local list from the server's own answer,
       never from what we hoped it stored. */
    function create(input) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));

        return client.createAnniversary(input).then(function (record) {
            state.items = state.items.concat([record]);
            state.status = "ready";
            notify();
            return record;
        });
    }

    function update(id, input) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));

        return client.updateAnniversary(id, input).then(function (record) {
            state.items = state.items.map(function (existing) {
                return existing.id === record.id ? record : existing;
            });
            state.status = "ready";
            notify();
            return record;
        });
    }

    function remove(id) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));
        var target = state.items.filter(function (record) {
            return record.id === id || String(record.backendId) === String(id);
        })[0];
        var key = target ? target.id : id;

        return client.removeAnniversary(id).then(function (result) {
            state.items = state.items.filter(function (record) {
                return record.id !== key;
            });
            notify();
            return result;
        });
    }

    global.LoveStoryAnniversaries = {
        /* dates */
        isDay: isDay,
        todayIso: todayIso,
        isLeapYear: isLeapYear,
        occurrenceIn: occurrenceIn,
        nextOccurrence: nextOccurrence,
        completedOccurrences: completedOccurrences,
        history: history,

        /* formatting */
        ordinal: ordinal,
        anniversaryLabel: anniversaryLabel,
        formatShort: formatShort,
        formatLong: formatLong,
        formatMonthDay: formatMonthDay,
        daysLabel: daysLabel,
        daysPhrase: daysPhrase,
        decorate: decorate,

        /* store */
        load: load,
        onChange: onChange,
        all: all,
        upcoming: upcoming,
        next: next,
        following: following,
        byId: byId,
        create: create,
        update: update,
        remove: remove,
        get count() { return state.items.length; },
        get status() { return state.status; },
        get error() { return state.error; }
    };
})(window);
