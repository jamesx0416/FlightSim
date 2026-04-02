# MSFS Compatibility Layer Plan

**Important:** Do not implement, exit, or add anything that is aircraft-specific. All bug fixes and changes must be generic MSFS loader fixes that apply broadly, not patches tailored to a specific aircraft.

The goal is to build a serious compatibility layer for Microsoft Flight Simulator aircraft, not a simple model decoder.

The target is:

- Support both **MSFS 2020** and **MSFS 2024** aircraft.
- Aim for the highest practical level of compatibility with the **documented** aircraft-facing APIs and content formats.
- Exclude Marketplace encryption from the core architecture discussion.
- Use a **hybrid model**:
  - one-time import / compile for static package data(Stored in the browser)
  - runtime interpretation / execution for dynamic aircraft behavior
- Start with **MSFS 2020 first**, but design the system so that **MSFS 2024** support is a planned extension rather than a rewrite.

We also established an important constraint:

- Browser WebAssembly availability is not enough by itself.
- The difficult part is reproducing the **aircraft host runtime** that MSFS provides:
  - variables
  - events
  - model behavior execution
  - instrument hosting
  - panel bindings
  - sound logic
  - simulator lifecycle / timing

So the project should target:

- **Very high documented compatibility**

and not promise:

- literal **100% compatibility for every aircraft package**

until proven by implementation and test coverage.

## Goals

- Load and normalize aircraft packages from MSFS 2020 and MSFS 2024.
- Execute documented aircraft behavior formats with a custom host runtime.
- Support both visual and logical aircraft content:
  - models
  - textures
  - animations
  - model behaviors
  - panel configuration
  - HTML/JS instruments
  - a supported subset of WASM-hosted behavior
  - sound configuration semantics
- Keep the compatibility layer reusable across aircraft instead of hand-porting each one.

## Non-Goals

- Guarantee full parity with undocumented engine behavior.
- Guarantee compatibility with encrypted content.
- Recreate the whole simulator before proving the aircraft runtime.
- Hard-code aircraft-specific logic into the generic compatibility path unless used as an explicit override mechanism.

## Core Design Decision

This should be **some one-time compile, some runtime interpreter, plus local host code**.

### Import / Compile Time

Use a one-time importer/compiler for anything that depends only on package files:

- package discovery
- `aircraft.cfg`, `model.cfg`, `panel.cfg`, `panel.xml`, sound XML parsing
- 2020 vs 2024 package normalization
- template include resolution
- model behavior template expansion
- RPN / calculator code parsing to internal bytecode or IR
- asset conversion and caching
- texture transcoding / manifest generation
- node, animation, material, and attachment lookup tables

### Runtime

Use runtime execution for anything that depends on simulation state, time, input, or events:

- SimVar, LVar, BVar, and event execution
- model behavior evaluation
- animation value updates
- node visibility
- panel interactions
- HTML instrument state
- supported WASM calls
- sound trigger and parameter logic

### Local Host Code

Implement the simulator host contract locally:

- compatibility runtime
- API shims
- event loop
- panel host
- audio backend
- renderer integration
- fallback overrides

## Architecture

## 1. Package Import Layer

Responsibilities:

- read aircraft packages from disk
- support 2020 monolithic aircraft layout first
- support 2024 modular aircraft layout second
- normalize all package inputs into an internal representation

Outputs:

- normalized aircraft manifest
- normalized asset graph
- normalized behavior sources
- normalized panel/instrument descriptors
- normalized sound descriptors

## 2. Behavior Compiler

Responsibilities:

- resolve XML includes and templates
- support 2020 `Asobo` template namespace
- support 2024 `Asobo_EX1` template namespace
- lower XML behavior definitions into internal IR / bytecode
- compile calculator code / RPN once, not every frame

Outputs:

- compiled behavior graph
- compiled expressions / bytecode
- symbol tables for variables, events, nodes, animations, and parameters

## 3. Aircraft Runtime Host

Responsibilities:

- run a deterministic aircraft update loop
- expose aircraft-facing variables and events
- host behavior VM execution
- synchronize runtime state with render, input, panel, and sound systems

Core services:

- SimVar service
- local variable service
- input event service
- key event routing
- animation state service
- node state service
- effect / light trigger service

## 4. Panel Host

Responsibilities:

- parse `panel.cfg` and `panel.xml`
- mount HTML/JS instruments
- provide compatibility shims for simulator-specific JS bindings
- map panel events and display surfaces into the web app

Important rule:

- treat HTML instruments as hosted apps with a simulator bridge, not as ordinary static pages

## 5. WASM Host Adapter

Responsibilities:

- define a supported compatibility subset for aircraft WASM use
- expose documented aircraft-facing APIs through a host shim
- support versioned runtime behavior where 2020 and 2024 differ

Important rule:

- do not begin with full arbitrary module support
- begin with a narrow documented subset and expand based on tested aircraft requirements

## 6. Sound Host

Responsibilities:

