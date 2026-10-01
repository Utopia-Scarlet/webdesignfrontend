/* ==========================================================================
   LoveStory — shared plan data

   "Plan the Future" is the one part of the archive that looks forwards. A
   plan is deliberately NOT a memory: it has a date *range* rather than a
   single day, an itinerary of days, and no photographs. It gets its own
   record and its own store rather than being forced into the memory shape.

   A plan record (the shape this module hands out):
     id             "plan-<n>" — namespaced, so a numeric id from the memory
                    collection can never be mistaken for a plan
     backendId      the integer the API knows it by
     title          string
     location       free text ("Tokyo, Japan")
     description    the overall plan
     startDate      "YYYY-MM-DD"
     endDate        "YYYY-MM-DD"
     duration       inclusive day count — the 12th to the 18th is seven days
     status         "upcoming" | "completed"
     transportation / accommodation / notes   optional, may be ""
     days           [{ dayNumber, date, activities: [{ id, text }] }]
     createdBy / updatedBy / updatedAt / createdAt

   Two rules are load-bearing and are implemented exactly once, here:

     · DURATION IS NEVER STORED. It is `endDate - startDate + 1`, inclusive.
       A stored duration is a second source of truth, and the day it disagrees
       with the dates is the day the page starts lying.

     · STATUS IS NEVER STORED. "Upcoming" means its last day is today or
       later; anything whose last day has passed is "completed". Deriving it
       from today's date means a plan moves from one list to the other on its
       own, with nothing to run and nothing to remember to update.

   The days of an itinerary are generated from the range too: day N falls on
   start + (N − 1). The server does the same when it stores them, so a day can
   never be dated inconsistently with the plan it belongs to.

   The backend is the only source of truth. Nothing here writes to
   localStorage: a plan is shared, so it lives where both people can see it.
   ========================================================================== */

