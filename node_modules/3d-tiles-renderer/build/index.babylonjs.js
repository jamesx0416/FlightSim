import { B as O, T as j } from "./B3DMLoaderBase-Cwfi38VH.js";
import { L as k, g as L, r as W } from "./LoaderBase-2yhE3Jur.js";
import { Matrix as m, ImportMeshAsync as S, Quaternion as A, Vector3 as i, BoundingBox as Q, BoundingSphere as N, TransformNode as U, Observable as X, Frustum as Y, Plane as G } from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";
const I = /* @__PURE__ */ m.Identity();
class z extends k {
  constructor(e) {
    super(), this.scene = e, this.adjustmentTransform = m.Identity();
  }
  async parse(e, t, n) {
    const { scene: s, workingPath: r, adjustmentTransform: o } = this;
    let a = r;
    a.length && !/[\\/]$/.test(a) && (a += "/");
    const c = n === "gltf" ? ".gltf" : ".glb";
    let h = null;
    const f = await S(
      new File([e], t),
      s,
      {
        pluginExtension: c,
        rootUrl: a,
        pluginOptions: {
          gltf: {
            onParsed: (w) => {
              h = w.json;
            }
          }
        }
      }
    ), d = f.meshes[0];
    d.rotationQuaternion = A.Identity();
    const l = d.computeWorldMatrix(!0);
    return o.multiplyToRef(l, I), I.decompose(d.scaling, d.rotationQuaternion, d.position), {
      scene: d,
      container: f,
      metadata: h
    };
  }
}
class H extends O {
  constructor(e) {
    super(), this.scene = e, this.adjustmentTransform = m.Identity();
  }
  async parse(e, t) {
    const n = super.parse(e), { scene: s, workingPath: r, fetchOptions: o, adjustmentTransform: a } = this, c = new z(s);
    c.workingPath = r, c.fetchOptions = o, a && (c.adjustmentTransform = a);
    const h = await c.parse(n.glbBytes, t, "glb"), f = h.scene;
    return {
      ...n,
      scene: f,
      container: h.container,
      metadata: h.metadata
    };
  }
}
const P = /* @__PURE__ */ new i();
class Z {
  constructor() {
    this.min = new i(-1, -1, -1), this.max = new i(1, 1, 1), this.transform = m.Identity(), this.inverseTransform = m.Identity(), this.points = new Array(8).fill(null).map(() => new i());
  }
  update() {
    const { min: e, max: t, points: n, transform: s } = this;
    s.invertToRef(this.inverseTransform);
    let r = 0;
    for (let o = 0; o <= 1; o++)
      for (let a = 0; a <= 1; a++)
        for (let c = 0; c <= 1; c++)
          n[r].set(
            o === 0 ? e.x : t.x,
            a === 0 ? e.y : t.y,
            c === 0 ? e.z : t.z
          ), i.TransformCoordinatesToRef(
            n[r],
            s,
            n[r]
          ), r++;
  }
  clampPoint(e, t) {
    const { min: n, max: s, transform: r, inverseTransform: o } = this;
    return i.TransformCoordinatesToRef(e, o, t), t.x = Math.max(n.x, Math.min(s.x, t.x)), t.y = Math.max(n.y, Math.min(s.y, t.y)), t.z = Math.max(n.z, Math.min(s.z, t.z)), i.TransformCoordinatesToRef(t, r, t), t;
  }
  distanceToPoint(e) {
    return this.clampPoint(e, P), i.Distance(P, e);
  }
  intersectsFrustum(e) {
    return Q.IsInFrustum(this.points, e);
  }
}
const g = /* @__PURE__ */ new i(), b = /* @__PURE__ */ new i(), T = /* @__PURE__ */ new i(), y = /* @__PURE__ */ new i(), _ = /* @__PURE__ */ new i();
class $ {
  constructor() {
    this.sphere = null, this.obb = null;
  }
  setSphereData(e, t, n, s, r) {
    const o = new N(_, _), a = o.centerWorld.set(e, t, n);
    i.TransformCoordinatesToRef(a, r, a), r.decompose(y, null, null), o.radiusWorld = s * Math.max(Math.abs(y.x), Math.abs(y.y), Math.abs(y.z)), this.sphere = o;
  }
  setObbData(e, t) {
    const n = new Z();
    g.set(e[3], e[4], e[5]), b.set(e[6], e[7], e[8]), T.set(e[9], e[10], e[11]);
    const s = g.length(), r = b.length(), o = T.length();
    g.normalize(), b.normalize(), T.normalize(), s === 0 && i.CrossToRef(b, T, g), r === 0 && i.CrossToRef(g, T, b), o === 0 && i.CrossToRef(g, b, T), n.transform = m.FromValues(
      g.x,
      b.x,
      T.x,
      e[0],
      g.y,
      b.y,
      T.y,
      e[1],
      g.z,
      b.z,
      T.z,
      e[2],
      0,
      0,
      0,
      1
    ).transpose().multiply(t), n.min.set(-s, -r, -o), n.max.set(s, r, o), n.update(), this.obb = n;
  }
  distanceToPoint(e) {
    const { sphere: t, obb: n } = this;
    let s = -1 / 0, r = -1 / 0;
    return t && (s = i.Distance(e, t.centerWorld) - t.radiusWorld, s = Math.max(s, 0)), n && (r = n.distanceToPoint(e)), s > r ? s : r;
  }
  intersectsFrustum(e) {
    const { sphere: t, obb: n } = this;
    return t && !t.isInFrustum(e) || n && !n.intersectsFrustum(e) ? !1 : !!(t || n);
  }
}
const D = /* @__PURE__ */ m.Identity(), B = /* @__PURE__ */ new i(), V = /* @__PURE__ */ new Array(6).fill(null).map(() => new G(0, 0, 0, 0));
class te extends j {
  constructor(e, t) {
    super(e), this.scene = t, this.group = new U("tiles-root", t), this._upRotationMatrix = m.Identity(), this._observables = /* @__PURE__ */ new Map();
  }
  addEventListener(e, t) {
    this._observables.has(e) || this._observables.set(e, new X()), this._observables.get(e).add(t);
  }
  removeEventListener(e, t) {
    if (!this._observables.has(e))
      return;
    this._observables.get(e).removeCallback(t);
  }
  dispatchEvent(e) {
    if (!this._observables.has(e.type))
      return;
    this._observables.get(e.type).notifyObservers(e);
  }
  loadRootTileset(...e) {
    return super.loadRootTileset(...e).then((t) => {
      const { asset: n } = t;
      switch ((n && n.gltfUpAxis || "y").toLowerCase()) {
        case "x":
          m.RotationYToRef(-Math.PI / 2, this._upRotationMatrix);
          break;
        case "y":
          m.RotationXToRef(Math.PI / 2, this._upRotationMatrix);
          break;
      }
      return t;
    });
  }
  preprocessNode(e, t, n = null) {
    super.preprocessNode(e, t, n);
    const s = m.Identity();
    e.transform && m.FromValuesToRef(...e.transform, s), n && s.multiplyToRef(n.engineData.transform, s);
    const r = m.Identity();
    s.invertToRef(r);
    const o = new $();
    "sphere" in e.boundingVolume && o.setSphereData(...e.boundingVolume.sphere, s), "box" in e.boundingVolume && o.setObbData(e.boundingVolume.box, s), e.engineData.transform = s, e.engineData.transformInverse = r, e.engineData.boundingVolume = o, e.engineData.active = !1, e.engineData.scene = null, e.engineData.container = null;
  }
  async parseTile(e, t, n, s, r) {
    const o = t.engineData, a = this.scene, c = L(s), h = this.fetchOptions, f = o.transform, d = this._upRotationMatrix;
    let l = null;
    const w = (W(e) || n).toLowerCase();
    switch (w) {
      case "b3dm": {
        const u = new H(a);
        u.workingPath = c, u.fetchOptions = h, u.adjustmentTransform.copyFrom(d), l = await u.parse(e, s);
        break;
      }
      case "gltf":
      case "glb": {
        const u = new z(a);
        u.workingPath = c, u.fetchOptions = h, u.adjustmentTransform.copyFrom(d), l = await u.parse(e, s, n);
        break;
      }
      default:
        throw new Error(`BabylonTilesRenderer: Content type "${w}" not supported.`);
    }
    const p = l.scene;
    if (p.setEnabled(!1), p.computeWorldMatrix(!0).multiply(f).decompose(p.scaling, p.rotationQuaternion, p.position), r.aborted) {
      l.container.dispose();
      return;
    }
    o.scene = p, o.container = l.container, o.metadata = l.metadata || null;
  }
  disposeTile(e) {
    super.disposeTile(e);
    const t = e.engineData;
    t.container && (t.container.dispose(), t.container = null, t.scene = null, t.metadata = null);
  }
  setTileVisible(e, t) {
    const s = e.engineData.scene;
    s && (t ? (s.parent = this.group, s.setEnabled(!0)) : (s.parent = null, s.setEnabled(!1)), super.setTileVisible(e, t));
  }
  calculateBytesUsed(e) {
    return 1;
  }
  calculateTileViewError(e, t) {
    const { scene: n } = this, r = e.engineData.boundingVolume, o = n.activeCamera, a = n.getEngine(), c = a.getHardwareScalingLevel(), h = a.getRenderWidth() * c, f = a.getRenderHeight() * c, l = o.getProjectionMatrix().m, w = l[15] === 1;
    let p, u;
    if (w) {
      const R = 2 / l[0], E = 2 / l[5];
      u = Math.max(E / f, R / h);
    } else
      p = 2 / l[5] / f;
    this.group.getWorldMatrix().invertToRef(D), i.TransformCoordinatesToRef(o.globalPosition, D, B), Y.GetPlanesToRef(o.getTransformationMatrix(!0), V);
    const C = V.map((R) => R.transform(D)), M = r.distanceToPoint(B);
    let v;
    w ? v = e.geometricError / u : v = M === 0 ? 1 / 0 : e.geometricError / (M * p);
    const F = r.intersectsFrustum(C);
    t.inView = F, t.error = v, t.distanceFromCamera = M;
  }
  dispose() {
    super.dispose(), this.group.dispose();
  }
}
export {
  te as TilesRenderer
};
//# sourceMappingURL=index.babylonjs.js.map
