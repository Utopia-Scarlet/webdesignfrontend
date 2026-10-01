/* ==========================================================================
   LoveStory — the interactive world

   The hub's small globe grows into this: a real orthographic globe drawn from
   Natural Earth coastlines, which can be turned, zoomed, and searched by
   country and city. Every place comes from LoveStoryData, so a memory only has
   to be recorded once.

   No library. Projection and horizon clipping live in geo.js.

   Interaction notes
   -----------------
   • Nothing calls setPointerCapture. Capturing on the <svg> retargets the
     derived click to the svg itself, which is why country clicks were being
     swallowed before. Drag listeners live on window instead, so the pointerup
     still knows which element is underneath.
   • A gesture is a CLICK only if it travelled less than CLICK_SLOP pixels.
   • Only countries and city markers take pointers; every decorative layer is
     pointer-events:none in the stylesheet.
   ========================================================================== */

(function (global) {
    "use strict";

    var data = global.LoveStoryData;
    var auth = global.LoveStoryAuth;
    var geo = global.LoveStoryGeo;
    if (!data || !geo || !geo.countries) return;

    var SVG_NS = "http://www.w3.org/2000/svg";
    var IMAGE_BASE = "../image/";

    /* A photograph is either a bundled file name or a URL the server handed
       over whole. Only the bundled kind needs the base in front of it —
       prefixing an absolute URL builds a path that cannot exist. */
    function photoSrc(file) {
        if (!file) return "";
        if (/^(data:|blob:|https?:)/.test(file)) return file;
        return IMAGE_BASE + file;
    }

    var VIEW = { cx: 500, cy: 500, radius: 430 };

    var MIN_ZOOM = 1;
    var MAX_ZOOM = 6;
    var DEFAULT_CENTER = { lon: 115, lat: 10 };

    /* Under this much travel, a gesture is a click rather than a drag. */
    var CLICK_SLOP = 6;

    var worldEl = document.getElementById("world");
    var stageEl = document.getElementById("worldStage");
    if (!worldEl || !stageEl) return;

    var worldSvg = document.getElementById("worldSvg");
    var countriesGroup = document.getElementById("worldCountries");
    var graticuleGroup = document.getElementById("worldGraticule");
    var markersGroup = document.getElementById("worldMarkers");
    var panelEl = document.getElementById("worldPanel");
    var indexEl = document.getElementById("worldIndex");
    var backButton = document.getElementById("worldBack");
    var countryLabel = document.getElementById("worldCountryLabel");

    var reducedMotion = global.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* On the Hub the world is an overlay, so closing it reveals the room behind.
       On the Memory Map the world IS the page: closing it would leave nothing,
       so a page that declares itself standalone never closes, it navigates. */
    var standalone = document.body.classList.contains("world-standalone");

    var state = {
        open: false,
        built: false,
        lon: DEFAULT_CENTER.lon,
        lat: DEFAULT_CENTER.lat,
        zoom: 1,
        dragging: false,
        travelled: 0,
        pointers: new Map(),
        pinchDistance: 0,
        frame: 0,
        idle: 0,
        flight: null,
        selectedCountry: null,
        selectedPlace: null,
        /* Our World has one selection and no hover preview: the panel follows
           a click, never the pointer. */
        hideTimer: 0,
        memoryIndexByPlace: Object.create(null)
    };

    var worldEl = document.getElementById("world");

    var parts = { countries: [], graticule: [], markers: [] };

    /* ------------------------------------------------------------------ helpers */
    function pluralise(count, singular, pluralForm) {
        var word = count === 1 ? singular : (pluralForm || singular + "S");
        return count + " " + word;
    }

    function shortDate(iso) {
        if (!iso) return "";
        var date = new Date(iso + "T00:00:00");
        if (isNaN(date.getTime())) return iso;
        var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                      "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        return date.getDate() + " " + months[date.getMonth()] + " " + date.getFullYear();
    }

    function svg(tag, className, radius) {
        var el = document.createElementNS(SVG_NS, tag);
        if (className) el.setAttribute("class", className);
        if (radius !== undefined) el.setAttribute("r", String(radius));
        return el;
    }

    function project() {
        return geo.projector(state.lon, state.lat, VIEW.radius * state.zoom, VIEW.cx, VIEW.cy);
    }

    function schedule() {
        if (state.frame) return;
        state.frame = global.requestAnimationFrame(function () {
            state.frame = 0;
            redraw();
        });
    }

    /* --------------------------------------------------------------- building */
    /* Built once, on first open — the hub never pays for geometry it is not
       showing, and the Memory Map can build during its own opening. */
    function ensureBuilt() {
        if (state.built) return;
        state.built = true;
        /* The globe gives the panel room on every surface that shows Our
           World — the Hub's overlay and the Memory Map page alike. */
        if (worldEl) worldEl.classList.add("world--panel-layout");
        buildCountries();
        buildGraticule();
        buildMarkers();
        buildIndex();
    }

    /* A memory written from the map must appear on the map immediately: newer
       cities get a marker, existing ones get a bigger count. Nothing here
       needs a page reload. */
    function refresh() {
        if (!state.built) return;

        buildMarkers();
        buildIndex();

        var withMemories = Object.create(null);
        data.countriesInData().forEach(function (country) {
            if (country.code) withMemories[String(country.code)] = true;
        });
        parts.countries.forEach(function (item) {
            item.el.classList.toggle("has-memories", !!withMemories[item.country.id]);
        });

        updateWorldChrome();
        redraw();
    }

    function buildCountries() {
        if (!countriesGroup) return;
        countriesGroup.textContent = "";
        parts.countries = [];

        var withMemories = Object.create(null);
        data.countriesInData().forEach(function (country) {
            if (country.code) withMemories[String(country.code)] = true;
        });

        /* One real SVG path per country — never a single combined outline. */
        geo.countries.forEach(function (country) {
            var el = svg("path", "world__country" +
                (withMemories[country.id] ? " has-memories" : ""));
            el.dataset.code = country.id;
            el.dataset.name = country.name;
            countriesGroup.appendChild(el);
            parts.countries.push({ country: country, el: el });
        });
    }

    function buildGraticule() {
        if (!graticuleGroup) return;
        graticuleGroup.textContent = "";
        parts.graticule = [];

        geo.graticule(30).forEach(function (line) {
            var el = svg("path", "world__line");
            graticuleGroup.appendChild(el);
            parts.graticule.push({ line: line, el: el });
        });
    }

    function buildMarkers() {
        if (!markersGroup) return;
        markersGroup.textContent = "";
        parts.markers = [];

        mapPlaces().forEach(function (place) {
            var group = svg("g", "world__marker-group");
            group.dataset.place = place.id;

            var ring = svg("circle", "world__marker-ring", 12);
            var hit = svg("circle", "world__marker-hit", 18);   /* 36px target */
            var dot = svg("circle", "world__marker", 5.5);

            group.appendChild(ring);
            group.appendChild(hit);
            group.appendChild(dot);

            /* A marker is reachable by keyboard as well as by pointer: focus
               previews it exactly as hover does, Enter or Space pins it. */
            group.setAttribute("tabindex", "0");
            group.setAttribute("role", "button");
            group.setAttribute("aria-label",
                place.label +
                (place.count > 1 ? ", " + place.count + " memories" : ", 1 memory"));
            /* Focus is a visual state only: tabbing through the markers must
               not move the globe or open the panel. Enter or Space selects,
               exactly as a click does. */
            group.addEventListener("keydown", function (event) {
                if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                event.preventDefault();
                pinPlace(place);
            });

            markersGroup.appendChild(group);
            parts.markers.push({ place: place, el: group });
        });
    }

    function buildIndex() {
        if (!indexEl) return;
        indexEl.textContent = "";

        mapPlaces().forEach(function (place) {
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = place.count > 1
                ? place.label + " \u00b7 " + place.count
                : place.label;
            button.addEventListener("click", function () { pinPlace(place); });
            indexEl.appendChild(button);
        });
    }

    /* ----------------------------------------------------------------- drawing */
    function redraw() {
        var projectFn = project();
        var radius = VIEW.radius * state.zoom;

        parts.countries.forEach(function (item) {
            var d = geo.countryPath(item.country, projectFn, radius, VIEW.cx, VIEW.cy);
            item.el.setAttribute("d", d || "M-9 -9");
        });

        parts.graticule.forEach(function (item) {
            item.el.setAttribute("d", geo.lineToPath(item.line, projectFn) || "M-9 -9");
        });

        parts.markers.forEach(function (item) {
            /* With a country chosen, only its own cities are offered. */
            var inCountry = !state.selectedCountry ||
                isInCountry(item.place, state.selectedCountry);

            if (!inCountry) {
                item.el.setAttribute("opacity", "0");
                item.el.setAttribute("pointer-events", "none");
                return;
            }

            var point = projectFn(item.place.longitude, item.place.latitude);
            if (!point.visible) {
                item.el.setAttribute("opacity", "0");
                item.el.setAttribute("pointer-events", "none");
                return;
            }

            item.el.setAttribute("opacity", "1");
            item.el.removeAttribute("pointer-events");
            item.el.setAttribute("transform",
                "translate(" + point.x.toFixed(1) + "," + point.y.toFixed(1) + ")");
        });

        highlight();
    }

    function highlight() {
        /* Lets the stylesheet dim everything that is not the chosen country. */
        if (countriesGroup) {
            countriesGroup.classList.toggle("is-focused", !!state.selectedCountry);
        }

        parts.countries.forEach(function (item) {
            item.el.classList.toggle("is-selected",
                !!state.selectedCountry && item.country.id === state.selectedCountry.code);
        });

        parts.markers.forEach(function (item) {
            var dot = item.el.querySelector(".world__marker");
            if (!dot) return;
            dot.classList.toggle("is-selected",
                !!state.selectedPlace && item.place.id === state.selectedPlace.id);
        });
    }

    /* ------------------------------------------------------- flying to a point */
    function angleDelta(from, to) {
        var delta = (to - from) % 360;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    function flyTo(lon, lat, zoom) {
        var targetZoom = zoom ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) : state.zoom;

        if (reducedMotion) {
            state.lon = lon;
            state.lat = lat;
            state.zoom = targetZoom;
            schedule();
            return;
        }

        state.flight = {
            fromLon: state.lon,
            fromLat: state.lat,
            fromZoom: state.zoom,
            dLon: angleDelta(state.lon, lon),
            toLat: lat,
            toZoom: targetZoom,
            start: global.performance.now(),
            duration: 900
        };
    }

    function stepFlight(now) {
        var flight = state.flight;
        if (!flight) return;

        var t = Math.min(1, (now - flight.start) / flight.duration);
        var eased = 1 - Math.pow(1 - t, 3);

        state.lon = flight.fromLon + flight.dLon * eased;
        state.lat = flight.fromLat + (flight.toLat - flight.fromLat) * eased;
        state.zoom = flight.fromZoom + (flight.toZoom - flight.fromZoom) * eased;

        schedule();
        if (t >= 1) state.flight = null;
    }

    function ringsOf(code) {
        var item = parts.countries.filter(function (entry) {
            return entry.country.id === String(code);
        })[0];
        return item ? item.country.rings : [];
    }

    /* Rough centre of a country: the average of its longest ring. */
    function countryCentre(code) {
        var ring = ringsOf(code).reduce(function (best, current) {
            return current.length > best.length ? current : best;
        }, []);
        if (!ring.length) return null;

        var lon = 0, lat = 0;
        ring.forEach(function (point) { lon += point[0]; lat += point[1]; });
        return { lon: lon / ring.length, lat: lat / ring.length };
    }

    /* How wide the country is, so a small country can be zoomed further in. */
    function countrySpan(code) {
        var min = Infinity, max = -Infinity;
        ringsOf(code).forEach(function (ring) {
            ring.forEach(function (point) {
                if (point[0] < min) min = point[0];
                if (point[0] > max) max = point[0];
            });
        });
        return (max - min) || 360;
    }

    function zoomForSpan(span) {
        if (span > 90) return 1.4;
        if (span > 40) return 1.7;
        if (span > 15) return 2.2;
        return 2.8;
    }

    /* ------------------------------------------------------------- selection */
    function selectCountry(code, name) {
        state.selectedCountry = { code: String(code), name: name };
        state.selectedPlace = null;

        var centre = countryCentre(code);
        var span = countrySpan(code);
        if (centre) flyTo(centre.lon, centre.lat, zoomForSpan(span));

        updateWorldChrome();
    }

    /* Our World's places, straight from the archive: one per country and city,
       and only where a memory actually carries a position. */
    function mapPlaces() {
        if (data.mapPlaces) return data.mapPlaces();
        return data.placesAll();
    }

    function placeById(id) {
        return mapPlaces().filter(function (p) { return p.id === id; })[0] || null;
    }

    /* Whether a place belongs to the country that is selected.

       The archive stores a country's NAME and no code — the memories table has
       no country_code column — while a country shape on the globe is
       identified by its numeric ISO id. The name is the only thing both sides
       actually hold, so that is what is compared; a code is used only when
       both sides happen to have one. */
    function isInCountry(place, country) {
        if (!place || !country) return false;
        var want = String(country.name || "").trim().toLowerCase();
        var have = String(place.country || "").trim().toLowerCase();
        if (want && have && want === have) return true;

        var wantCode = String(country.code || "").trim().toLowerCase();
        var haveCode = String(place.countryCode || "").trim().toLowerCase();
        return !!wantCode && !!haveCode && wantCode === haveCode;
    }

    /* The numeric id the globe's geometry uses for a country name. */
    function countryIdForName(name) {
        var want = String(name || "").trim().toLowerCase();
        var found = parts.countries.filter(function (item) {
            return String(item.country.properties.name || "").trim().toLowerCase() === want;
        })[0];
        return found ? String(found.country.id) : "";
    }

    /* What the panel is showing: the place the visitor selected, and nothing
       else. There is no hover state left to consult. */
    function displayPlace() {
        return state.selectedPlace;
    }

    function memoryIndexFor(place) {
        var index = state.memoryIndexByPlace[place.id] || 0;
        if (index < 0) index = 0;
        if (index >= place.memories.length) index = place.memories.length - 1;
        return index;
    }

    /* Every visual consequence of "a place is showing" lives here, so the
       classes and the panel can never disagree with the state. */
    function updateWorldChrome() {
        var shown = displayPlace();
        if (worldEl) {
            worldEl.classList.toggle("has-place", !!shown);
            worldEl.classList.toggle("has-panel",
                !!shown || !!state.selectedCountry || !mapPlaces().length);
        }
        /* Drawing the panel is the one part of this that can fail on a record
           it did not expect. If it does, the failure stays in the console —
           it must never leave the world itself half-open and blank. */
        try {
            renderPanel();
        } catch (error) {
            console.error("Love Story: the place panel could not be drawn.", error);
        }
        highlight();
    }

    /* Click: pin. Clicking the pinned place again lets it go. */
    function pinPlace(place) {
        var wasPinned = state.selectedPlace && state.selectedPlace.id === place.id;

        if (wasPinned) {
            /* Clicking the selected place again lets it go. */
            state.selectedPlace = null;
            state.selectedCountry = null;
            flyTo(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, 1);
        } else {
            state.selectedPlace = place;
            state.selectedCountry = place.countryCode
                ? { code: String(place.countryCode), name: place.country }
                : null;
            /* A light focus, not a camera flight: enough to bring the place to
               the middle while its neighbours stay reachable. */
            flyTo(place.longitude, place.latitude, Math.max(state.zoom, 1.6));
        }

        updateWorldChrome();
    }

    function stepMemory(place, offset) {
        if (!place || place.memories.length < 2) return;
        var next = memoryIndexFor(place) + offset;
        if (next < 0) next = place.memories.length - 1;
        if (next >= place.memories.length) next = 0;
        state.memoryIndexByPlace[place.id] = next;
        renderPanel();
    }

    function selectPlace(place) {
        state.selectedPlace = place;
        state.selectedCountry = place.countryCode
            ? { code: String(place.countryCode), name: place.country }
            : null;

        flyTo(place.longitude, place.latitude, 3.2);
        updateWorldChrome();
    }

    /* Back out one step: a city returns to its country, a country to the world. */
    function goBack() {
        if (state.selectedPlace && state.selectedPlace.country) {
            selectCountry(countryIdForName(state.selectedPlace.country),
                          state.selectedPlace.country);
            return;
        }
        state.selectedCountry = null;
        state.selectedPlace = null;
        flyTo(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, 1);
        updateWorldChrome();
    }

    function clearSelection() {
        state.selectedCountry = null;
        state.selectedPlace = null;
        flyTo(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, 1);
        updateWorldChrome();
    }

    /* ---------------------------------------------------------------- panel */
    function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* ------------------------------------------------------- the place panel
       One memory at a time, its cover, and a way through to the memory itself.
       This is a preview of the place, not a second Library: the arrows move
       between memories here, never between photographs. */
    function renderLocationPanel(place) {
        var index = memoryIndexFor(place);
        var memory = place.memories[index];
        if (!memory) return;

        var shell = element("div", "world__swap world__place");
        panelEl.appendChild(shell);

        var facts = [place.country.toUpperCase(), pluralise(place.count, "MEMORY", "MEMORIES")]
            .filter(Boolean).join(" \u00b7 ");
        shell.appendChild(element("span", "world__eyebrow", "Place"));
        shell.appendChild(element("h2", "world__title", place.label));
        shell.appendChild(element("p", "world__sub", facts));

        var cover = data.coverUrl ? data.coverUrl(memory) : "";

        if (place.memories.length > 1) {
            var nav = element("div", "world__nav");

            var prev = element("button", "world__nav-button", "\u2039");
            prev.type = "button";
            prev.setAttribute("aria-label", "Previous memory");
            prev.addEventListener("click", function () { stepMemory(place, -1); });

            var next = element("button", "world__nav-button", "\u203a");
            next.type = "button";
            next.setAttribute("aria-label", "Next memory");
            next.addEventListener("click", function () { stepMemory(place, 1); });

            var frame = element("div", "world__cover");
            if (cover) {
                var image = document.createElement("img");
                image.src = photoSrc(cover);
                image.alt = "";
                image.decoding = "async";
                frame.appendChild(image);
            } else {
                frame.classList.add("world__cover--empty");
            }

            nav.appendChild(prev);
            nav.appendChild(frame);
            nav.appendChild(next);
            shell.appendChild(nav);
        } else {
            var single = element("div", "world__cover");
            if (cover) {
                var one = document.createElement("img");
                one.src = photoSrc(cover);
                one.alt = "";
                one.decoding = "async";
                single.appendChild(one);
            } else {
                single.classList.add("world__cover--empty");
            }
            shell.appendChild(single);
        }

        if (!cover && !place.memories.some(function (m) { return (m.photos || []).length; })) {
            shell.appendChild(element("p", "world__empty",
                "No photograph for this place yet."));
        }

        var facts = element("div", "world__facts");
        facts.appendChild(element("h3", "world__memory-title", memory.title || "Untitled"));
        if (memory.date) {
            facts.appendChild(element("p", "world__memory-date", longDate(memory.date)));
        }

        /* Only what exists is said: no "weather: null" lines. */
        var line = [];
        var condition = memory.weather && memory.weather.condition;
        if (condition) line.push(condition);
        if (memory.mood) line.push(memory.mood);
        if (condition && typeof memory.weather.temperature === "number") {
            line[0] = condition + " \u00b7 " + memory.weather.temperature + "\u00b0C";
        }
        if (line.length) {
            facts.appendChild(element("p", "world__memory-meta", line.join(" \u00b7 ")));
        }

        var photos = (memory.photos || []).length;
        if (photos > 1) {
            facts.appendChild(element("p", "world__memory-photos",
                pluralise(photos, "PHOTO", "PHOTOS")));
        }
        if (place.memories.length > 1) {
            facts.appendChild(element("p", "world__memory-count",
                (index + 1) + " / " + place.memories.length));
        }
        shell.appendChild(facts);

        var view = element("a", "world__action", "View memory \u2192");
        view.href = window.LoveStoryRoutes
            ? window.LoveStoryRoutes.memory(memory.id)
            : "modules/moments.html?memory=" + encodeURIComponent(memory.id);
        shell.appendChild(view);

        /* The block settles in rather than the whole panel blinking. */
        global.requestAnimationFrame(function () { shell.classList.add("is-in"); });
    }

    function renderNoPlaces() {
        var shell = element("div", "world__swap world__place");
        panelEl.appendChild(shell);
        shell.appendChild(element("span", "world__eyebrow", "Our world"));
        shell.appendChild(element("h2", "world__title", "No places yet"));
        shell.appendChild(element("p", "world__empty",
            (auth && auth.isEditor())
                ? "Add a memory with a location to place it on Our World."
                : "No places have been added yet."));
        global.requestAnimationFrame(function () { shell.classList.add("is-in"); });
    }

    function longDate(iso) {
        if (!iso) return "";
        var date = new Date(iso + "T00:00:00");
        if (isNaN(date.getTime())) return iso;
        var months = ["January", "February", "March", "April", "May", "June",
                      "July", "August", "September", "October", "November", "December"];
        return date.getUTCDate() + " " + months[date.getUTCMonth()] + " " +
            date.getUTCFullYear();
    }

    function renderPanel() {
        if (!panelEl) return;
        panelEl.textContent = "";

        /* Our World shows a place while one is being explored or is pinned,
           its country list while a country is open, and nothing at all
           otherwise — the default state has no panel. This is the same on
           every surface that shows the globe. */
        var activePlace = displayPlace();
        if (activePlace) { renderLocationPanel(activePlace); return; }
        if (!state.selectedCountry) {
            if (!mapPlaces().length) renderNoPlaces();
            return;
        }

        /* A way back, shown only once you are inside something. A place whose
           record carries no country code is still a place — the label falls
           back rather than reading through a country that is not there. */
        if (state.selectedCountry || state.selectedPlace) {
            var backLabel = "World";
            if (state.selectedPlace) {
                backLabel = state.selectedCountry ? state.selectedCountry.name : "World";
            }
            var back = element("button", "world__panel-back", "\u2190 " + backLabel);
            back.type = "button";
            back.addEventListener("click", goBack);
            panelEl.appendChild(back);
        }

        var heading = state.selectedPlace ? state.selectedPlace.label
            : state.selectedCountry ? state.selectedCountry.name
            : "Places";

        panelEl.appendChild(element("span", "world__eyebrow",
            state.selectedPlace ? "Place" : (state.selectedCountry ? "Country" : "Our world")));
        panelEl.appendChild(element("h2", "world__title", heading));

        /* --- one place: its memories ---------------------------------------- */
        if (state.selectedPlace) {
            var memories = data.memoriesAtPlace(state.selectedPlace.key);
            panelEl.appendChild(element("p", "world__sub",
                pluralise(memories.length, "MEMORY", "MEMORIES")));

            var photos = [];
            memories.forEach(function (memory) {
                /* The cover leads; any other photograph of the memory follows,
                   so the panel agrees with the Library about which picture
                   represents a place. */
                var cover = data.coverUrl ? data.coverUrl(memory) : "";
                if (cover) photos.push(cover);
                (memory.photos || []).forEach(function (file) {
                    if (file !== cover) photos.push(file);
                });
            });

            if (photos.length) {
                var gallery = element("div", "world__photos");
                photos.slice(0, 6).forEach(function (file) {
                    var image = document.createElement("img");
                    image.src = photoSrc(file);
                    image.alt = "";
                    image.decoding = "async";
                    gallery.appendChild(image);
                });
                panelEl.appendChild(gallery);
            } else {
                panelEl.appendChild(element("p", "world__empty",
                    "Photographs for this place are still to come."));
            }

            var list = element("ul", "world__list");
            memories.forEach(function (memory) {
                var item = document.createElement("li");
                var link = document.createElement("a");
                /* One memory opens in the Photo Library, by ID. This used to
                   fall back to a memory's own stored href, which no longer
                   exists — the deep link is the point of the list. */
                link.href = window.LoveStoryRoutes
                    ? window.LoveStoryRoutes.memory(memory.id)
                    : "modules/moments.html?memory=" + encodeURIComponent(memory.id);
                link.appendChild(element("span", null, shortDate(memory.date) || memory.title));
                link.appendChild(element("span", "world__count", memory.title));
                item.appendChild(link);
                list.appendChild(item);
            });
            panelEl.appendChild(list);

            /* This button used to point at memory-map.html — the very page it
               is already on. It means "show me these memories", so it now
               hands the place to the album and the album arrives filtered. */
            var action = element("a", "world__action", "View memories \u2192");
            action.href = "modules/moments.html?place=" +
                encodeURIComponent(state.selectedPlace.key);
            panelEl.appendChild(action);

            return;
        }

        /* --- a country: only the cities we actually have --------------------- */
        if (state.selectedCountry) {
            var places = mapPlaces().filter(function (place) {
                return isInCountry(place, state.selectedCountry);
            });

            if (!places.length) {
                panelEl.appendChild(element("p", "world__empty",
                    "No memories here yet. This is where they will go."));

                /* Writing a memory belongs to the Library, so this points
                   there rather than offering a second form. */
                var toLibrary = element("a", "world__action", "Add one in the Library \u2192");
                toLibrary.href = "modules/moments.html";
                panelEl.appendChild(toLibrary);
                return;
            }

            /* A country is a level of its own: what it holds, and where. No
               photographs — those belong to the place. */
            var placesTotal = places.length;
            var memoriesTotal = places.reduce(function (sum, place) {
                return sum + place.count;
            }, 0);
            panelEl.appendChild(element("p", "world__sub",
                pluralise(placesTotal, "PLACE", "PLACES") + " \u00b7 " +
                pluralise(memoriesTotal, "MEMORY", "MEMORIES")));

            var cityList = element("ul", "world__list");
            places.forEach(function (place) {
                var item = document.createElement("li");
                var button = document.createElement("button");
                button.type = "button";
                button.appendChild(element("span", null, place.label));
                button.appendChild(element("span", "world__count",
                    place.count + (place.count === 1 ? " memory" : " memories") +
                    " \u2192"));
                button.addEventListener("click", function () { pinPlace(place); });
                item.appendChild(button);
                cityList.appendChild(item);
            });
            panelEl.appendChild(cityList);
            return;
        }

        /* --- nothing chosen yet --------------------------------------------- */
        var countries = data.countriesInData();
        panelEl.appendChild(element("p", "world__sub",
            pluralise(countries.length, "COUNTRY", "COUNTRIES")));

        var countryList = element("ul", "world__list");
        countries.forEach(function (country) {
            var item = document.createElement("li");
            var button = document.createElement("button");
            button.type = "button";
            button.appendChild(element("span", null, country.name));
            button.appendChild(element("span", "world__count",
                country.cities.length +
                (country.cities.length === 1 ? " city" : " cities")));
            button.addEventListener("click", function () {
                if (country.code) selectCountry(country.code, country.name);
            });
            item.appendChild(button);
            countryList.appendChild(item);
        });
        panelEl.appendChild(countryList);
    }

    /* ------------------------------------------------------------ interaction */
    function pointerDistance() {
        var points = Array.from(state.pointers.values());
        if (points.length < 2) return 0;
        var dx = points[0].x - points[1].x;
        var dy = points[0].y - points[1].y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function showCountryLabel(name) {
        if (!countryLabel) return;
        countryLabel.textContent = name || "";
        countryLabel.classList.toggle("is-visible", !!name);
    }

    /* Whatever is genuinely under the pointer — the same hit test the browser
       uses, so no layer can silently swallow the click. */
    function pickAt(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el || !el.closest) return;

        var marker = el.closest(".world__marker-group");
        if (marker) {
            var place = placeById(marker.dataset.place);
            if (place) pinPlace(place);
            return;
        }

        var country = el.closest(".world__country");
        if (country) {
            selectCountry(country.dataset.code, country.dataset.name);
            return;
        }

        /* Empty ocean: step back out. */
        clearSelection();
    }

    function onPointerDown(event) {
        if (event.pointerType === "mouse" && event.button !== 0) return;

        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        state.travelled = 0;
        state.flight = null;

        if (state.pointers.size === 1) {
            state.dragging = true;
            if (worldSvg) worldSvg.classList.add("is-dragging");
            global.addEventListener("pointermove", onPointerMove);
            global.addEventListener("pointerup", onPointerUp);
            global.addEventListener("pointercancel", onPointerUp);
        } else if (state.pointers.size === 2) {
            state.pinchDistance = pointerDistance();
        }
    }

    function onPointerMove(event) {
        if (!state.pointers.has(event.pointerId)) return;

        var previous = state.pointers.get(event.pointerId);
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        var dx = event.clientX - previous.x;
        var dy = event.clientY - previous.y;
        state.travelled += Math.abs(dx) + Math.abs(dy);

        /* --- pinch zoom ----------------------------------------------------- */
        if (state.pointers.size === 2) {
            var distance = pointerDistance();
            if (state.pinchDistance) {
                state.zoom = Math.max(MIN_ZOOM,
                    Math.min(MAX_ZOOM, state.zoom * (distance / state.pinchDistance)));
                schedule();
            }
            state.pinchDistance = distance;
            return;
        }

        if (!state.dragging) return;

        var speed = 0.28 / state.zoom;
        state.lon -= dx * speed;
        state.lat += dy * speed;
        state.lat = Math.max(-85, Math.min(85, state.lat));
        schedule();
    }

    function onPointerUp(event) {
        var wasSingle = state.pointers.size === 1;
        state.pointers.delete(event.pointerId);
        if (state.pointers.size < 2) state.pinchDistance = 0;
        if (state.pointers.size > 0) return;

        state.dragging = false;
        if (worldSvg) worldSvg.classList.remove("is-dragging");

        global.removeEventListener("pointermove", onPointerMove);
        global.removeEventListener("pointerup", onPointerUp);
        global.removeEventListener("pointercancel", onPointerUp);

        /* A short gesture is a click; anything longer was a turn of the globe. */
        if (wasSingle && state.travelled < CLICK_SLOP) {
            pickAt(event.clientX, event.clientY);
        }
    }

    function onWheel(event) {
        event.preventDefault();
        state.flight = null;
        state.zoom = Math.max(MIN_ZOOM,
            Math.min(MAX_ZOOM, state.zoom * Math.exp(-event.deltaY * 0.0012)));
        schedule();
    }

    if (worldSvg) {
        worldSvg.addEventListener("pointerdown", onPointerDown);
        worldSvg.addEventListener("wheel", onWheel, { passive: false });
        worldSvg.addEventListener("contextmenu", function (event) { event.preventDefault(); });

        /* Turning is the user's job while they are here. */
        worldSvg.addEventListener("pointerenter", stopIdle);
        worldSvg.addEventListener("pointerleave", function () {
            hideCountryLabel();
            if (state.open && !reducedMotion) startIdle();
        });

        worldSvg.addEventListener("pointerover", function (event) {
            if (!(event.target instanceof Element)) return;

            /* A place under the pointer is previewed. This is the whole of the
               hover behaviour: no camera movement, no permanent selection. */
            /* Pointing at a marker lights it up and nothing more. The panel
               follows a click, so the selection is untouched here. */

            var country = event.target.closest(".world__country");
            if (country) showCountryLabel(country.dataset.name);
        });

        worldSvg.addEventListener("pointerout", function (event) {
            if (!(event.target instanceof Element)) return;

            if (event.relatedTarget instanceof Element &&
                event.relatedTarget.closest(".world__country")) return;
            showCountryLabel("");
        });

        /* Leaving the globe entirely ends a preview — a pin stays. */
    }

    function hideCountryLabel() { showCountryLabel(""); }

    /* ------------------------------------------------------------------ open */
    function open(originEl) {
        if (state.open) return;
        state.open = true;

        /* A close that is still running must not hide the world again a
           moment after it was reopened. */
        if (state.hideTimer) { global.clearTimeout(state.hideTimer); state.hideTimer = 0; }

        ensureBuilt();
        /* The archive may have changed while we were away — a memory added,
           moved or removed — so the markers are derived again on every
           visit rather than only on the first. */
        refreshPlaces();

        /* Where the hub globe is, in the stage's own coordinates, so the small
           globe appears to grow into this one. */
        if (originEl && stageEl) {
            var orb = originEl.getBoundingClientRect();
            var width = stageEl.offsetWidth || 1;
            var height = stageEl.offsetHeight || 1;
            var stageLeft = global.innerWidth / 2 - width / 2;
            var stageTop = global.innerHeight / 2 - height / 2;

            stageEl.style.setProperty("--morph-x",
                ((orb.left + orb.width / 2 - stageLeft) / width * 100).toFixed(2) + "%");
            stageEl.style.setProperty("--morph-y",
                ((orb.top + orb.height / 2 - stageTop) / height * 100).toFixed(2) + "%");
        }

        worldEl.hidden = false;
        document.body.classList.add("world-open");

        updateWorldChrome();
        schedule();

        global.requestAnimationFrame(function () {
            worldEl.classList.add("is-open");
            if (backButton) backButton.focus();
        });

        if (!reducedMotion) startIdle();
    }

    function close() {
        if (!state.open) return;
        state.open = false;

        stopIdle();
        hideCountryLabel();
        worldEl.classList.remove("is-open");
        document.body.classList.remove("world-open");

        /* Nothing held over from this visit: the next one starts in the
           default state, with nothing selected and no panel. */
        state.selectedPlace = null;
        state.selectedCountry = null;
        state.memoryIndexByPlace = Object.create(null);

        if (state.hideTimer) global.clearTimeout(state.hideTimer);
        state.hideTimer = global.setTimeout(function () {
            state.hideTimer = 0;
            worldEl.hidden = true;
        }, reducedMotion ? 20 : 420);
    }

    /* Rebuild what the archive says is on the globe. The markers and the index
       are made fresh, so their listeners are bound to the elements that are
       actually on screen. */
    function refreshPlaces() {
        if (!state.built) return;
        buildMarkers();
        buildIndex();
        schedule();
    }

    /* A globe that never moves reads as a picture. Barely visible on purpose. */
    function startIdle() {
        stopIdle();
        state.idle = global.setInterval(function () {
            if (state.dragging || state.flight || state.pinchDistance) return;
            state.lon += 0.045;
            schedule();
        }, 50);
    }

    function stopIdle() {
        if (state.idle) global.clearInterval(state.idle);
        state.idle = 0;
    }

    if (backButton) backButton.addEventListener("click", close);

    document.addEventListener("keydown", function (event) {
        if (!state.open) return;

        /* Arrow keys walk the memories of the place on screen — but never
           while the visitor is typing somewhere. */
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            var active = document.activeElement;
            var typing = active && (active.tagName === "INPUT" ||
                                    active.tagName === "TEXTAREA" ||
                                    active.isContentEditable);
            var shown = displayPlace();
            if (!typing && shown && shown.memories.length > 1) {
                event.preventDefault();
                stepMemory(shown, event.key === "ArrowLeft" ? -1 : 1);
            }
            return;
        }

        if (event.key !== "Escape") return;

        /* An open sheet owns Escape; never take it away from the form. */
        if (document.querySelector(".sheet.is-open")) return;

        if (state.selectedPlace) {
            state.selectedPlace = null;
            state.selectedCountry = null;
            flyTo(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, 1);
            updateWorldChrome();
            return;
        }
        if (state.selectedCountry) { goBack(); return; }
        if (!standalone) close();
    });

    /* ------------------------------------------------------------------ loop */
    (function tick(now) {
        stepFlight(now || 0);
        global.requestAnimationFrame(tick);
    })(0);

    /* Bring one place forward, for a link that already knows where it means. */
    function focusPlace(key) {
        var place = data.placesAll().filter(function (p) { return p.key === key; })[0];
        if (!place) return false;
        ensureBuilt();
        selectPlace(place);
        return true;
    }

    function focusCountry(code, name) {
        if (!code) return false;
        ensureBuilt();
        selectCountry(String(code), name || "");
        return true;
    }

    /* --------------------------------------------------------------- public */
    global.LoveStoryGlobe = {
        open: open,
        close: close,
        back: goBack,
        clearSelection: clearSelection,
        refresh: refresh,
        /* Redraw the panel from the current session state — the empty state
           speaks to an editor differently from a guest, and who is reading is
           answered asynchronously. */
        refreshPanel: updateWorldChrome,
        focusPlace: focusPlace,
        focusCountry: focusCountry,
        ensureBuilt: ensureBuilt,
        get isOpen() { return state.open; }
    };
})(window);
