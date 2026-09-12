const GEOAPIFY_API_KEY = "85867c06d61349a3a6ca728bdb6d3624"

const map = L.map('map').setView([51.5074, -0.1276], 15);

L.maplibreGL({
    style: 'https://tiles.openfreemap.org/styles/dark',
    maxZoom: 5,
    attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

let currentLocation = null

window.onload = function () {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition((position) => {
            currentLocation = [position.coords.latitude, position.coords.longitude]
            map.flyTo(currentLocation, 15, { duration: 1.5 })
            const currentLocationMarker = L.circleMarker(currentLocation, {
                radius: 6,
                fillColor: '#439eff',
                color: '#000',
                weight: 1,
                opacity: 1,
                fillOpacity: 1
            });

            map.addLayer(currentLocationMarker);
        });
    }
};

let marker = null;
let isochroneLayer = null;
let currentLatLng = null;
let currentPolygonGeoJSON = null;
let pubMarkersGroup = L.layerGroup().addTo(map);

// DOM Elements
const optionsFoldout = document.getElementById('options-foldout');
const toggleOptionsBtn = document.getElementById('toggle-options-btn');
const pubListContainer = document.getElementById('pub-list-container');

// Toggle Fold-out Options Panel
toggleOptionsBtn.addEventListener('click', () => {
    optionsFoldout.classList.toggle('open');
});

// Generic Debounce Utility
function debounce(func, delay = 400) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// --- Ramer-Douglas-Peucker polygon simplification ---
// Perpendicular distance from point p to the line segment a-b
function perpendicularDistance(p, a, b) {
    const [px, py] = p;
    const [ax, ay] = a;
    const [bx, by] = b;

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        // a and b are the same point
        return Math.hypot(px - ax, py - ay);
    }

    // Project p onto the line, clamped to the segment
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const closestX = ax + t * dx;
    const closestY = ay + t * dy;

    return Math.hypot(px - closestX, py - closestY);
}

function simplifyPolygon(points, tolerance = 0.00003) {
    // tolerance is in the same units as the coordinates (degrees, here) -
    // 0.0003 degrees is roughly 30m at UK latitudes, which is well within
    // what matters for a "is this pub in the area" check.
    if (points.length <= 2) return points;

    let maxDistance = 0;
    let maxIndex = 0;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const distance = perpendicularDistance(points[i], first, last);
        if (distance > maxDistance) {
            maxDistance = distance;
            maxIndex = i;
        }
    }

    if (maxDistance > tolerance) {
        // Keep this point - recurse on both halves
        const left = simplifyPolygon(points.slice(0, maxIndex + 1), tolerance);
        const right = simplifyPolygon(points.slice(maxIndex), tolerance);
        return left.slice(0, -1).concat(right);
    }

    // No point deviates enough to matter - collapse to the endpoints
    return [first, last];
}

const debouncedFetchAndDrawIsochrone = debounce(() => {
    if (currentLatLng) fetchAndDrawIsochrone();
}, 400);

// Map Click Event - Sets location and runs search
map.on('click', async (e) => {
    currentLatLng = e.latlng;
    updateMarker(currentLatLng.lat, currentLatLng.lng);
    await fetchAndDrawIsochrone();
});

// Search Button & Enter Key Events
document.getElementById('search-btn').addEventListener('click', geocodeAddress);
document.getElementById('address-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') geocodeAddress();
});

// Settings Input Events (Only fire if a search location is active)
document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (currentLatLng) debouncedFetchAndDrawIsochrone();
    });
});

document.getElementById('time-input').addEventListener('input', () => {
    if (currentLatLng) debouncedFetchAndDrawIsochrone();
});


function updateMarker(lat, lng) {
    if (marker) {
        marker.setLatLng([lat, lng]);
    } else {
        marker = L.marker([lat, lng]).addTo(map);
    }
    map.flyTo([lat, lng], 15, { duration: 1.5 })
}

async function geocodeAddress() {
    const query = document.getElementById('address-input').value.trim();
    if (!query) return;

    const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(query)}&apiKey=${GEOAPIFY_API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            const [lng, lat] = data.features[0].geometry.coordinates;
            currentLatLng = { lat, lng };

            map.flyTo([lat, lng], 15, { duration: 1.5 })
            updateMarker(lat, lng);
            await fetchAndDrawIsochrone();
        } else {
            alert('Location not found. Please try a different query.');
        }
    } catch (err) {
        console.error('Geocoding Error:', err);
    }
}

