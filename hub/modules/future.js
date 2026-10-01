/* ==========================================================================
   LoveStory — Plan the Future

   The page behind the Hub's "Plan the Future" module: the index of plans,
   one plan opened, and the sheet that writes them.

   Three things are worth knowing before reading this file:

     · The list is an index, not a gallery. A plan is read the way a
       departure board is read — soonest first — so the rows are numbered
       and ordered by date, never by when they were typed in.

     · Duration and status are never entered and never stored. Both are
       derived by data/future-plans.js from the dates and today's date, so
       the form shows duration as something *read*, and a plan moves from
       Upcoming to Completed on its own when its last day passes.

     · Only an editor sees a way to change anything, and the API refuses a
       write from anyone else regardless. Hiding a button is a courtesy;
       it is not the boundary.

   Depends on ../../data/future-plans.js, api.js and ../../auth.js.
   ========================================================================== */

(function (global) {
    "use strict";

    var Plans = global.LoveStoryPlans;

    var state = {
        view: "upcoming",
        openId: null,
        /* The days the form is holding, so a date change can preserve what
           has already been typed into them. */
        days: [],
        range: { start: "", end: "" },
        editing: null,
        saving: false
    };

    /* DOM that arrives with the page. */
    var ui = {};

    /* The injected sheet and its fields. */
    var sheet = null;
    var fields = {};
    var dayEditor = null;
    var durationValue = null;

    var confirmBox = null;
    var confirmResolve = null;

    var reducedMotion = false;
    try {
        reducedMotion = global.matchMedia &&
            global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (error) { /* no matchMedia: motion is on */ }

    /* ------------------------------------------------------------- helpers */

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

    function today() {
        return Plans && Plans.todayIso ? Plans.todayIso() : "";
    }

    /* ---------------------------------------------------------- permissions */

    /* A guest reads the plans and that is all. There is no disabled state to
       reason about: the controls simply are not there. */
    function isEditor() {
        return !!(global.LoveStoryAuth && global.LoveStoryAuth.isEditor());
    }

    function applyPermissions() {
        var editor = isEditor();

        if (ui.newButton) ui.newButton.hidden = !editor;
        if (ui.editButton) ui.editButton.hidden = !editor || !state.openId;
        if (ui.deleteButton) ui.deleteButton.hidden = !editor || !state.openId;
    }

    /* ------------------------------------------------------------- the list */

    function visiblePlans() {
        return state.view === "completed" ? Plans.completed() : Plans.upcoming();
    }

    function render() {
        if (!ui.list) return;

        if (ui.loading) ui.loading.hidden = Plans.status !== "loading" && Plans.status !== "idle";
        if (ui.error) ui.error.hidden = Plans.status !== "error";

        var plans = visiblePlans();
        var gone = Plans.status === "error";

        if (ui.stats) {
            ui.stats.textContent = gone ? "" : statsLine(plans);
        }

        if (ui.empty) {
            if (!gone && Plans.status !== "loading" && !plans.length) {
                ui.empty.textContent = emptyLine();
                ui.empty.hidden = false;
            } else {
                ui.empty.hidden = true;
            }
        }

        clear(ui.list);

        if (gone || !plans.length) return;
        plans.forEach(function (plan, index) {
            ui.list.appendChild(rowFor(plan, index));
        });
    }

    function statsLine(plans) {
        if (!plans.length) return "";
        var days = plans.reduce(function (total, plan) {
            return total + (plan.duration || 0);
        }, 0);

        return plans.length + (plans.length === 1 ? " plan" : " plans") +
               " · " + days + (days === 1 ? " day" : " days");
    }

    function emptyLine() {
        if (state.view === "completed") {
            return "Nothing completed yet. A plan moves here once its last day has passed.";
        }
        return isEditor()
            ? "Nothing planned yet. Start with + New Plan."
            : "Nothing planned yet.";
    }

    /* One row. The whole row is the target — a plan has no "open" affordance
       to hunt for, and the row is already a single line of reading. */
    function rowFor(plan, index) {
        var item = el("li", "plan-row");
        var button = el("button", "plan-row__button");
        button.type = "button";
        button.setAttribute("data-plan", plan.id);

        button.appendChild(el("span", "plan-row__number"));

        var identity = el("span");
        identity.appendChild(el("span", "plan-row__title", plan.title || "Untitled plan"));
        if (plan.location) {
            identity.appendChild(el("span", "plan-row__where", plan.location));
        }
        button.appendChild(identity);

        var when = el("span", "plan-row__range", Plans.formatRange(plan.startDate, plan.endDate));
        when.appendChild(el("span", "plan-row__meta", metaLine(plan)));
        button.appendChild(when);

        button.addEventListener("click", function () { openPlan(plan.id); });

        item.appendChild(button);
        return item;
    }

    function metaLine(plan) {
        var pieces = [Plans.formatDuration(plan.duration)];

        if (plan.status === "completed") {
            pieces.push("done");
        } else {
            var away = Plans.countdown(plan.startDate, today());
            if (away) pieces.push(away.toLowerCase());
        }

        return pieces.join(" · ");
    }

    /* ----------------------------------------------------------- the detail */

    function openPlan(id) {
        var plan = Plans.byId(id);
        if (!plan) return;

        state.openId = plan.id;
        renderDetail(plan);

        if (!ui.detail) return;
        ui.detail.hidden = false;
        applyPermissions();
        global.requestAnimationFrame(function () {
            ui.detail.classList.add("is-open");
            if (ui.detailScroll) ui.detailScroll.scrollTop = 0;
            if (ui.detailBack && ui.detailBack.focus) ui.detailBack.focus();
        });
    }

    function closePlan() {
        state.openId = null;
        applyPermissions();
        if (!ui.detail) return;

        ui.detail.classList.remove("is-open");
        /* The contents are not cleared on a timer: opening another plan
           before the fade finished would have it wiped out from under the
           reader. renderDetail() clears the archive itself. */
        global.setTimeout(function () { ui.detail.hidden = true; },
            reducedMotion ? 20 : 320);
    }

    function renderDetail(plan) {
        var archive = clear(ui.archive);

        archive.appendChild(el("p",
            "plan-archive__status" + (plan.status === "completed" ? " plan-archive__status--done" : ""),
            plan.status === "completed" ? "Completed" : "Upcoming"));

        archive.appendChild(el("h2", "plan-archive__title", plan.title || "Untitled plan"));
        if (plan.location) {
            archive.appendChild(el("p", "plan-archive__where", plan.location));
        }

        var range = el("p", "plan-archive__range", Plans.formatRange(plan.startDate, plan.endDate));
        range.appendChild(el("span", "plan-archive__duration", detailTiming(plan)));
        archive.appendChild(range);

        if (plan.description) {
            archive.appendChild(section("Overall plan",
                el("p", "plan-archive__prose", plan.description)));
        }

        var facts = factsFor(plan);
        if (facts) archive.appendChild(section("Getting there & staying", facts));

        if (plan.days && plan.days.length) {
            archive.appendChild(section("Daily plan", itinerary(plan)));
        }

        archive.appendChild(el("p", "plan-archive__by", byline(plan)));
    }

    function detailTiming(plan) {
        var pieces = [Plans.formatDuration(plan.duration)];
        if (plan.status === "upcoming") {
            var away = Plans.countdown(plan.startDate, today());
            if (away) pieces.push(away.toLowerCase());
        }
        return pieces.join(" · ");
    }

    function section(label, body) {
        var wrap = el("section", "plan-archive__section");
        wrap.appendChild(el("p", "plan-archive__label", label));
        wrap.appendChild(body);
        return wrap;
    }

    /* Only the parts that were filled in. An empty "Accommodation" row is not
       information — it is the absence of it, and the page can say so by
       leaving it out. */
    function factsFor(plan) {
        var pairs = [
            ["Transportation", plan.transportation],
            ["Accommodation", plan.accommodation],
            ["Notes", plan.notes]
        ].filter(function (pair) { return pair[1]; });

        if (!pairs.length) return null;

        var list = el("dl", "plan-archive__facts");
        pairs.forEach(function (pair) {
            var fact = el("div", "plan-archive__fact");
            fact.appendChild(el("dt", null, pair[0]));
            fact.appendChild(el("dd", null, pair[1]));
            list.appendChild(fact);
        });
        return list;
    }

    function itinerary(plan) {
        var list = el("ol", "itinerary");

        plan.days.forEach(function (day) {
            var item = el("li", "itinerary__day");
            item.appendChild(el("p", "itinerary__label",
                Plans.formatDayLabel(day.dayNumber, day.date)));

            if (day.activities && day.activities.length) {
                var activities = el("ul", "itinerary__activities");
                day.activities.forEach(function (activity) {
                    activities.appendChild(el("li", "itinerary__activity", activity.text));
                });
                item.appendChild(activities);
            } else {
                item.appendChild(el("p", "itinerary__none", "Nothing planned for this day yet."));
            }

            list.appendChild(item);
        });

        return list;
    }

    function byline(plan) {
        var who = plan.createdBy && plan.createdBy.displayName
            ? plan.createdBy.displayName
            : "";
        var text = who ? "Added by " + who : "Added";

        if (plan.updatedBy && plan.updatedBy.displayName) {
            text += " · last edited by " + plan.updatedBy.displayName;
        }

        return text;
    }

    /* ------------------------------------------------------------ the sheet */

    var SHEET_MARKUP = [
        '<div class="sheet" id="planSheet" hidden>',
        '    <button class="sheet__scrim" type="button" id="planSheetScrim" tabindex="-1" aria-label="Close"></button>',
        '',
        '    <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="planSheetTitle">',
        '        <header class="sheet__head">',
        '            <p class="sheet__eyebrow" id="planSheetTitle">New Plan</p>',
        '            <button class="sheet__close" type="button" id="planSheetClose" aria-label="Close">&times;</button>',
        '        </header>',
        '',
        '        <form class="sheet__form" id="planForm" novalidate>',
        '',
        '            <p class="field__hint field__hint--lead" id="planSheetLead">',
        '                A name, a place and the dates. The days of the trip are worked',
        '                out from the dates &mdash; you never type them.',
        '            </p>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">The Plan</h2>',
        '                <label class="field">',
        '                    <span class="field__label">Plan Name <em class="field__req">*</em></span>',
        '                    <input class="field__input" type="text" id="planTitle"',
        '                           maxlength="120" autocomplete="off" placeholder="Winter in Japan">',
        '                    <span class="field__error" id="planTitleError"></span>',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Location <em class="field__req">*</em></span>',
        '                    <input class="field__input" type="text" id="planLocation"',
        '                           maxlength="140" autocomplete="off" placeholder="Tokyo, Japan">',
        '                    <span class="field__error" id="planLocationError"></span>',
        '                </label>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">When</h2>',
        '                <div class="field-row">',
        '                    <label class="field">',
        '                        <span class="field__label">Start <em class="field__req">*</em></span>',
        '                        <input class="field__input" type="date" id="planStart" required',
        '                               min="1900-01-01" max="2099-12-31">',
        '                        <span class="field__error" id="planStartError"></span>',
        '                    </label>',
        '                    <label class="field">',
        '                        <span class="field__label">End <em class="field__req">*</em></span>',
        '                        <input class="field__input" type="date" id="planEnd" required',
        '                               min="1900-01-01" max="2099-12-31">',
        '                        <span class="field__error" id="planEndError"></span>',
        '                    </label>',
        '                </div>',
        '                <div class="plan-duration" id="planDurationBox">',
        '                    <span class="plan-duration__value" id="planDurationValue">&mdash;</span>',
        '                    <span class="plan-duration__note">from the dates, inclusive</span>',
        '                </div>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">The Shape of It</h2>',
        '                <label class="field">',
        '                    <span class="field__label">Overall Plan <em class="field__req">*</em></span>',
        '                    <textarea class="field__input field__input--area" id="planDescription"',
        '                              rows="5" maxlength="2000"',
        '                              placeholder="What we are going for, in our own words."></textarea>',
        '                    <span class="field__error" id="planDescriptionError"></span>',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Transportation</span>',
        '                    <input class="field__input" type="text" id="planTransportation"',
        '                           maxlength="200" autocomplete="off" placeholder="Flights, trains, the car">',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Accommodation</span>',
        '                    <input class="field__input" type="text" id="planAccommodation"',
        '                           maxlength="200" autocomplete="off" placeholder="Where we sleep">',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Notes</span>',
        '                    <textarea class="field__input field__input--area" id="planNotes"',
        '                              rows="3" maxlength="2000"',
        '                              placeholder="Anything else worth remembering."></textarea>',
        '                </label>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">Daily Plan</h2>',
        '                <p class="field__hint" id="planDaysHint">',
        '                    Choose the dates and the days appear. Add as much or as',
        '                    little as you like to each one.',
        '                </p>',
        '                <div class="plan-day-editor" id="planDayEditor"></div>',
        '            </section>',
        '',
        '            <p class="sheet__error" id="planSheetError" role="alert" aria-live="polite"></p>',
        '',
        '            <div class="sheet__actions">',
        '                <button class="sheet__cancel" type="button" id="planSheetCancel">Cancel</button>',
        '                <button class="sheet__save" type="submit">',
        '                    <span id="planSaveLabel">Save Plan</span>',
        '                    <span aria-hidden="true">&rarr;</span>',
        '                </button>',
        '            </div>',
        '        </form>',
        '    </div>',
        '</div>'
    ].join("\n");

    var CONFIRM_MARKUP = [
        '<div class="confirm" id="planConfirm" hidden>',
        '    <div class="confirm__scrim" id="planConfirmScrim"></div>',
        '    <div class="confirm__panel" role="alertdialog" aria-modal="true"',
        '         aria-labelledby="planConfirmTitle" aria-describedby="planConfirmNote">',
        '        <h2 class="confirm__title" id="planConfirmTitle"></h2>',
        '        <p class="confirm__note" id="planConfirmNote"></p>',
        '        <div class="confirm__actions">',
        '            <button class="confirm__cancel" type="button" id="planConfirmCancel">Cancel</button>',
        '            <button class="confirm__go" type="button" id="planConfirmGo">Continue</button>',
        '        </div>',
        '    </div>',
        '</div>'
    ].join("\n");

    function buildSheet() {
        var holder = el("div");
        holder.innerHTML = SHEET_MARKUP;
        document.body.appendChild(holder.firstChild);

        sheet = byId("planSheet");

        fields = {
            title: byId("planTitle"),
            location: byId("planLocation"),
            start: byId("planStart"),
            end: byId("planEnd"),
            description: byId("planDescription"),
            transportation: byId("planTransportation"),
            accommodation: byId("planAccommodation"),
            notes: byId("planNotes")
        };

        dayEditor = byId("planDayEditor");
        durationValue = byId("planDurationValue");

        byId("planSheetScrim").addEventListener("click", closeForm);
        byId("planSheetClose").addEventListener("click", closeForm);
        byId("planSheetCancel").addEventListener("click", closeForm);
        byId("planForm").addEventListener("submit", submitForm);

        /* The range is watched, not the individual fields: either one moving
           can add or remove days, and the days are what carry the typing. */
        fields.start.addEventListener("change", onRangeChange);
        fields.end.addEventListener("change", onRangeChange);
        fields.start.addEventListener("input", updateDuration);
        fields.end.addEventListener("input", updateDuration);
    }

    function buildConfirm() {
        var holder = el("div");
        holder.innerHTML = CONFIRM_MARKUP;
        document.body.appendChild(holder.firstChild);

        confirmBox = byId("planConfirm");
        byId("planConfirmScrim").addEventListener("click", function () { settleConfirm(false); });
        byId("planConfirmCancel").addEventListener("click", function () { settleConfirm(false); });
        byId("planConfirmGo").addEventListener("click", function () { settleConfirm(true); });
    }

    /* -------------------------------------------------------- the confirm --
       Returns a promise, so the caller reads as the sentence it is:
       "if they say yes, do it". */
    function ask(options) {
        return new Promise(function (resolve) {
            confirmResolve = resolve;

            byId("planConfirmTitle").textContent = options.title || "";
            byId("planConfirmNote").textContent = options.note || "";

            var go = byId("planConfirmGo");
            go.textContent = options.go || "Continue";
            go.className = "confirm__go" + (options.danger ? " confirm__go--danger" : "");

            /* A message with nothing to decide offers one way out, not two
               words for the same thing. */
            var cancel = byId("planConfirmCancel");
            cancel.hidden = options.cancel === false;
            cancel.textContent = options.cancel || "Cancel";

            confirmBox.hidden = false;
            global.requestAnimationFrame(function () {
                confirmBox.classList.add("is-open");
                go.focus();
            });
        });
    }

    function settleConfirm(answer) {
        if (!confirmResolve) return;
        var resolve = confirmResolve;
        confirmResolve = null;

        confirmBox.classList.remove("is-open");
        var box = confirmBox;
        global.setTimeout(function () { box.hidden = true; }, reducedMotion ? 20 : 200);
        resolve(answer);
    }

    /* ------------------------------------------------------- open the form */

    function openForm(plan) {
        if (!isEditor()) return;

        state.editing = plan || null;
        state.days = [];
        state.saving = false;

        byId("planForm").reset();
        clearFieldErrors();
        setSheetError("");

        byId("planSheetTitle").textContent = plan ? "Edit Plan" : "New Plan";
        byId("planSaveLabel").textContent = plan ? "Save Changes" : "Save Plan";
        byId("planSheetLead").textContent = plan
            ? "Change anything here. Shortening the dates removes the days that no longer exist."
            : "A name, a place and the dates. The days of the trip are worked out from the dates — you never type them.";

        if (plan) {
            fields.title.value = plan.title || "";
            fields.location.value = plan.location || "";
            fields.start.value = plan.startDate || "";
            fields.end.value = plan.endDate || "";
            fields.description.value = plan.description || "";
            fields.transportation.value = plan.transportation || "";
            fields.accommodation.value = plan.accommodation || "";
            fields.notes.value = plan.notes || "";

            state.days = (plan.days || []).map(function (day) {
                return {
                    dayNumber: day.dayNumber,
                    activities: (day.activities || []).map(function (activity) {
                        return { text: activity.text || "" };
                    })
                };
            });
        }

        state.range = { start: fields.start.value, end: fields.end.value };

        /* A plan whose days were never written (or that shrank on the server)
           still needs its rows, so the editor matches the range it is showing. */
        growDays(Plans.duration(fields.start.value, fields.end.value));
        renderDays();
        updateDuration();

        sheet.hidden = false;
        global.requestAnimationFrame(function () {
            sheet.classList.add("is-open");
            fields.title.focus();
        });
    }

    function closeForm() {
        if (!sheet || state.saving) return;
        sheet.classList.remove("is-open");
        global.setTimeout(function () { sheet.hidden = true; }, reducedMotion ? 20 : 400);
    }

    /* ------------------------------------------------------- the day editor */

    /* Make the day list match `count`, keeping what was typed. Growing never
       destroys anything; shrinking is only ever reached after the visitor has
       agreed to it. */
    function growDays(count) {
        var wanted = Math.max(0, count || 0);
        var start = fields.start.value;

        while (state.days.length > wanted) state.days.pop();

        while (state.days.length < wanted) {
            var number = state.days.length + 1;
            state.days.push({
                dayNumber: number,
                activities: [{ text: "" }]
            });
        }

        state.days.forEach(function (day, index) {
            day.dayNumber = index + 1;
            /* Day N is the start date plus N−1 — the same arithmetic the
               server does, so the sheet and the archive never disagree. */
            day.date = start ? Plans.addDays(start, index) : "";
        });

        if (!state.days.length && wanted === 0) {
            state.days = [];
        }

        return state.days;
    }

    /* The day numbers that would disappear, but only the ones with something
       written in them — dropping an empty day loses nothing worth warning
       about. */
    function lostDays(count) {
        return state.days.filter(function (day, index) {
            if (index < count) return false;
            return day.activities.some(function (activity) {
                return String(activity.text || "").trim() !== "";
            });
        }).map(function (day) { return day.dayNumber; });
    }

    function listDays(numbers) {
        if (numbers.length === 1) return "Day " + numbers[0];
        if (numbers.length === 2) return "Day " + numbers[0] + " and Day " + numbers[1];
        return "Day " + numbers.slice(0, -1).join(", Day ") +
               " and Day " + numbers[numbers.length - 1];
    }

    function onRangeChange() {
        var start = fields.start.value;
        var end = fields.end.value;

        if (!Plans.isDay(start) || !Plans.isDay(end)) {
            updateDuration();
            return;
        }

        if (end < start) {
            setFieldError("end", "Please choose an end date after the start date.");
            updateDuration();
            return;
        }
        setFieldError("end", "");

        var count = Plans.duration(start, end);
        var losing = lostDays(count);

        if (!losing.length) {
            growDays(count);
            state.range = { start: start, end: end };
            renderDays();
            updateDuration();
            return;
        }

        /* Nothing is dropped yet, but the number beside the dates must agree
           with the dates the visitor is looking at. */
        paintDuration(count);

        ask({
            title: "Shorter trip",
            note: "Changing the dates will remove the plans for " + listDays(losing) +
                  ". That cannot be undone.",
            go: "Continue"
        }).then(function (agreed) {
            if (!agreed) {
                /* Put the dates back where they were. The days were never
                   touched, so there is nothing else to restore. */
                fields.start.value = state.range.start;
                fields.end.value = state.range.end;
                updateDuration();
                return;
            }
            growDays(count);
            state.range = { start: start, end: end };
            renderDays();
            updateDuration();
        });
    }

    function updateDuration() {
        var start = fields.start.value;
        var end = fields.end.value;
        var count = Plans.duration(start, end);

        paintDuration(count);

        /* The dates and the day rows are two views of one thing, so a legal
           range keeps them together even if the change event was missed. */
        if (count && Plans.isDay(start) && Plans.isDay(end) && end >= start &&
            count !== state.days.length) {
            growDays(count);
            renderDays();
        }
    }

    /* The readout on its own. While a date change is waiting to be agreed to,
       the days must not move — but the number beside the dates has to keep up
       with what the dates say, or the sheet contradicts itself on screen. */
    function paintDuration(count) {
        if (!durationValue) return;
        durationValue.textContent = count ? Plans.formatDuration(count) : "—";
    }

    function renderDays() {
        clear(dayEditor);

        if (!state.days.length) {
            dayEditor.appendChild(el("p", "plan-day__empty",
                "Choose a start and an end date and the days will appear here."));
            return;
        }

        state.days.forEach(function (day, dayIndex) {
            var block = el("div", "plan-day");
            block.setAttribute("data-day", String(day.dayNumber));

            var head = el("div", "plan-day__head");
            head.appendChild(el("p", "plan-day__label",
                Plans.formatDayLabel(day.dayNumber, day.date)));
            block.appendChild(head);

            day.activities.forEach(function (activity, activityIndex) {
                block.appendChild(activityRow(dayIndex, activityIndex, activity.text));
            });

            var add = el("button", "plan-activity-add", "+ Add Activity");
            add.type = "button";
            add.addEventListener("click", function () {
                day.activities.push({ text: "" });
                renderDays();
                focusActivity(dayIndex, day.activities.length - 1);
            });
            block.appendChild(add);

            dayEditor.appendChild(block);
        });
    }

    function activityRow(dayIndex, activityIndex, text) {
        var row = el("div", "plan-activity");

        var input = el("input", "plan-activity__input");
        input.type = "text";
        input.maxLength = 160;
        input.value = text || "";
        input.setAttribute("placeholder", "What we are doing");
        input.setAttribute("aria-label",
            "Day " + state.days[dayIndex].dayNumber + " activity " + (activityIndex + 1));
        input.addEventListener("input", function () {
            state.days[dayIndex].activities[activityIndex].text = input.value;
        });
        row.appendChild(input);

        var remove = el("button", "plan-activity__remove", "\u00d7");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove this activity");
        remove.addEventListener("click", function () {
            state.days[dayIndex].activities.splice(activityIndex, 1);
            renderDays();
        });
        row.appendChild(remove);

        return row;
    }

    function focusActivity(dayIndex, activityIndex) {
        var block = dayEditor.querySelector('[data-day="' + state.days[dayIndex].dayNumber + '"]');
        if (!block) return;
        var inputs = block.querySelectorAll(".plan-activity__input");
        if (inputs[activityIndex]) inputs[activityIndex].focus();
    }

    /* ----------------------------------------------------------- validation */

    var FIELD_ERRORS = {
        title: "planTitleError",
        location: "planLocationError",
        start: "planStartError",
        end: "planEndError",
        description: "planDescriptionError"
    };

    function setFieldError(name, message) {
        var node = byId(FIELD_ERRORS[name]);
        if (node) node.textContent = message || "";
    }

    function clearFieldErrors() {
        Object.keys(FIELD_ERRORS).forEach(function (name) { setFieldError(name, ""); });
    }

    function setSheetError(message) {
        var node = byId("planSheetError");
        if (node) node.textContent = message || "";
    }

    /* The form checks what it can see so the visitor is told before a round
       trip; the server checks it all again, and its answer is what is shown
       if the two ever disagree. */
    function validate() {
        clearFieldErrors();
        var problems = 0;

        if (!fields.title.value.trim()) {
            setFieldError("title", "A plan needs a name.");
            problems++;
        }
        if (!fields.location.value.trim()) {
            setFieldError("location", "Where is this plan?");
            problems++;
        }
        if (!fields.description.value.trim()) {
            setFieldError("description", "Say what this plan is.");
            problems++;
        }

        var start = fields.start.value;
        var end = fields.end.value;

        if (!Plans.isDay(start)) {
            setFieldError("start", "Choose a start date, year and all.");
            problems++;
        }
        if (!Plans.isDay(end)) {
            setFieldError("end", "Choose an end date, year and all.");
            problems++;
        }
        if (Plans.isDay(start) && Plans.isDay(end) && end < start) {
            setFieldError("end", "Please choose an end date after the start date.");
            problems++;
        }

        return problems === 0;
    }

    /* --------------------------------------------------------------- saving */

    function submitForm(event) {
        if (event) event.preventDefault();
        if (state.saving) return;
        if (!validate()) {
            setSheetError("Please check the fields marked above.");
            return;
        }

        var payload = {
            title: fields.title.value.trim(),
            location: fields.location.value.trim(),
            description: fields.description.value.trim(),
            startDate: fields.start.value,
            endDate: fields.end.value,
            transportation: fields.transportation.value.trim(),
            accommodation: fields.accommodation.value.trim(),
            notes: fields.notes.value.trim(),
            days: state.days.map(function (day, index) {
                return {
                    dayNumber: index + 1,
                    activities: day.activities.map(function (activity) {
                        return { text: String(activity.text || "").trim() };
                    }).filter(function (activity) { return activity.text; })
                };
            })
        };

        var editing = state.editing;
        state.saving = true;
        setSheetError("");

        var request = editing
            ? Plans.update(editing.id, payload)
            : Plans.create(payload);

        request.then(function (plan) {
            state.saving = false;
            sheet.classList.remove("is-open");
            global.setTimeout(function () { sheet.hidden = true; }, reducedMotion ? 20 : 400);

            /* Show what was just written. A plan is a whole page of text, and
               the archive is the only place that proves it arrived. */
            if (plan.status !== state.view) switchView(plan.status);
            else render();

            openPlan(plan.id);
        }, function (error) {
            state.saving = false;
            setSheetError((error && error.message) ||
                "This plan could not be saved. Please try again.");
        });
    }

    /* ------------------------------------------------------------- deleting */

    function deletePlan() {
        var plan = state.openId ? Plans.byId(state.openId) : null;
        if (!plan || !isEditor()) return;

        ask({
            title: "Delete this plan?",
            note: "This will remove " + (plan.title || "the plan") +
                  " from Our Future. Its days go with it, and it cannot be brought back.",
            go: "Delete Plan",
            danger: true
        }).then(function (agreed) {
            if (!agreed) return;

            Plans.remove(plan.id).then(function () {
                closePlan();
                render();
            }, function (error) {
                ask({
                    title: "Could not delete",
                    note: (error && error.message) ||
                          "The plan could not be removed. Please try again.",
                    go: "Close",
                    cancel: false
                });
            });
        });
    }

    /* ----------------------------------------------------------------- boot */

    function switchView(view) {
        state.view = view === "completed" ? "completed" : "upcoming";

        var upcoming = state.view === "upcoming";
        if (ui.tabUpcoming) {
            ui.tabUpcoming.classList.toggle("is-on", upcoming);
            ui.tabUpcoming.setAttribute("aria-selected", String(upcoming));
        }
        if (ui.tabCompleted) {
            ui.tabCompleted.classList.toggle("is-on", !upcoming);
            ui.tabCompleted.setAttribute("aria-selected", String(!upcoming));
        }
        if (ui.title) ui.title.textContent = upcoming ? "Upcoming" : "Completed";

        render();
    }

    function bindChrome() {
        ui.tabs.addEventListener("click", function (event) {
            var tab = event.target.closest("[data-view]");
            if (tab && ui.tabs.contains(tab)) switchView(tab.getAttribute("data-view"));
        });

        ui.newButton.addEventListener("click", function () { openForm(null); });
        ui.retry.addEventListener("click", function () { Plans.load({ force: true }); });
        ui.detailBack.addEventListener("click", closePlan);
        ui.detailScrim.addEventListener("click", closePlan);
        ui.editButton.addEventListener("click", function () {
            var plan = state.openId ? Plans.byId(state.openId) : null;
            if (plan) openForm(plan);
        });
        ui.deleteButton.addEventListener("click", deletePlan);

        document.addEventListener("keydown", function (event) {
            if (event.key !== "Escape") return;

            if (confirmResolve) { settleConfirm(false); return; }
            if (sheet && sheet.classList.contains("is-open")) { closeForm(); return; }
            if (ui.detail && ui.detail.classList.contains("is-open")) closePlan();
        });

        /* A plan saved in the sheet keeps the detail behind it current. */
        document.addEventListener("lovestory:auth-changed", applyPermissions);
    }

    function boot() {
        ui = {
            tabs: byId("futureTabs"),
            tabUpcoming: byId("tabUpcoming"),
            tabCompleted: byId("tabCompleted"),
            title: byId("futureTitle"),
            stats: byId("futureStats"),
            loading: byId("futureLoading"),
            error: byId("futureError"),
            empty: byId("futureEmpty"),
            list: byId("planList"),
            scroll: byId("futureScroll"),
            newButton: byId("newPlanButton"),
            retry: byId("futureRetry"),
            detail: byId("planDetail"),
            detailScrim: byId("planDetailScrim"),
            detailBack: byId("planDetailBack"),
            detailScroll: document.querySelector(".plan-detail__stage"),
            editButton: byId("planEditButton"),
            deleteButton: byId("planDeleteButton"),
            archive: byId("planArchive")
        };

        buildSheet();
        buildConfirm();
        bindChrome();
        applyPermissions();

        /* The store is a plain script beside this one. If it did not load there
           is no data layer at all, so say so plainly instead of throwing on
           the first render and leaving an empty room. */
        if (!Plans) {
            if (ui.loading) ui.loading.hidden = true;
            if (ui.error) ui.error.hidden = false;
            return;
        }

        Plans.onChange(render);

        render();
        Plans.load();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
