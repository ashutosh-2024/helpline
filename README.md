# Nearest Help Now

A tiny installable web app (PWA): one big button finds the nearest **hospitals, pharmacies, police stations, fire stations and blood banks**, sorted by distance, each with **📞 Call** and **🧭 Directions** buttons.

No backend, no API keys, no cost.

## Features

- **One tap**: uses your phone's GPS. If location is blocked or unavailable, type an area, city or landmark instead.
- **Emergency number always on top**: a big **Call 112** button, adjusted to the local number by time zone (India 112, plus quick-dial 108 / 100 / 101 / 1091 / 1098; US 911; UK 999; Australia 000).
- **Widens the search automatically**: 3 km → 8 km → 20 km until at least 3 hospitals are found.
- **Filters** by category, a **map** (Leaflet + OpenStreetMap tiles), and badges for **Emergency** departments and **24/7** places.
- **Call** uses the phone number from OpenStreetMap when there is one. **Directions** opens Google Maps navigation.
- **Works offline** once loaded: the app shell is cached, and the last results are saved on the phone and shown if you have no signal.

## How it works

| Piece | Source |
|---|---|
| Places | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (OpenStreetMap data), with 3 public servers tried in turn |
| Typed-place search | [Nominatim](https://nominatim.org/) |
| Map | [Leaflet](https://leafletjs.com/) 1.9.4 + OSM tiles |
| Directions | `https://www.google.com/maps/dir/?api=1&destination=lat,lng` |

OpenStreetMap data can be incomplete, especially phone numbers. You can improve your area at [openstreetmap.org](https://www.openstreetmap.org).

## Run locally

```sh
python3 -m http.server 8766
# open http://localhost:8766
```

## Deploy to GitHub Pages

Location only works over **HTTPS** (or localhost):

```sh
gh repo create helpline --public --source=. --push
gh api repos/{owner}/helpline/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

Then open `https://<you>.github.io/helpline/` on your phone and choose **Add to Home screen**.

## Files

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline support and installability

When you change any app file, bump `VERSION` in `sw.js` so installed copies update.

## Disclaimer

This is a helper, not an emergency service. In a life-threatening emergency, call your local emergency number first.
