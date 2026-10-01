/* ==========================================================================
   LoveStory — who can see this private memory

   One control, used by two forms: the memory sheet when a new private memory is
   being written, and the same sheet when an existing one is being edited. It is
   the only place that knows how the three presets turn into the concrete list
   of people the server actually stores.

   THE SERVER HAS NO IDEA WHAT "EVERYONE" MEANS

   The ACL is per-person and always has been: `{userId, permission}` rows, and
   nothing else. So the three presets live here, in the interface, and they are
   translated into rows at the moment of saving:

     Only me          -> no rows at all (the owner is implicit and always has
                         been, so there is nothing to write)
     Selected people  -> a row for each person given VIEW or EDIT
     Everyone         -> a row for every ACTIVE MEMBER OF THIS SPACE at this
                         moment, viewer unless the owner made them an editor

   "Everyone" is a snapshot, not a rule. Somebody who joins the space next month
   is not in the list, because the list was written before they existed, and the
   alternative — re-reading "everyone" whenever somebody joins — would mean a
   memory the owner shared with three people quietly becoming one that a
   stranger can read. The interface says so, once, in a small line.

   The same asymmetry applies in reverse when an existing memory is opened: the
   ACL is compared with the current members, and "everyone" is only offered back
   if it still describes exactly what is stored. If the space has changed since,
   the honest answer is Selected people.
   ========================================================================== */

