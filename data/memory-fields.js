/* ==========================================================================
   LoveStory — the lists a memory form offers

   Pure data, and nothing else: no store, no request, no state. These four lists
   are what the Add/Edit Memory sheet builds its weather select, its moment
   select and its two rows of chips from, and that is all they have ever been
   used for.

   WHY THIS FILE EXISTS

   They used to live inside data/memories.js, which is the ordinary archive's
   store — the thing that fetches /api/memories and holds the result. So the
   Private Archive page, which must never hold an ordinary memory, had to load
   the ordinary store to draw its edit form. Nothing private was ever put in it,
   but a page whose whole point is a separate store should not depend on the
   other one for four arrays of words.

   Now the form reads these, and:
     · the ordinary pages load this file AND data/memories.js (the store), as
       before, and their sheet is unchanged;
     · the private archive loads this file alone, and its sheet is unchanged.

   Depends on nothing.
   ========================================================================== */

(function (global) {
    "use strict";

    var MOODS = ["Happy", "Peaceful", "Excited", "Romantic", "Funny",
                 "Emotional", "Tired", "Difficult", "Other"];

    var WEATHER = ["Sunny", "Cloudy", "Rainy", "Snowy", "Windy",
                   "Foggy", "Stormy", "Other"];

    var MOMENT_TYPES = ["trip", "first", "happy", "important", "everyday"];

    /* Fixed for now; a future release can let the visitor create their own. */
    var COLLECTION_NAMES = ["Trips", "Happy Moments", "Important", "Our Firsts"];

    /* Each is { label, filter } — the Sidebar uses the filter, the Add Memory
       sheet uses the label. Which collections a memory belongs to is data, not
       a rule: the visitor chooses, and nothing is inferred. */
    var COLLECTIONS = COLLECTION_NAMES.map(function (name) {
        return { label: name, filter: { kind: "collection", value: name } };
    });

    global.LoveStoryMemoryFields = {
        moods: MOODS,
        weatherConditions: WEATHER,
        momentTypes: MOMENT_TYPES,
        collectionNames: COLLECTION_NAMES,
        collections: COLLECTIONS
    };
})(window);
