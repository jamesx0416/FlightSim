# Stock Support Scope

Current fixture-driven stock XML coverage is narrower than the full public Asobo XML tree.

Verified fixture routes:
- A320:
  - `https://vanilla-3dtiles.localhost:3000/?package=/tmp/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0`
- A330:
  - `https://vanilla-3dtiles.localhost:3000/`

The current A320/A330 model XML include graphs pull in these mounted public stock Asobo XML files:
- `Asobo/Common.xml`
- `Asobo/Common/Index.xml`
- `Asobo/Exterior.xml`
- `Asobo/Generic.xml`
- `Asobo/Generic/FX.xml`
- `Asobo/Generic/Index.xml`

Notes:
- `Exterior.xml` is already verified clean on both fixtures.
- `Common.xml` / `Common/Index.xml` / `Generic.xml` / `Generic/Index.xml` are part of the active fixture include chain and are the next authoritative stock XML families to validate.
- `Generic/FX.xml` is mounted and resolved in the active fixture include chain, but actual runtime FX execution remains outside the current renderer/runtime scope.
- Most of the remaining downloaded public stock XML files are not currently exercised by the A320/A330 fixture routes. They should not be marked complete unless they are either:
  - exercised and verified on the fixture routes, or
  - explicitly documented as blocked / out of current runtime scope with a reason.
