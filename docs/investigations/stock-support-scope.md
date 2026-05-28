# Stock Support Scope

Current fixture-driven stock XML coverage is narrower than the full public Asobo XML tree.

Active checklist:
- The active stock-support checklist currently lives in [loader-todo.md](loader-todo.md#stock-support-todo).
- Keep stock-support status updates in `loader-todo.md` and use this file only for scope notes.

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
- 2026-05-11: Lighting, pressurization, safety, passenger, pilot, electrical subtemplate, fuel subtemplate, and passenger subtemplate items in the active checklist have separate A330/A320 DevApi verification evidence from targeted stock input-event/key-event runtime support, so those items are no longer part of the unchecked remainder. GPS, glass cockpit, generic complex, and misc XML families remain unchecked until their mounted stock contracts are exercised or explicitly scoped out.
- 2026-05-28: `AircraftTypes/Gliders.xml` and `AircraftTypes/Rotorcrafts.xml` are blocked on public glider/rotorcraft fixture coverage. The current A320/A330 airliner routes do not include those XML files, so airliner route smokes cannot prove their yaw-string, rotor, collective, swashplate, or rotorcraft-specific interaction behavior.
- 2026-05-28: The public `Asobo/Airliner/*.xml` family remains mostly unchecked because the active A320/A330 package routes do not exercise it as their full airliner behavior source. Targeted stock FMC/MCDU brightness behavior is verified separately, and the remaining FBW-to-ASOBO Airbus template alias is intentionally blocked as vendor-specific.
- 2026-05-28: `Asobo/Inputs/Generic.xml`, `Helpers.xml`, and `Templates.xml` are partially covered through the checked Common/NAVCOM/Transponder input-event work, but they remain unchecked as full files because the public generic input contract includes tooltip/watch-var/value metadata, full interaction-template dispatch, and first-available binding variants that have not all been exercised on current routes.
- 2026-05-28: The public `Asobo/GPS/*` and `Asobo/GlassCockpit/*` families are blocked on representative avionics fixture/harness coverage. Shared lower-level input, autopilot, NAVCOM, emissive, and screen primitives are covered elsewhere, but the suite-specific GPS/glass softkey, joystick, bezel, and screen contracts are not instantiated by the active A320/A330 routes.
