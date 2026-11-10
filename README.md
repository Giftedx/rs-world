# RS World

A live 3D view of an [rs-sdk](https://github.com/MaxBittker/rs-sdk) game world. It renders the map from
the server's own cache and streams every player and npc from the engine as they move, fight, skill and talk.

It's a fork of dennisdev's [rs-map-viewer](https://github.com/dennisdev/rs-map-viewer), the viewer
behind [osrs.world](https://osrs.world). The terrain, locs and camera are theirs; the live layer is
new. See [DESIGN.md](DESIGN.md) for how it works.

**This fork** ([Giftedx/rs-world](https://github.com/Giftedx/rs-world)) adds to
[MaxBittker/rs-world](https://github.com/MaxBittker/rs-world): an embed mode that another page drives by
URL and by message, multi-view with tiling layouts, camera flight between followed players, touch
gestures and ground items. [rs-fleet-dashboard](https://github.com/Giftedx/rs-fleet-dashboard) uses it as
its 3D view. Each change goes to MaxBittker/rs-world as its own pull request. See [Credits](#credits)
for the authors of the work it builds on.

<img src="screenshots/live-lumbridge.png" alt="Live players and npcs in the Lumbridge castle courtyard">

## What you see

- **The world as the server packs it**: rev 289 terrain, locs and models from rs-sdk's cache.
- **Live players**: each player's real body (identity kits, colours and worn items), walking, running,
  combat and skilling animations, overhead chat, hitsplats, health bars, and overhead prayers and
  skulls.
- **Live npcs**: every npc in view with its server-side movement, animations, overhead text and combat.
- **Follow a player**: right-click a player → Follow, pick them in the Live panel, or open `?follow=<name>`.
  `[` and `]` (or Prev/Next in the panel) step to the previous and next player in the list.
  While following, drag (or the arrow keys) orbits the player and the wheel zooms; moving the camera
  (WASD, Q/E, right-drag) stops following. Otherwise the wheel flies the camera forward and back.
  Zooming out sees further and streams more of the world.
- **Multi-view**: watch up to 16 players at once. **+ View** in the Live panel (or right-click a
  player → View) splits the screen; each view follows its own player, with a name box and **×** in
  its bottom-left corner. Click a view to select it: the Live panel, keys, drag and wheel then act on
  that view. Closing views down to one returns to the normal single view. All views share one WebGL
  renderer, cache, worker pool, map squares and baked models; each view has its own feed connection.
- **Pan**: right-drag slides the camera over the ground. A right click without dragging opens the menu.
- **Touch**: one-finger drag rotates, two-finger drag pans and pinch zooms, like drag, right-drag and the
  wheel. The joystick at the bottom left moves the camera too. While following, a one-finger drag orbits
  the player and a pinch changes the orbit distance; a two-finger drag stops following, as a right-drag does.
- **World map**: every online player as a dot (white, your followed player orange). Click one to fly there.

## Running locally

You need an rs-sdk engine with its world feed turned on. The feed ships with rs-sdk and is off by
default.

```sh
# 1. Engine with the feed on (from an rs-sdk checkout)
cd ../rs-sdk/server/engine
WORLD_FEED=true EASY_STARTUP=true bun run src/app.ts

# 2. Install the engine's cache into caches/ (reads ../rs-sdk/server/engine/data/pack)
cd ../../../rs-world
yarn sync-cache

# 3. Viewer
yarn install --ignore-scripts   # sharp (texture export script only) doesn't build on new Node
yarn start                      # http://localhost:3000, feed defaults to ws://localhost:8888/worldfeed
```

To watch a remote server, sync its cache over HTTP and point the viewer at its feed:

```sh
yarn sync-cache --server https://rs-sdk-demo.fly.dev
# then open http://localhost:3000/?live=wss://rs-sdk-demo.fly.dev/worldfeed
```

That only works if that server runs with `WORLD_FEED=true`.

## URL parameters

| Param                  | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `live=<ws url>`        | World feed to stream (URL-encode it if it carries `?token=`). `off` disables it. |
| `follow=<name>`        | Fly to a player and keep following them.                                    |
| `multi=<a,b,...>`      | Open multi-view with up to 16 players, one view each.                       |
| `md=<tiles>`           | Multi-view distance per view, 16-128 (default 48).                          |
| `tile=<mode>`          | Multi-view layout: `grid` (default), `main`, `focus` or `columns`.          |
| `cx cy cz p y v=1`     | Camera position, pitch and yaw, same as osrs.world.                         |
| `embed=1`              | For a frame in another page: hides the panels, the minimap, the fps counter and the joysticks, and frames the followed player from 20 tiles out. |
| `fps=<n>`              | Frame rate cap.                                                             |
| `scale=<0-1>`          | Render resolution scale. `0.5` draws a quarter of the pixels.               |
| `ml=<0-3>`             | The highest floor drawn, from the first frame.                              |
| `hideNames=<a,b>`      | Players whose nameplates are never drawn.                                   |
| `hideNamesFrom=<url>`  | The same list as a JSON array, fetched with CORS.                           |
| `highlightFrom=<url>`  | A JSON array of players, fetched with CORS. Their nameplates are gold.      |
| `flight=0`             | A follow change jumps at once, with no camera flight.                       |

The Live panel (bottom right) shows connection state, the online count and every player (scroll for more). Info, under
it, credits the original viewer and links the repos. Render settings (top right) default to one step
brighter than the old client default and 1 rendered pixel per CSS pixel. Pick Native there for
full hi-dpi resolution. Follow Level (on by default) makes Max Level track the floor of the player
you're following, so it changes as they climb up and down stairs and ladders.

iPhone and iPad browsers can load the viewer when WebGL2 is available. Touch controls use the
joystick and gestures on the scene (see Touch above). On mobile, the player list and Info button sit at the
top right, and the render settings menu is hidden. Browsers without shared memory use one worker with
an ordinary copy of the cache; cross-origin isolation is still recommended for lower memory use.

### Messages from an embedding page

A page that holds the viewer in a frame can change it with `postMessage`, so the frame never reloads:

| Message                        | Effect                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| `{follow: "<name>"}`           | Fly to this player and follow them.                            |
| `{fps: 20}`                    | Frame rate cap.                                                |
| `{scale: 0.5}`                 | Render resolution scale.                                       |
| `{maxLevel: 1}`                | The highest floor drawn, 0-3. No reload.                       |
| `{warm: [[x, z], ...]}`        | Up to 16 places that the page may follow next. The viewer loads their map squares ahead. |

### Multi-view in an embedding page

With `?embed=1` the page owns the views. It sets them with `?multi=a,b,c` at load or with a message, and
the viewer answers with messages to `window.parent`:

| Message                                              | Direction | Meaning                                                                 |
| ---------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `{multi: ["a", "b", ...]}`                           | to viewer | Show these players, one view each (at most 16). Views that already follow an asked player keep their feed. |
| `{multi: []}`                                        | to viewer | Return to the single view.                                              |
| `{multiDistance: 48}`                                | to viewer | View distance per view in tiles, 16-128.                                |
| `{viewerMulti: {names, shown, offline}}`             | to page   | `names` in the asked order; `shown` have their player on screen; `offline` are not online. A name in neither list is still being found. Sent when it changes; all three are empty after `{multi: []}`. |
| `{viewerMultiPick: "<name>", index: <view number>}`  | to page   | A click or tap on a view. The viewer does nothing else with it.         |
| `{multiLayout: {mode, main, gap, ratio, rows, cols, strip, animate, color}}` | to viewer | The tiling. Every part is optional and keeps its value when absent or out of range. `mode`: `"grid"`, `"main"`, `"focus"` or `"columns"`. `main`: the main view, by name or by its number in the asked order. `gap`: 0-24 px between views (default 4). `ratio`: 0.5-0.8, the share of the main view in `"main"` (default 0.62). `rows`, `cols`: the shares of the rows and of the columns in `"grid"` and `"columns"`, one positive number for each row and for each view of a full row; a list of another length is not used, a share under a quarter of an even one is refused, and `[]` gives even sizes back. `strip`: 0.1-0.45, the share of the height the thumbnail strip takes in `"focus"`; 0 gives its own size back. `animate: false`: changes are drawn at once. `color`: `#rrggbb` of the gaps. |
| `{multiOrder: ["b", "a", ...]}`                      | to viewer | The same views in a new order. No view follows another player. A name with no view is skipped; a view that is not named stays after the named ones. |
| `{multiFocus: "<name>"}` or `{multiFocus: <number>}` | to viewer | Selects a view. It is the view that stays when the viewer returns to the single view. |
| `{multiChrome: false}`                               | to viewer | The page draws the names and frames: the viewer draws no label and no selection frame on a view, and a double click on a view does not lock the pointer. |
| `{viewerMultiLayout: {mode, main, focus, rects, animating, ms, at}}` | to page | Where the views go. `rects` is `[{name, x, y, w, h}]` in the asked order: the target rectangles in CSS pixels of the viewer frame. `main` and `focus` are names or `null`. With `animating: true` the views move there over `ms` milliseconds from the time `at` (milliseconds since the Unix epoch) with an ease-out cubic curve, `cubic-bezier(1/3, 1, 2/3, 1)` in CSS. Sent when the targets change, when a move ends (`animating: false`, `ms: 0`) and after `multiFocus`. |

Each view hides the floors above its own player. A view prints its player's name in its bottom-left
corner, except for a hidden name (`hideNames`, `hideNamesFrom`): that view has no label, the name is
not drawn over the player, and messages carry the marker `⟦MAIN⟧` in its place. The marker can also
be asked for in `multi`, `multiOrder`, `multiFocus` and `multiLayout.main`, as in `follow`. A view of
a player who is not online starts to follow them when they log in. Camera input is off in the views
of an embedding page.

The views are tiled, and the main view is the first tile of every layout:

| Layout    | Tiles                                                                                         |
| --------- | --------------------------------------------------------------------------------------------- |
| `grid`    | The column count that gives the largest 4:3 views for the window. The last row is stretched over the full width, so no part of the window is empty. |
| `main`    | The main view takes `ratio` of the window. The others are a grid beside it in a wide window and under it in a tall one. |
| `focus`   | The main view at the full width, over a strip of thumbnails. A narrow window wraps the strip into at most 3 rows. |
| `columns` | Views side by side at full height. Columns narrower than 160 px wrap into rows.              |

A change of the views, their order, the layout or the main view moves each view from where it is to
its new rectangle in 240 ms. A view is the same view while its player is asked for. A new view grows
and fades in at its place; a closed view shrinks and fades out. On `{multi: []}` the selected view
grows to the full window and is then the single view. While views move, the viewer draws
every display frame, whatever the `fps` limit; at rest a frame costs what it cost before. There is
no move when the system asks for reduced motion (`prefers-reduced-motion`) or after
`{multiLayout: {animate: false}}`, and a new window size is followed at once. `?tile=<mode>` sets
the layout from the URL.

## Deploying

Every push to `main` deploys to GitHub Pages at https://maxbittker.github.io/rs-world/
(`.github/workflows/pages.yml`). The workflow syncs the cache from `https://rs-sdk-demo.fly.dev` and
defaults the feed to `wss://rs-sdk-demo.fly.dev/worldfeed`. Set the `RS_SDK_SERVER` and
`WORLD_FEED_URL` repository variables to point it elsewhere.

Elsewhere, `yarn build` gives a static site. Copy `caches/` to `build/caches/` and host the result with:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  The viewer shares cache buffers with its workers (`SharedArrayBuffer`) when available, and
  otherwise uses ordinary buffers with one worker. `public/_headers` sets
  both on Cloudflare Pages and Netlify. Hosts that can't set headers (like GitHub Pages) fall back
  to `public/coi-serviceworker.js`, which adds them from a service worker and reloads once.
- `REACT_APP_WORLD_FEED_URL=wss://<server>/worldfeed` at build time, so the live layer has a default
  off localhost.
- `PUBLIC_URL=/<path>` at build time when the site isn't served from the domain root.

On the engine side, see the deployment notes in [DESIGN.md](DESIGN.md#deploying-the-feed).

## Credits

- Multi-view and the ground items are ports of work by Stunned
  ([TestingPurposes/rs-world](https://github.com/TestingPurposes/rs-world), BSD 2-Clause): the
  multi-view branch (upstream pull request 4) and the world-state branch (upstream pull request 5)
- The touch gestures are by Kaden Staker ([kadeski](https://github.com/kadeski), upstream pull request 1)
- [rs-map-viewer](https://github.com/dennisdev/rs-map-viewer) by dennisdev (BSD 2-Clause), which
  credits Jagex, RuneLite, the OpenRS2 Archive, the RuneScape Archive, the OSRS Wiki, 2004scape,
  2009scape, RuneStar, Blurite and the RuneApps Model Viewer
- [rs-sdk](https://github.com/MaxBittker/rs-sdk) and [LostCity](https://github.com/LostCityRS) (MIT):
  the engine, the cache, and the client logic the live layer ports
