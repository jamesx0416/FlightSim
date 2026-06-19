import {
  AutopilotStateKeys,
  AvionicsStateKeys,
  ControlStateKeys,
  convertSimUnit,
  ElectricalStateKeys,
  EnvironmentStateKeys,
  FuelStateKeys,
  LightingStateKeys,
  PropulsionStateKeys,
  SurfaceStateKeys,
  readAvionicsNumber,
  readAutopilotBoolean,
  readAutopilotNumber,
  readControlBoolean,
  readControlRatio,
  readControlSignedRatio,
  readElectricalBoolean,
  readElectricalNumber,
  readEnvironmentBoolean,
  readFuelBoolean,
  readFuelNumber,
  readLightingEnabled,
  readLightingRatio,
  readPropulsionBoolean,
  readPropulsionNumber,
  readSurfaceRatio,
  type SimStateSource,
  type SimStateStore,
  type SimUnit,
} from '../sim/engine'

export interface MsfsStateAlias {
  readonly kind:
    | 'autopilotBoolean'
    | 'autopilotNumber'
    | 'avionicsBoolean'
    | 'avionicsNumber'
    | 'avionicsBarometerMillibars'
    | 'lightPotentiometer'
    | 'lightPower'
    | 'lightChannel'
    | 'controlRatio'
    | 'controlSignedRatio'
    | 'controlBoolean'
    | 'electricalBoolean'
    | 'electricalNumber'
    | 'environmentBoolean'
    | 'fuelBoolean'
    | 'fuelNumber'
    | 'propulsionBoolean'
    | 'propulsionNumber'
    | 'surfaceRatio'
  readonly stateKey: string
  readonly canonicalUnit: SimUnit
  readonly defaultUnit?: SimUnit
}

export class MsfsCompatibilityBridge {
  readonly id = 'msfs-compatibility'

  constructor(private readonly state: SimStateStore) {}

