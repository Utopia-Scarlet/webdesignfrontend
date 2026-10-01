/* ==========================================================================
   LoveStory — the HTTP client for the backend

   The Photo Library is the only place a memory is created, and since this phase
   it creates it for real: a photograph is written to disk and the record to
   SQLite, so both survive a refresh, a browser restart and a server restart.

   Everything that talks to the API goes through here, so the base URL and the
   failure behaviour are defined once. If the backend is not running the Library
   still works exactly as before — it simply shows the bundled seed memories and
   says so once, quietly, instead of throwing on every render.
   ========================================================================== */

(function (global) {
    "use strict";

    /* Where the API is. The answer belongs to config.js, which is loaded
       before this file and works it out from the hostname — so no page, and no
       request made from one, contains a hard-coded server address. The literal
       below is the last resort, used only if config.js is missing entirely. */
    function configuredBase() {
        var config = global.LoveStoryConfig;
        if (config && typeof config.API_BASE === "string") return config.API_BASE;
        /* No config, no address: relative requests, and a page that plainly
           cannot reach the archive. Better a visible failure than a second,
           hidden copy of the server's address. */
        return "";
    }

    var BASE = configuredBase();

    /* Point the client at another server — used when the API moves, and by the
       automated tests so they never touch the real archive. */
    function setBase(next) {
        if (next) BASE = String(next).replace(/\/+$/, "");
        return BASE;
    }

    var TIMEOUT = 20000;      /* a photograph over a slow disk can take a moment */

    /* null = not checked yet, true/false = the last answer. */
    var online = null;

    function url(path) {
        return BASE + path;
    }

    /* fetch with a timeout, so a backend that accepts the connection but never
       answers cannot leave the sheet spinning forever. */
    function request(path, options) {
        var controller = typeof AbortController === "function" ? new AbortController() : null;

        /* The session lives in an HttpOnly cookie on the API's origin, and this
           page is served from a different port — a different origin. Without
           this the cookie is simply not sent, and every editor-only call comes
           back 401 however signed in the visitor is. */
        var settings = Object.assign({ credentials: "include" }, options || {});
        if (controller) settings.signal = controller.signal;

        var timer = global.setTimeout(function () {
            if (controller) controller.abort();
        }, TIMEOUT);

        return global.fetch(url(path), settings).then(function (response) {
            global.clearTimeout(timer);
            return response;
        }, function (error) {
            global.clearTimeout(timer);
            throw error;
        });
    }

    var GENERIC = "Could not save this memory. Please try again.";

    function announceSessionLoss(status) {
        if (status !== 401) return;
        try {
            document.dispatchEvent(new CustomEvent("lovestory:session-expired"));
        } catch (error) { /* no document, nothing to tell */ }
    }

    /* Turn any non-2xx into a message worth showing a person.

       A 4xx is the visitor's own input, and the server's wording for it is
       written for people ("A title is required."), so it is passed through.
       A 5xx is our problem, and its detail is a database or filesystem
       message — that belongs in the console, never on the screen. */
    function readableError(response) {
        return response.json().then(function (body) {
            var detail = null;

            if (body && typeof body.detail === "string") detail = body.detail;
            else if (body && Array.isArray(body.detail) && body.detail.length) {
                detail = body.detail[0].msg || null;
            }

            if (response.status >= 500) {
                if (detail) console.error("Love Story API " + response.status + ":", detail);
                return GENERIC;
            }

            return detail || "That could not be saved as it stands.";
        }, function () {
            /* A body that is not JSON at all. */
            if (response.status >= 500) {
                console.error("Love Story API " + response.status + " with no readable body");
                return GENERIC;
            }
            return "That could not be saved as it stands.";
        });
    }

    /* GET /api/memories -> an array in the shape the data layer understands. */
    function list() {
        return request("/api/memories", { method: "GET" })
            .then(function (response) {
                if (!response.ok) { announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); }); }
                online = true;
                return response.json();
            })
            .then(function (body) {
                var memories = (body && body.memories) || [];
                return memories.map(toMemory);
            });
    }

    /* POST /api/memories -> the created memory. */
    function create(formData) {
        return request("/api/memories", { method: "POST", body: formData })
            .then(function (response) {
                if (!response.ok) { announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); }); }
                online = true;
                return response.json();
            })
            .then(toMemory);
    }

    /* The server's record translated into the shape every page already reads.
       `photos` stays an array of plain source strings — the Hub, the Entrance
       films and the globe all depend on that — and `photoList()` derives the
       richer objects from it, exactly as it does for seed memories. */
    function toMemory(raw) {
        var photos = (raw.photos || []).slice().sort(function (a, b) {
            return (a.order || 0) - (b.order || 0);
        });

        var coverIndex = 0;
        photos.forEach(function (photo, index) {
            if (photo.isCover) coverIndex = index;
        });

        var location = raw.location || {};
        var weather = raw.weather || {};
        var hasPlace = !!(location.country || location.city || location.placeName);

        return {
            /* A string id, so it can never collide with the numeric ids the
               backend hands out for a different record. */
            id: "backend-" + raw.id,
            source: "backend",
            backendId: raw.id,
            year: raw.date ? Number(String(raw.date).slice(0, 4)) : null,
            date: raw.date || "",
            time: raw.time || "",
            title: raw.title || "Untitled memory",
            description: raw.description || "",
            location: hasPlace ? {
                country: location.country || "",
                countryCode: "",
                city: location.city || "",
                placeName: location.placeName || location.city || location.country || "",
                latitude: location.latitude === undefined ? null : location.latitude,
                longitude: location.longitude === undefined ? null : location.longitude
            } : null,
            weather: {
                condition: weather.condition || "",
                temperature: weather.temperature === undefined ? null : weather.temperature
            },
            mood: raw.mood || "",
            /* Carried through when the server knows about them; empty
               otherwise, rather than pretending they were stored. */
            tags: (raw.tags || []).map(function (tag) {
                return typeof tag === "string" ? tag : (tag && tag.name) || "";
            }).filter(Boolean),
            collections: (raw.collections || []).map(function (collection) {
                return typeof collection === "string"
                    ? collection
                    : (collection && (collection.name || collection.label)) || "";
            }).filter(Boolean),
            momentType: raw.momentType || raw.moment_type || "everyday",
            favorite: !!raw.favorite,
            milestone: !!raw.showOnTimeline,
            showOnTimeline: !!raw.showOnTimeline,
            cover: coverIndex,
            /* Who added it. Display identity only — the server never sends a
               username or anything from the account's private side. */
            createdBy: raw.createdBy || null,
            updatedBy: raw.updatedBy || null,
            updatedAt: raw.updatedAt || null,
            /* "standard" or "private". Carried through the ordinary mapping
               because the sheet has to be able to tell that the memory it just
               saved went to the private archive — the alternative is a form
               that closes into Moments and looks as though it lost it. A
               private memory never arrives through the ordinary list, so in
               practice this reads `standard` everywhere except in the answer to
               the save that made it private. */
            privacyMode: raw.privacyMode === "private" ? "private" : "standard",
            photos: photos.map(function (photo) { return photo.url; }),
            photoRecords: photos,
            createdAt: raw.createdAt ? Date.parse(raw.createdAt) || 0 : 0
        };
    }

    /* Change a memory. Only the fields a form owns are sent; the server sets
       the uploader and the timestamps from the session and its own clock. */
    function update(memoryId, formData) {
        var numeric = String(memoryId).replace(/^backend-/, "");
        return request("/api/memories/" + encodeURIComponent(numeric), {
            method: "PATCH",
            body: formData
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        }).then(toMemory);
    }

    function remove(memoryId) {
        var numeric = String(memoryId).replace(/^backend-/, "");
        return request("/api/memories/" + encodeURIComponent(numeric), {
            method: "DELETE"
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* GET /api/locations/cities -> cities in one country, for the City field.

       The lookup lives on the server, so no key is ever held in the browser and
       the provider can be swapped without touching a page. A failed lookup is
       reported as a failure, never as "no cities": the form says so and lets
       the visitor type the city by hand. */
    function cities(countryCode, query) {
        var country = String(countryCode || "").trim().toUpperCase();
        if (country.length !== 2) return Promise.resolve([]);
        var text = String(query || "").trim();
        if (!text) return Promise.resolve([]);

        return request("/api/locations/cities?country=" + encodeURIComponent(country) +
                       "&q=" + encodeURIComponent(text), { method: "GET" })
            .then(function (response) {
                if (!response.ok) {
                    return readableError(response).then(function (message) {
                        var error = new Error(message);
                        error.status = response.status;
                        throw error;
                    });
                }
                return response.json();
            })
            .then(function (body) { return (body && body.cities) || []; });
    }

    /* ======================================================================
       PLAN THE FUTURE

       A plan is not a memory: it has a date *range*, an itinerary of days, and
       no photographs. It gets its own record shape rather than being squeezed
       into the memory one, but it travels over the same client, the same
       cookie and the same error handling.
       ====================================================================== */

    /* The server's plan record translated into what the pages read.

       `duration` and `status` are sent by the server and never computed here —
       they are derived from the dates and today's date, and two places
       disagreeing about what "upcoming" means is the kind of bug that shows up
       as a plan listed twice. */
    function toPlan(raw) {
        if (!raw) return null;

        return {
            /* Namespaced, exactly as memories are, so a numeric id from one
               collection can never be mistaken for a record in the other. */
            id: "plan-" + raw.id,
            source: "backend",
            backendId: raw.id,
            title: raw.title || "",
            location: raw.location || "",
            description: raw.description || "",
            startDate: raw.startDate || "",
            endDate: raw.endDate || "",
            duration: Number(raw.duration) || 0,
            status: raw.status === "completed" ? "completed" : "upcoming",
            transportation: raw.transportation || "",
            accommodation: raw.accommodation || "",
            notes: raw.notes || "",
            days: (raw.days || []).slice()
                .sort(function (a, b) { return (a.dayNumber || 0) - (b.dayNumber || 0); })
                .map(function (day) {
                    return {
                        dayNumber: Number(day.dayNumber) || 0,
                        date: day.date || "",
                        activities: (day.activities || []).map(function (activity) {
                            return {
                                id: activity.id === undefined ? null : activity.id,
                                text: activity.text || ""
                            };
                        }).filter(function (activity) { return activity.text; })
                    };
                }),
            createdBy: raw.createdBy || null,
            updatedBy: raw.updatedBy || null,
            updatedAt: raw.updatedAt || null,
            createdAt: raw.createdAt || null
        };
    }

    /* GET /api/future-plans -> every plan. Anyone may read them. */
    function listPlans() {
        return request("/api/future-plans", { method: "GET" })
            .then(function (response) {
                if (!response.ok) {
                    announceSessionLoss(response.status);
                    return readableError(response).then(function (m) { throw new Error(m); });
                }
                online = true;
                return response.json();
            })
            .then(function (body) {
                return ((body && body.plans) || []).map(toPlan);
            });
    }

    /* GET /api/future-plans/{id} -> one plan, or null when it is gone. */
    function getPlan(planId) {
        var numeric = numericPlanId(planId);
        return request("/api/future-plans/" + encodeURIComponent(numeric), { method: "GET" })
            .then(function (response) {
                if (response.status === 404) return null;
                if (!response.ok) {
                    return readableError(response).then(function (m) { throw new Error(m); });
                }
                return response.json();
            })
            .then(function (body) { return body ? toPlan(body) : null; });
    }

    function numericPlanId(planId) {
        return String(planId).replace(/^plan-/, "");
    }

    /* POST /api/future-plans -> the created plan. Sending JSON rather than a
       form, because the itinerary is nested and multipart would mean inventing
       an encoding for it. */
    function createPlan(plan) {
        return request("/api/future-plans", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(planPayload(plan))
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            online = true;
            return response.json();
        }).then(toPlan);
    }

    function updatePlan(planId, plan) {
        return request("/api/future-plans/" + encodeURIComponent(numericPlanId(planId)), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(planPayload(plan))
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        }).then(toPlan);
    }

    function removePlan(planId) {
        return request("/api/future-plans/" + encodeURIComponent(numericPlanId(planId)), {
            method: "DELETE"
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* Only what the form owns. The days go up as `{dayNumber, activities}`
       because the date of day N is the start date plus N−1 — sending a date
       per day would let a client store an itinerary that contradicts itself. */
    function planPayload(plan) {
        return {
            title: plan.title,
            location: plan.location,
            description: plan.description,
            startDate: plan.startDate,
            endDate: plan.endDate,
            transportation: plan.transportation || "",
            accommodation: plan.accommodation || "",
            notes: plan.notes || "",
            days: (plan.days || []).map(function (day) {
                return {
                    dayNumber: day.dayNumber,
                    activities: (day.activities || []).map(function (activity) {
                        return { text: typeof activity === "string" ? activity : activity.text };
                    })
                };
            })
        };
    }

    /* ======================================================================
       ANNIVERSARIES

       A third record shape, kept apart from memories and plans on purpose. It
       carries only what is stored: a title, the original date and a note.
       Every number the pages show about it — the next occurrence, the days
       remaining, the anniversary number, how many have passed — is worked out
       from the date by data/anniversaries.js, so there is one answer and not
       two that can drift apart.
       ====================================================================== */

    function toAnniversary(raw) {
        if (!raw) return null;

        return {
            id: "anniversary-" + raw.id,
            source: "backend",
            backendId: raw.id,
            title: raw.title || "",
            originalDate: raw.originalDate || "",
            note: raw.note || "",
            createdBy: raw.createdBy || null,
            updatedBy: raw.updatedBy || null,
            updatedAt: raw.updatedAt || null,
            createdAt: raw.createdAt || null
        };
    }

    /* GET /api/anniversaries -> every date. Anyone may read them. */
    function listAnniversaries() {
        return request("/api/anniversaries", { method: "GET" })
            .then(function (response) {
                if (!response.ok) {
                    announceSessionLoss(response.status);
                    return readableError(response).then(function (m) { throw new Error(m); });
                }
                online = true;
                return response.json();
            })
            .then(function (body) {
                return ((body && body.anniversaries) || []).map(toAnniversary);
            });
    }

    function numericAnniversaryId(id) {
        return String(id).replace(/^anniversary-/, "");
    }

    /* GET /api/anniversaries/{id} -> one date, or null when it is gone. */
    function getAnniversary(id) {
        return request("/api/anniversaries/" + encodeURIComponent(numericAnniversaryId(id)),
                       { method: "GET" })
            .then(function (response) {
                if (response.status === 404) return null;
                if (!response.ok) {
                    return readableError(response).then(function (m) { throw new Error(m); });
                }
                return response.json();
            })
            .then(function (body) { return body ? toAnniversary(body) : null; });
    }

    function createAnniversary(record) {
        return request("/api/anniversaries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(anniversaryPayload(record))
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            online = true;
            return response.json();
        }).then(toAnniversary);
    }

    function updateAnniversary(id, record) {
        return request("/api/anniversaries/" + encodeURIComponent(numericAnniversaryId(id)), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(anniversaryPayload(record))
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        }).then(toAnniversary);
    }

    function removeAnniversary(id) {
        return request("/api/anniversaries/" + encodeURIComponent(numericAnniversaryId(id)), {
            method: "DELETE"
        }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* Only the three things a form owns. The actor is the session cookie, so
       a page cannot claim a record on someone else's behalf. */
    function anniversaryPayload(record) {
        return {
            title: record.title,
            originalDate: record.originalDate,
            note: record.note || ""
        };
    }

    /* ======================================================================
       SPACES, GROUPS AND NOTIFICATIONS

       The space endpoints, on the same client as everything else, so the base
       URL, the session cookie and the error handling are defined once.

       An account has one personal space and any number of groups. `listSpaces`
       and `selectSpace` move between them; the calls below those — members,
       invitations, join requests — are addressed by an explicit space id, so a
       group can be run from a page whose session is looking somewhere else.
       ====================================================================== */

    function jsonRequest(path, method, body) {
        var options = { method: method, headers: { "Content-Type": "application/json" } };
        if (body !== undefined) options.body = JSON.stringify(body);

        return request(path, options).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) {
                    /* The status rides along, because some refusals are worth
                       telling apart — "you are already a member" is not a
                       failure the person needs to retry. */
                    var error = new Error(m);
                    error.status = response.status;
                    throw error;
                });
            }
            return response.json();
        });
    }

    /* GET /api/spaces -> every space this account is in, and which one this
       sign-in is looking at. */
    function listSpaces() {
        return request("/api/spaces", { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* POST /api/spaces -> a new group, with the caller as its creator. The name
       is required by the API; sending one is the caller's job. */
    function createSpace(name) {
        return jsonRequest("/api/spaces", "POST", { name: name });
    }

    /* POST /api/spaces/{id}/select -> this sign-in works in that space from now
       on. The page reloads afterwards, so every store re-reads the new one
       rather than half the screen belonging to the old space. */
    function selectSpace(spaceId) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) + "/select",
                           "POST");
    }

    /* --- running a group ------------------------------------------------- */

    function listMembers(spaceId) {
        return request("/api/spaces/" + encodeURIComponent(spaceId) + "/members",
                       { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    function listInvitations(spaceId) {
        return request("/api/spaces/" + encodeURIComponent(spaceId) + "/invitations",
                       { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* The addressed form: a group is invited into by its own id, whatever space
       this sign-in happens to be looking at. */
    function createInvitationFor(spaceId) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) + "/invitations",
                           "POST");
    }

    function revokeInvitationsFor(spaceId) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) + "/invitations",
                           "DELETE");
    }

    function listJoinRequests(spaceId, status) {
        var query = status ? "?status=" + encodeURIComponent(status) : "";
        return request("/api/spaces/" + encodeURIComponent(spaceId) + "/join-requests" + query,
                       { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    function reviewJoinRequest(spaceId, requestId, decision) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) +
                           "/join-requests/" + encodeURIComponent(requestId) + "/" +
                           (decision === "approve" ? "approve" : "decline"), "POST");
    }

    function changeMemberRole(spaceId, userId, role) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) + "/members/" +
                           encodeURIComponent(userId) + "/role", "PATCH", { role: role });
    }

    function removeMember(spaceId, userId) {
        return jsonRequest("/api/spaces/" + encodeURIComponent(spaceId) + "/members/" +
                           encodeURIComponent(userId), "DELETE");
    }

    /* --- the account's own notifications --------------------------------- */

    function listNotifications() {
        return request("/api/notifications", { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* The number on the bell. Kept apart from the list so a page can ask the
       cheap question often and the expensive one rarely. */
    function unreadNotifications() {
        return request("/api/notifications/unread-count", { method: "GET" })
            .then(function (response) {
                if (!response.ok) return { unreadCount: 0 };
                return response.json();
            });
    }

    function markNotificationRead(notificationId) {
        return jsonRequest("/api/notifications/" +
                           encodeURIComponent(notificationId) + "/read", "POST");
    }

    function markAllNotificationsRead() {
        return jsonRequest("/api/notifications/read-all", "POST");
    }

    /* GET /api/spaces/current -> { space, pairingStatus, pendingInvitation }.
       `space` is null for an account that is not in one yet: a real answer, not
       an error. */
    function currentSpace() {
        return request("/api/spaces/current", { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    /* POST .../lookup -> who is asking, before anybody commits to anything. */
    function lookUpInvitation(pairingCode) {
        return jsonRequest("/api/spaces/invitations/lookup", "POST",
                           { pairingCode: pairingCode });
    }

    /* GET .../{token} -> the same question for a link. */
    function readInvitation(token) {
        return request("/api/spaces/invitations/" + encodeURIComponent(token),
                       { method: "GET" }).then(function (response) {
            if (!response.ok) {
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    function acceptInvitation(token) {
        return jsonRequest("/api/spaces/invitations/" + encodeURIComponent(token) + "/accept",
                           "POST");
    }

    function acceptInvitationCode(pairingCode) {
        return jsonRequest("/api/spaces/invitations/accept-code", "POST",
                           { pairingCode: pairingCode });
    }

    /* ======================================================================
       THE PRIVATE ARCHIVE

       Two things are true of every call below, and they are why they live here
       with the rest rather than in a client of their own:

         · the refusal codes are meaningful, so `error.status` is preserved —
           423 means the ten minutes ran out, 403 means the action is not
           yours, 404 means the memory is not yours to know about;
         · nothing here is cached, stored or retried. A private memory exists in
           this browser only as long as the page that asked for it.
       ====================================================================== */

    function privacyStatus() {
        return request("/api/privacy/status", { method: "GET" }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) { throw new Error(m); });
            }
            return response.json();
        });
    }

    function privacySetup(accountPassword, privacyPassword) {
        return jsonRequest("/api/privacy/setup", "POST",
                           { accountPassword: accountPassword,
                             privacyPassword: privacyPassword });
    }

    function privacyUnlock(privacyPassword) {
        return jsonRequest("/api/privacy/unlock", "POST",
                           { privacyPassword: privacyPassword });
    }

    function privacyLock() {
        return jsonRequest("/api/privacy/lock", "POST");
    }

    function privacyChangePassword(accountPassword, newPrivacyPassword) {
        return jsonRequest("/api/privacy/password", "PATCH",
                           { accountPassword: accountPassword,
                             newPrivacyPassword: newPrivacyPassword });
    }

    function privateMemories() {
        return request("/api/private-archive/memories", { method: "GET" })
            .then(function (response) {
                if (!response.ok) {
                    return readableError(response).then(function (m) {
                        var error = new Error(m);
                        error.status = response.status;
                        throw error;
                    });
                }
                return response.json();
            });
    }

    function privateMemory(memoryId) {
        return request("/api/private-archive/memories/" + encodeURIComponent(memoryId),
                       { method: "GET" }).then(function (response) {
            if (!response.ok) {
                return readableError(response).then(function (m) {
                    var error = new Error(m);
                    error.status = response.status;
                    throw error;
                });
            }
            return response.json();
        });
    }

    /* The private edit: the same multipart the ordinary one sends, to the
       private route. `FormData` is built by the caller, because only the form
       knows which fields changed. */
    function privateUpdate(memoryId, payload) {
        return request("/api/private-archive/memories/" + encodeURIComponent(memoryId),
                       { method: "PATCH", body: payload }).then(function (response) {
            if (!response.ok) {
                announceSessionLoss(response.status);
                return readableError(response).then(function (m) {
                    var error = new Error(m);
                    error.status = response.status;
                    throw error;
                });
            }
            return response.json();
        });
    }

    function privateRemove(memoryId) {
        return jsonRequest("/api/private-archive/memories/" + encodeURIComponent(memoryId),
                           "DELETE");
    }

    function privateAccess(memoryId, access) {
        return jsonRequest("/api/private-archive/memories/" +
                           encodeURIComponent(memoryId) + "/access", "PUT",
                           { access: access });
    }

    global.LoveStoryApi = {
        get BASE() { return BASE; },
        setBase: setBase,
        url: url,
        list: list,
        create: create,
        update: update,
        remove: remove,
        cities: cities,
        toMemory: toMemory,
        listPlans: listPlans,
        getPlan: getPlan,
        createPlan: createPlan,
        updatePlan: updatePlan,
        removePlan: removePlan,
        toPlan: toPlan,
        listSpaces: listSpaces,
        createSpace: createSpace,
        selectSpace: selectSpace,
        listMembers: listMembers,
        listInvitations: listInvitations,
        createInvitationFor: createInvitationFor,
        revokeInvitationsFor: revokeInvitationsFor,
        listJoinRequests: listJoinRequests,
        reviewJoinRequest: reviewJoinRequest,
        changeMemberRole: changeMemberRole,
        removeMember: removeMember,
        listNotifications: listNotifications,
        unreadNotifications: unreadNotifications,
        markNotificationRead: markNotificationRead,
        markAllNotificationsRead: markAllNotificationsRead,
        currentSpace: currentSpace,
        lookUpInvitation: lookUpInvitation,
        readInvitation: readInvitation,
        acceptInvitation: acceptInvitation,
        acceptInvitationCode: acceptInvitationCode,
        privacyStatus: privacyStatus,
        privacySetup: privacySetup,
        privacyUnlock: privacyUnlock,
        privacyLock: privacyLock,
        privacyChangePassword: privacyChangePassword,
        privateMemories: privateMemories,
        privateMemory: privateMemory,
        privateUpdate: privateUpdate,
        privateRemove: privateRemove,
        privateAccess: privateAccess,
        listAnniversaries: listAnniversaries,
        getAnniversary: getAnniversary,
        createAnniversary: createAnniversary,
        updateAnniversary: updateAnniversary,
        removeAnniversary: removeAnniversary,
        toAnniversary: toAnniversary,
        get online() { return online; },
        markOffline: function () { online = false; }
    };
})(window);
