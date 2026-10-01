/* ==========================================================================
   LoveStory — the Add Memory sheet

   ONE form, used everywhere a memory can be written. The Moments album opens
   it from the sidebar; the Memory Map opens it from the toolbar, or from a
   place that is already selected. Either way the record is created by the same
   code, validated the same way, and stored in the same place — there is no
   "map memory" and no "album memory".

   The markup is injected, so a host page only needs:
       <link rel="stylesheet" href="memory-form.css">
       <script src="memory-form.js" defer></script>
   and then, optionally, LoveStoryMemoryForm.open(...).

   The sheet is a panel rather than a modal: the page behind it stays visible,
   which keeps the visitor oriented inside the archive.
   ========================================================================== */

(function (global) {
    "use strict";

    /* The lists the form is built from. They come from data/memory-fields.js on
       every page now; `LoveStoryData` is still accepted as a fallback so an
       older cached page cannot end up with an empty weather select. */
    var fields = global.LoveStoryMemoryFields || global.LoveStoryData || null;
    if (!fields || !fields.moods) return;

    var reducedMotion = global.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ----------------------------------------------------------------- state */
    var state = {
        uploaded: [],          /* [{ file, url }] staged in this sheet */
        saving: false,
        mode: "add",           /* "add" | "edit" — one sheet, two modes */
        editingMemoryId: null, /* which memory is being changed, or null */
        editing: null,         /* that memory's values, only to prefill from */
        cover: 0,              /* which staged photograph becomes the cover */
        existingPhotos: [],    /* a memory's photographs, in Edit mode */
        coverPhotoId: null,    /* the one chosen to represent it, or null */
        coverDirty: false,     /* chosen in this sitting, not yet saved */
        collections: [],       /* ticked by hand, never inferred */
        mood: "",
        requireLocation: false,
        onSaved: null,

        /* Privacy. A memory is standard unless somebody says otherwise, which
           is what the server defaults to as well — so a form that never touches
           these fields saves exactly what it always saved. */
        scope: "standard",     /* "standard" | "private": which API saves it */
        privacy: "standard",   /* the mode chosen in the form */
        permission: null,      /* owner | editor | viewer, for an existing one */
        privacyConfigured: false,
        privacyUnlocked: false,
        audience: null,        /* the mounted "who can access?" control */
        members: null,         /* this space's members, read at most once */
        privacyPreset: "only", /* derived from an existing memory's ACL */
        privacyAccess: [],     /* ditto, as returned by the server */
        confirmingPrivacy: false
    };

    var sheet = null;
    var form = null;
    var sheetError = null;
    var photoPreview = null;
    var moodChips = null;
    var collectionChips = null;
    var locationNote = null;
    var cityLabel = null;
    var countryLabel = null;
    var countryBox = null;
    var cityBox = null;
    var coverPicker = null;

    /* ---------------------------------------------------------------- markup */
    /* Kept as an array of lines so it stays readable and needs no escaping. */
    var MARKUP = [
        '<div class="sheet" id="addSheet" hidden>',
        '    <button class="sheet__scrim" type="button" id="sheetScrim" tabindex="-1" aria-label="Close"></button>',
        '',
        '    <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">',
        '        <header class="sheet__head">',
        '            <p class="sheet__eyebrow" id="sheetTitle">Add Memory</p>',
        '            <button class="sheet__close" type="button" id="sheetClose" aria-label="Close">&times;</button>',
        '        </header>',
        '',
        '        <form class="sheet__form" id="memoryForm" novalidate>',
        '',
        '            <p class="field__hint field__hint--lead" id="sheetLead">',
        '                Only three things are required: a photograph, a date and a title.',
        '                Everything else can be filled in later &mdash; or never.',
        '            </p>',
        '',
        '            <section class="field-group" id="photoGroup">',
        '                <h2 class="field-group__title">Photos <em class="field__req">*</em></h2>',
        '                <label class="upload">',
        '                    <input type="file" id="photoInput" accept="image/*" multiple hidden>',
        '                    <span class="upload__label">+ Upload Photos</span>',
        '                </label>',
        '                <div class="upload__preview" id="photoPreview"></div>',
        '                <p class="field__hint">',
        '                    Choose as many as you like. The first is the cover; use',
        '                    <em>Set as cover</em> on any other to promote it.',
        '                </p>',
        '                <p class="field__error" id="photoError" role="alert" aria-live="polite"></p>',
        '            </section>',
        '',
        '            <section class="field-group" id="coverGroup" hidden>',
        '                <h2 class="field-group__title">Photos</h2>',
        '                <div class="upload__preview" id="coverPicker"></div>',
        '                <p class="field__hint">',
        '                    These are the photographs this memory already holds. Choose the',
        '                    one that represents it \u2014 the cover is the only thing about',
        '                    the photographs that can be changed here.',
        '                </p>',
        '                <p class="field__error" id="coverError" role="alert" aria-live="polite"></p>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">When</h2>',
        '                <div class="field-row">',
        '                    <label class="field">',
        '                        <span class="field__label">Date <em class="field__req">*</em></span>',
        '                        <input class="field__input" type="date" id="memoryDate" required',
        '                               min="1900-01-01" max="2099-12-31">',
        '                        <span class="field__error" id="memoryDateError"></span>',
        '                    </label>',
        '                    <label class="field">',
        '                        <span class="field__label">Time</span>',
        '                        <input class="field__input" type="time" id="memoryTime">',
        '                    </label>',
        '                </div>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">Where</h2>',
        '                <div class="field-row">',
        '                    <div class="field">',
        '                        <label class="field__label" id="countryLabel" for="memoryCountry">Country</label>',
        '                        <div class="combo" id="countryCombo">',
        '                            <input class="field__input" type="text" id="memoryCountry"',
        '                                   autocomplete="off" role="combobox" aria-expanded="false"',
        '                                   aria-autocomplete="list" aria-controls="countryList"',
        '                                   aria-haspopup="listbox">',
        '                            <ul class="combo__list" id="countryList" role="listbox"',
        '                                aria-label="Countries" hidden></ul>',
        '                        </div>',
        '                        <span class="field__error" id="memoryCountryError"></span>',
        '                    </div>',
        '                    <div class="field">',
        '                        <label class="field__label" id="cityLabel" for="memoryCity">City</label>',
        '                        <div class="combo" id="cityCombo">',
        '                            <input class="field__input" type="text" id="memoryCity"',
        '                                   autocomplete="off" role="combobox" aria-expanded="false"',
        '                                   aria-autocomplete="list" aria-controls="cityList"',
        '                                   aria-haspopup="listbox">',
        '                            <ul class="combo__list" id="cityList" role="listbox"',
        '                                aria-label="Cities" hidden></ul>',
        '                        </div>',
        '                        <span class="field__error" id="memoryCityError"></span>',
        '                    </div>',
        '                </div>',
        '                <p class="field__hint" id="locationNote">',
        '                    Coordinates are optional. Without them the place still appears in the album',
        '                    and the Timeline &mdash; it just cannot be pinned on the globe.',
        '                </p>',
        '                <div class="field-row">',
        '                    <label class="field">',
        '                        <span class="field__label">Latitude <em id="latAuto">auto</em></span>',
        '                        <input class="field__input" type="number" id="memoryLat"',
        '                               step="0.0001" min="-90" max="90" placeholder="30.5728">',
        '                    </label>',
        '                    <label class="field">',
        '                        <span class="field__label">Longitude <em id="lngAuto">auto</em></span>',
        '                        <input class="field__input" type="number" id="memoryLng"',
        '                               step="0.0001" min="-180" max="180" placeholder="104.0668">',
        '                    </label>',
        '                </div>',
        '                <input type="hidden" id="memoryCountryCode">',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">Context</h2>',
        '                <div class="field-row">',
        '                    <label class="field">',
        '                        <span class="field__label">Weather</span>',
        '                        <select class="field__input" id="memoryWeather"></select>',
        '                    </label>',
        '                    <label class="field">',
        '                        <span class="field__label">Temperature &deg;C</span>',
        '                        <input class="field__input" type="number" id="memoryTemp"',
        '                               min="-40" max="60" placeholder="22">',
        '                    </label>',
        '                </div>',
        '                <div class="field">',
        '                    <span class="field__label">Mood</span>',
        '                    <div class="chips" id="moodChips"></div>',
        '                </div>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">Story</h2>',
        '                <label class="field">',
        '                    <span class="field__label">Title <em class="field__req">*</em></span>',
        '                    <input class="field__input" type="text" id="memoryTitle"',
        '                           placeholder="Our day in Chengdu">',
        '                    <span class="field__error" id="memoryTitleError"></span>',
        '                </label>',
        '                <label class="field">',
        '                    <span class="field__label">Description</span>',
        '                    <textarea class="field__input field__input--area" id="memoryDescription" rows="5"',
        '                              placeholder="What happened, and what it felt like."></textarea>',
        '                </label>',
        '            </section>',
        '',
        '            <section class="field-group">',
        '                <h2 class="field-group__title">Organize</h2>',
        '                <p class="field__hint" id="organizeNote" hidden>',
        '                    Tags, collections and the moment type are not stored on the',
        '                    server yet, so they cannot be changed here. Everything else can.',
        '                </p>',
        '                <label class="field" id="tagsField">',
        '                    <span class="field__label">Tags <em>comma separated</em></span>',
        '                    <input class="field__input" type="text" id="memoryTags" placeholder="Travel, Chengdu">',
        '                </label>',
        '                <div class="field" id="collectionsField">',
        '                    <span class="field__label">Collections <em>optional</em></span>',
        '                    <div class="chips chips--collections" id="collectionChips"></div>',
        '                    <span class="field__hint">',
        '                        A memory appears under every collection you tick.',
        '                    </span>',
        '                </div>',
        '                <div class="field-row">',
        '                    <label class="field" id="momentField">',
        '                        <span class="field__label">Moment</span>',
        '                        <select class="field__input" id="memoryMoment"></select>',
        '                    </label>',
        '                    <label class="field field--check">',
        '                        <input type="checkbox" id="memoryFavorite">',
        '                        <span>Favorite</span>',
        '                    </label>',
        '                </div>',
        '                <label class="field field--check">',
        '                    <input type="checkbox" id="memoryTimeline">',
        '                    <span>Add to Timeline</span>',
        '                </label>',
        '                <p class="field__hint">',
        '                    The Timeline shows the memories you consider landmarks.',
        '                    Leave this off and the memory still lives in the album and on the map.',
        '                </p>',
        '            </section>',
        '',
        '            <!-- ------------------------------------------------------',
        '                 PRIVACY',
        '',
        '                 The same two words the archive itself uses: standard',
        '                 and private. Not "public" — nothing here is public, the',
        '                 archive already needs a space to read at all.',
        '',
        '                 Private is offered only where it can actually be taken:',
        '                 the private option is removed for a memory somebody else',
        '                 made, and the gate below stands in front of it when the',
        '                 private archive has no password yet or is closed.',
        '                 ------------------------------------------------------ -->',
        '            <section class="field-group" id="privacyGroup">',
        '                <h2 class="field-group__title" id="privacyTitle">Privacy</h2>',
        '',
        '                <div class="privacy-choice" role="radiogroup" aria-label="Privacy"',
        '                     id="privacyChoice">',
        '                    <label class="privacy-choice__option">',
        '                        <input type="radio" class="privacy-choice__radio"',
        '                               name="memoryPrivacy" value="standard"',
        '                               id="privacyStandard" checked>',
        '                        <span class="privacy-choice__body">',
        '                            <span class="privacy-choice__label">Standard</span>',
        '                            <span class="privacy-choice__note" id="privacyStandardNote">',
        '                                Visible normally to members of this space.',
        '                            </span>',
        '                        </span>',
        '                    </label>',
        '',
        '                    <label class="privacy-choice__option" id="privacyPrivateOption">',
        '                        <input type="radio" class="privacy-choice__radio"',
        '                               name="memoryPrivacy" value="private"',
        '                               id="privacyPrivate">',
        '                        <span class="privacy-choice__body">',
        '                            <span class="privacy-choice__label">Private</span>',
        '                            <span class="privacy-choice__note">',
        '                                Stored in your Private Archive and protected by',
        '                                your privacy password.',
        '                            </span>',
        '                        </span>',
        '                    </label>',
        '                </div>',
        '',
        '                <p class="field__hint" id="privacyOwnerNote" hidden></p>',
        '',
        '                <div class="privacy-gate" id="privacyGate" hidden>',
        '                    <p class="privacy-gate__note" id="privacyGateNote"></p>',
        '                    <button class="privacy-gate__button" type="button"',
        '                            id="privacyGateButton">Unlock private archive &rarr;</button>',
        '                </div>',
        '',
        '                <p class="field__error" id="privacyError" role="alert" aria-live="polite"></p>',
        '',
        '                <div class="audience-host" id="audienceHost" hidden></div>',
        '',
        '                <!-- The confirmation before a standard memory leaves the',
        '                     ordinary archive. In the sheet rather than in a',
        '                     window.confirm, so it can be read, styled and undone. -->',
        '                <div class="privacy-confirm" id="privacyConfirm" hidden>',
        '                    <p class="privacy-confirm__question">Move to the Private Archive?</p>',
        '                    <p class="privacy-confirm__note">',
        '                        This memory will disappear from Moments, the Timeline,',
        '                        Our World and the normal archive.',
        '                    </p>',
        '                    <div class="privacy-confirm__actions">',
        '                        <button class="privacy-confirm__cancel" type="button"',
        '                                id="privacyConfirmCancel">Cancel</button>',
        '                        <button class="privacy-confirm__yes" type="button"',
        '                                id="privacyConfirmYes">Make private</button>',
        '                    </div>',
        '                </div>',
        '            </section>',
        '',
        '            <p class="sheet__error" id="sheetError" role="alert" aria-live="polite"></p>',
        '',
        '            <div class="sheet__actions">',
        '                <button class="sheet__cancel" type="button" id="sheetCancel">Cancel</button>',
        '                <button class="sheet__save" type="submit">',
        '                    <span>Save Memory</span>',
        '                    <span aria-hidden="true">&rarr;</span>',
        '                </button>',
        '            </div>',
        '        </form>',
        '',
        '        <!-- Where a private memory ends up instead of the album. Closing the',
        '             sheet and redrawing Moments would look exactly like losing it. -->',
        '        <section class="sheet__private-saved" id="sheetPrivateSaved" hidden>',
        '            <p class="sheet__private-eyebrow">Private archive</p>',
        '            <h2 class="sheet__private-title">Saved to your private archive.</h2>',
        '            <p class="sheet__private-note" id="sheetPrivateSavedNote"></p>',
        '            <div class="sheet__private-actions">',
        '                <a class="sheet__private-action" id="sheetPrivateSavedView"',
        '                   href="../private/index.html">View Private Archive &rarr;</a>',
        '                <a class="sheet__private-action sheet__private-action--quiet"',
        '                   id="sheetPrivateSavedBack" href="../index.html">Back to Our Space &rarr;</a>',
        '            </div>',
        '        </section>',
        '    </div>',
        '</div>'
    ].join("\n");

    /* --------------------------------------------------------------- helpers */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function byId(id) { return document.getElementById(id); }

    /* ------------------------------------------------------------------------
       A searchable list attached to a text field.

       Both Country and City are the same widget with a different source: the
       country list is local (data/countries.js) and the city list is asked of
       the server. It is a real combobox — Arrow keys move, Enter chooses,
       Escape closes — because a mouse-only dropdown is not usable.

       The value the form reads is always the input's text, so typing a country
       that is not in the list still works; only *choosing* a city fills in
       coordinates.
       ---------------------------------------------------------------------- */
    function createCombobox(options) {
        var input = options.input;
        var list = options.list;
        var items = [];
        var active = -1;
        var open = false;

        function close() {
            if (!open) return;
            open = false;
            list.hidden = true;
            list.textContent = "";
            items = [];
            active = -1;
            input.setAttribute("aria-expanded", "false");
            input.removeAttribute("aria-activedescendant");
        }

        function paint() {
            list.textContent = "";
            if (!items.length) return;

            items.forEach(function (item, index) {
                var option = el("li", "combo__option");
                option.id = list.id + "-option-" + index;
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", index === active ? "true" : "false");
                if (index === active) option.classList.add("is-active");

                option.appendChild(el("span", "combo__name", item.label));
                if (item.detail) {
                    option.appendChild(el("span", "combo__detail", item.detail));
                }

                /* mousedown, not click: the input must not blur first. */
                option.addEventListener("mousedown", function (event) {
                    event.preventDefault();
                    choose(index);
                });
                list.appendChild(option);
            });
        }

        function show(next) {
            items = next || [];
            active = items.length ? 0 : -1;
            if (!items.length) { close(); return; }
            open = true;
            list.hidden = false;
            input.setAttribute("aria-expanded", "true");
            paint();
        }

        function note(message) {
            list.textContent = "";
            var item = el("li", "combo__note", message);
            item.setAttribute("role", "presentation");
            list.appendChild(item);
            open = true;
            items = [];
            active = -1;
            list.hidden = false;
            input.setAttribute("aria-expanded", "true");
        }

        function move(step) {
            if (!open || !items.length) return;
            active = (active + step + items.length) % items.length;
            input.setAttribute("aria-activedescendant", list.id + "-option-" + active);
            paint();
        }

        function choose(index) {
            var item = items[index];
            if (!item) return;
            close();
            options.onChoose(item);
        }

        input.addEventListener("keydown", function (event) {
            if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
            if (event.key === "Enter" && open && active >= 0) {
                /* Enter picks the highlighted item instead of submitting the
                   form, which is what the arrow keys just promised. */
                event.preventDefault();
                choose(active);
                return;
            }
            if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        });

        input.addEventListener("blur", function () {
            global.setTimeout(close, 120);
        });

        return {
            show: show,
            note: note,
            close: close,
            isOpen: function () { return open; },
            items: function () { return items.slice(); },
            activeIndex: function () { return active; }
        };
    }

    /* The date and time fields keep the browser's own picker. The little gold
       glyph is a background image, which cannot be clicked, so a click on the
       field that is *not* in the native indicator's strip opens the picker
       through showPicker(). The strip itself is left alone: the native control
       toggles when clicked, and asking twice would close what just opened. */
    function makePickerOpenable(input, indicatorStrip) {
        if (!input) return;
        input.addEventListener("click", function (event) {
            if (typeof input.showPicker !== "function") return;
            var box = input.getBoundingClientRect();
            if (box.right - event.clientX <= indicatorStrip) return;
            try {
                input.showPicker();
            } catch (error) {
                /* Already open, or the browser wants a gesture it did not get.
                   Either way the field still works the way it always did. */
            }
        });
    }

    function buildSelect(select, values, placeholder) {
        if (!select) return;
        select.textContent = "";

        var empty = document.createElement("option");
        empty.value = "";
        empty.textContent = placeholder;
        select.appendChild(empty);

        values.forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
            select.appendChild(option);
        });
    }

    /* ------------------------------------------------------------- the chips */
    function buildMoodChips() {
        moodChips.textContent = "";
        fields.moods.forEach(function (mood) {
            var chip = el("button", "chip", mood);
            chip.type = "button";
            chip.setAttribute("aria-pressed", "false");
            chip.addEventListener("click", function () {
                state.mood = state.mood === mood ? "" : mood;
                Array.prototype.forEach.call(moodChips.children, function (child) {
                    child.setAttribute("aria-pressed",
                        child.textContent === state.mood ? "true" : "false");
                });
            });
            moodChips.appendChild(chip);
        });
    }

    /* Four fixed collections, each an explicit choice. Nothing is guessed. */
    function buildCollectionChips() {
        collectionChips.textContent = "";
        fields.collections.forEach(function (collection) {
            var name = collection.label;
            var chip = el("button", "chip", name);
            chip.type = "button";
            chip.setAttribute("aria-pressed", "false");

            chip.addEventListener("click", function () {
                var at = state.collections.indexOf(name);
                if (at === -1) state.collections.push(name);
                else state.collections.splice(at, 1);
                chip.setAttribute("aria-pressed", at === -1 ? "true" : "false");
            });

            collectionChips.appendChild(chip);
        });
    }

    /* --------------------------------------------------------- field errors */
    /* The archive's date rule, kept in step with the server's: four digits, a
       real day in a real month, and a year a memory could be from. */
    var EARLIEST_DATE = "1900-01-01";
    var LATEST_DATE = "2099-12-31";
    var DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

    function dateProblem(value) {
        var text = String(value || "").trim();
        var match = DATE_SHAPE.exec(text);
        if (!match) return "Please enter a valid date, as YYYY-MM-DD.";

        var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        var probe = new Date(Date.UTC(year, month - 1, day));
        if (probe.getUTCFullYear() !== year ||
            probe.getUTCMonth() !== month - 1 ||
            probe.getUTCDate() !== day) {
            return "Please enter a real calendar date.";
        }
        if (text < EARLIEST_DATE || text > LATEST_DATE) {
            return "Please enter a date between " + EARLIEST_DATE + " and " + LATEST_DATE + ".";
        }
        return "";
    }

    /* Inline, next to the field it belongs to. Never a dialog. */
    function setFieldError(name, message) {
        var slot = byId(name + "Error");
        if (slot) {
            slot.textContent = message || "";
            slot.classList.toggle("is-on", !!message);
        }
        var input = byId(name);
        if (input) {
            if (message) input.setAttribute("aria-invalid", "true");
            else input.removeAttribute("aria-invalid");
        }
    }

    function clearFieldErrors() {
        ["photo", "memoryDate", "memoryTitle", "memoryCountry", "memoryCity"]
            .forEach(function (name) { setFieldError(name, ""); });
        if (sheetError) sheetError.textContent = "";
    }

    /* -------------------------------------------------------- photo staging */
    /* The chosen File is kept exactly as the visitor handed it over, and the
       ORIGINAL is what gets uploaded — no canvas, no downscaling, no data URL.
       A blob URL is made only so the preview below can show the picture, and
       is revoked as soon as it is no longer on screen. */
    var MAX_PHOTOS = 20;
    var ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    var ALIASED_TYPES = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

    function typeOf(file) {
        var declared = String((file && file.type) || "").toLowerCase();
        return ALIASED_TYPES[declared] || declared;
    }

    /* Returns the message to show, or "" when everything was staged. */
    function stageFiles(files) {
        var list = Array.prototype.slice.call(files || []);
        var rejected = 0;
        var room = MAX_PHOTOS - state.uploaded.length;

        if (list.length > room) {
            /* Say so rather than quietly dropping the rest. */
            setFieldError("photo", "You can add up to " + MAX_PHOTOS +
                " photographs to one memory.");
            list = list.slice(0, Math.max(0, room));
        } else {
            setFieldError("photo", "");
        }

        list.forEach(function (file) {
            if (ACCEPTED_TYPES.indexOf(typeOf(file)) === -1) {
                rejected++;
                return;
            }
            state.uploaded.push({
                file: file,
                url: global.URL && global.URL.createObjectURL
                    ? global.URL.createObjectURL(file)
                    : ""
            });
        });

        if (rejected) {
            setFieldError("photo", rejected === 1
                ? "One file was skipped \u2014 only JPEG, PNG and WebP photographs can be added."
                : rejected + " files were skipped \u2014 only JPEG, PNG and WebP photographs can be added.");
        }
        return state.uploaded.length;
    }

    /* Idempotent: close() and resetForm() both call this, and a URL must only
       ever be revoked once. Clearing it here is what makes the second call a
       no-op rather than a second revoke. */
    function releasePhotos() {
        state.uploaded.forEach(function (photo) {
            if (photo && photo.url && global.URL && global.URL.revokeObjectURL) {
                global.URL.revokeObjectURL(photo.url);
                photo.url = "";
            }
        });
    }

    function renderUploadPreview() {
        photoPreview.textContent = "";

        if (state.cover >= state.uploaded.length) state.cover = 0;

        state.uploaded.forEach(function (photo, index) {
            var isCover = index === state.cover;
            var thumb = el("div", "upload__thumb" + (isCover ? " upload__thumb--cover" : ""));

            var img = document.createElement("img");
            img.src = photo.url;
            img.alt = "";
            thumb.appendChild(img);

            if (isCover) {
                thumb.appendChild(el("span", "upload__badge", "Cover"));
            } else {
                var promote = el("button", "upload__cover", "Set as cover");
                promote.type = "button";
                promote.addEventListener("click", function () {
                    state.cover = index;
                    renderUploadPreview();
                });
                thumb.appendChild(promote);
            }

            var remove = el("button", "upload__remove", "\u00d7");
            remove.type = "button";
            remove.setAttribute("aria-label", "Remove photo");
            remove.addEventListener("click", function () {
                if (photo.url && global.URL && global.URL.revokeObjectURL) {
                    global.URL.revokeObjectURL(photo.url);
                }
                state.uploaded.splice(index, 1);
                /* Keep pointing at the same photograph where possible. */
                if (index < state.cover) state.cover -= 1;
                renderUploadPreview();
                setFieldError("photo", "");
            });
            thumb.appendChild(remove);

            photoPreview.appendChild(thumb);
        });
    }

    /* ------------------------------------------------- the cover of a memory
       In Edit mode the photographs are already on the server and are not this
       form's business — except for one thing: which of them represents the
       memory. Choosing one here changes nothing until Save Changes, so Cancel
       really does leave the archive alone. */
    function renderCoverPicker() {
        if (!coverPicker) return;
        coverPicker.textContent = "";

        state.existingPhotos.forEach(function (photo) {
            var isCover = photo.id !== null && photo.id === state.coverPhotoId;
            var thumb = el("div", "upload__thumb" + (isCover ? " upload__thumb--cover" : ""));

            var img = document.createElement("img");
            img.src = photo.url;
            img.alt = "";
            img.loading = "lazy";
            thumb.appendChild(img);

            if (isCover) {
                thumb.appendChild(el("span", "upload__badge", "Cover"));
            } else {
                var promote = el("button", "upload__cover", "Set as cover");
                promote.type = "button";
                promote.addEventListener("click", function () {
                    state.coverPhotoId = photo.id;
                    state.coverDirty = true;
                    renderCoverPicker();
                });
                thumb.appendChild(promote);
            }
            coverPicker.appendChild(thumb);
        });
    }

    function loadExistingPhotos(memory) {
        var records = (memory && memory.photoRecords) || [];
        state.existingPhotos = records.filter(function (record) {
            return record && record.id !== undefined && record.id !== null;
        }).map(function (record) {
            return {
                id: record.id,
                url: record.url || "",
                isCover: !!record.isCover
            };
        });

        var cover = state.existingPhotos.filter(function (p) { return p.isCover; })[0];
        state.coverPhotoId = cover ? cover.id : (state.existingPhotos[0] || {}).id;
        state.coverDirty = false;
        renderCoverPicker();
    }

    /* ------------------------------------------------------------ open/close */
    function open(options) {
        if (!sheet) return;
        options = options || {};

        /* One sheet, two modes. Editing shows the same fields, prefilled, and
           saves with PATCH instead of POST. */
        state.requireLocation = !!options.requireLocation;
        state.onSaved = typeof options.onSaved === "function" ? options.onSaved : null;

        /* resetForm() clears the mode AND the scope, so both are set after it —
           otherwise the sheet opens in "add" mode, and a private memory is
           saved through the ordinary route, which does not know it exists. */
        resetForm();
        /* "private" is not a different form: it is the same fields saved
           through the private archive's route, which is where an edit of a
           private memory has to go. */
        state.scope = options.scope === "private" ? "private" : "standard";
        var target = options.memory || null;
        state.mode = target ? "edit" : "add";
        state.editing = target;
        state.editingMemoryId = target ? target.id : null;
        applyMode();
        if (target) prefill(target);
        else applyPreset(options.preset);

        applyPrivacyMode();
        loadPrivacyStatus();

        sheet.hidden = false;
        global.requestAnimationFrame(function () {
            sheet.classList.add("is-open");
            /* A pre-filled memory is already part-way written, so start the
               visitor at the title rather than at the photographs. */
            var focusTarget = options.preset ? byId("memoryDate") : byId("photoInput");
            if (state.mode === "edit") focusTarget = byId("memoryTitle");
            if (focusTarget && focusTarget.focus) focusTarget.focus();
        });
    }

    function close() {
        if (!sheet) return;
        /* Nothing on screen is using the previews any more. */
        releasePhotos();
        /* The next open reads resetForm() anyway; this keeps the sheet from
           ever being reopened in the private-saved state by a path that does
           not. */
        setFieldHidden("sheetPrivateSaved", true);
        if (form) form.hidden = false;
        sheet.classList.remove("is-open");
        global.setTimeout(function () { sheet.hidden = true; }, reducedMotion ? 20 : 500);
    }

    function resetForm() {
        form.reset();
        releasePhotos();
        var photoGroup = byId("photoInput").closest(".field-group");
        if (photoGroup) photoGroup.hidden = false;
        state.mode = "add";
        state.editing = null;
        state.editingMemoryId = null;
        state.uploaded = [];
        state.cover = 0;
        state.existingPhotos = [];
        state.coverPhotoId = null;
        state.collections = [];
        state.mood = "";
        /* Privacy starts where a new memory starts: standard, in the ordinary
           archive, with nothing read yet about the private one. */
        state.privacy = "standard";
        state.scope = "standard";
        state.permission = null;
        state.privacyAccess = [];
        state.privacyPreset = "only";
        state.members = null;
        state.audience = null;
        state.confirmingPrivacy = false;
        setFieldHidden("privacyConfirm", true);
        /* The sheet goes back to being a form: the private-saved panel is only
           ever the end of one save. */
        setFieldHidden("sheetPrivateSaved", true);
        if (form) form.hidden = false;
        setFieldHidden("privacyGate", true);
        setFieldHidden("audienceHost", true);
        var standardChoice = byId("privacyStandard");
        if (standardChoice) standardChoice.checked = true;
        clearFieldErrors();
        renderUploadPreview();

        /* A place carries over into nothing: the next memory starts with no
           country code, no city search and no coordinates. */
        setCountryCode("");
        markCoordinates("");
        citySearch.token++;
        if (citySearch.timer) { global.clearTimeout(citySearch.timer); citySearch.timer = null; }
        if (countryBox) countryBox.close();
        if (cityBox) cityBox.close();
        refreshCityAvailability();

        Array.prototype.forEach.call(moodChips.children, function (chip) {
            chip.setAttribute("aria-pressed", "false");
        });
        Array.prototype.forEach.call(collectionChips.children, function (chip) {
            chip.setAttribute("aria-pressed", "false");
        });
    }

    /* The Map asks for a place; the album does not. Only the marker and the
       wording change — it is the same form either way. */
    function applyMode() {
        var required = state.requireLocation;

        var editing = state.mode === "edit";
        byId("sheetTitle").textContent = editing
            ? "Edit Memory"
            : (required ? "Add Memory Here" : "Add Memory");

        var saveLabel = form.querySelector(".sheet__save span");
        if (saveLabel) {
            saveLabel.dataset.idle = editing ? "Save Changes" : "Save Memory";
            saveLabel.textContent = saveLabel.dataset.idle;
        }
        byId("sheetLead").textContent = editing
            ? "Change anything here. The photographs stay as they are."
            : (required
                ? "A photograph, a date, a title and a place. The place is what puts this memory on the map."
                : "Only three things are required: a photograph, a date and a title. Everything else can be filled in later \u2014 or never.");

        /* Tags, collections and the moment type are not stored on the server
           yet, so in Edit mode they are hidden rather than shown ticked and
           then quietly discarded. Adding still offers them, as it always has. */
        setFieldHidden("tagsField", editing);
        setFieldHidden("collectionsField", editing);
        setFieldHidden("momentField", editing);
        var organizeNote = byId("organizeNote");
        if (organizeNote) organizeNote.hidden = !editing;

        /* Editing a memory offers exactly one thing about its photographs:
           which of them is the cover. Adding keeps the upload group instead. */
        var coverGroup = byId("coverGroup");
        if (coverGroup) coverGroup.hidden = !(editing && state.existingPhotos.length > 1);
        var photoGroup = byId("photoGroup");
        if (photoGroup) photoGroup.hidden = editing;
        /* Hidden is not enough on its own: a disabled input cannot be opened
           by any route, so an edit really has no way to add a photograph. */
        var uploadInput = byId("photoInput");
        if (uploadInput) uploadInput.disabled = editing;

        countryLabel.textContent = "Country";
        cityLabel.textContent = "City";
        countryLabel.className = "field__label" + (required ? " field__label--req" : "");
        cityLabel.className = "field__label" + (required ? " field__label--req" : "");

        if (required) {
            countryLabel.appendChild(el("em", "field__req", " *"));
            cityLabel.appendChild(el("em", "field__req", " *"));
        }

        locationNote.textContent = required
            ? "This place is passed straight from the map. Adjust it if the pin landed in the wrong spot."
            : "Coordinates are optional. Without them the place still appears in the album and the Timeline \u2014 it just cannot be pinned on the globe.";

        applyPrivacyMode();
    }

    function setFieldHidden(id, hidden) {
        var node = byId(id);
        if (node) node.hidden = !!hidden;
    }

    /* ---------------------------------------------------------------- privacy */

    function privacy() { return global.LoveStoryPrivacy || null; }
    function audience() { return global.LoveStoryAudience || null; }

    function mySpace() {
        return (global.LoveStoryAuth && global.LoveStoryAuth.currentSpace) || null;
    }

    function myUserId() {
        var user = global.LoveStoryAuth && global.LoveStoryAuth.user;
        return user ? Number(user.id) : null;
    }

    /* Is this memory mine to make private?

       The owner is `createdBy.id` on the memory, which the archive has always
       returned — so no new field was needed for this, and no backend change was
       made. A memory created before accounts existed has no owner, and nobody
       may move it. */
    function iOwn(memory) {
        if (!memory || !memory.createdBy) return false;
        var me = myUserId();
        return me !== null && Number(memory.createdBy.id) === me;
    }

    /* Show or hide the privacy section, and the private choice inside it, for
       the memory currently in the form. */
    function applyPrivacyMode() {
        var group = byId("privacyGroup");
        if (!group) return;

        var editing = state.mode === "edit";
        var privateScope = state.scope === "private";
        var owner = iOwn(state.editing);
        var personal = (mySpace() || {}).type === "personal";

        byId("privacyStandardNote").textContent = personal
            ? "Visible normally in your space."
            : "Visible normally to members of this space.";

        /* A private memory being edited here is already private: the privacy
           question was settled when it was made. Its owner gets PRIVACY &
           ACCESS (the audience control); an editor gets no privacy section at
           all, because none of it is theirs to change. */
        if (privateScope) {
            var canManage = state.permission === "owner";
            group.hidden = !canManage;
            byId("privacyChoice").hidden = true;
            byId("privacyTitle").textContent = "Privacy & Access";
            byId("privacyOwnerNote").hidden = true;
            if (canManage) ensureAudience();
            return;
        }

        group.hidden = false;
        byId("privacyChoice").hidden = false;
        byId("privacyTitle").textContent = "Privacy";

        /* Editing somebody else's standard memory: the private option is not
           shown at all. They may edit what it says — that has always been true
           in a shared space — but making another person's memory disappear from
           the archive is not an edit, and a disabled control would only invite
           the argument. */
        var privateOption = byId("privacyPrivateOption");
        privateOption.hidden = editing && !owner;

        var note = byId("privacyOwnerNote");
        if (editing && !owner) {
            note.hidden = false;
            note.textContent = "Only the person who made this memory can move it "
                + "to their private archive.";
        } else if (editing && owner) {
            note.hidden = false;
            note.textContent = "Moving this memory to your private archive takes it "
                + "out of Moments, the Timeline and Our World.";
        } else {
            note.hidden = true;
            note.textContent = "";
        }

        if (state.privacy === "private") refreshPrivacyGate();
        else hideGate();
    }

    function hideGate() {
        setFieldHidden("privacyGate", true);
        setFieldHidden("audienceHost", true);
    }

    /* The gate in front of PRIVATE.

       Two things can be missing, and they read differently: no privacy password
       has ever been set, or one has been set and this sign-in has not opened the
       archive. Neither is an error, so neither is shown as one — each is a
       button that fixes it, and the memory being written stays exactly where it
       is while the modal is open. */
    function refreshPrivacyGate() {
        var gate = byId("privacyGate");
        if (!gate) return;

        var known = privacy() ? privacy().knownStatus() : null;
        if (!known) {
            /* Not answered yet: ask, then draw. Nothing private is shown either
               way, so this is only about which button to offer. */
            privacy().status().then(function () { refreshPrivacyGate(); });
            return;
        }
        var configured = !!(known && known.configured);
        var unlocked = !!(known && known.unlocked);
        state.privacyConfigured = configured;
        state.privacyUnlocked = unlocked;

        if (configured && unlocked) {
            gate.hidden = true;
            ensureAudience();
            return;
        }

        setFieldHidden("audienceHost", true);
        gate.hidden = false;
        byId("privacyGateNote").textContent = configured
            ? "Your private archive is closed. Open it to save this memory there."
            : "Your private archive needs a password before anything can be kept in it.";
        var button = byId("privacyGateButton");
        button.textContent = configured
            ? "Unlock private archive \u2192"
            : "Set up private archive \u2192";
        button.dataset.action = configured ? "unlock" : "setup";
    }

    /* Ask privacy.js for the current status, once, when the sheet opens. */
    function loadPrivacyStatus() {
        if (!privacy()) return;
        privacy().status().then(function () {
            if (state.privacy === "private") refreshPrivacyGate();
        });
    }

    /* The audience control, mounted the first time it is needed. The members
       are read once per open: somebody who was removed from the space this
       morning must not still be on the list. */
    function ensureAudience() {
        var host = byId("audienceHost");
        if (!host || !audience()) return;

        var space = mySpace();
        var personal = !space || space.type !== "group";

        function mount(members) {
            host.hidden = false;
            state.audience = audience().mount(host, {
                members: members,
                ownerId: myUserId(),
                personal: personal,
                preset: state.privacyPreset,
                access: state.privacyAccess
            });
        }

        if (personal || state.members) {
            mount(state.members || []);
            return;
        }

        var api = global.LoveStoryApi;
        if (!api || !space || !space.id) { mount([]); return; }
        api.listMembers(space.id).then(function (data) {
            state.members = (data && data.members) || [];
            /* The preset is only derivable once the members are known: "everyone"
               means "everyone who is in this space now". */
            if (state.privacyPreset === null) {
                state.privacyPreset = audience().presetFor(
                    state.privacyAccess, state.members, myUserId());
            }
            mount(state.members);
        }, function () {
            state.members = [];
            mount([]);
        });
    }

    function readPrivacyChoice() {
        var chosen = form.querySelector('input[name="memoryPrivacy"]:checked');
        state.privacy = chosen ? chosen.value : "standard";
    }

    function onPrivacyChoice() {
        readPrivacyChoice();
        byId("privacyError").textContent = "";
        state.confirmingPrivacy = false;
        setFieldHidden("privacyConfirm", true);
        refreshPrivacyGate();
    }

    function askGate() {
        var button = byId("privacyGateButton");
        var action = button && button.dataset.action;
        if (!action || !privacy()) return;
        privacy().openModal(action === "unlock" ? "unlock" : "setup", {
            onDone: function () {
                byId("privacyError").textContent = "";
                refreshPrivacyGate();
            }
        });
    }

    /* What the server is sent about who may see it. Never a preset name: the
       server stores people, one row each, and has no idea what "everyone"
       means. */
    function privacyAccessPayload() {
        if (state.privacy !== "private") return null;
        if (state.audience) return state.audience.value().access;
        return state.privacyAccess || [];
    }

    /* Put an existing memory back into the form. Every field it can carry is
       restored, so nothing is silently dropped on the way through. */
    function prefill(memory) {
        byId("memoryTitle").value = memory.title || "";
        byId("memoryDate").value = memory.date || "";
        byId("memoryTime").value = memory.time || "";
        byId("memoryDescription").value = memory.description || "";

        var location = memory.location || null;
        if (location) {
            byId("memoryCountry").value = location.country || "";
            byId("memoryCity").value = location.city || "";
            /* An older memory stores only the country's text. The code is
               recovered from the local list so the city search works when the
               form is opened; unknown text is left alone, not guessed at. */
            byId("memoryCountryCode").value =
                location.countryCode || codeForCountry(location.country) || "";
            byId("memoryLat").value = location.latitude === null || location.latitude === undefined
                ? "" : location.latitude;
            byId("memoryLng").value = location.longitude === null || location.longitude === undefined
                ? "" : location.longitude;
            markCoordinates("stored");
        }

        /* The record may already name a country, which is all the City field
           needs before it can be typed into again. Without this an edit opens
           with City still disabled from resetForm(). */
        refreshCityAvailability();

        var weather = memory.weather || {};
        byId("memoryWeather").value = weather.condition || "";
        byId("memoryTemp").value = weather.temperature === null || weather.temperature === undefined
            ? "" : weather.temperature;

        byId("memoryFavorite").checked = !!memory.favorite;
        byId("memoryTimeline").checked = !!memory.showOnTimeline;
        byId("memoryMoment").value = memory.momentType || "";

        /* The chips are buttons, so their state is their aria-pressed. */
        state.mood = memory.mood || "";
        Array.prototype.forEach.call(moodChips.children, function (chip) {
            chip.setAttribute("aria-pressed",
                chip.textContent === state.mood ? "true" : "false");
        });

        state.collections = (memory.collections || []).slice();
        Array.prototype.forEach.call(collectionChips.children, function (chip) {
            chip.setAttribute("aria-pressed",
                state.collections.indexOf(chip.textContent) !== -1 ? "true" : "false");
        });

        /* Privacy, as the server answered. An owner is given the access list;
           an editor and a viewer are not, which is why the preset can only be
           derived when there is one — for anybody else the question is not
           being asked. */
        state.permission = memory.privatePermission || null;
        state.privacy = memory.privacyMode === "private" ? "private" : "standard";
        state.privacyAccess = memory.privateAccess || [];
        state.privacyPreset = memory.privateAccess
            ? null              /* derived once the members are known */
            : (state.privacy === "private" ? "only" : "only");

        var privateChoice = byId("privacyPrivate");
        var standardChoice = byId("privacyStandard");
        if (state.privacy === "private") privateChoice.checked = true;
        else standardChoice.checked = true;

        /* An existing memory already has its photographs; they are not staged
           here. The picker below only chooses which one is the cover, and the
           choice is not sent until Save Changes. */
        loadExistingPhotos(memory);
        applyMode();
    }

    /* ------------------------------------------------------------- the place
       Country and City, and the coordinates that follow from them.

       The rule that matters: coordinates only ever describe the city that is
       currently chosen. Change the country, retype the city, and any position
       left over from the previous choice is cleared immediately — so the form
       can never save "Australia / Chengdu / 30.57, 104.07", which is a place
       that does not exist. */
    var citySearch = { token: 0, timer: null, country: "" };

    function countryList() {
        return (global.LoveStoryCountries && global.LoveStoryCountries.list) || [];
    }

    function codeForCountry(name) {
        var found = global.LoveStoryCountries && global.LoveStoryCountries.matchName
            ? global.LoveStoryCountries.matchName(name) : null;
        return found ? found.code : "";
    }

    function labelForCountry(code) {
        var found = global.LoveStoryCountries && global.LoveStoryCountries.byCode
            ? global.LoveStoryCountries.byCode(code) : null;
        return found ? found.name : "";
    }

    function markCoordinates(how) {
        var lat = byId("latAuto");
        var lng = byId("lngAuto");
        /* "auto" while the position came from a chosen city; "stored" when the
           memory already had one; blank when it is the visitor's own entry. */
        var text = how === "auto" ? "from location" : (how === "stored" ? "saved" : "");
        if (lat) lat.textContent = text;
        if (lng) lng.textContent = text;
    }

    function clearCoordinates() {
        byId("memoryLat").value = "";
        byId("memoryLng").value = "";
        markCoordinates("");
    }

    /* Empty the city from the moment its text stops describing the chosen one. */
    function clearCityAndCoordinates() {
        byId("memoryCity").value = "";
        clearCoordinates();
    }

    function setCountryCode(code) {
        byId("memoryCountryCode").value = code || "";
    }

    function refreshCityAvailability() {
        var code = byId("memoryCountryCode").value;
        var city = byId("memoryCity");
        var ready = !!code;

        city.disabled = !ready;
        city.placeholder = ready ? "" : "Select a country first";
        city.setAttribute("aria-disabled", ready ? "false" : "true");
        if (!ready && cityBox) cityBox.close();
    }

    function runCitySearch(query) {
        var code = byId("memoryCountryCode").value;
        if (!code) return;

        var text = String(query || "").trim();
        if (!text) { cityBox.close(); return; }

        /* The provider only matches on a prefix once there are a few letters,
           so a single character is answered with a nudge rather than a
           confusing "no matches". */
        if (text.length < 2) {
            cityBox.note("Keep typing for suggestions\u2026");
            return;
        }

        var token = ++citySearch.token;
        cityBox.note("Searching\u2026");
        global.LoveStoryApi.cities(code, text).then(function (cities) {
            if (token !== citySearch.token) return;
            var current = String(byId("memoryCity").value || "").trim();
            if (!cityBox.isOpen() && current !== text) return;
            if (!cities.length) { cityBox.note("No matching cities"); return; }
            cityBox.show(cities.map(function (city) {
                return {
                    label: city.name,
                    detail: [city.admin1, city.country].filter(Boolean).join(" \u00b7 "),
                    city: city
                };
            }));
        }, function (failure) {
            if (token !== citySearch.token) return;
            /* A failed lookup must not block the form: the city can be typed by
               hand, and its coordinates left empty or entered manually. */
            console.error("Love Story: city lookup failed.", failure);
            cityBox.note("Could not load city suggestions. You can still enter the city manually.");
        });
    }

    function scheduleCitySearch() {
        if (citySearch.timer) global.clearTimeout(citySearch.timer);
        citySearch.timer = global.setTimeout(function () {
            citySearch.timer = null;
            runCitySearch(byId("memoryCity").value);
        }, 280);
    }

    function chooseCity(city) {
        if (!city) return;
        byId("memoryCity").value = city.name || "";
        setCountryCode(city.countryCode || byId("memoryCountryCode").value);
        /* The suggestion already carries its position, so it is never looked
           up a second time. */
        if (typeof city.latitude === "number") byId("memoryLat").value = city.latitude;
        if (typeof city.longitude === "number") byId("memoryLng").value = city.longitude;
        markCoordinates("auto");
    }

    function wireLocationFields() {
        var countryInput = byId("memoryCountry");
        var cityInput = byId("memoryCity");

        countryBox = createCombobox({
            input: countryInput,
            list: byId("countryList"),
            onChoose: function (item) {
                countryInput.value = item.country.name;
                setCountryCode(item.country.code);
                /* A different country means the city, and everything the old
                   city put on the map, is no longer this memory's place. */
                clearCityAndCoordinates();
                refreshCityAvailability();
                cityInput.focus();
            }
        });

        cityBox = createCombobox({
            input: cityInput,
            list: byId("cityList"),
            onChoose: function (item) {
                chooseCity(item.city);
            }
        });

        countryInput.addEventListener("input", function () {
            var code = codeForCountry(countryInput.value);
            var previous = byId("memoryCountryCode").value;
            setCountryCode(code);
            if (code !== previous) {
                /* The country text changed underneath the chosen city. */
                clearCityAndCoordinates();
            }
            refreshCityAvailability();
            var text = countryInput.value.trim();
            if (!text) { countryBox.close(); return; }
            countryBox.show(countryList().length
                ? (global.LoveStoryCountries.search(text, 8)).map(function (country) {
                    return { label: country.name, detail: country.code, country: country };
                })
                : []);
        });

        cityInput.addEventListener("input", function () {
            /* Typing over a chosen city invalidates its position at once; only
               choosing a suggestion puts coordinates back. */
            clearCoordinates();
            scheduleCitySearch();
        });

        cityInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !cityBox.isOpen()) event.preventDefault();
        });

        byId("memoryLat").addEventListener("input", function () { markCoordinates(""); });
        byId("memoryLng").addEventListener("input", function () { markCoordinates(""); });
    }

    /* Fill the Where group from a place the map already knows about. */
    function applyPreset(preset) {
        if (!preset) return;

        byId("memoryCountry").value = preset.country || "";
        byId("memoryCity").value = preset.city || preset.placeName || "";
        setCountryCode(preset.countryCode || codeForCountry(preset.country));

        if (preset.latitude !== null && preset.latitude !== undefined) {
            byId("memoryLat").value = preset.latitude;
        }
        if (preset.longitude !== null && preset.longitude !== undefined) {
            byId("memoryLng").value = preset.longitude;
        }
        markCoordinates("auto");
        refreshCityAvailability();
    }

    /* ---------------------------------------------------------------- saving */
    function saveMemory(event) {
        /* Called two ways: by the form's submit, and by the confirmation that
           precedes taking a standard memory out of the ordinary archive. */
        var options = (event && event.preventDefault) ? {} : (event || {});
        if (event && event.preventDefault) event.preventDefault();
        clearFieldErrors();

        /* Privacy is decided first, because it decides WHERE this is saved
           rather than what it says. */
        readPrivacyChoice();

        /* The gate blocks a save only when the answer is KNOWN and it is "no".
           An unanswered status is not a locked archive: the request goes, and
           if the archive really is closed the server answers 423 and the gate
           opens with that as the reason. Deciding on a status this page has not
           received yet would refuse a perfectly good save. */
        var privacyKnown = privacy() ? privacy().knownStatus() : null;
        if (state.privacy === "private" && privacyKnown
                && !(privacyKnown.configured && privacyKnown.unlocked)) {
            /* The sheet stays open and the gate says what to do. Nothing the
               person typed is touched, and nothing is sent. */
            refreshPrivacyGate();
            byId("privacyError").textContent = state.privacyConfigured
                ? "Open your private archive before saving here."
                : "Set up your private archive before saving here.";
            var gateButton = byId("privacyGateButton");
            if (gateButton && gateButton.focus) gateButton.focus();
            return;
        }

        /* A standard memory becoming private is the one privacy change that
           happens through the ordinary route, and the only one that takes the
           memory away from everybody else in the space. It asks first. */
        var becomingPrivate = state.privacy === "private"
            && state.mode === "edit"
            && state.editing
            && state.editing.privacyMode !== "private";
        if (becomingPrivate && !options.confirmed) {
            byId("privacyConfirm").hidden = false;
            state.confirmingPrivacy = true;
            byId("privacyConfirmYes").focus();
            return;
        }
        state.confirmingPrivacy = false;

        /* Required fields, checked in the order they appear. */
        var firstInvalid = null;

        /* Editing keeps the photographs it already has, so the requirement is
           only enforced when adding. */
        if (state.mode !== "edit" && !state.uploaded.length) {
            setFieldError("photo",
                "Add at least one photograph \u2014 a memory without one has no tile in the album.");
            firstInvalid = firstInvalid || byId("photoInput");
        }

        var date = byId("memoryDate").value;
        if (!date) {
            setFieldError("memoryDate",
                "A date is required \u2014 it decides the year, the album and the Timeline.");
            firstInvalid = firstInvalid || byId("memoryDate");
        } else {
            /* The browser will accept a six-digit year and call it valid, so
               the shape of the date is checked here rather than trusted. */
            var problem = dateProblem(date);
            if (problem) {
                setFieldError("memoryDate", problem);
                firstInvalid = firstInvalid || byId("memoryDate");
            }
        }

        var title = byId("memoryTitle").value.trim();
        if (!title) {
            setFieldError("memoryTitle", "A title is required \u2014 it is how you will find this again.");
            firstInvalid = firstInvalid || byId("memoryTitle");
        }

        var country = byId("memoryCountry").value.trim();
        var city = byId("memoryCity").value.trim();

        /* From the map a memory with no place is meaningless: it could never
           be plotted, which is the whole point of writing it there. */
        if (state.requireLocation && !country && !city) {
            setFieldError("memoryCity",
                "A place is required here \u2014 without one this memory cannot appear on the map.");
            firstInvalid = firstInvalid || byId("memoryCity");
        }

        if (firstInvalid) {
            sheetError.textContent = state.mode === "edit"
                ? "A date and a title are required."
                : (state.requireLocation
                    ? "A photograph, a date, a title and a place are required."
                    : "A photograph, a date and a title are required.");
            if (firstInvalid.focus) firstInvalid.focus();
            return;
        }

        var lat = byId("memoryLat").value;
        var lng = byId("memoryLng").value;

        /* Coordinates are only stored when they are actually known \u2014 nothing
           is invented on the visitor's behalf. */
        var location = (country || city) ? {
            country: country,
            countryCode: byId("memoryCountryCode").value.trim(),
            city: city,
            placeName: city || country,
            latitude: lat === "" ? null : Number(lat),
            longitude: lng === "" ? null : Number(lng)
        } : null;

        var temperature = byId("memoryTemp").value;

        /* --------------------------------------------------------- the upload
           The photographs travel as the original files, in one multipart
           request. Nothing is written to a front-end array: the server puts
           the images on disk and the record in SQLite, and the Library is
           re-read from it afterwards. */
        if (!global.LoveStoryApi) {
            sheetError.textContent =
                "The archive server is not loaded on this page, so this memory cannot be saved.";
            return;
        }

        var payload = new FormData();

        state.uploaded.forEach(function (photo) {
            /* The third argument keeps the visitor's own filename, which the
               server stores as original_name while generating its own. */
            payload.append("photos", photo.file, photo.file.name || "photo");
        });

        payload.append("title", title);
        payload.append("date", date);
        payload.append("time", byId("memoryTime").value);
        payload.append("country", country);
        payload.append("city", city);
        payload.append("place_name", location ? location.placeName : "");
        payload.append("latitude", lat === "" ? "" : String(lat));
        payload.append("longitude", lng === "" ? "" : String(lng));
        payload.append("weather", byId("memoryWeather").value);
        payload.append("temperature", temperature === "" ? "" : String(temperature));
        payload.append("mood", state.mood);
        payload.append("description", byId("memoryDescription").value.trim());
        payload.append("favorite", byId("memoryFavorite").checked ? "true" : "");
        payload.append("show_on_timeline", byId("memoryTimeline").checked ? "true" : "");
        payload.append("cover", String(state.cover));

        /* Editing: the photographs stay exactly as they are. The one thing that
           may travel is which of them is the cover, and only when it was
           actually changed — so Cancel leaves the archive untouched. */
        if (state.mode === "edit" && state.coverDirty && state.coverPhotoId !== null) {
            payload.append("cover_photo_id", String(state.coverPhotoId));
        }

        /* Privacy travels with the ordinary fields.

           A standard memory sends `standard` and no access list at all; a
           private one sends its mode and the people, expanded from whatever the
           audience control currently says — never a preset name, because the
           server stores people. */
        if (state.scope === "private") {
            /* Inside the private archive the privacy question was settled when
               the memory was made: it is private, and it stays private. Sending
               the mode it already has would be asking the server to confirm a
               change nobody is making — and an editor may not make one, so the
               request would be refused for the wrong reason. The owner's "Make
               standard" is its own action, not a field on this form. */
        } else {
            payload.append("privacyMode", state.privacy);
            if (state.privacy === "private") {
                payload.append("privateAccess", JSON.stringify(privacyAccessPayload()));
            }
        }

        setSaving(true);

        /* The id, not the snapshot: refreshMemories() may replace the store's
           object while this request is in flight. */
        var editingId = state.editingMemoryId;
        var editing = state.mode === "edit";
        var attempt;
        if (state.scope === "private") {
            /* A private memory is saved through the private archive, always.
               The ordinary route does not know it exists. */
            attempt = global.LoveStoryApi.privateUpdate(editingId, payload);
        } else {
            attempt = editing
                ? global.LoveStoryApi.update(editingId, payload)
                : global.LoveStoryApi.create(payload);
        }

        attempt.then(function (memory) {
            setSaving(false);
            var callback = state.onSaved;
            var wentPrivate = memory && memory.privacyMode === "private"
                && state.scope !== "private";

            /* A private memory does not appear in the album, so closing the
               sheet and redrawing Moments would look exactly like losing it.
               The sheet says where it went, and offers both places to go next. */
            if (wentPrivate) {
                /* The caller is NOT told, and that is deliberate: a private
                   memory is not in the ordinary store, so there is nothing for
                   the album to redraw — and a page that closed the sheet on
                   success would close it over the one screen that says where
                   the memory actually went. The sheet owns this ending. */
                showPrivateSaved(memory);
                return;
            }

            close();
            resetForm();

            /* Whoever opened the sheet decides what to redraw. */
            if (callback) callback(memory);

            document.dispatchEvent(new CustomEvent("lovestory:memory-added", {
                detail: { memory: memory }
            }));
        }, function (error) {
            setSaving(false);
            /* The sheet stays open with everything still in it, so nothing the
               visitor typed is lost and they can simply try again. */
            console.error("Love Story: saving failed.", error);

            /* 423: the ten minutes ran out between choosing PRIVATE and
               pressing Save. The gate reopens rather than an error being
               shouted about something the person can simply fix. */
            if (error && error.status === 423) {
                if (privacy()) privacy().expired();
                state.privacyConfigured = true;
                state.privacyUnlocked = false;
                refreshPrivacyGate();
                byId("privacyError").textContent =
                    "Your private archive locked itself. Open it again to save here.";
                return;
            }
            if (error && error.status === 403) {
                byId("privacyError").textContent =
                    "Your access to this memory has changed. Reload to see what is.";
                return;
            }
            sheetError.textContent = editing
                ? "Could not save these changes. Please try again."
                : "Could not save this memory. Please try again.";
        });
    }

    /* The end of a private create: not the album, and not silence. */
    function showPrivateSaved(memory, callback) {
        var note = byId("sheetPrivateSavedNote");
        if (note) {
            note.textContent = "“" + (memory.title || "This memory")
                + "” is not in Moments, the Timeline or Our World. It is in "
                + "your private archive, and only there.";
        }
        form.hidden = true;
        byId("sheetPrivateSaved").hidden = false;
        byId("sheetTitle").textContent = "Saved";
        if (callback) callback(memory);

        document.dispatchEvent(new CustomEvent("lovestory:memory-added", {
            detail: { memory: memory }
        }));
    }

    /* A second click while the first upload is in flight would create two
       memories, so the button reports what is happening and refuses to fire. */
    function setSaving(busy) {
        state.saving = busy;

        var button = form.querySelector(".sheet__save");
        if (!button) return;

        button.disabled = busy;
        button.setAttribute("aria-busy", busy ? "true" : "false");

        var label = button.querySelector("span");
        if (label) {
            if (busy && !label.dataset.idle) label.dataset.idle = label.textContent;
            label.textContent = busy ? "Saving\u2026" : (label.dataset.idle || "Save Memory");
        }
    }

    /* ----------------------------------------------------------------- mount */
    function mount() {
        var host = document.createElement("div");
        host.innerHTML = MARKUP;
        var node = host.firstChild;
        document.body.appendChild(node);

        sheet = node;
        form = byId("memoryForm");
        sheetError = byId("sheetError");
        photoPreview = byId("photoPreview");
        moodChips = byId("moodChips");
        collectionChips = byId("collectionChips");
        locationNote = byId("locationNote");
        coverPicker = byId("coverPicker");
        cityLabel = byId("cityLabel");
        countryLabel = byId("countryLabel");

        buildSelect(byId("memoryWeather"), fields.weatherConditions, "Not recorded");
        buildSelect(byId("memoryMoment"), fields.momentTypes, "Everyday");
        buildMoodChips();
        buildCollectionChips();
        renderUploadPreview();

        /* The date and time keep the browser's own picker, opened by a click
           anywhere on the field. The glyph itself is drawn by the stylesheet,
           so 44px of the right-hand side is left to the native control. */
        makePickerOpenable(byId("memoryDate"), 44);
        makePickerOpenable(byId("memoryTime"), 44);
        wireLocationFields();
        refreshCityAvailability();

        /* The privacy choice, the gate's button and the confirmation. All three
           are part of the sheet, so none of them can be missed by a page that
           mounted the sheet and forgot them. */
        Array.prototype.forEach.call(
            form.querySelectorAll('input[name="memoryPrivacy"]'),
            function (radio) { radio.addEventListener("change", onPrivacyChoice); });
        byId("privacyGateButton").addEventListener("click", askGate);
        byId("privacyConfirmCancel").addEventListener("click", function () {
            state.confirmingPrivacy = false;
            setFieldHidden("privacyConfirm", true);
        });
        byId("privacyConfirmYes").addEventListener("click", function () {
            state.confirmingPrivacy = true;
            setFieldHidden("privacyConfirm", true);
            saveMemory({ confirmed: true });
        });

        /* Where a private memory goes instead of the album. Both links come
           from the one file that knows where pages live. */
        var routes = global.LoveStoryRoutes;
        if (routes) {
            byId("sheetPrivateSavedView").href = routes.page("privateArchive");
            byId("sheetPrivateSavedBack").href = routes.hub();
        }

        byId("sheetClose").addEventListener("click", close);
        byId("sheetScrim").addEventListener("click", close);
        /* Cancel is the same act as the close cross: nothing is sent, nothing
           in the store changes, and the visitor is back where they were. */
        byId("sheetCancel").addEventListener("click", close);
        form.addEventListener("submit", saveMemory);

        byId("photoInput").addEventListener("change", function (event) {
            stageFiles(Array.prototype.slice.call(event.target.files || []));
            renderUploadPreview();
            event.target.value = "";
        });

        /* Any element anywhere can open the sheet, so a page does not have to
           wire each trigger by hand. */
        document.addEventListener("click", function (event) {
            if (event.target instanceof Element && event.target.closest("[data-open-add]")) {
                event.preventDefault();
                open();
            }
        });

        document.addEventListener("keydown", function (event) {
            if (sheet.hidden) return;
            if (event.key !== "Escape") return;
            /* A confirmation is the innermost thing on the sheet, so it is what
               Escape dismisses first: taking the whole sheet away because
               somebody changed their mind about going private would lose the
               memory they were writing. */
            if (state.confirmingPrivacy) {
                state.confirmingPrivacy = false;
                setFieldHidden("privacyConfirm", true);
                byId("privacyPrivate").focus();
                return;
            }
            close();
        });

        /* The archive locked while the sheet was open — the ten minutes ran out,
           or somebody pressed LOCK on the Hub in another tab of this document.

           Whatever the form was holding about the private archive goes: the
           member list and the access choices are not something to leave lying
           on the screen after a lock. A PRIVATE MEMORY'S CONTENT goes further
           than that — the sheet closes, because the whole point of the lock is
           that nothing private is still displayed. A standard memory that was
           merely being aimed at the private archive keeps its title, its date
           and its photographs; only the destination is reset. */
        if (global.LoveStoryPrivacy) {
            global.LoveStoryPrivacy.onLock(function () {
                if (!sheet || sheet.hidden) return;

                state.audience = null;
                state.members = null;
                state.privacyAccess = [];
                state.privacyPreset = "only";
                var host = byId("audienceHost");
                if (host) {
                    host.textContent = "";
                    host.hidden = true;
                }

                if (state.scope === "private") {
                    close();
                    resetForm();
                    return;
                }
                if (state.privacy === "private") {
                    state.privacy = "standard";
                    var standard = byId("privacyStandard");
                    if (standard) standard.checked = true;
                    refreshPrivacyGate();
                }
            });
        }
    }

    mount();

    global.LoveStoryMemoryForm = {
        open: open,
        close: close,
        get isOpen() { return !!sheet && !sheet.hidden; }
    };
})(window);
