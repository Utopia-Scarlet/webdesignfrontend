/* ==========================================================================
   LoveStory — the private store

   The private archive's memories, held in memory for the life of one page.

   Not "in memory" as a figure of speech: there is no localStorage, no
   sessionStorage, no IndexedDB, no cache, and no copy anywhere the browser
   keeps things after the tab closes. A reload asks the server again, and the
   server answers from the session's unlock — which is the only place the fact
   that this browser was unlocked ten minutes ago is written down.

   WHY THIS IS NOT data/memories.js

   The ordinary store is loaded by the Hub, the Library and the Memory Map. If
   private memories went into it, every one of those pages would be holding
   them: one careless render and a private memory is in the ordinary album. So
   the private archive has its own store, loaded only by the one page that is
   allowed to have it.

   It is also why nothing here is a "view" over anything. What it holds is
   exactly what the private archive API returned, and clearing it is one
   assignment.
   ========================================================================== */

(function (global) {
    "use strict";

    var memories = [];
    var loaded = false;

    function api() { return global.LoveStoryApi || null; }

    /* -------------------------------------------------------------- reading */

    function load() {
        if (!api()) return Promise.resolve([]);
        return api().privateMemories().then(function (data) {
            memories = (data && data.memories) || [];
            loaded = true;
            return memories;
        });
    }

    function all() { return memories.slice(); }

    function get(id) {
        var wanted = String(id);
        return memories.filter(function (memory) {
            return String(memory.id) === wanted;
        })[0] || null;
    }

    function count() { return memories.length; }

    /* Replace one memory in place after an edit, so the list does not lose its
       scroll position or redraw from a request that would only tell us what we
       already know. */
    function replace(memory) {
        if (!memory) return;
        var wanted = String(memory.id);
        for (var i = 0; i < memories.length; i++) {
            if (String(memories[i].id) === wanted) {
                memories[i] = memory;
                return;
            }
        }
        memories.push(memory);
    }

    function remove(id) {
        var wanted = String(id);
        memories = memories.filter(function (memory) {
            return String(memory.id) !== wanted;
        });
    }

    /* Everything this store knows, let go of. Called when the archive locks —
       by the button or by a 423 — so a lock really does empty the page rather
       than leave cards behind that were fetched while it was open. */
    function clear() {
        memories = [];
        loaded = false;
    }

    global.LoveStoryPrivateStore = {
        load: load,
        all: all,
        get: get,
        count: count,
        replace: replace,
        remove: remove,
        clear: clear,
        get loaded() { return loaded; }
    };
})(window);
