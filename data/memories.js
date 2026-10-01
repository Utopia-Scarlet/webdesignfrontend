/* ==========================================================================
   LoveStory — shared memory data

   One source of truth. The same record drives the Memory Map, the Timeline,
   the Moments album, the upcoming dates and the Entrance films — nothing is
   written down twice.

   A memory record:
     id           unique string
     year         which year filter it belongs to
     date         "YYYY-MM-DD" — drives the Timeline, the year filter, sorting
     time         "HH:MM" or "" — shown in the album detail only
     title        string
     description  free text, multi-line; the full story lives here
     location     { country, countryCode, city, placeName, latitude, longitude }
                  countryCode is the ISO 3166-1 numeric id used by the
                  world-atlas data, so the globe can match a record to a real
                  country outline. This is the only place "where" is written.
     weather      { condition, temperature }
     mood         "Happy" | "Peaceful" | ... (restrained list, see MOODS)
     tags         array of short strings
     momentType   "trip" | "first" | "happy" | "important" | "everyday"
     favorite     boolean (seed default; user toggles are stored separately)
     photos       FILE NAMES inside /image (no folder, no leading slash)
     href         optional deep link into the story page
     showOnTimeline  true → this memory is a landmark and belongs on the
                  Timeline. It is NOT an anniversary: a memory's date never
                  becomes one. Anniversaries are declared on purpose, and live
                  in data/anniversaries.js.
     sample       true → PLACEHOLDER, not a verified fact

   ==========================================================================
   !!  SAMPLE DATA  !!
   Rows marked  sample:true  are PLACEHOLDERS. Replace their dates, places and
   titles with your own. Coordinates are the real coordinates of the named
   city, so the globe stays honest even while the trip is a sample.
   ========================================================================== */