async function fetchAndDrawIsochrone() {
    if (!currentLatLng) return;

    const mode = document.querySelector('input[name="mode"]:checked').value;
    const minutes = parseInt(document.getElementById('time-input').value, 10) || 15;
    const seconds = minutes * 60;

    const url = `https://api.geoapify.com/v1/isoline?lat=${currentLatLng.lat}&lon=${currentLatLng.lng}&type=time&mode=${mode}&range=${seconds}&apiKey=${GEOAPIFY_API_KEY}&avoid=highways|ferries`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        currentPolygonGeoJSON = data;

        if (isochroneLayer) {
            map.removeLayer(isochroneLayer);
        }

        isochroneLayer = L.geoJSON(data, {
            style: {
                color: '#EBD917',
                fillColor: '#EBD917',
                fillOpacity: 0.2,
                weight: 1
            }
        }).addTo(map);
        if (currentPolygonGeoJSON) {
            await fetchPubsInPolygon(data);
        }

    } catch (err) {
        console.error('Geoapify Error:', err);
    }
}

async function fetchPubsInPolygon(geojsonData) {
    console.log("Querying OSM for pubs")
    pubMarkersGroup.clearLayers();
    const listElement = document.getElementById('pub-list');
    const statusElement = document.getElementById('pub-status');
    const headerElement = document.getElementById('pub-count-header');

    listElement.innerHTML = '';
    statusElement.innerText = 'Searching for pubs...';
    headerElement.innerText = 'Pubs in Reach';

    const feature = geojsonData.features[0];
    const geometryId = geojsonData["properties"]["id"]
    let coords = [];

    if (feature.geometry.type === 'Polygon') {
        coords = feature.geometry.coordinates[0];
    } else if (feature.geometry.type === 'MultiPolygon') {
        coords = feature.geometry.coordinates[0][0];
    }

    if (!coords || coords.length === 0) {
        statusElement.innerText = 'Invalid area shape.';
        return;
    }

    // Ensure closed polygon ring
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push(first);
    }

    // Simplify before querying - Overpass poly cost scales with vertex count,
    // and isolines are usually far more detailed than a pub search needs.
    const originalCount = coords.length;
    let simplifiedCoords = simplifyPolygon(coords);

    // Safety net: a degenerate/very small polygon could collapse to under
    // 4 points (not a valid ring). Fall back to the original in that case.
    if (simplifiedCoords.length < 4) {
        simplifiedCoords = coords;
    }

    console.log(`Simplified polygon: ${originalCount} -> ${simplifiedCoords.length} points`);

    const polyString = simplifiedCoords.map(p => `${p[1]} ${p[0]}`).join(' ');

    let result = null;
    let lastError = null;

    let categories = 'catering.pub,catering.taproom'
    const queryUrl = `https://api.geoapify.com/v2/places?categories=${categories}&filter=geometry:${geometryId}&apiKey=${GEOAPIFY_API_KEY}`

    try {
        console.log(`Trying query to ${queryUrl}`)
        const response = await fetch(queryUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 100)}`);
        }

        result = await response.json();
    } catch (err) {
        console.warn(`Endpoint ${url} failed:`, err);
        lastError = err;
    }

    if (!result) {
        console.error('Something went wrong:', lastError);
        statusElement.innerText = 'Error loading pubs (Server busy).';
        return;
    }

    const pubs = result.features;
    statusElement.innerText = '';
    headerElement.innerText = `Pubs in Reach (${pubs.length})`;

    if (pubs.length === 0) {
        statusElement.innerText = 'No pubs found within this area.';
        return;
    }

    pubs.forEach(pub => {
        const [lon, lat] = pub.geometry.coordinates;
        const name = (pub.properties && pub.properties.name) ? pub.properties.name : 'Unnamed Pub';

        if (!lat || !lon) return;

        const pubMarker = L.circleMarker([lat, lon], {
            radius: 10,
            fillColor: '#EBD917',
            color: '#000',
            weight: 1,
            opacity: 1,
            fillOpacity: 0.9
        }).bindPopup(`<b>${name}</b>`);

        pubMarkersGroup.addLayer(pubMarker);

        const li = document.createElement('li');
        li.innerText = name;
        li.addEventListener('click', () => {
            map.setView([lat, lon], 16);
            pubMarker.openPopup();
        });
        listElement.appendChild(li);
    });
    console.log(pubs)
}