  readSimVar(name: string, unit?: string | null): number | undefined {
    const alias = mapMsfsSimVarToCanonicalState(name)

    if (alias == null) {
      return undefined
    }

    if (alias.kind === 'lightChannel') {
      return readLightingEnabled(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'propulsionBoolean') {
      return readPropulsionBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'controlBoolean') {
      return readControlBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'controlRatio') {
      const value = readControlRatio(this.state, alias.stateKey)
      return convertSimUnit(
        value,
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }

    if (alias.kind === 'controlSignedRatio') {
      const value = readControlSignedRatio(this.state, alias.stateKey)
      return convertSimUnit(
        value,
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }

    if (alias.kind === 'propulsionNumber') {
      return convertSimUnit(
        readPropulsionNumber(this.state, alias.stateKey),
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }
    if (alias.kind === 'electricalBoolean') {
      return readElectricalBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'electricalNumber') {
      const value = readElectricalNumber(this.state, alias.stateKey)
      return convertSimUnit(
        value,
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }

    if (alias.kind === 'environmentBoolean') {
      return readEnvironmentBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'fuelBoolean') {
      return readFuelBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'fuelNumber') {
      return convertSimUnit(
        readFuelNumber(this.state, alias.stateKey),
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }

    if (alias.kind === 'autopilotBoolean') {
      return readAutopilotBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    if (alias.kind === 'autopilotNumber') {
      return readAutopilotNumber(this.state, alias.stateKey)
    }

    if (alias.kind === 'avionicsBoolean') {
      return this.state.readBoolean(alias.stateKey, { fallback: false }) ? 1 : 0
    }

    if (alias.kind === 'avionicsNumber') {
      return fromCanonicalAvionicsNumber(
        readAvionicsNumber(this.state, alias.stateKey),
        alias
      )
    }

    if (alias.kind === 'avionicsBarometerMillibars') {
      return readAvionicsNumber(this.state, alias.stateKey) * 33.863_886_666_7
    }

    if (alias.kind === 'surfaceRatio') {
      const value = readSurfaceRatio(this.state, alias.stateKey)
      return convertSimUnit(
        value,
        alias.canonicalUnit,
        normalizeMsfsAliasUnit(unit, alias)
      )
    }

    const value = readLightingRatio(this.state, alias.stateKey)
    return convertSimUnit(
      value,
      alias.canonicalUnit,
      normalizeMsfsAliasUnit(unit, alias)
    )
  }

  writeSimVar(
    name: string,
    value: number,
    unit?: string | null,
    source: SimStateSource = 'runtime'
  ): boolean {
    const alias = mapMsfsSimVarToCanonicalState(name)

    if (alias == null) {
      return false
    }

    if (alias.kind === 'lightChannel') {
      this.state.define({
        key: alias.stateKey,
        unit: 'boolean',
        valueType: 'boolean',
      })
      this.state.set(alias.stateKey, value > 0, {
        source,
        unit: 'boolean',
      })
    } else {
      const valueType =
      alias.kind === 'propulsionBoolean' ||
      alias.kind === 'controlBoolean' ||
      alias.kind === 'electricalBoolean' ||
      alias.kind === 'environmentBoolean' ||
      alias.kind === 'fuelBoolean' ||
      alias.kind === 'autopilotBoolean' ||
      alias.kind === 'avionicsBoolean'
        ? 'boolean'
        : 'number'
      this.state.define({
        key: alias.stateKey,
        unit: alias.canonicalUnit,
        valueType,
      })
      if (
      alias.kind === 'propulsionBoolean' ||
      alias.kind === 'controlBoolean' ||
      alias.kind === 'electricalBoolean' ||
      alias.kind === 'environmentBoolean' ||
      alias.kind === 'fuelBoolean' ||
      alias.kind === 'autopilotBoolean' ||
      alias.kind === 'avionicsBoolean'
    ) {
        this.state.set(alias.stateKey, value > 0, {
          source,
          unit: 'boolean',
        })
    } else {
    const normalizedValue =
      alias.kind === 'avionicsNumber'
        ? toCanonicalAvionicsNumber(value, alias)
        : alias.kind === 'avionicsBarometerMillibars'
          ? value / 33.863_886_666_7
          : value
    this.state.set(alias.stateKey, normalizedValue, {
      source,
        unit: normalizeMsfsAliasUnit(unit, alias),
      })
      }
    }
    return true
  }

  readLocalVar(name: string): number | undefined {
    const alias = mapMsfsLocalVarToCanonicalState(name)
    if (alias == null) {
      return undefined
    }

    if (alias.kind === 'propulsionBoolean') {
      return readPropulsionBoolean(this.state, alias.stateKey) ? 1 : 0
    }
    if (alias.kind === 'propulsionNumber') {
      return readPropulsionNumber(this.state, alias.stateKey)
    }
    if (alias.kind === 'electricalBoolean') {
      if (this.state.getEntry(alias.stateKey) == null) {
        return undefined
      }
      return readElectricalBoolean(this.state, alias.stateKey) ? 1 : 0
    }

    return undefined
  }

  writeLocalVar(
    name: string,
    value: number,
    source: SimStateSource = 'runtime'
  ): boolean {
    const alias = mapMsfsLocalVarToCanonicalState(name)
    if (alias == null) {
      return false
    }

    if (alias.kind === 'propulsionNumber') {
      this.state.define({
        key: alias.stateKey,
        unit: alias.canonicalUnit,
        valueType: 'number',
      })
      this.state.set(alias.stateKey, value, {
        source,
        unit: alias.canonicalUnit,
      })
      return true
    }

    if (alias.kind === 'propulsionBoolean' || alias.kind === 'electricalBoolean') {
      this.state.define({
        key: alias.stateKey,
        unit: 'boolean',
        valueType: 'boolean',
      })
      this.state.set(alias.stateKey, value > 0, {
        source,
        unit: 'boolean',
      })
      return true
    }

    return false
  }
}

export function mapMsfsSimVarToCanonicalState(
  rawName: string
): MsfsStateAlias | undefined {
  const name = normalizeMsfsSimVarName(rawName)
  const potentiometerMatch = /^LIGHT POTENTIOMETER:(\d+)$/u.exec(name)

  if (potentiometerMatch != null) {
    return {
      kind: 'lightPotentiometer',
      stateKey: LightingStateKeys.potentiometer(Number(potentiometerMatch[1])),
      canonicalUnit: 'ratio',
    }
  }

  const powerMatch = /^LIGHT\s+(.+?)\s+POWER SETTING(?::(\d+))?$/u.exec(name)

  if (powerMatch != null) {
    const rawIndex = powerMatch[2] == null ? null : Number(powerMatch[2])
    return {
      kind: 'lightPower',
      stateKey: LightingStateKeys.power(
        powerMatch[1],
        rawIndex == null || !Number.isFinite(rawIndex)
          ? undefined
          : Math.trunc(rawIndex)
      ),
      canonicalUnit: 'ratio',
    }
  }

  const channelMatch = /^LIGHT\s+(.+?)(?::(\d+))?$/u.exec(name)

  if (channelMatch != null) {
    const channel = normalizeMsfsLightChannel(channelMatch[1])

    if (channel != null) {
      const rawIndex = channelMatch[2] == null ? null : Number(channelMatch[2])
      return {
        kind: 'lightChannel',
        stateKey: LightingStateKeys.channelEnabled(
          channel,
          rawIndex == null || !Number.isFinite(rawIndex)
            ? undefined
            : Math.trunc(rawIndex)
        ),
        canonicalUnit: 'boolean',
      }
    }
  }

  const apuAlias = mapMsfsApuSimVarToCanonicalState(name)
  if (apuAlias != null) {
    return apuAlias
  }

  const engineAlias = mapMsfsEngineSimVarToCanonicalState(name)
  if (engineAlias != null) {
    return engineAlias
  }

  const controlAlias = mapMsfsControlSimVarToCanonicalState(name)
  if (controlAlias != null) {
    return controlAlias
  }

  const electricalAlias = mapMsfsElectricalSimVarToCanonicalState(name)
  if (electricalAlias != null) {
    return electricalAlias
  }

  const environmentAlias = mapMsfsEnvironmentSimVarToCanonicalState(name)
  if (environmentAlias != null) {
    return environmentAlias
  }

  const autopilotAlias = mapMsfsAutopilotSimVarToCanonicalState(name)
  if (autopilotAlias != null) {
    return autopilotAlias
  }

  const avionicsAlias = mapMsfsAvionicsSimVarToCanonicalState(name)
  if (avionicsAlias != null) {
    return avionicsAlias
  }

  const fuelAlias = mapMsfsFuelSimVarToCanonicalState(name)
  if (fuelAlias != null) {
    return fuelAlias
  }

  return undefined
}

export function mapMsfsLocalVarToCanonicalState(
  rawName: string
): MsfsStateAlias | undefined {
  const name = normalizeMsfsVariableName(rawName)

  if (isApuMasterLocalSwitchName(name)) {
    return {
      kind: 'propulsionBoolean',
      stateKey: PropulsionStateKeys.apuMaster(),
      canonicalUnit: 'boolean',
    }
  }

  if (isApuStartLocalSwitchName(name)) {
    return {
      kind: 'propulsionBoolean',
      stateKey: PropulsionStateKeys.apuStarter(),
      canonicalUnit: 'boolean',
    }
  }

  const electricalBusAlias = mapMsfsA32nxElectricalBusLocalVarToCanonicalState(name)
  if (electricalBusAlias != null) {
    return electricalBusAlias
  }

  const engineN1Alias = mapMsfsA32nxEngineLocalVarToCanonicalState(name)
  if (engineN1Alias != null) {
    return engineN1Alias
  }

  return undefined
}

function mapMsfsA32nxEngineLocalVarToCanonicalState(
  name: string
): MsfsStateAlias | undefined {
  const n1Match = /^A32NX_ENGINE_N1:(\d+)$/u.exec(name)
  if (n1Match == null) return undefined

  const index = Number.parseInt(n1Match[1], 10)
  if (!Number.isFinite(index) || index <= 0) return undefined

  return {
    kind: 'propulsionNumber',
    stateKey: PropulsionStateKeys.engineN1Percent(index),
    canonicalUnit: 'percent',
  }
}

function mapMsfsA32nxElectricalBusLocalVarToCanonicalState(
  name: string
): MsfsStateAlias | undefined {
  const busIdByName: Record<string, string> = {
    A32NX_ELEC_AC_ESS_BUS_IS_POWERED: 'ac-ess',
    A32NX_ELEC_AC_ESS_SHED_BUS_IS_POWERED: 'ac-ess-shed',
    A32NX_ELEC_AC_1_BUS_IS_POWERED: 'ac-1',
    A32NX_ELEC_AC_2_BUS_IS_POWERED: 'ac-2',
  }
  const busId = busIdByName[name]
  if (busId == null) {
    return undefined
  }

  return {
    kind: 'electricalBoolean',
    stateKey: LightingStateKeys.electricalBusPowered(busId),
    canonicalUnit: 'boolean',
  }
}

function mapMsfsElectricalSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const batteryMatch = /^(?:ELECTRICAL MASTER BATTERY|MASTER BATTERY SWITCH|BATTERY SWITCH)(?::(\d+))?$/u.exec(
    name
  )

  if (batteryMatch != null) {
    const index = batteryMatch[1] == null ? undefined : Number(batteryMatch[1])
    return {
      kind: 'electricalBoolean',
      stateKey:
        index == null || !Number.isFinite(index)
          ? ElectricalStateKeys.batteryEnabled()
          : ElectricalStateKeys.batteryEnabled(Math.trunc(index)),
      canonicalUnit: 'boolean',
    }
  }

  const sourceMatch = /^ELECTRICAL SOURCE (.+?) (AVAILABLE|CONNECTED|VOLTAGE)$/u.exec(name)
  if (sourceMatch != null) {
    const sourceId = sourceMatch[1]
    switch (sourceMatch[2]) {
      case 'AVAILABLE':
        return {
          kind: 'electricalBoolean',
          stateKey: ElectricalStateKeys.sourceAvailable(sourceId),
          canonicalUnit: 'boolean',
        }
      case 'CONNECTED':
        return {
          kind: 'electricalBoolean',
          stateKey: ElectricalStateKeys.sourceConnected(sourceId),
          canonicalUnit: 'boolean',
        }
      case 'VOLTAGE':
        return {
          kind: 'electricalNumber',
          stateKey: ElectricalStateKeys.sourceVoltage(sourceId),
          canonicalUnit: 'number',
        }
    }
  }

  const busMatch = /^ELECTRICAL BUS (.+?) (POWERED|VOLTAGE)$/u.exec(name)
  if (busMatch != null) {
    return {
      kind: busMatch[2] === 'POWERED' ? 'electricalBoolean' : 'electricalNumber',
      stateKey:
        busMatch[2] === 'POWERED'
          ? ElectricalStateKeys.busPowered(busMatch[1])
          : ElectricalStateKeys.busVoltage(busMatch[1]),
      canonicalUnit: busMatch[2] === 'POWERED' ? 'boolean' : 'number',
    }
  }

  const consumerMatch = /^ELECTRICAL CONSUMER (.+?) (SWITCH|POWERED)$/u.exec(name)
  if (consumerMatch != null) {
    return {
      kind: 'electricalBoolean',
      stateKey:
        consumerMatch[2] === 'POWERED'
          ? ElectricalStateKeys.consumerPowered(consumerMatch[1])
          : ElectricalStateKeys.consumerSwitchEnabled(consumerMatch[1]),
      canonicalUnit: 'boolean',
    }
  }

  switch (name) {
    case 'EXTERNAL POWER AVAILABLE':
      return {
        kind: 'electricalBoolean',
        stateKey: ElectricalStateKeys.externalPowerAvailable(),
        canonicalUnit: 'boolean',
      }
    case 'EXTERNAL POWER ON':
      return {
        kind: 'electricalBoolean',
        stateKey: ElectricalStateKeys.externalPowerConnected(),
        canonicalUnit: 'boolean',
      }
    case 'AVIONICS MASTER SWITCH':
      return {
        kind: 'electricalBoolean',
        stateKey: ElectricalStateKeys.avionicsMasterEnabled(),
        canonicalUnit: 'boolean',
      }
    case 'ELECTRICAL MAIN BUS VOLTAGE':
      return {
        kind: 'electricalNumber',
        stateKey: ElectricalStateKeys.busVoltage('main'),
        canonicalUnit: 'number',
      }
    case 'ELECTRICAL AVIONICS BUS VOLTAGE':
      return {
        kind: 'electricalNumber',
        stateKey: ElectricalStateKeys.busVoltage('avionics'),
        canonicalUnit: 'number',
      }
    default:
      return undefined
  }
}

function mapMsfsEnvironmentSimVarToCanonicalState(
  name: string
): MsfsStateAlias | undefined {
  if (name === 'STRUCTURAL DEICE SWITCH') {
    return {
      kind: 'environmentBoolean',
      stateKey: EnvironmentStateKeys.structuralDeiceEnabled(),
      canonicalUnit: 'boolean',
    }
  }

  const engineAntiIceMatch = /^ENG ANTI ICE(?::(\d+))?$/u.exec(name)
  if (engineAntiIceMatch != null) {
    const index =
      engineAntiIceMatch[1] == null ? 1 : Number(engineAntiIceMatch[1])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'environmentBoolean',
      stateKey: EnvironmentStateKeys.engineAntiIceEnabled(index),
      canonicalUnit: 'boolean',
    }
  }

  const pitotHeatMatch = /^PITOT HEAT(?: SWITCH(?::(\d+))?)?$/u.exec(name)
  if (pitotHeatMatch == null) {
    return undefined
  }

  const index = pitotHeatMatch[1] == null ? 1 : Number(pitotHeatMatch[1])
  if (!Number.isInteger(index) || index <= 0) {
    return undefined
  }

  return {
    kind: 'environmentBoolean',
    stateKey: EnvironmentStateKeys.pitotHeatEnabled(index),
    canonicalUnit: 'boolean',
  }
}

function mapMsfsAutopilotSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const flightDirectorMatch = /^AUTOPILOT FLIGHT DIRECTOR ACTIVE(?::(\d+))?$/u.exec(name)
  if (flightDirectorMatch != null) {
    const index = flightDirectorMatch[1] == null ? 1 : Number(flightDirectorMatch[1])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'autopilotBoolean',
      stateKey: AutopilotStateKeys.flightDirectorActive(index),
      canonicalUnit: 'boolean',
    }
  }

  switch (name) {
    case 'AUTOPILOT MASTER':
      return autopilotBooleanAlias(AutopilotStateKeys.masterEnabled())
    case 'AUTOPILOT DISENGAGED':
      return autopilotBooleanAlias(AutopilotStateKeys.disengaged())
    case 'AUTOPILOT HEADING LOCK':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('heading'))
    case 'AUTOPILOT ALTITUDE LOCK':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('altitude'))
    case 'AUTOPILOT VERTICAL HOLD':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('vertical-speed'))
    case 'AUTOPILOT AIRSPEED HOLD':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('airspeed'))
    case 'AUTOPILOT MACH HOLD':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('mach'))
    case 'AUTOPILOT APPROACH HOLD':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('approach'))
    case 'AUTOPILOT GLIDESLOPE HOLD':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('glideslope'))
    case 'AUTOPILOT NAV1 LOCK':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('nav'))
    case 'AUTOPILOT CHANGE':
      return autopilotBooleanAlias(AutopilotStateKeys.modeEnabled('flight-level-change'))
    case 'AUTOPILOT HEADING LOCK DIR':
      return autopilotNumberAlias(AutopilotStateKeys.selectedHeadingDegrees())
    case 'AUTOPILOT ALTITUDE LOCK VAR':
      return autopilotNumberAlias(AutopilotStateKeys.selectedAltitudeFeet())
    case 'AUTOPILOT VERTICAL HOLD VAR':
      return autopilotNumberAlias(AutopilotStateKeys.selectedVerticalSpeedFeetPerMinute())
    case 'AUTOPILOT AIRSPEED HOLD VAR':
      return autopilotNumberAlias(AutopilotStateKeys.selectedAirspeedKnots())
    case 'AUTOPILOT MACH HOLD VAR':
      return autopilotNumberAlias(AutopilotStateKeys.selectedMach())
    case 'AUTOPILOT MAX BANK ID':
      return autopilotNumberAlias(AutopilotStateKeys.maxBankId())
    default:
      return undefined
  }
}

