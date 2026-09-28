# Asteroid Watch

A live 3D dashboard of the asteroids passing Earth each day, built on NASA's
[NeoWs](https://api.nasa.gov/) (Near Earth Object Web Service).

- **What's flying by today**: every close approach for the day, with size, speed and miss distance
- **Hazard flags**: potentially hazardous asteroids (and Sentry-monitored objects) are highlighted, and you can filter to show only them
- **Real positions in 3D**: each asteroid is placed around Earth using its published orbit, with its trajectory, the Moon, and Earth's real day/night side and rotation
- **Click anything**: asteroids in the scene, list cards, timeline ticks and stat tiles all open a detail panel with a size comparison, a distance ladder, an orbit diagram around the Sun, orbital elements and the observation record
- **Time travel**: scrub the day or play it back at 1 min/s, 10 min/s or 1 h/s. Other days are one click away.

Live at **https://asteroidwatch.hashimsalim.com**, served by GitHub Pages from the `main` branch.

## Run it

It's a static site with no build step, but ES modules need to be served over HTTP:

```bash
cd ~/Desktop/NASA
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## API key

Your NASA API key lives in `js/config.js`. Because this is a browser app, the key
is sent to the browser, so anyone who can open the page can read it. That's
fine for a personal NASA key, but keep it in mind before hosting the site
publicly.

Each day you view is cached locally, so revisiting a day doesn't spend a request.

## How asteroid positions are computed

NeoWs gives a miss distance and time but no direction, so the app requests the
feed with `detailed=true`, which includes each asteroid's orbital elements. For
any moment it then:

1. propagates the asteroid's Kepler orbit and Earth's orbit (JPL approximate elements, corrected for the Moon)
2. subtracts the two to get the asteroid's position relative to Earth
3. nudges the path by a tiny constant offset so the closest approach matches NASA's published miss distance exactly (the raw two-body result is typically within 0.1%)

Distances from Earth are drawn on a **logarithmic scale**. Otherwise a flyby at
40 lunar distances would be about 60 m from a 1 cm Earth. Rings mark 10, 30 and
100 LD (1 LD = the Earth–Moon distance, 384,400 km).

## Controls

| Action | How |
| --- | --- |
| Orbit / zoom / pan | Drag / scroll / right-drag |
| Select an asteroid | Click it in the scene, list or timeline |
| Back to overview | `Esc` or the back arrow |
| Play / pause | `Space` |
| Previous / next day | `[` / `]` |
| Scrub time | Drag the timeline, or focus it and use arrow keys (`Shift` = 1 hour) |

## Files

```
index.html            layout, icons, import map (Three.js from jsDelivr)
css/styles.css        glass HUD styling, responsive down to phone width
js/main.js            app state, list, detail panel, timeline, date navigation
js/scene.js           Three.js scene: Earth shader, Moon, asteroids, trails, camera
js/astro.js           orbital mechanics (Kepler solver, Earth/Moon ephemerides, sidereal time)
js/neo.js             turns NeoWs records into models with a trajectory function
js/api.js             NeoWs client with localStorage caching
js/config.js          your NASA API key
js/orbit-diagram.js   SVG of the asteroid's orbit around the Sun
js/format.js          number, date and size-comparison helpers
```

Data: NASA NeoWs / JPL Small-Body Database. Earth textures: NASA Blue Marble
and Black Marble via the `three-globe` package.