(function (global) {
    "use strict";

    var IMAGE_DIR = "image/";

    /* No years are declared. They are derived from the memories themselves,
       so a fresh archive has no year filter at all and the first memory added
       brings its own year with it. */
    var YEARS = [];

    /* ------------------------------------------------------------------ seed */
    /* No seed content. The archive is what the backend holds, and a fresh
       install is genuinely empty until someone adds the first memory. The old
       demo memories live in data/seed-fixtures.js, which only tests load. */
    var SEED = [];

    /* The order the Moments stack on the Hub is built in, BACK first, FRONT
       last. Anything not listed falls in front of these. */
    var STACK_ORDER = [
        "lastshowering.jpeg",
        "hulunpicture1.jpeg",
        "maerdaifu4.jpeg",
        "hulunpicture2.jpeg",
        "maerdaifu3.jpeg"
    ];

    var PLACE_POSITIONS = {
        "Hulunbeier": { x: 68, y: 26 },
        "Chengdu": { x: 66, y: 40 },
        "Tokyo": { x: 82, y: 34 },
        "Maldives": { x: 46, y: 62 },
        "Brisbane": { x: 88, y: 74 }
    };

    /* The lists a memory form offers live in data/memory-fields.js, because
       they are pure data and the Private Archive's form needs them without the
       ordinary store. Re-exported here so nothing that already reads
       LoveStoryData.moods has to change. */
    var FIELDS = global.LoveStoryMemoryFields || {};
    var MOODS = FIELDS.moods || [];
    var WEATHER = FIELDS.weatherConditions || [];
    var MOMENT_TYPES = FIELDS.momentTypes || [];
    var COLLECTIONS = FIELDS.collections || [];

    /* The Hub's year filter also offers "ALL" — the whole archive at once.
       It is a sentinel rather than a year, so every query below accepts it. */
    var ALL_YEARS = "all";

    /* ------------------------------------------------------------ persistence */
    /* Added memories and favourite toggles live in localStorage. This is a
       front-end archive, not a database: it keeps the album useful without
       pretending to be storage. Swapping in a server later means replacing
       the four helpers below and nothing else. */
    var MEMORY_KEY = "lovestory.memories.v1";
    var FAVORITE_KEY = "lovestory.favorites.v1";

    function readJSON(key, fallback) {
        try {
            var raw = global.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try {
            global.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            /* No storage: the session still works, it simply forgets. */
        }
    }

    /* localStorage keeps only a light mirror, so the pages that read this
       synchronously still see added memories. The records themselves — which
       carry downscaled photographs — live in IndexedDB. */
    var mirror = readJSON(MEMORY_KEY, []);
    var added = mirror.slice();

    /* ---------------------------------------------------------- the backend
       Memories that came from the SQLite archive, fetched over HTTP. They are
       kept SEPARATE from the seed data and from `added` so it is always clear
       where a record came from: a backend memory carries `source: "backend"`
       and its `photos` are server URLs rather than bundled filenames.

       The seed entries below are still the source of truth for the Hub, the
       Memory Map and the Timeline; only the Photo Library merges in what the
       backend holds. Importing the seed into SQLite is the next phase.
       ---------------------------------------------------------------------- */
    var remote = [];
    var favoriteOverrides = readJSON(FAVORITE_KEY, {});

    var DB_NAME = "LoveStoryDB";
    var DB_STORE = "memories";
    var dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve) {
            if (!global.indexedDB) { resolve(null); return; }
            var request;
            try {
                request = global.indexedDB.open(DB_NAME, 1);
            } catch (error) {
                resolve(null);
                return;
            }
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE, { keyPath: "id" });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { resolve(null); };
        });
        return dbPromise;
    }

    function dbAll() {
        return openDB().then(function (db) {
            if (!db) return [];
            return new Promise(function (resolve) {
                try {
                    var request = db.transaction(DB_STORE, "readonly")
                        .objectStore(DB_STORE).getAll();
                    request.onsuccess = function () { resolve(request.result || []); };
                    request.onerror = function () { resolve([]); };
                } catch (error) {
                    resolve([]);
                }
            });
        });
    }

    function dbPut(record) {
        return openDB().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(DB_STORE, "readwrite");
                    tx.objectStore(DB_STORE).put(record);
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { resolve(false); };
                } catch (error) {
                    resolve(false);
                }
            });
        });
    }

    function dbDelete(id) {
        return openDB().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(DB_STORE, "readwrite");
                    tx.objectStore(DB_STORE).delete(id);
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { resolve(false); };
                } catch (error) {
                    resolve(false);
                }
            });
        });
    }

    /* The mirror is what a synchronous reader gets: metadata without the
       photographs, which are far too large for localStorage. */
    function writeMirror() {
        writeJSON(MEMORY_KEY, added.map(function (memory) {
            var copy = {};
            Object.keys(memory).forEach(function (key) { copy[key] = memory[key]; });
            copy.photos = [];
            copy.photoCount = (memory.photos || []).length;
            return copy;
        }));
    }

    /* Retire the old browser-side store.

       Earlier versions saved memories to IndexedDB and to a localStorage
       mirror. Neither is a source of truth any more, and leaving them behind
       means a memory deleted from the archive can still surface from a stale
       browser. This removes exactly those two places, once, and touches nothing
       else — no cookies, no session, no account, no other site data.

       It only ever deletes; it cannot create or restore a memory. */
    function purgeLegacyBrowserStore() {
        var report = { indexedDB: false, localStorage: false, legacyCount: added.length };

        try {
            if (global.indexedDB && global.indexedDB.deleteDatabase) {
                global.indexedDB.deleteDatabase(DB_NAME);
                report.indexedDB = true;
            }
        } catch (error) { /* nothing to retire */ }

        try {
            global.localStorage.removeItem(MEMORY_KEY);
            report.localStorage = true;
        } catch (error) { /* storage unavailable */ }

        added = [];
        mirror = [];
        return report;
    }

    /* What the visitor's browser was holding, before it is retired. Reported so
       the cleanup can be seen rather than merely believed. */
    var legacy = { count: added.length, ids: added.map(function (m) { return m.id; }) };

    /* Nothing left to load: the backend is fetched by whoever needs it. Kept as
       a promise so existing callers do not have to change. */
    var ready = Promise.resolve([]);

    /* The archive, and only the archive.

       This list used to be SEED + whatever the browser had saved + the backend.
       That middle bucket is gone, and it mattered: an old "firework" memory
       written by an earlier version of the Add Memory form lived in this
       browser's IndexedDB, so it kept appearing on the Photo Library long after
       the database had been emptied. The backend is the single source of truth;
       nothing the browser once stored can invent a memory.

       SEED is empty in production and only ever filled by a test. */
    /* ------------------------------------------------------------ test adapter
       The ONLY way fixture data can enter the store, and no page calls it. It
       fills the same bucket a backend response fills, so the tests exercise the
       real data path rather than a parallel one.

       Production has no seed: `allMemories()` below is the archive, and the
       archive is the server.
       ---------------------------------------------------------------------- */
    function useSeedFixtures(list) {
        remote = Array.isArray(list) ? list.slice() : [];
        store.memories = remote;
        store.status = remote.length ? "ready" : "empty";
        return remote.length;
    }

    /* The archive, and only the archive. Production knows nothing of SEED —
       fixture data reaches the store through useSeedFixtures() below, which
       fills the same bucket a backend response fills. */
    function allMemories() {
        return remote;
    }

    /* ======================================================================
       The one memory store

       Every page reads memories from here and nowhere else. There is one fetch
       per page load, however many modules ask for it, and the four states are
       always distinguishable — so a module can say "loading" rather than
       flashing "empty" before the answer arrives.
       ====================================================================== */
    var store = {
        status: "idle",     /* idle | loading | ready | empty | error */
        memories: [],
        error: null
    };

    var inFlight = null;

    /* Fetch the archive once. A second caller while the first is in flight
       joins the same request rather than starting another. */
    function loadMemories(force) {
        var api = global.LoveStoryApi;

        if (!api) {
            store.status = "error";
            store.error = "The archive client is not loaded on this page.";
            return Promise.resolve(store);
        }
        if (inFlight && !force) return inFlight;
        if (store.status === "ready" && !force) return Promise.resolve(store);

        store.status = "loading";
        store.error = null;

        inFlight = api.list().then(function (memories) {
            remote = memories;
            store.memories = memories;
            store.status = memories.length ? "ready" : "empty";
            inFlight = null;
            return store;
        }, function (error) {
            /* No fallback of any kind. A failure is reported as a failure —
               never as seed data, never as something remembered in the
             browser. */
            store.status = "error";
            store.error = (error && error.message) || "The archive could not be read.";
            store.memories = [];
            remote = [];
            inFlight = null;
            console.error("Love Story: could not read the archive.", store.error);
            return store;
        });

        return inFlight;
    }

    function refreshMemories() { return loadMemories(true); }

    /* Replace the backend bucket. Called by the Photo Library after a fetch,
       and after a successful upload. */
    function setRemoteMemories(list) {
        remote = Array.isArray(list) ? list : [];
        /* Keep the store's account of itself true, whichever path filled it. */
        store.memories = remote;
        store.status = remote.length ? "ready" : "empty";
        return remote;
    }

    function remoteMemories() {
        return remote.slice();
    }

    /* A record is only ever read from one place, but if the same id somehow
       appears twice the newest wins — this keeps a re-fetch idempotent. */
    function dedupeById(list) {
        var seen = Object.create(null);
        return list.filter(function (memory) {
            if (!memory || memory.id === undefined || memory.id === null) return true;
            var key = String(memory.id);
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    /* ---------------------------------------------------------------- utils */
    function byDate(a, b) {
        var da = a.date || "";
        var db = b.date || "";
        if (da && db) return da < db ? -1 : (da > db ? 1 : 0);
        if (da) return -1;
        if (db) return 1;
        return 0;
    }

    function toDate(value) {
        if (!value) return null;
        var d = new Date(value + "T00:00:00");
        return isNaN(d.getTime()) ? null : d;
    }

    function placeKey(location) {
        if (!location) return "";
        return location.city || location.placeName || location.country || "";
    }

    function isFavorite(id) {
        if (Object.prototype.hasOwnProperty.call(favoriteOverrides, id)) {
            return !!favoriteOverrides[id];
        }
        var record = allMemories().filter(function (m) { return m.id === id; })[0];
        return !!(record && record.favorite);
    }

    function toggleFavorite(id) {
        favoriteOverrides[id] = !isFavorite(id);
        writeJSON(FAVORITE_KEY, favoriteOverrides);
        return favoriteOverrides[id];
    }

    function placeOf(memory, key) {
        return {
            key: key,
            label: key,
            location: memory.location,
            latitude: memory.location.latitude,
            longitude: memory.location.longitude,
            country: memory.location.country,
            countryCode: memory.location.countryCode
        };
    }

    /* -------------------------------------------------------------- queries */
    /* Every year-scoped query takes either a year or ALL_YEARS, so nothing
       downstream needs a second code path for the combined view. */
    function isAllYears(year) {
        return year === ALL_YEARS || year === "all" || year === null || year === undefined;
    }

    function memoriesIn(year) {
        return allMemories().filter(function (m) {
            return isAllYears(year) ? true : m.year === year;
        }).sort(byDate);
    }

    /* What the Hub's Timeline draws. Curated memories have no flag and are
       always included; a memory the visitor uploads only joins the Timeline
       when they ticked "Add to Timeline" while writing it. */
    /* The Timeline is a deliberate choice, not a default. A memory appears
       only when it was explicitly marked for it — `undefined` and `null` mean
       "not chosen", and are not a silent yes. */
    function timelineMemories(year) {
        return memoriesIn(year).filter(function (m) { return m.showOnTimeline === true; });
    }

    function placesIn(year) {
        var seen = Object.create(null);
        var out = [];

        memoriesIn(year).forEach(function (memory) {
            var key = placeKey(memory.location);
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(placeOf(memory, key));
        });

        return out;
    }

    function placesAll() {
        var seen = Object.create(null);
        var out = [];

        allMemories().forEach(function (memory) {
            var key = placeKey(memory.location);
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(placeOf(memory, key));
        });

        return out;
    }

    /* ------------------------------------------------------- Our World's places
       A location the globe can actually pin: one per country and city, and only
       where a memory really carries a position.

       Two rules the map depends on:

         * a memory with a country and a city but no coordinates still lives in
           the album and the timeline — it simply cannot be placed, and guessing
           a position for it would be inventing one;
         * memories in the same city are one location, so ten memories of one
           town are one marker rather than ten on top of each other.

       The marker sits at the first *valid* position in the group — the newest
       memory's, because the list is newest first. No averaging: a city whose
       memories are spread out would otherwise put its marker in the sea.
       ---------------------------------------------------------------------- */
    function hasCoordinates(location) {
        if (!location) return false;
        var lat = location.latitude;
        var lng = location.longitude;
        if (typeof lat !== "number" || typeof lng !== "number") return false;
        if (!isFinite(lat) || !isFinite(lng)) return false;
        return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }

    function mapPlaces() {
        var groups = Object.create(null);
        var out = [];

        allMemories().forEach(function (memory) {
            var location = memory.location;
            if (!hasCoordinates(location)) return;

            var city = (location.city || location.placeName || "").trim();
            var country = (location.country || "").trim();
            var label = city || country;
            if (!label) return;

            /* Country and city together: two Sydneys are not one place. A
               slug, so it can live in a data attribute and a URL. */
            var id = (country + "-" + label).toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
            var place = groups[id];
            if (!place) {
                place = {
                    id: id,
                    key: placeKey(location),
                    label: label,
                    country: country,
                    countryCode: location.countryCode || "",
                    latitude: location.latitude,
                    longitude: location.longitude,
                    memories: []
                };
                groups[id] = place;
                out.push(place);
            }
            place.memories.push(memory);
        });

        out.forEach(function (place) {
            /* Newest first: the panel opens on the most recent memory here. */
            place.memories.sort(function (a, b) { return byDate(b, a); });
            place.count = place.memories.length;
        });

        return out;
    }

    function mapPlaceById(id) {
        return mapPlaces().filter(function (place) { return place.id === id; })[0] || null;
    }

    function memoriesAtPlace(key) {
        return allMemories()
            .filter(function (m) { return placeKey(m.location) === key; })
            .sort(byDate);
    }

    function countriesInData() {
        var seen = Object.create(null);
        var out = [];

        allMemories().forEach(function (memory) {
            var location = memory.location;
            if (!location || !location.country || seen[location.country]) return;
            seen[location.country] = true;
            out.push({ name: location.country, code: location.countryCode, cities: [] });
        });

        out.forEach(function (country) {
            country.cities = placesAll().filter(function (place) {
                return place.country === country.name;
            });
        });

        return out;
    }

    function stackPhotos(year, limit) {
        var photos = [];
        memoriesIn(year).forEach(function (memory) {
            /* One card per memory, and it is the cover — the same photograph
               the Library shows, so the two never disagree. */
            var cover = coverUrl(memory);
            if (cover) photos.push({ file: cover, memory: memory });
        });

        photos.sort(function (a, b) {
            var ia = STACK_ORDER.indexOf(a.file);
            var ib = STACK_ORDER.indexOf(b.file);
            if (ia === -1) ia = STACK_ORDER.length;
            if (ib === -1) ib = STACK_ORDER.length;
            return ia - ib;
        });

        return typeof limit === "number" && photos.length > limit
            ? photos.slice(photos.length - limit)
            : photos;
    }

    function photosIn(year) {
        return memoriesIn(year).reduce(function (all, m) {
            return all.concat(m.photos || []);
        }, []);
    }

    /* ------------------------------------------------------------------------
       There is deliberately no upcomingEvents() here any more.

       It used to build the Hub's "Next Anniversary" module out of memories: any
       memory marked for the Timeline had its date treated as an anniversary, so
       a holiday snap counted down to next year alongside the day we met. A
       memory is something that happened once; an anniversary is a date declared
       on purpose. Anniversaries now live in data/anniversaries.js and the
       database table behind it, and nothing in this file feeds them.
       ---------------------------------------------------------------------- */

    /* ------------------------------------------------------------ photographs */
    /* ------------------------------------------------------- which photograph
       One memory, many photographs — but exactly one of them represents the
       memory wherever it appears: the Library, the Hub, the Map, the Timeline
       and the Entrance film all ask here rather than each picking photos[0].

       The rules, in order:

         1. the photograph the server marked as the cover;
         2. failing that, the one the record points at;
         3. failing that, the first — which is the lowest sort order, because
            the server returns them in that order;
         4. a memory with no photographs has none.
       ---------------------------------------------------------------------- */
    function coverIndex(memory) {
        var photos = (memory && memory.photos) || [];
        if (!photos.length) return -1;

        var records = (memory && memory.photoRecords) || [];
        for (var i = 0; i < records.length; i++) {
            var record = records[i];
            if (!record || !record.isCover) continue;
            var at = record.url ? photos.indexOf(record.url) : -1;
            if (at !== -1) return at;
            return Math.min(i, photos.length - 1);
        }

        if (typeof memory.cover === "number" &&
            memory.cover >= 0 && memory.cover < photos.length) {
            return memory.cover;
        }
        return 0;
    }

    /* The whole record, so a caller that needs the id or the order has it. */
    function getCoverPhoto(memory) {
        var index = coverIndex(memory);
        if (index < 0) return null;
        var records = (memory && memory.photoRecords) || [];
        if (records[index]) return records[index];
        return {
            id: null,
            url: memory.photos[index],
            originalName: "",
            order: index,
            isCover: true
        };
    }

    /* Just the source string, which is what most pages actually want. */
    function coverUrl(memory) {
        var photo = getCoverPhoto(memory);
        return photo ? (photo.url || "") : "";
    }

    /* The photographs behind the cover, in order, for the fan and the carousel. */
    function extraPhotos(memory) {
        var photos = (memory && memory.photos) || [];
        var cover = coverIndex(memory);
        return photos.filter(function (src, index) {
            return index !== cover;
        });
    }

    /* `photos` stays an array of plain source strings, because the Hub, the
       Entrance films and the globe all read it that way. The richer photo
       object is derived here, so there is still only one copy of the data. */
    function photoList(memory) {
        var photos = (memory && memory.photos) || [];
        var cover = typeof memory.cover === "number" ? memory.cover : 0;
        return photos.map(function (src, index) {
            return {
                id: memory.id + ":" + index,
                src: src,
                thumbnailSrc: src,
                isCover: index === cover,
                order: index
            };
        });
    }

    /* -------------------------------------------------- the album's queries */
    /* Everything the Moments page needs, expressed once so the page itself
       stays about layout. */

    function allPhotos() {
        var out = [];
        allMemories().forEach(function (memory) {
            (memory.photos || []).forEach(function (file, index) {
                out.push({
                    id: memory.id + ":" + index,
                    file: file,
                    index: index,
                    memory: memory,
                    date: memory.date
                });
            });
        });
        out.sort(function (a, b) {
            var da = a.date || "", db = b.date || "";
            return da < db ? 1 : (da > db ? -1 : 0);      /* newest first */
        });
        return out;
    }

    /* A filter is a plain description, so the Sidebar only has to name one. */
    function filterMemories(filter) {
        filter = filter || { kind: "all" };
        var list = allMemories().slice().sort(function (a, b) {
            return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
        });

        if (filter.kind === "year") {
            list = list.filter(function (m) { return m.year === filter.year; });
        } else if (filter.kind === "favorite") {
            list = list.filter(function (m) { return isFavorite(m.id); });
        } else if (filter.kind === "recent") {
            /* When it was uploaded, never when it happened. */
            list = added.slice().sort(function (a, b) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        } else if (filter.kind === "momentType") {
            list = list.filter(function (m) { return m.momentType === filter.value; });
        } else if (filter.kind === "collection") {
            list = list.filter(function (m) {
                return (m.collections || []).indexOf(filter.value) !== -1;
            });
        } else if (filter.kind === "tag") {
            list = list.filter(function (m) {
                return (m.tags || []).indexOf(filter.value) !== -1;
            });
        } else if (filter.kind === "place") {
            list = list.filter(function (m) { return placeKey(m.location) === filter.value; });
        }

        if (filter.favoriteOnly) {
            list = list.filter(function (m) { return isFavorite(m.id); });
        }

        return list;
    }

    /* Month groups, so the album can read as a year rather than a wall. */
    function groupByMonth(list) {
        var months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
                      "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
        var order = [];
        var groups = Object.create(null);

        list.forEach(function (memory) {
            var date = toDate(memory.date);
            var key = date ? date.getFullYear() + "-" + date.getMonth() : "unknown";
            if (!groups[key]) {
                groups[key] = {
                    key: key,
                    label: date ? months[date.getMonth()] : "UNDATED",
                    year: date ? date.getFullYear() : "",
                    memories: []
                };
                order.push(key);
            }
            groups[key].memories.push(memory);
        });

        return order.map(function (key) { return groups[key]; });
    }

    function stats(list) {
        var places = Object.create(null);
        var photos = 0;
        list.forEach(function (memory) {
            photos += (memory.photos || []).length;
            var key = placeKey(memory.location);
            if (key) places[key] = true;
        });
        return { memories: list.length, photos: photos, places: Object.keys(places).length };
    }

    /* ------------------------------------------------------------ authoring */
    /* Creates a memory and persists it. The record returned is the same shape
       the Map, the Timeline and the album already read. */
    function addMemory(input) {
        input = input || {};

        var date = input.date || "";
        var record = {
            id: "memory-" + Date.now().toString(36),
            year: date ? Number(date.slice(0, 4)) : new Date().getFullYear(),
            date: date,
            time: input.time || "",
            title: input.title || "Untitled memory",
            description: input.description || "",
            location: input.location || null,
            weather: input.weather || { condition: "", temperature: null },
            mood: input.mood || "",
            tags: input.tags || [],
            momentType: input.momentType || "everyday",
            favorite: !!input.favorite,
            photos: (input.photos || []).map(function (file) {
                return typeof file === "string" ? file : file.file;
            }),
            collections: input.collections || [],
            cover: typeof input.cover === "number" ? input.cover : 0,
            /* Opt-in: an uploaded memory stays out of the Timeline unless the
               visitor asked for it. Curated entries omit the flag entirely. */
            showOnTimeline: !!input.showOnTimeline,
            category: input.momentType || "moment",
            createdAt: Date.now()
        };

        added.push(record);
        dbPut(record);
        writeMirror();

        if (record.favorite) {
            favoriteOverrides[record.id] = true;
            writeJSON(FAVORITE_KEY, favoriteOverrides);
        }

        return record;
    }

    function removeMemory(id) {
        added = added.filter(function (m) { return m.id !== id; });
        dbDelete(id);
        writeMirror();
        delete favoriteOverrides[id];
        writeJSON(FAVORITE_KEY, favoriteOverrides);
    }

    global.LoveStoryData = {
        version: 4,
        imageDir: IMAGE_DIR,
        years: YEARS,
        stackOrder: STACK_ORDER,
        moods: MOODS,
        weatherConditions: WEATHER,
        momentTypes: MOMENT_TYPES,
        collections: COLLECTIONS,

        /* A live view: includes anything the visitor has added. */
        get memories() { return allMemories(); },

        /* Years are derived from the memories themselves, so a 2027 memory
           makes 2027 appear on its own. The declared list is only a floor. */
        get years() {
            var seen = Object.create(null);
            YEARS.forEach(function (y) { seen[y] = true; });
            allMemories().forEach(function (m) { if (m.year) seen[m.year] = true; });
            return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
        },

        /* Each is { label, filter } — the Sidebar uses the filter, the
           Add Memory sheet uses the label. */
        get collections() { return COLLECTIONS; },

        /* The sentinel the Hub's year filter uses for the combined view. */
        ALL_YEARS: ALL_YEARS,

        /* Resolves once saved records have come back from IndexedDB. */
        ready: ready,

        allMemories: allMemories,
        useSeedFixtures: useSeedFixtures,
        loadMemories: loadMemories,
        refreshMemories: refreshMemories,
        getStore: function () { return store; },
        get status() { return store.status; },
        get error() { return store.error; },
        purgeLegacyBrowserStore: purgeLegacyBrowserStore,
        legacyBrowserStore: legacy,
        memoriesIn: memoriesIn,
        timelineMemories: timelineMemories,
        isAllYears: isAllYears,
        placesIn: placesIn,
        placesAll: placesAll,
        memoriesAtPlace: memoriesAtPlace,
        countriesInData: countriesInData,
        stackPhotos: stackPhotos,
        photosIn: photosIn,
        placeKey: placeKey,

        allPhotos: allPhotos,
        photoList: photoList,
        mapPlaces: mapPlaces,
        mapPlaceById: mapPlaceById,
        hasCoordinates: hasCoordinates,
        coverIndex: coverIndex,
        getCoverPhoto: getCoverPhoto,
        coverUrl: coverUrl,
        extraPhotos: extraPhotos,
        setRemoteMemories: setRemoteMemories,
        remoteMemories: remoteMemories,
        dedupeById: dedupeById,
        filterMemories: filterMemories,
        groupByMonth: groupByMonth,
        stats: stats,
        isFavorite: isFavorite,
        toggleFavorite: toggleFavorite,
        addMemory: addMemory,
        removeMemory: removeMemory
    };
})(window);