function autopilotBooleanAlias(stateKey: string): MsfsStateAlias {
  return {
    kind: 'autopilotBoolean',
    stateKey,
    canonicalUnit: 'boolean',
  }
}

function autopilotNumberAlias(stateKey: string): MsfsStateAlias {
  return {
    kind: 'autopilotNumber',
    stateKey,
    canonicalUnit: 'number',
  }
}

function mapMsfsAvionicsSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const radioMatch = /^(COM|NAV) (ACTIVE|STANDBY) FREQUENCY(?::(\d+))?( HZ)?$/u.exec(
    name
  )
  if (radioMatch != null) {
    const index = radioMatch[3] == null ? 1 : Number(radioMatch[3])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    const family = radioMatch[1].toLowerCase()
    const slot = radioMatch[2].toLowerCase()
    return {
      kind: 'avionicsNumber',
      stateKey:
        slot === 'active'
          ? AvionicsStateKeys.radioActiveFrequencyMhz(family, index)
          : AvionicsStateKeys.radioStandbyFrequencyMhz(family, index),
      canonicalUnit: 'number',
      defaultUnit: radioMatch[4] == null ? 'number' : 'unitless',
    }
  }

  const adfFrequencyMatch = /^ADF (ACTIVE|STANDBY) FREQUENCY(?::(\d+))?$/u.exec(
    name
  )
  if (adfFrequencyMatch != null) {
    const index = adfFrequencyMatch[2] == null ? 1 : Number(adfFrequencyMatch[2])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'avionicsNumber',
      stateKey:
        adfFrequencyMatch[1] === 'ACTIVE'
          ? AvionicsStateKeys.adfActiveFrequencyKhz(index)
          : AvionicsStateKeys.adfStandbyFrequencyKhz(index),
      canonicalUnit: 'number',
      defaultUnit: 'number',
    }
  }

  const kohlsmanMatch = /^KOHLSMAN SETTING (HG|MB)(?::(\d+))?$/u.exec(name)
  if (kohlsmanMatch != null) {
    const index = kohlsmanMatch[2] == null ? 1 : Number(kohlsmanMatch[2])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind:
        kohlsmanMatch[1] === 'MB'
          ? 'avionicsBarometerMillibars'
          : 'avionicsNumber',
      stateKey: AvionicsStateKeys.barometerSettingHg(index),
      canonicalUnit: 'number',
      defaultUnit: 'number',
    }
  }

  const transponderStateMatch = /^TRANSPONDER STATE(?::(\d+))?$/u.exec(name)
  if (transponderStateMatch != null) {
    const index =
      transponderStateMatch[1] == null ? 1 : Number(transponderStateMatch[1])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'avionicsNumber',
      stateKey: AvionicsStateKeys.transponderState(index),
      canonicalUnit: 'number',
    }
  }

  const transponderIdentMatch = /^TRANSPONDER IDENT(?::(\d+))?$/u.exec(name)
  if (transponderIdentMatch != null) {
    const index =
      transponderIdentMatch[1] == null ? 1 : Number(transponderIdentMatch[1])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'avionicsBoolean',
      stateKey: AvionicsStateKeys.transponderIdentActive(index),
      canonicalUnit: 'boolean',
    }
  }

  return undefined
}

function mapMsfsFuelSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const tankQuantityMatch = /^FUELSYSTEM TANK (.+?) QUANTITY(?: RATIO| PERCENT)?$/u.exec(name)
  if (tankQuantityMatch != null) {
    return {
      kind: 'fuelNumber',
      stateKey: FuelStateKeys.tankQuantityRatio(tankQuantityMatch[1]),
      canonicalUnit: 'ratio',
      defaultUnit: name.endsWith('PERCENT') ? 'percent' : 'ratio',
    }
  }

  const engineAvailabilityMatch = /^FUELSYSTEM ENGINE (?:(\d+) )?FUEL AVAILABLE$/u.exec(name)
  if (engineAvailabilityMatch != null) {
    const index = engineAvailabilityMatch[1] == null ? 1 : Number(engineAvailabilityMatch[1])
    if (Number.isInteger(index) && index > 0) {
      return {
        kind: 'fuelBoolean',
        stateKey: FuelStateKeys.engineAvailable(index),
        canonicalUnit: 'boolean',
      }
    }
  }

  const namedPumpMatch = /^FUELSYSTEM PUMP (.+?) (SWITCH|ACTIVE)$/u.exec(name)
  if (namedPumpMatch != null && !/^\d+$/u.test(namedPumpMatch[1])) {
    return {
      kind: 'fuelBoolean',
      stateKey:
        namedPumpMatch[2] === 'ACTIVE'
          ? FuelStateKeys.pumpActive(namedPumpMatch[1])
          : FuelStateKeys.pumpSwitchEnabled(namedPumpMatch[1]),
      canonicalUnit: 'boolean',
    }
  }

  const namedValveMatch = /^FUELSYSTEM VALVE (.+?) (SWITCH|OPEN)$/u.exec(name)
  if (namedValveMatch != null && !/^\d+$/u.test(namedValveMatch[1])) {
    return {
      kind: 'fuelBoolean',
      stateKey:
        namedValveMatch[2] === 'OPEN'
          ? FuelStateKeys.valveOpen(namedValveMatch[1])
          : FuelStateKeys.valveSwitchOpen(namedValveMatch[1]),
      canonicalUnit: 'boolean',
    }
  }

  const pumpMatch = /^(FUELSYSTEM PUMP SWITCH|FUELSYSTEM PUMP ACTIVE|GENERAL ENG FUEL PUMP SWITCH EX1|GENERAL ENG FUEL PUMP ACTIVE):(\d+)$/u.exec(
    name
  )
  if (pumpMatch != null) {
    const index = Number(pumpMatch[2])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'fuelBoolean',
      stateKey:
        pumpMatch[1] === 'FUELSYSTEM PUMP ACTIVE' ||
        pumpMatch[1] === 'GENERAL ENG FUEL PUMP ACTIVE'
          ? FuelStateKeys.pumpActive(index)
          : FuelStateKeys.pumpSwitchEnabled(index),
      canonicalUnit: 'boolean',
    }
  }

  const valveMatch = /^(FUELSYSTEM VALVE SWITCH|FUELSYSTEM VALVE OPEN):(\d+)$/u.exec(name)
  if (valveMatch != null) {
    const index = Number(valveMatch[2])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'fuelBoolean',
      stateKey:
        valveMatch[1] === 'FUELSYSTEM VALVE OPEN'
          ? FuelStateKeys.valveOpen(index)
          : FuelStateKeys.valveSwitchOpen(index),
      canonicalUnit: 'boolean',
    }
  }

  const junctionMatch = /^FUELSYSTEM JUNCTION SETTING:(\d+)$/u.exec(name)
  if (junctionMatch != null) {
    const index = Number(junctionMatch[1])
    if (!Number.isInteger(index) || index <= 0) {
      return undefined
    }

    return {
      kind: 'fuelNumber',
      stateKey: FuelStateKeys.junctionSetting(index),
      canonicalUnit: 'number',
    }
  }

  return undefined
}

function mapMsfsControlSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const indexedName = name.replace(/:\d+$/u, '')

  switch (indexedName) {
    case 'GEAR HANDLE POSITION':
      return controlRatioAlias(ControlStateKeys.gearHandleRatio())
    case 'GEAR ANIMATION POSITION':
    case 'GEAR CENTER POSITION':
    case 'GEAR LEFT POSITION':
    case 'GEAR RIGHT POSITION':
      return controlRatioAlias(ControlStateKeys.gearPositionRatio(), 'percent')
    case 'FLAPS HANDLE PERCENT':
      return controlRatioAlias(ControlStateKeys.flapsHandleRatio(), 'percent')
    case 'TRAILING EDGE FLAPS LEFT PERCENT':
    case 'TRAILING EDGE FLAPS RIGHT PERCENT':
    case 'LEADING EDGE FLAPS LEFT PERCENT':
    case 'LEADING EDGE FLAPS RIGHT PERCENT':
      return surfaceRatioAlias(SurfaceStateKeys.positionRatio('flaps'), 'percent')
    case 'SPOILERS HANDLE POSITION':
      return controlRatioAlias(ControlStateKeys.spoilersHandleRatio(), 'percent')
    case 'SPOILERS LEFT POSITION':
    case 'SPOILERS RIGHT POSITION':
      return surfaceRatioAlias(SurfaceStateKeys.positionRatio('spoilers'), 'percent')
    case 'AILERON POSITION':
      return controlRatioAlias(ControlStateKeys.aileronPositionRatio())
    case 'AILERON TRIM PCT':
      return controlSignedRatioAlias(ControlStateKeys.aileronTrimRatio())
    case 'AILERON TRIM':
      return controlSignedRatioAlias(ControlStateKeys.aileronTrimRatio(), 'percent')
    case 'AILERON TRIM DISABLED':
      return {
        kind: 'controlBoolean',
        stateKey: ControlStateKeys.aileronTrimDisabled(),
        canonicalUnit: 'boolean',
      }
    case 'ELEVATOR POSITION':
      return controlRatioAlias(ControlStateKeys.elevatorPositionRatio())
    case 'ELEVATOR TRIM PCT':
    case 'ELEVATOR TRIM POSITION':
      return controlSignedRatioAlias(ControlStateKeys.elevatorTrimRatio())
    case 'ELEVATOR TRIM':
      return controlSignedRatioAlias(ControlStateKeys.elevatorTrimRatio(), 'percent')
    case 'ELEVATOR TRIM DISABLED':
      return {
        kind: 'controlBoolean',
        stateKey: ControlStateKeys.elevatorTrimDisabled(),
        canonicalUnit: 'boolean',
      }
    case 'RUDDER POSITION':
      return controlRatioAlias(ControlStateKeys.rudderPositionRatio())
    case 'RUDDER TRIM PCT':
      return controlSignedRatioAlias(ControlStateKeys.rudderTrimRatio())
    case 'RUDDER TRIM':
      return controlSignedRatioAlias(ControlStateKeys.rudderTrimRatio(), 'percent')
    case 'RUDDER TRIM DISABLED':
      return {
        kind: 'controlBoolean',
        stateKey: ControlStateKeys.rudderTrimDisabled(),
        canonicalUnit: 'boolean',
      }
    case 'BRAKE PARKING POSITION':
      return {
        kind: 'controlBoolean',
        stateKey: ControlStateKeys.parkingBrakeEnabled(),
        canonicalUnit: 'boolean',
      }
    default:
      return undefined
  }
}

