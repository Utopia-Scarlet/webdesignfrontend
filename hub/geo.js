/* ==========================================================================
   LoveStory — geo engine

   Turns the vendored Natural Earth data (data/world-countries.js) into
   drawable SVG paths with a real orthographic projection.

   No library: TopoJSON arcs are delta-encoded integers, which is a few lines
   to undo; the orthographic projection and its horizon clipping are another
   thirty. Country outlines are REAL coastlines — nothing here is hand-drawn.
   ========================================================================== */

(function (global) {
    "use strict";

    var DEG = Math.PI / 180;

    /* ------------------------------------------------------------------ decode */
    /* TopoJSON stores each arc as deltas from the previous point, then scales
       and translates the whole set. Undo that once, at load. */
    function decodeArcs(topology) {
        var t = topology.transform;
        var sx = t.scale[0], sy = t.scale[1];
        var tx = t.translate[0], ty = t.translate[1];

        return topology.arcs.map(function (arc) {
            var x = 0, y = 0;
            return arc.map(function (point) {
                x += point[0];
                y += point[1];
                return [x * sx + tx, y * sy + ty];
            });
        });
    }

    /* A ring is a list of arc indexes. A negative index means "this arc,
       reversed", encoded as ~i === -i - 1. */
    function ringFromArcs(indexes, arcs, close) {
        var ring = [];

        indexes.forEach(function (index) {
            var arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
            /* Skip the joining vertex so shared endpoints are not duplicated. */
            for (var i = ring.length ? 1 : 0; i < arc.length; i++) ring.push(arc[i]);
        });

        if (close && ring.length) {
            var first = ring[0];
            var last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        }

        return ring;
    }

    function buildCountries(topology) {
        if (!topology || !topology.objects || !topology.objects.countries) return [];

        var arcs = decodeArcs(topology);

        return topology.objects.countries.geometries.map(function (geometry) {
            var polygons = geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs;

            return {
                id: String(geometry.id),
                name: (geometry.properties && geometry.properties.name) || "Unknown",
                rings: polygons.reduce(function (all, polygon) {
                    return all.concat(polygon.map(function (ring) {
                        return ringFromArcs(ring, arcs, true);
                    }));
                }, [])
            };
        });
    }

    /* -------------------------------------------------------------- projection */
    /* Orthographic, centred on [lon, lat]. Returns null for the far side so
       callers can clip rather than draw the back of the world. */
    function projector(centerLon, centerLat, scale, cx, cy) {
        var sinLat = Math.sin(centerLat * DEG);
        var cosLat = Math.cos(centerLat * DEG);

        return function (lon, lat) {
            var l = (lon - centerLon) * DEG;
            var p = lat * DEG;

            var cosP = Math.cos(p);
            var sinP = Math.sin(p);
            var cosC = sinLat * sinP + cosLat * cosP * Math.cos(l);

            var x = cosP * Math.sin(l);
            var y = cosLat * sinP - sinLat * cosP * Math.cos(l);

            return {
                x: cx + scale * x,
                y: cy - scale * y,
                visible: cosC >= 0,
                cos: cosC
            };
        };
    }

    /* Where the segment a→b crosses the visible disc. Nothing behind the
       horizon is ever drawn, so no far-side geometry leaks in. */
    function horizonPoint(a, b, scale, cx, cy) {
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var A = dx * dx + dy * dy;
        if (A === 0) return { x: a.x, y: a.y };

        var fx = a.x - cx;
        var fy = a.y - cy;
        var B = 2 * (fx * dx + fy * dy);
        var C = fx * fx + fy * fy - scale * scale;
        var disc = B * B - 4 * A * C;
        if (disc < 0) return { x: a.x, y: a.y };

        var t = (-B + Math.sqrt(disc)) / (2 * A);
        if (t < 0) t = 0;
        if (t > 1) t = 1;

        return { x: a.x + t * dx, y: a.y + t * dy };
    }

    /* One ring → one SVG subpath, clipped to the horizon. */
    function ringToPath(ring, project, scale, cx, cy) {
        var d = "";
        var drawing = false;
        var previous = null;

        for (var i = 0; i < ring.length; i++) {
            var point = project(ring[i][0], ring[i][1]);

            if (!previous) {
                if (point.visible) {
                    d += "M" + point.x.toFixed(1) + " " + point.y.toFixed(1);
                    drawing = true;
                }
            } else if (previous.visible && point.visible) {
                d += "L" + point.x.toFixed(1) + " " + point.y.toFixed(1);
            } else if (previous.visible && !point.visible) {
                var exit = horizonPoint(previous, point, scale, cx, cy);
                d += "L" + exit.x.toFixed(1) + " " + exit.y.toFixed(1);
                drawing = false;
            } else if (!previous.visible && point.visible) {
                var entry = horizonPoint(point, previous, scale, cx, cy);
                d += "M" + entry.x.toFixed(1) + " " + entry.y.toFixed(1);
                d += "L" + point.x.toFixed(1) + " " + point.y.toFixed(1);
                drawing = true;
            }

            previous = point;
        }

        return drawing ? d : d;
    }

    function isVisible(ring, project) {
        /* Cheap reject: skip rings entirely on the far side. */
        for (var i = 0; i < ring.length; i += 4) {
            if (project(ring[i][0], ring[i][1]).visible) return true;
        }
        return false;
    }

    function countryPath(country, project, scale, cx, cy) {
        var d = "";
        for (var i = 0; i < country.rings.length; i++) {
            var ring = country.rings[i];
            if (!isVisible(ring, project)) continue;
            d += ringToPath(ring, project, scale, cx, cy);
        }
        return d;
    }

    /* ------------------------------------------------------------- graticule */
    function graticule(step) {
        var lines = [];
        var i, lon, lat, line;

        for (lon = -180; lon < 180; lon += step) {
            line = [];
            for (lat = -90; lat <= 90; lat += 3) line.push([lon, lat]);
            lines.push(line);
        }
        for (lat = -60; lat <= 60; lat += step) {
            line = [];
            for (lon = -180; lon <= 180; lon += 3) line.push([lon, lat]);
            lines.push(line);
        }
        return lines;
    }

    function lineToPath(points, project) {
        var d = "";
        var drawing = false;

        for (var i = 0; i < points.length; i++) {
            var p = project(points[i][0], points[i][1]);
            if (p.visible) {
                d += (drawing ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1);
                drawing = true;
            } else {
                drawing = false;
            }
        }
        return d;
    }

    global.LoveStoryGeo = {
        countries: buildCountries(global.LoveStoryWorld),
        projector: projector,
        countryPath: countryPath,
        graticule: graticule,
        lineToPath: lineToPath,
        horizonPoint: horizonPoint
    };
})(window);