(function (global) {
    "use strict";

    function api() { return global.LoveStoryApi || null; }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    /* --------------------------------------------------------------- helpers */

    /* The people this memory can be shared with: everybody in the space except
       the owner, who is never a row and never needs to be.

       Sorted by display name so the list does not jump about between openings,
       and taken from the members endpoint rather than from anything cached —
       somebody who left the space this morning must not appear. */
    function others(members, ownerId) {
        return (members || [])
            .filter(function (member) {
                return Number(member.userId) !== Number(ownerId);
            })
            .slice()
            .sort(function (a, b) {
                return String(a.displayName).localeCompare(String(b.displayName));
            });
    }

    /* The stored ACL, as a map of id -> permission. */
    function byUser(access) {
        var map = {};
        (access || []).forEach(function (entry) {
            if (entry && entry.userId !== undefined) {
                map[Number(entry.userId)] = entry.permission;
            }
        });
        return map;
    }

    /* Which preset does an existing memory's ACL actually describe?

       Empty means Only me. Covering every current member means Everyone —
       because that is what the owner picked and nothing has changed since. Any
       other list is Selected people, which is also the answer when the space has
       gained or lost somebody: the safest reading of an ACL that no longer
       matches any preset is the narrowest one that is still true. */
    function presetFor(access, members, ownerId) {
        var stored = byUser(access);
        var people = others(members, ownerId);
        if (!Object.keys(stored).length) return "only";
        if (people.length && people.every(function (person) {
            return stored[Number(person.userId)];
        })) {
            return "everyone";
        }
        return "selected";
    }

    /* ------------------------------------------------------------ the control */

    function mount(container, options) {
        options = options || {};
        var state = {
            preset: options.preset || "only",
            /* id -> "viewer" | "editor". A person absent from this map has no
               access, which is why "no access" needs no representation. */
            access: options.access ? byUser(options.access) : {},
            members: options.members || [],
            ownerId: options.ownerId,
            personal: !!options.personal
        };

        var root = el("div", "audience");
        container.textContent = "";
        container.appendChild(root);

        /* A personal space has nobody to choose between, so the whole control
           becomes one sentence. Showing a list of presets with one member would
           be a question with only one answer. */
        if (state.personal) {
            root.appendChild(el("p", "audience__note",
                "Only you can access this memory."));
            return {
                value: function () { return { preset: "only", access: [] }; }
            };
        }

        root.appendChild(el("p", "audience__question", "Who can access?"));

        /* The three presets, as real radios: arrow keys move between them and a
           screen reader reads them as one choice rather than three buttons. */
        var group = el("div", "audience__presets");
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-label", "Who can access this memory");

        var presets = [
            { id: "only", label: "Only me" },
            { id: "selected", label: "Selected people" },
            { id: "everyone", label: "Everyone in this space" }
        ];

        presets.forEach(function (preset) {
            var label = el("label", "audience__preset");
            var input = el("input", "audience__radio");
            input.type = "radio";
            input.name = "privateAudience";
            input.value = preset.id;
            input.id = "audience-" + preset.id;
            input.checked = state.preset === preset.id;
            input.addEventListener("change", function () {
                state.preset = preset.id;
                render();
            });
            label.appendChild(input);
            label.appendChild(el("span", "audience__preset-label", preset.label));
            group.appendChild(label);
        });
        root.appendChild(group);

        var detail = el("div", "audience__detail");
        root.appendChild(detail);

        var note = el("p", "audience__snapshot", "");
        root.appendChild(note);

        /* --------------------------------------------------------- the rows */

        function memberRow(person, permission) {
            var row = el("div", "audience__row");

            var name = el("span", "audience__name", person.displayName || "Someone");
            row.appendChild(name);

            /* Three states on one line: NO ACCESS, VIEW, EDIT. The first is
               what an absent entry means, so it is shown as a choice rather
               than as a gap. */
            var choices = el("div", "audience__choices");
            choices.setAttribute("role", "radiogroup");
            choices.setAttribute("aria-label",
                "Access for " + (person.displayName || "this person"));

            [["none", "No access"], ["viewer", "View"], ["editor", "Edit"]]
                .forEach(function (choice) {
                    var label = el("label", "audience__choice");
                    var input = el("input", "audience__radio");
                    input.type = "radio";
                    input.name = "access-" + person.userId;
                    input.value = choice[0];
                    input.checked = (permission || "none") === choice[0];
                    input.addEventListener("change", function () {
                        if (choice[0] === "none") delete state.access[Number(person.userId)];
                        else state.access[Number(person.userId)] = choice[0];
                        /* In Selected people, giving somebody an access IS
                           choosing that preset; in Only me it cannot happen,
                           because there are no rows to click. In Everyone the
                           rows are already there and only the permission
                           changes. */
                        if (state.preset === "only") {
                            state.preset = "selected";
                            var selected = root.querySelector("#audience-selected");
                            if (selected) selected.checked = true;
                        }
                        render();
                    });
                    label.appendChild(input);
                    label.appendChild(el("span", "audience__choice-label", choice[1]));
                    choices.appendChild(label);
                });

            row.appendChild(choices);
            return row;
        }

        function render() {
            detail.textContent = "";
            note.textContent = "";

            if (state.preset === "only") {
                detail.appendChild(el("p", "audience__note",
                    "Only you can access this memory."));
                return;
            }

            if (state.preset === "everyone") {
                /* Everybody gets a row, viewer unless the owner says editor.
                   A permission already chosen for somebody is kept. */
                others(state.members, state.ownerId).forEach(function (person) {
                    detail.appendChild(memberRow(
                        person, state.access[Number(person.userId)] || "viewer"));
                });
                note.textContent = "People who join this space later won\u2019t be "
                    + "added automatically.";
                return;
            }

            /* Selected people: the same rows, but nobody is included by
               default, so an untouched list really is "only me". */
            var available = others(state.members, state.ownerId);
            if (!available.length) {
                detail.appendChild(el("p", "audience__note",
                    "There is nobody else in this space yet."));
                return;
            }
            available.forEach(function (person) {
                detail.appendChild(memberRow(person, state.access[Number(person.userId)]));
            });
        }

        render();

        return {
            /* What the server is sent. Always concrete rows — never a preset
               name, because the server has no idea what the presets mean. */
            value: function () {
                if (state.preset === "only") return { preset: "only", access: [] };
                if (state.preset === "everyone") {
                    var rows = others(state.members, state.ownerId).map(function (person) {
                        return {
                            userId: Number(person.userId),
                            permission: state.access[Number(person.userId)] || "viewer"
                        };
                    });
                    return { preset: "everyone", access: rows };
                }
                var chosen = [];
                Object.keys(state.access).forEach(function (id) {
                    chosen.push({ userId: Number(id), permission: state.access[id] });
                });
                return { preset: "selected", access: chosen };
            },
            get preset() { return state.preset; }
        };
    }

    global.LoveStoryAudience = {
        mount: mount,
        presetFor: presetFor,
        byUser: byUser
    };
})(window);