function controlRatioAlias(stateKey: string, defaultUnit?: SimUnit): MsfsStateAlias {
  return {
    kind: 'controlRatio',
    stateKey,
    canonicalUnit: 'ratio',
    defaultUnit,
  }
}

function controlSignedRatioAlias(stateKey: string, defaultUnit?: SimUnit): MsfsStateAlias {
  return {
    kind: 'controlSignedRatio',
    stateKey,
    canonicalUnit: 'ratio',
    defaultUnit,
  }
}

function surfaceRatioAlias(stateKey: string, defaultUnit?: SimUnit): MsfsStateAlias {
  return {
    kind: 'surfaceRatio',
    stateKey,
    canonicalUnit: 'ratio',
    defaultUnit,
  }
}

function toCanonicalAvionicsNumber(value: number, alias: MsfsStateAlias): number {
  return alias.defaultUnit === 'unitless' ? value / 1_000_000 : value
}

function fromCanonicalAvionicsNumber(value: number, alias: MsfsStateAlias): number {
  return alias.defaultUnit === 'unitless' ? value * 1_000_000 : value
}

function mapMsfsApuSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  if (name === 'APU GENERATOR AVAILABLE') {
    return {
      kind: 'propulsionBoolean',
      stateKey: PropulsionStateKeys.apuGeneratorAvailable(),
      canonicalUnit: 'boolean',
    }
  }

  switch (name) {
    case 'APU MASTER SWITCH':
    case 'APU SWITCH':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.apuMaster(),
        canonicalUnit: 'boolean',
      }
    case 'APU STARTER':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.apuStarter(),
        canonicalUnit: 'boolean',
      }
    case 'APU ACTIVE':
    case 'APU ACTIVE:1':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.apuRunning(),
        canonicalUnit: 'boolean',
      }
    case 'APU PCT RPM':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.apuRpmPercent(),
        canonicalUnit: 'percent',
      }
    default:
      return undefined
  }
}