(function (global) {
    "use strict";

    /* ------------------------------------------------------------- dates */

    var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    var MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November",
                       "December"];

    /* A date is parsed by hand and kept in UTC. `new Date("2027-01-12")` is
       midnight UTC, which is still the 11th for anyone west of Greenwich —
       a plan that starts a day early in California is exactly the kind of
       quiet wrongness this whole file exists to prevent. */
    function parseDay(iso) {
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
        if (!match) return null;

        var date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
        /* Rejects 2027-02-30 and friends, which Date would otherwise roll. */
        if (date.getUTCFullYear() !== +match[1] ||
            date.getUTCMonth() !== +match[2] - 1 ||
            date.getUTCDate() !== +match[3]) return null;

        return date;
    }

    function isDay(iso) { return parseDay(iso) !== null; }

    function isoOf(date) { return date.toISOString().slice(0, 10); }

    /* Today, in the reader's own timezone — the day it is where they are is
       the day that decides whether a trip has happened. */
    function todayIso(now) {
        var date = now ? new Date(now) : new Date();
        var month = String(date.getMonth() + 1).padStart(2, "0");
        var day = String(date.getDate()).padStart(2, "0");
        return date.getFullYear() + "-" + month + "-" + day;
    }

    function addDays(iso, count) {
        var date = parseDay(iso);
        if (!date) return "";
        return isoOf(new Date(date.getTime() + (count || 0) * 86400000));
    }

    /* Inclusive: the 12th to the 18th is 7, not 6. A range that ends before
       it starts has no duration at all, so it is 0 rather than a negative. */
    function duration(startDate, endDate) {
        var start = parseDay(startDate);
        var end = parseDay(endDate);
        if (!start || !end) return 0;
        return Math.max(0, Math.round((end - start) / 86400000) + 1);
    }

    /* Upcoming while its last day is today or later. A trip that is happening
       right now is upcoming, not completed. */
    function statusOf(endDate, today) {
        var end = parseDay(endDate);
        if (!end) return "upcoming";
        return isoOf(end) >= (today || todayIso()) ? "upcoming" : "completed";
    }

    /* Every date in the range, inclusive — the itinerary's skeleton. */
    function rangeDays(startDate, endDate) {
        var total = duration(startDate, endDate);
        var days = [];
        for (var index = 0; index < total; index++) {
            days.push({ dayNumber: index + 1, date: addDays(startDate, index) });
        }
        return days;
    }

    function daysUntil(iso, today) {
        var from = parseDay(today || todayIso());
        var to = parseDay(iso);
        if (!from || !to) return null;
        return Math.round((to - from) / 86400000);
    }

    /* ---------------------------------------------------------- formatting */

    function parts(iso) {
        var date = parseDay(iso);
        if (!date) return null;
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth(),
            day: date.getUTCDate(),
            short: MONTHS[date.getUTCMonth()],
            long: MONTHS_LONG[date.getUTCMonth()]
        };
    }

    /* "12 JAN 2027" — the small, quiet form: a day line, a list row. */
    function formatShort(iso) {
        var p = parts(iso);
        if (!p) return "";
        return p.day + " " + p.short + " " + p.year;
    }

    /* "12 January 2027" — the form that reads as a sentence. */
    function formatLong(iso) {
        var p = parts(iso);
        if (!p) return "";
        return p.day + " " + p.long + " " + p.year;
    }

    /* "Day 1 · 12 JAN 2027" — how one itinerary day announces itself. */
    function formatDayLabel(dayNumber, iso) {
        var written = formatShort(iso);
        return written ? "DAY " + dayNumber + " · " + written
                       : "DAY " + dayNumber;
    }

    /* The range, written as one editorial line. Three cases, because the
       year and the month are worth saying once, not twice:
           12 — 18 JAN 2027
           28 NOV — 04 DEC 2027
           28 DEC 2026 — 04 JAN 2027
       A single-day plan is just that day. */
    function formatRange(startDate, endDate) {
        var start = parts(startDate);
        var end = parts(endDate);

        if (!start && !end) return "";
        if (!start) return formatShort(endDate);
        if (!end) return formatShort(startDate);

        var first = String(start.day).padStart(2, "0");
        var last = String(end.day).padStart(2, "0");

        if (start.year === end.year && start.month === end.month) {
            if (start.day === end.day) return first + " " + start.short + " " + start.year;
            return first + " — " + last + " " + start.short + " " + start.year;
        }

        if (start.year === end.year) {
            return first + " " + start.short + " — " + last + " " + end.short +
                   " " + start.year;
        }

        return first + " " + start.short + " " + start.year + " — " +
               last + " " + end.short + " " + end.year;
    }

    /* "7 days" / "1 day" — never "7 day". */
    function formatDuration(count) {
        var total = Number(count) || 0;
        return total + (total === 1 ? " day" : " days");
    }

    /* How far off a plan is, in words a person would use. */
    function countdown(startDate, today) {
        var away = daysUntil(startDate, today);
        if (away === null) return "";
        if (away < 0) return "";
        if (away === 0) return "TODAY";
        if (away === 1) return "TOMORROW";
        return "IN " + away + " DAYS";
    }

    /* --------------------------------------------------------------- store */

    var state = {
        plans: [],
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

    function setPlans(plans) {
        state.plans = plans || [];
        notify();
        return state.plans;
    }

    function sorted() {
        return state.plans.slice();
    }

    /* Soonest first. A plan still to come is read as a queue. */
    function upcoming() {
        return sorted()
            .filter(function (plan) { return plan.status === "upcoming"; })
            .sort(function (a, b) {
                if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
                return (a.backendId || 0) - (b.backendId || 0);
            });
    }

    /* Most recently finished first. What we have just done is the thing we
       are most likely to want to look at. */
    function completed() {
        return sorted()
            .filter(function (plan) { return plan.status === "completed"; })
            .sort(function (a, b) {
                if (a.endDate !== b.endDate) return a.endDate < b.endDate ? 1 : -1;
                return (b.backendId || 0) - (a.backendId || 0);
            });
    }

    function byId(id) {
        var wanted = String(id || "");
        return state.plans.filter(function (plan) {
            return plan.id === wanted || String(plan.backendId) === wanted.replace(/^plan-/, "");
        })[0] || null;
    }

    /* Read the plans from the server. Concurrent callers share one request —
       the Hub and the page itself both ask on load, and two round trips for
       the same list would be two chances to disagree. */
    function load(options) {
        var force = !!(options && options.force);
        var client = api();

        if (inFlight && !force) return inFlight;

        if (!client || typeof client.listPlans !== "function") {
            state.status = "error";
            state.error = "The archive is not reachable.";
            notify();
            return Promise.resolve(state.plans);
        }

        state.status = "loading";
        state.error = "";
        notify();

        inFlight = client.listPlans().then(function (plans) {
            inFlight = null;
            state.status = "ready";
            state.error = "";
            return setPlans(plans);
        }, function (error) {
            inFlight = null;
            state.status = "error";
            state.error = (error && error.message) || "The plans could not be read.";
            notify();
            return state.plans;
        });

        return inFlight;
    }

    /* The three writes all funnel through here so the local list is updated
       from the server's own answer, never from what we hoped it would store. */
    function create(input) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));

        return client.createPlan(input).then(function (plan) {
            state.plans = state.plans.concat([plan]);
            state.status = "ready";
            notify();
            return plan;
        });
    }

    function update(id, input) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));

        return client.updatePlan(id, input).then(function (plan) {
            state.plans = state.plans.map(function (existing) {
                return existing.id === plan.id ? plan : existing;
            });
            state.status = "ready";
            notify();
            return plan;
        });
    }

    function remove(id) {
        var client = api();
        if (!client) return Promise.reject(new Error("The archive is not reachable."));
        var target = byId(id);
        var key = target ? target.id : id;

        return client.removePlan(id).then(function (result) {
            state.plans = state.plans.filter(function (plan) { return plan.id !== key; });
            notify();
            return result;
        });
    }

    global.LoveStoryPlans = {
        /* dates */
        isDay: isDay,
        todayIso: todayIso,
        addDays: addDays,
        duration: duration,
        statusOf: statusOf,
        rangeDays: rangeDays,
        daysUntil: daysUntil,

        /* formatting */
        formatShort: formatShort,
        formatLong: formatLong,
        formatRange: formatRange,
        formatDayLabel: formatDayLabel,
        formatDuration: formatDuration,
        countdown: countdown,

        /* store */
        load: load,
        onChange: onChange,
        upcoming: upcoming,
        completed: completed,
        byId: byId,
        create: create,
        update: update,
        remove: remove,
        get plans() { return sorted(); },
        get status() { return state.status; },
        get error() { return state.error; }
    };
})(window);
