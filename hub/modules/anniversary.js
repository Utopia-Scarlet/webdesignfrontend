/* ==========================================================================
   LoveStory — Anniversaries

   The page behind the Hub's countdown: the dates, one date opened, and the
   sheet that writes them.

   This page exists because the Hub used to build its anniversary module out of
   memories. Anything marked for the Timeline had its date counted down to, so
   a holiday snap sat in the Anniversary module. A memory is a thing that
   happened once; an anniversary is a date declared on purpose. Nothing here
   reads a memory, and nothing here can be created by one.

   Three rules the whole page obeys:

     · Only the title, the original date and the note are ever sent anywhere.
       The next occurrence, the days remaining, the anniversary number and the
       list of past anniversaries are computed from the date and today, every
       time they are shown — so editing a date moves all of them at once and
       none of them can be stale.

     · Every countdown is counted in the reader's own local days. Midnight
       where they are, not midnight UTC, which would show one day too few for
       half the world.

     · Only an editor sees a way to change anything, and the API refuses a
       write from anyone else regardless.

   Depends on ../../data/anniversaries.js, api.js and ../../auth.js.
   ========================================================================== */

(function (global) {
    "use strict";

    var Dates = global.LoveStoryAnniversaries;

    var state = {
        openId: null,
        editing: null,
        saving: false
    };

    var ui = {};
    var sheet = null;
    var fields = {};
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
        return Dates && Dates.todayIso ? Dates.todayIso() : "";
    }

    /* ---------------------------------------------------------- permissions */

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

    function render() {
        if (!ui.list) return;

        var loading = Dates.status === "loading" || Dates.status === "idle";
        var failed = Dates.status === "error";
        var rows = Dates.upcoming(today());

        if (ui.loading) ui.loading.hidden = !loading;
        if (ui.error) ui.error.hidden = !failed;

        if (ui.count) {
            ui.count.textContent = failed ? "" : countLine(rows.length);
        }
        if (ui.stats) {
            ui.stats.textContent = failed ? "" : statsLine(rows);
        }

        if (ui.empty) {
            if (!failed && !loading && !rows.length) {
                ui.empty.textContent = emptyLine();
                ui.empty.hidden = false;
            } else {
                ui.empty.hidden = true;
            }
        }

        clear(ui.list);

        if (failed || loading || !rows.length) return;
        rows.forEach(function (record) { ui.list.appendChild(rowFor(record)); });
    }

    function countLine(total) {
        if (!total) return "";
        return total === 1 ? "1 date" : total + " dates";
    }

    function statsLine(rows) {
        if (!rows.length) return "";

        var soonest = rows[0];
        if (!soonest || soonest.daysRemaining === null) return "";

        return soonest.isToday
            ? "the next one is today"
            : "the next one is " + Dates.daysPhrase(soonest.daysRemaining);
    }

    function emptyLine() {
        return isEditor()
            ? "No dates yet. Add the day your story began, and it will come round every year."
            : "No anniversaries have been added yet.";
    }

    /* One row. Soonest first, so the top of the list is the answer to the only
       question this page is asked. */
    function rowFor(record) {
        var item = el("li", "anniv-row");
        var button = el("button", "anniv-row__button");
        button.type = "button";
        button.setAttribute("data-anniversary", record.id);

        var identity = el("span");
        identity.appendChild(el("span", "anniv-row__title", record.title || "Untitled date"));

        /* The original date is the fact; the anniversary number is what it has
           become. Both, because they are different things. */
        identity.appendChild(el("span", "anniv-row__label",
            record.nextLabel || "The day itself"));
        identity.appendChild(el("span", "anniv-row__since",
            "SINCE " + Dates.formatShort(record.originalDate)));

        button.appendChild(identity);

        var when = el("span", "anniv-row__when");
        when.appendChild(el("span", "anniv-row__days",
            record.isToday ? "TODAY" : Dates.daysLabel(record.daysRemaining)));
        when.appendChild(el("span", "anniv-row__date", Dates.formatShort(record.nextDate)));
        button.appendChild(when);

        button.addEventListener("click", function () { openDate(record.id); });

        item.appendChild(button);
        return item;
    }

    /* ----------------------------------------------------------- the detail */

    function openDate(id) {
        var record = Dates.byId(id, today());
        if (!record) return;

        state.openId = record.id;
        renderDetail(record);

        if (!ui.detail) return;
        ui.detail.hidden = false;
        applyPermissions();
        global.requestAnimationFrame(function () {
            ui.detail.classList.add("is-open");
            if (ui.detailStage) ui.detailStage.scrollTop = 0;
            if (ui.detailBack && ui.detailBack.focus) ui.detailBack.focus();
        });
    }

    function closeDate() {
        state.openId = null;
        applyPermissions();
        if (!ui.detail) return;

        ui.detail.classList.remove("is-open");
        global.setTimeout(function () { ui.detail.hidden = true; },
            reducedMotion ? 20 : 320);
    }

    function renderDetail(record) {
        var archive = clear(ui.archive);

        archive.appendChild(el("p", "anniv-archive__eyebrow", "Anniversary"));
        archive.appendChild(el("h2", "anniv-archive__title", record.title || "Untitled date"));
        archive.appendChild(el("p", "anniv-archive__since",
            "SINCE " + Dates.formatLong(record.originalDate)));

        archive.appendChild(nextBlock(record));

        archive.appendChild(section("Past anniversaries", pastList(record)));

        if (record.note) {
            archive.appendChild(section("Note",
                el("p", "anniv-archive__prose", record.note)));
        }

        archive.appendChild(el("p", "anniv-archive__by", byline(record)));
    }

    /* The next one, given the weight of a headline. The number is the
       anniversary it will be, which is why the original date is not the 1st:
       it is the beginning, and nothing has come round yet. */
    function nextBlock(record) {
        var block = el("div", "anniv-next");

        block.appendChild(el("span", "anniv-next__label", "Next anniversary"));
        block.appendChild(el("span", "anniv-next__number",
            record.nextLabel || "The day itself"));
        block.appendChild(el("span", "anniv-next__date", Dates.formatLong(record.nextDate)));
        block.appendChild(el("span", "anniv-next__days",
            record.isToday ? "TODAY" : Dates.daysLabel(record.daysRemaining)));

        return block;
    }

    /* The past, newest first, generated rather than stored: there is no row
       in the database for 2026 or 2027, and there never will be. */
    function pastList(record) {
        if (!record.completed.length) {
            return el("p", "anniv-past__none",
                "Nothing has come round yet. The original date is the beginning, not the first anniversary.");
        }

        var list = el("ol", "anniv-past");

        record.completed.forEach(function (entry) {
            var item = el("li", "anniv-past__item");
            item.appendChild(el("span", "anniv-past__number",
                String(entry.number).padStart(2, "0")));
            item.appendChild(el("span", "anniv-past__date", Dates.formatShort(entry.date)));
            item.appendChild(el("span", "anniv-past__label",
                Dates.anniversaryLabel(entry.number)));
            list.appendChild(item);
        });

        return list;
    }

    function section(label, body) {
        var wrap = el("section", "anniv-archive__section");
        wrap.appendChild(el("p", "anniv-archive__label", label));
        wrap.appendChild(body);
        return wrap;
    }

    function byline(record) {
        var who = record.createdBy && record.createdBy.displayName
            ? record.createdBy.displayName
            : "";
        var text = who ? "Added by " + who : "Added";

        if (record.updatedBy && record.updatedBy.displayName) {
            text += " · last edited by " + record.updatedBy.displayName;
        }

        return text;
    }

    /* ------------------------------------------------------------ the sheet */

    var SHEET_MARKUP = [
        '<div class="sheet" id="annivSheet" hidden>',
        '    <button class="sheet__scrim" type="button" id="annivSheetScrim" tabindex="-1" aria-label="Close"></button>',
        '',
        '    <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="annivSheetTitle">',
        '        <header class="sheet__head">',
        '            <p class="sheet__eyebrow" id="annivSheetTitle">New Anniversary</p>',
        '            <button class="sheet__close" type="button" id="annivSheetClose" aria-label="Close">&times;</button>',
        '        </header>',
        '',
        '        <form class="sheet__form" id="annivForm" novalidate>',
        '',
        '            <p class="field__hint field__hint--lead" id="annivSheetLead">',
        '                Two things are needed: what the day is called, and the date it',
        '                first happened. It will come round every year from then on.',
        '            </p>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">The Date</h2>',
        '                <label class="field">',
        '                    <span class="field__label">Title <em class="field__req">*</em></span>',
        '                    <input class="field__input" type="text" id="annivFieldTitle"',
        '                           maxlength="120" autocomplete="off" placeholder="Our Day">',
        '                    <span class="field__error" id="annivFieldTitleError"></span>',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Date <em class="field__req">*</em></span>',
        '                    <input class="field__input" type="date" id="annivFieldDate" required',
        '                           min="1900-01-01" max="2099-12-31">',
        '                    <span class="field__hint">',
        '                        The day it first happened. Every year after it is worked',
        '                        out from this one date.',
        '                    </span>',
        '                    <span class="field__error" id="annivFieldDateError"></span>',
        '                </label>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">A Note</h2>',
        '                <label class="field">',
        '                    <span class="field__label">Note</span>',
        '                    <textarea class="field__input field__input--area" id="annivFieldNote"',
        '                              rows="4" maxlength="2000"',
        '                              placeholder="The day our story officially began."></textarea>',
        '                </label>',
        '            </section>',
        '',
        '            <p class="sheet__error" id="annivSheetError" role="alert" aria-live="polite"></p>',
        '',
        '            <div class="sheet__actions">',
        '                <button class="sheet__cancel" type="button" id="annivSheetCancel">Cancel</button>',
        '                <button class="sheet__save" type="submit">',
        '                    <span id="annivSaveLabel">Save Anniversary</span>',
        '                    <span aria-hidden="true">&rarr;</span>',
        '                </button>',
        '            </div>',
        '        </form>',
        '    </div>',
        '</div>'
    ].join("\n");

    var CONFIRM_MARKUP = [
        '<div class="confirm" id="annivConfirm" hidden>',
        '    <div class="confirm__scrim" id="annivConfirmScrim"></div>',
        '    <div class="confirm__panel" role="alertdialog" aria-modal="true"',
        '         aria-labelledby="annivConfirmTitle" aria-describedby="annivConfirmNote">',
        '        <h2 class="confirm__title" id="annivConfirmTitle"></h2>',
        '        <p class="confirm__note" id="annivConfirmNote"></p>',
        '        <div class="confirm__actions">',
        '            <button class="confirm__cancel" type="button" id="annivConfirmCancel">Cancel</button>',
        '            <button class="confirm__go" type="button" id="annivConfirmGo">Continue</button>',
        '        </div>',
        '    </div>',
        '</div>'
    ].join("\n");

    function buildSheet() {
        var holder = el("div");
        holder.innerHTML = SHEET_MARKUP;
        document.body.appendChild(holder.firstChild);

        sheet = byId("annivSheet");
        fields = {
            title: byId("annivFieldTitle"),
            date: byId("annivFieldDate"),
            note: byId("annivFieldNote")
        };

        byId("annivSheetScrim").addEventListener("click", closeForm);
        byId("annivSheetClose").addEventListener("click", closeForm);
        byId("annivSheetCancel").addEventListener("click", closeForm);
        byId("annivForm").addEventListener("submit", submitForm);
    }

    function buildConfirm() {
        var holder = el("div");
        holder.innerHTML = CONFIRM_MARKUP;
        document.body.appendChild(holder.firstChild);

        confirmBox = byId("annivConfirm");
        byId("annivConfirmScrim").addEventListener("click", function () { settleConfirm(false); });
        byId("annivConfirmCancel").addEventListener("click", function () { settleConfirm(false); });
        byId("annivConfirmGo").addEventListener("click", function () { settleConfirm(true); });
    }

    function ask(options) {
        return new Promise(function (resolve) {
            confirmResolve = resolve;

            byId("annivConfirmTitle").textContent = options.title || "";
            byId("annivConfirmNote").textContent = options.note || "";

            var go = byId("annivConfirmGo");
            go.textContent = options.go || "Continue";
            go.className = "confirm__go" + (options.danger ? " confirm__go--danger" : "");

            var cancel = byId("annivConfirmCancel");
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

    function openForm(record) {
        if (!isEditor()) return;

        state.editing = record || null;
        state.saving = false;

        byId("annivForm").reset();
        clearFieldErrors();
        setSheetError("");

        byId("annivSheetTitle").textContent = record ? "Edit Anniversary" : "New Anniversary";
        byId("annivSaveLabel").textContent = record ? "Save Changes" : "Save Anniversary";
        byId("annivSheetLead").textContent = record
            ? "Change the title, the date or the note. Moving the date moves the countdown with it."
            : "Two things are needed: what the day is called, and the date it first happened. It will come round every year from then on.";

        if (record) {
            fields.title.value = record.title || "";
            fields.date.value = record.originalDate || "";
            fields.note.value = record.note || "";
        }

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

    /* ----------------------------------------------------------- validation */

    var FIELD_ERRORS = {
        title: "annivFieldTitleError",
        date: "annivFieldDateError"
    };

    function setFieldError(name, message) {
        var node = byId(FIELD_ERRORS[name]);
        if (node) node.textContent = message || "";
    }

    function clearFieldErrors() {
        Object.keys(FIELD_ERRORS).forEach(function (name) { setFieldError(name, ""); });
    }

    function setSheetError(message) {
        var node = byId("annivSheetError");
        if (node) node.textContent = message || "";
    }

    function validate() {
        clearFieldErrors();
        var problems = 0;

        if (!fields.title.value.trim()) {
            setFieldError("title", "A date needs a name.");
            problems++;
        }
        if (!fields.date.value) {
            setFieldError("date", "Choose the date this first happened.");
            problems++;
        } else if (!Dates.isDay(fields.date.value)) {
            /* The native picker cannot produce this; a hand-typed year can. */
            setFieldError("date", "Please enter a real date, year and all.");
            problems++;
        }

        return problems === 0;
    }

    /* --------------------------------------------------------------- saving */

    function submitForm(event) {
        if (event) event.preventDefault();
        if (state.saving) return;
        if (!validate()) {
            setSheetError("Please check the field marked above.");
            return;
        }

        /* Only the three stored facts. Nothing derived is sent, because the
           server would have nothing to do with it. */
        var payload = {
            title: fields.title.value.trim(),
            originalDate: fields.date.value,
            note: fields.note.value.trim()
        };

        var editing = state.editing;
        state.saving = true;
        setSheetError("");

        var request = editing
            ? Dates.update(editing.id, payload)
            : Dates.create(payload);

        request.then(function (record) {
            state.saving = false;
            sheet.classList.remove("is-open");
            global.setTimeout(function () { sheet.hidden = true; }, reducedMotion ? 20 : 400);

            render();
            openDate(record.id);
        }, function (error) {
            state.saving = false;
            setSheetError((error && error.message) ||
                "This date could not be saved. Please try again.");
        });
    }

    /* ------------------------------------------------------------- deleting */

    function deleteDate() {
        var record = state.openId ? Dates.byId(state.openId, today()) : null;
        if (!record || !isEditor()) return;

        ask({
            title: "Delete this anniversary?",
            note: "This removes the date from Our Story. It cannot be brought back.",
            go: "Delete Anniversary",
            danger: true
        }).then(function (agreed) {
            if (!agreed) return;

            Dates.remove(record.id).then(function () {
                closeDate();
                render();
            }, function (error) {
                ask({
                    title: "Could not delete",
                    note: (error && error.message) ||
                          "The date could not be removed. Please try again.",
                    go: "Close",
                    cancel: false
                });
            });
        });
    }

    /* ----------------------------------------------------------------- boot */

    /* A link from the Timeline names one date: anniversary.html?anniversary=3.
       Opened that way the page shows the date itself; opened any other way it
       shows the list. */
    function requestedId() {
        var match = /[?&]anniversary=([^&#]+)/.exec(global.location.search || "");
        return match ? decodeURIComponent(match[1]) : "";
    }

    function bindChrome() {
        ui.newButton.addEventListener("click", function () { openForm(null); });
        ui.retry.addEventListener("click", function () { Dates.load({ force: true }); });
        ui.detailBack.addEventListener("click", closeDate);
        ui.detailScrim.addEventListener("click", closeDate);
        ui.editButton.addEventListener("click", function () {
            var record = state.openId ? Dates.byId(state.openId, today()) : null;
            if (record) openForm(record);
        });
        ui.deleteButton.addEventListener("click", deleteDate);

        document.addEventListener("keydown", function (event) {
            if (event.key !== "Escape") return;

            if (confirmResolve) { settleConfirm(false); return; }
            if (sheet && sheet.classList.contains("is-open")) { closeForm(); return; }
            if (ui.detail && ui.detail.classList.contains("is-open")) closeDate();
        });

        document.addEventListener("lovestory:auth-changed", applyPermissions);
    }

    function boot() {
        ui = {
            count: byId("annivCount"),
            stats: byId("annivStats"),
            loading: byId("annivLoading"),
            error: byId("annivError"),
            empty: byId("annivEmpty"),
            list: byId("annivList"),
            newButton: byId("newAnniversaryButton"),
            retry: byId("annivRetry"),
            detail: byId("annivDetail"),
            detailScrim: byId("annivDetailScrim"),
            detailBack: byId("annivDetailBack"),
            detailStage: byId("annivDetailStage"),
            editButton: byId("annivEditButton"),
            deleteButton: byId("annivDeleteButton"),
            archive: byId("annivArchive")
        };

        buildSheet();
        buildConfirm();
        bindChrome();
        applyPermissions();

        /* The store is a plain script beside this one. If it did not load there
           is no data layer at all, so say so plainly instead of throwing on
           the first render and leaving an empty room. */
        if (!Dates) {
            if (ui.loading) ui.loading.hidden = true;
            if (ui.error) ui.error.hidden = false;
            return;
        }

        Dates.onChange(render);

        render();
        Dates.load().then(function () {
            /* The list is on screen either way; a link from the Timeline also
               opens its date. A stale id is simply not found, and the list is
               what is left — never an empty room. */
            var wanted = requestedId();
            if (wanted && Dates.byId(wanted, today())) openDate(wanted);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
