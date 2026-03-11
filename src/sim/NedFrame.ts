import { Geodetic, Ellipsoid } from '@takram/three-geospatial'
import { Matrix4, Quaternion, Vector3, Matrix3 } from 'three'

const matrixScratch = /*#__PURE__*/ new Matrix4()
const geodeticScratch = /*#__PURE__*/ new Geodetic()

export class NedFrame {
  readonly north = new Vector3()
  readonly east = new Vector3()
  readonly down = new Vector3()
  readonly nedToEcef = new Matrix3()
  readonly ecefToNed = new Matrix3()
  readonly qNedToEcef = new Quaternion()
  readonly qEcefToNed = new Quaternion()
  altitudeMeters = 0

  updateFromECEF(positionEcef: Vector3): this {
    const east = this.east
    const north = this.north
    const down = this.down

    Ellipsoid.WGS84.getEastNorthUpVectors(positionEcef, east, north, down)
    down.multiplyScalar(-1)

    matrixScratch.makeBasis(north, east, down)
    this.qNedToEcef.setFromRotationMatrix(matrixScratch)
    this.qEcefToNed.copy(this.qNedToEcef).invert()

    this.nedToEcef.setFromMatrix4(matrixScratch)
    this.ecefToNed.copy(this.nedToEcef).transpose()

    this.altitudeMeters = geodeticScratch.setFromECEF(positionEcef).height
    return this
  }
}

