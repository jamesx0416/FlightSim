# Air Physics TODO

This checklist tracks airborne flight dynamics and propulsion physics. Ground contact and ground handling are intentionally deferred.

## First complete airborne slice

- [~] Define simulator agnostic canonical airframe and propulsion physics metadata.
- [ ] Translate authoritative MSFS `flight_model.cfg` and `engines.cfg` metadata into that definition.
- [ ] Add atmosphere state for altitude, temperature, pressure, density, speed of sound, Mach, and wind.
- [ ] Add a fixed step rigid body air physics subsystem in the engine `physics` scheduler phase.
- [~] Use spanwise wing elements so local airflow, roll rate, control deflection, flaps, and spoilers affect forces at their physical locations.
  - [x] Roll rate changes local airflow independently across left and right wing elements.
  - [x] Ailerons act only on their local outboard wing elements with opposite left/right deflection.
  - [x] Flap lift and drag act only on wing elements inside the configured flap span.
  - [x] Allow one wing to stall before the other from each element's independent local angle of attack, with explicit asymmetric post-stall verification.
  - [x] Model sideslip through local wing/tail airflow and fuselage crossflow force using authored fuselage geometry.
  - [x] Drive tail downwash from spanwise wing circulation so asymmetric loading and stall change the local wake.
  - [x] Add spatially and temporally varying turbulence and gusts so individual elements see different perturbations.
  - [x] Add ground effect using local wing height and the package-authored maximum intensity.
  - [ ] Add aeroelastic wing flex driven by distributed element loads after aerodynamic validation.
- [ ] Apply engine thrust at each authored engine location so asymmetric thrust creates the correct moments.
- [ ] Drive thrust from N1, Mach, static thrust, thrust scalar, and the package thrust table.
- [ ] Keep starter, ignition, fuel availability, spool state, and generator availability coupled to existing canonical propulsion systems.
- [ ] Expose physics state and controls through `window.__DevApi` for deterministic browser testing.
- [ ] Verify the Headwind A330 at sea level, altitude, different temperatures, clean and configured flight, and asymmetric thrust.
- [ ] Run typecheck and the complete test suite.

## Later airborne fidelity

- [x] Add horizontal and vertical tail elements and richer fuselage crossflow modelling where package metadata supports it.
- [x] Add local finite-wing subsonic compressibility while retaining package-authored transonic Mach drag.
- [ ] Add turbulence, gusts, icing, precipitation, and weather driven wind fields.
- [ ] Add dynamic aircraft mass, CG, inertia, and fuel burn from tank state.
- [ ] Add aeroelastic wing flex driven by computed aerodynamic load.

## Deferred

- [ ] Ground contact, suspension, tire friction, braking, steering, runway surface response, and collisions.