function mapMsfsEngineSimVarToCanonicalState(name: string): MsfsStateAlias | undefined {
  const generatorMatch = /^GENERAL ENG GENERATOR AVAILABLE(?::(\d+))?$/u.exec(name)
  if (generatorMatch != null) {
    const index = generatorMatch[1] == null ? 1 : Number(generatorMatch[1])
    if (Number.isInteger(index) && index > 0) {
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.engineGeneratorAvailable(index),
        canonicalUnit: 'boolean',
      }
    }
  }

  const match = /^(GENERAL ENG STARTER|GENERAL ENG COMBUSTION|GENERAL ENG RPM|TURB ENG N1|GENERAL ENG THROTTLE LEVER POSITION|GENERAL ENG PROPELLER LEVER POSITION|GENERAL ENG MIXTURE LEVER POSITION|GENERAL ENG FUEL VALVE|GENERAL ENG MASTER ALTERNATOR)(?::(\d+))?$/u.exec(
    name
  )

  if (match == null) {
    return undefined
  }

  const index = match[2] == null ? 1 : Number(match[2])
  if (!Number.isInteger(index) || index <= 0) {
    return undefined
  }

  switch (match[1]) {
    case 'GENERAL ENG STARTER':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.engineStarter(index),
        canonicalUnit: 'boolean',
      }
    case 'GENERAL ENG COMBUSTION':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.engineRunning(index),
        canonicalUnit: 'boolean',
      }
    case 'GENERAL ENG RPM':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.engineRpm(index),
        canonicalUnit: 'number',
      }
    case 'TURB ENG N1':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.engineN1Percent(index),
        canonicalUnit: 'percent',
      }
    case 'GENERAL ENG THROTTLE LEVER POSITION':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.engineThrottleLeverRatio(index),
        canonicalUnit: 'ratio',
        defaultUnit: 'percent',
      }
    case 'GENERAL ENG PROPELLER LEVER POSITION':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.enginePropellerLeverRatio(index),
        canonicalUnit: 'ratio',
        defaultUnit: 'percent',
      }
    case 'GENERAL ENG MIXTURE LEVER POSITION':
      return {
        kind: 'propulsionNumber',
        stateKey: PropulsionStateKeys.engineMixtureLeverRatio(index),
        canonicalUnit: 'ratio',
        defaultUnit: 'percent',
      }
    case 'GENERAL ENG FUEL VALVE':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.engineFuelValveOpen(index),
        canonicalUnit: 'boolean',
      }
    case 'GENERAL ENG MASTER ALTERNATOR':
      return {
        kind: 'propulsionBoolean',
        stateKey: PropulsionStateKeys.engineAlternatorEnabled(index),
        canonicalUnit: 'boolean',
      }
    default:
      return undefined
  }
}