- parse sound XML
- evaluate sound conditions and parameter routing
- map aircraft-driven sound logic onto the local audio engine

Important rule:

- separate “sound configuration compatibility” from “native Wwise parity”

## 7. Compatibility Overrides

Responsibilities:

- provide controlled escape hatches when generic compatibility is insufficient
- keep overrides versioned, visible, and isolated

Important rule:

- the default path should stay generic
- overrides are for exceptions, not the primary architecture

## Why Start With MSFS 2020

Start with **MSFS 2020 first** for the first vertical slice.

Reasons:

- package layout is simpler
- current repo direction already aligns more closely with 2020-style aircraft content
- it avoids starting with 2024 modular merge complexity
- it proves the hard runtime problems sooner:
  - behaviors
  - vars/events
  - panels
  - sound logic

But the design must stay 2024-ready from day one:

- importer interface must allow multiple package backends
- behavior compiler must keep template namespaces/versioning separate
- runtime host must avoid baking in 2020-only assumptions

## Delivery Strategy

## Phase 0: Inventory And Contracts

Deliverables:

- document the documented aircraft-facing API surface
- define internal package IR
- define runtime service interfaces
- define compatibility categories and test matrix

Exit criteria:

- clear schema for package import
- clear schema for compiled behavior output
- clear schema for runtime variables/events

## Phase 1: MSFS 2020 Package Importer

Deliverables:

- importer for monolithic aircraft packages
- parsing for the main aircraft config and model/panel/sound references
- asset manifest generation
- normalized import cache

Exit criteria:

- can import and cache a representative 2020 aircraft package without manual edits

## Phase 2: Behavior Compiler + VM

Deliverables:

- XML include resolution
- template expansion
- calculator code parser
- internal bytecode / IR
- runtime VM

Exit criteria:

- can drive documented animation, visibility, and interaction logic from compiled behavior output

## Phase 3: Renderer / Animation Integration

Deliverables:

- connect compiled behavior state to the current model loading path
- replace hand-maintained animation assumptions with behavior-driven state where possible
- establish node and animation lookup conventions

Exit criteria:

- dynamic aircraft visuals are driven by compatibility runtime state, not only bespoke code

## Phase 4: Panel Host

Deliverables:

- `panel.cfg` parser
- HTML instrument mounting
- simulator JS bridge shims
- panel update loop integration

Exit criteria:

- representative HTML instruments load and exchange state with the aircraft runtime

## Phase 5: WASM Host Subset

Deliverables:

- documented subset of aircraft-facing WASM host APIs
- runtime version split for 2020 vs 2024 differences
- test harness for aircraft module behavior

Exit criteria:

- representative documented module interactions work through the host adapter

## Phase 6: Sound Host

Deliverables:

- sound XML parser
- runtime condition evaluation
- parameter routing into local audio

Exit criteria:

- representative aircraft sound events respond correctly to aircraft state

## Phase 7: MSFS 2024 Import And Modular Support

Deliverables:

- modular aircraft package merge pipeline
- 2024 package normalization
- support for 2024 template namespace and behavior versioning

Exit criteria:

- can import and execute a representative 2024 aircraft package using the same core runtime

## Phase 8: Compatibility Matrix And Hardening

Deliverables:

- conformance matrix by subsystem
- regression fixtures
- override mechanism for edge cases
- cache versioning and import diagnostics

Exit criteria:

- compatibility failures are categorized, reproducible, and fixable without architectural churn

## Immediate Repo Work

1. Add a documented API inventory file for aircraft-facing surfaces.
2. Define internal IR types for:
   - package manifest
   - behavior graph
   - variable/event registry
   - panel descriptors
   - sound descriptors
3. Refactor the existing aircraft loading path behind a generic import/runtime boundary.
4. Build the first behavior compiler spike:
   - includes
   - templates
   - expression parsing
5. Build the first runtime services:
   - variables
   - events
   - node animation outputs

## Success Criteria

The compatibility layer is on the right path when:

- an imported 2020 aircraft package can load without bespoke package edits
- aircraft visual state is driven primarily by compiled behavior output
- panel content can communicate through a simulator-style host bridge
- the runtime can support a documented subset of aircraft WASM interactions
- the same architecture extends to a 2024 modular package without redesign

## Risks

- undocumented or partially documented behavior differences
- 2020 vs 2024 semantic mismatches
- host timing differences between browser and simulator runtime
- sound parity gaps
- drift toward aircraft-specific hacks

## Risk Mitigation

- keep importer, compiler, and runtime versioned
- define explicit compatibility subsets
- build fixtures from real package content early
- keep overrides isolated
- avoid claiming compatibility before it is measured

## Final Direction

Build the project as a **portable aircraft runtime**, not as a one-off importer.

The correct boundary is:

- **compile static content once**
- **execute dynamic behavior at runtime**
- **implement the simulator host contract in local code**

That gives the fastest route to a working 2020 vertical slice while preserving a clean path to 2024 support.
