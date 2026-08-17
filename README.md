# Fall Line

**[▶ Play it in the browser](https://wiseecarrot.github.io/fall-line/)** — no install, no build step.

A first-person skiing game that runs in the browser. Thirty-two procedurally
generated mountains — full resorts, groomed trails, black diamond chutes,
terrain parks and backcountry — with a fully synthesised soundtrack and other
skiers going about their own runs around you.

One of them, **Perfect North**, is built from the real hill's trail map:
twenty named runs in their actual left-to-right order — Hollywood, Center
Stage, Deception, Clyde's Super Slide, Broadway — each carrying the hill's own
difficulty rating and a pitch scaled from its published slope angle. 400 ft of
vertical, five chairs and nine ropetows at the lengths the map draws them —
two of those chairs only serve the lower mountain and one crosses most of the
hill — plus two terrain parks, a race lane, twelve tubing lanes, the snowmaking
pond, floodlit until ten, and about 250 people on it.

The look of the place is the tree islands, not the runs: on the trail map it is
a wooded hill with ribbons cut into it, and every run has bare winter hardwood
on both sides of you. Getting that took three things the rest of the catalogue
does not need — `trails.feather` to state the shoulder of a cut run outright
rather than scaling it off the width, `trails.spread` to let the run list use
the whole face instead of the middle two thirds, and `features.undergrowth` to
put last autumn's leaves on the ground between the corridors. Without them
fourteen runs 46 m apart splat into one white sheet, which is the opposite of
what the map shows.

Maps with a `trails.runs` list build named runs instead of generated ones, so
the same treatment works for any real hill you have a trail map for.

**Mount Everest** is the whole mountain in a single map: 3,497 m from the
summit ridge to Base Camp, about seven minutes, no interruption. 8,867 m at
the top and 5,377 m on the moraine, against a real 8,849 and 5,364.

It is one heightfield 6.6 km long, which needs `spec.vertexBudget` to raise it
well above the standard resolution — at the default the cells come out at 8 m
and a 15 m summit ridge stops being a ridge. At 4 m it holds: 720,000 vertices,
1.3 seconds to build.

The corridor does the work of describing the mountain: 30 m at the Hillary
Step, 480 m on the South Col, 657 m across the Cwm, 78 m threading the Icefall.
Ice covers the Lhotse Face and the Icefall and nothing else; crevasses are
banded to the Cwm and the Icefall; the Yellow Band outcrops where it should.

Because one terrain can only have one sky — and a mountain this tall genuinely
doesn't have one — `weatherStops` interpolates presets with height. The zenith
runs from near-black death zone to pre-dawn blue, the sun from 3.1 to 1.35, and
visibility from 13.7 km down to 4.2 km, continuously as you descend.

`features.iceField` marks whole altitude bands as bare ice rather than the
discrete frozen tarns `lakes` makes — a face of blue ice is a surface, not a
feature sitting on one, and the existing ice channel (almost no friction, no
edge hold, glassy chattering audio) then does the rest. `features.rockBands`
puts strata of a different colour at a given height, and has to *create* rock
rather than recolour it: on a carved corridor there's no slope-derived rock to
recolour, so the Yellow Band vanished exactly where you ski through it.

`features.exposure` is a ridge alternative to boundary walls: every map keeps
you in by rising at the edges, which a corniced knife edge with three kilometres
of air either side can't do and still be the thing it is, so straying further
than N metres from the line means you've gone over it. No map sets it at the
moment — it's a single limit for a whole map, and Everest's summit ridge and its
620 m-wide Cwm floor can't share one. Banding it by `t` would fix that.

There is no timer, no race, no gates and no finish line. You pick a mountain and
you ski down it.

## Running it

The game is plain ES modules with no build step, but it does need to be served
over HTTP (module imports and the import map won't work from `file://`).

```
npx http-server -p 8123 -c-1
```

then open <http://localhost:8123>.

Three.js is vendored into `vendor/` so the game runs completely offline. The
only npm dependency is Three itself, and only so that `npm install` can refresh
that vendored copy.

Requires WebGL 2 and the Web Audio API — any current Chrome, Edge, Firefox or
Safari.

## Controls

| | |
|---|---|
| **Mouse** | Steer. The skis follow where you look. |
| **W** / **Shift** | Skate and tuck. Pushes you along from a standstill — hard at low speed, fading out as you pick up pace — then becomes a tuck once you're moving. |
| **E** | Ride the lift you're standing at, or get off one early |
| **S** / **Ctrl** | Check your speed (snowplough / skid) |
| **Space** | Pop off a lip. When you're barely moving, poles you along instead. On a rail, hops off. |
| **A** / **D** | Steer without the mouse |
| **C** or right-click | Look around without changing where the skis point |
| **R** | Restart — back where you began the run |
| **Esc** | Pause |
| **M** / **N** / **H** / **F** | Mute · score · HUD · view model |

## How it works

### Terrain

Nothing is hand-modelled. Each map in `src/world/maps.js` is a description —
a seed, a size, a pitch profile, how rough it is, how many trees, what the
weather's doing — and `src/world/terrain.js` turns that into a heightfield.

The pitch profile is the important part. It's a list of gradients down the run,
so a map can have a steep headwall, a bench in the middle and a flat runout, and
the generator turns that into terrain that actually skis that way. Vertical drop
is *derived* by integrating the profile rather than authored separately; the two
have to agree, and the profile is the one that decides how it feels.

On top of the base slope: relief noise for the shape of the hill, trail
corridors splatted in from meandering splines, mogul fields, cliff bands, glacier
crevasses, ridgelines at the boundary, and — for the parks — kickers and
halfpipes stamped straight into the heightfield so the normal ski physics
handles them for free.

### The resorts

A resort is mostly the bit at the bottom, so the seven resort maps get a real
base area rather than a lodge dropped on a hillside. `terrain.js` flattens the
ground for it first — none of it can be built on a slope — carving a plaza the
trails feed into, a car park a step down beside it, a beginner apron gentle
enough for a first run, and tubing lanes with berms between them. The layout is
fitted to the map width as one block, so nothing runs off the edge.

`basearea.js` then assembles on top: day lodge with a glazed strip and a sun
deck, rentals, ticketing, patrol, ski school, lift mazes at each base terminal,
a magic carpet on the beginner slope, ski racks, benches, flags, a parked
snowcat, lamp standards that become real lights on the night maps, a few
hundred parked cars, and a couple of hundred people standing around.

The car park is tarmac, which is not a ski surface — you get about two metres
into it. Trees and boulders are kept out of the developed area, which the groom
mask alone doesn't cover, because paved ground is deliberately not groomed snow.
The buildings are solid boxes rather than collision circles, so you can ski up
to the lodge and along it, but not through it.

**You start at the bottom of a resort**, out on the plaza a short skate from a
lift. Press **E** at a base terminal to ride up: you sit on the chair and the
mountain goes past underneath, which takes a minute or two. *Skip lift rides*
in Settings puts you at the unload station instantly instead.

### Skiing

The physics is in `src/player/skier.js` and rests on one idea: the skis have a
*heading*, and snow resists any velocity that isn't along it. Put them on edge
and that resistance climbs, so turning the heading drags your momentum around
with it — that's a carve, and it keeps your speed. Flatten them and the
resistance falls away, so you skid and scrub speed instead. Everything else —
gravity down the slope, drag, powder, ice, air — hangs off that.

Three details that matter more than they look:

- **A carve redirects momentum; a skid destroys it.** The velocity vector is
  *rotated* toward the skis rather than having its sideways component deleted,
  and you're only charged for the part your edges weren't clean enough to hold.
  Delete it instead and every turn bleeds speed.
- **The ground can push but never pull.** Only the component of velocity going
  into the snow is cancelled. Project the whole velocity onto the slope plane
  each frame and the ground quietly acquires the ability to pull you down —
  you'd follow a kicker down its own back side instead of launching off it.
- **A trail can change width down its length.** `widthProfile` interpolates
  width the way `pitch` interpolates gradient, so a run can start as an open
  face and neck down to a slot. The Fang uses it to be the shape it's named
  after: 225 m wide at the top, 33 m at the throat, and the crux sits at 62%
  down where you're going fastest rather than at the entrance where you
  aren't.
- **Relief noise can't be steeper than the pitch it sits on.** A sine of
  amplitude A and wavelength L peaks at gradient 2πA/L; let that exceed the
  hill's own gradient and the noise stops being texture and starts tipping
  sections uphill, leaving hollows the map can't pull you out of. The
  amplitude is capped against the local pitch, so flat benches get gentle
  relief and steep faces keep all of theirs.

### Audio

Every sound is generated at runtime. There are no audio files in this project.

`src/audio/` builds a Web Audio graph with a synthesised convolution reverb
(sparse early reflections off valley walls, then a long dark tail) and mixes
continuous layers that you can ski by ear: broadband contact noise, hard-snow
hiss, a resonant band that rises in pitch as you load an edge, a low roar for
powder, glassy chatter on ice, and wind driven by airspeed rather than ground
speed. One-shots — landings, crashes, wood-modal tree impacts, bamboo, steel —
are synthesised per event. The score in `music.js` is a generative ambient
piece: a lookahead scheduler places pad chords, bass and bell figures on a slow
grid from a mood palette chosen to suit the mountain.

### The other skiers

`src/ai/bots.js`. They aren't racing you and don't know you exist beyond not
running into you. Each has a skill level that sets their speed, how tight they
turn, how close to the fall line they hold, and whether they take the jumps.
They ski to the bottom and reappear at the top as though they'd ridden the lift.

## Layout

```
index.html            import map + page shell
styles/main.css       interface
vendor/               three.js, vendored for offline use
src/
  main.js             entry point, WebGL2 check
  game.js             renderer, map lifecycle, the loop
  core/               noise & seeded RNG, input, spatial hash
  world/              maps, terrain, props, base areas, sky/weather, materials
  player/             ski physics, first-person camera and view model
  ai/                 the crowd
  audio/              engine, ski layers, one-shots, generative score
  ui/                 HUD, menus
```

## Notes

- Settings persist in `localStorage` under `fallline.settings`.
- Detail level changes tree, rock and skier counts; it applies next time a
  mountain loads.
- `window.game` is exposed in the console if you want to poke at it.