export function normalizeMsfsLightChannel(rawChannel: string): string | null {
  const normalized = rawChannel.trim().replace(/_/gu, ' ').toUpperCase()

  switch (normalized) {
    case 'BEACON':
    case 'CABIN':
    case 'GLARESHIELD':
    case 'LANDING':
    case 'LOGO':
    case 'NAV':
    case 'RECOGNITION':
    case 'STROBE':
    case 'TAXI':
    case 'WING':
      return normalized.toLowerCase()
    case 'STROBES':
      return 'strobe'
    case 'NAVIGATION':
      return 'nav'
    default:
      return null
  }
}

export function normalizeMsfsUnit(unit: string | null | undefined): SimUnit {
  const normalized = unit?.trim().toLowerCase() ?? ''

  switch (normalized) {
    case '':
    case 'number':
    case 'scalar':
      return 'number'
    case 'percent':
    case 'percentage':
      return 'percent'
    case 'percent over 100':
    case 'percent_over_100':
    case 'ratio':
      return 'ratio'
    case 'bool':
    case 'boolean':
      return 'boolean'
    case 'seconds':
    case 'second':
      return 'seconds'
    case 'feet':
    case 'foot':
      return 'feet'
    case 'meters':
    case 'meter':
      return 'meters'
    case 'knots':
    case 'knot':
      return 'knots'
    case 'meters per second':
    case 'meter per second':
      return 'metersPerSecond'
    case 'celsius':
      return 'celsius'
    case 'kelvin':
      return 'kelvin'
    default:
      return 'number'
  }
}

function normalizeMsfsAliasUnit(
  unit: string | null | undefined,
  alias: MsfsStateAlias
): SimUnit {
  const normalized = normalizeMsfsUnit(unit)
  return normalized === 'number' ? alias.defaultUnit ?? alias.canonicalUnit : normalized
}

function normalizeMsfsSimVarName(rawName: string): string {
  return rawName
    .trim()
    .replace(/^\(?\s*A:/iu, '')
    .replace(/\)?$/u, '')
    .trim()
    .toUpperCase()
}

function normalizeMsfsVariableName(rawName: string): string {
  return rawName
    .trim()
    .replace(/^\(?\s*[ALI]:/iu, '')
    .replace(/\)?$/u, '')
    .trim()
    .toUpperCase()
}

function isApuMasterLocalSwitchName(name: string): boolean {
  return (
    name.includes('APU') &&
    name.includes('MASTER') &&
    (name.endsWith('_IS_ON') ||
      name.endsWith('_PB_IS_ON') ||
      name.includes('SW_PB_IS_ON'))
  )
}

function isApuStartLocalSwitchName(name: string): boolean {
  return (
    name.includes('APU') &&
    (name.includes('START') || name.includes('STARTER')) &&
    (name.endsWith('_IS_ON') || name.endsWith('_PB_IS_ON'))
  )
}
