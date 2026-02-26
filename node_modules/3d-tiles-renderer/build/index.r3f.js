import { jsx as g, jsxs as S, Fragment as H } from "react/jsx-runtime";
import { useRef as T, useLayoutEffect as N, useEffect as y, useContext as q, useState as j, useCallback as K, createContext as G, forwardRef as _, useReducer as ye, useMemo as L, StrictMode as Ce, cloneElement as xe } from "react";
import { useThree as M, useFrame as F, createPortal as Ee } from "@react-three/fiber";
import { Object3D as be, Scene as Me, Vector3 as R, Matrix4 as A, Ray as ee, OrthographicCamera as Le, BackSide as qe, EventDispatcher as pe, Line3 as me, Vector2 as we, Raycaster as _e } from "three";
import { T as Se, E as Re, G as Pe, a as Te } from "./CameraTransitionManager-raJsCcaV.js";
import { W as Fe, a as We, c as he } from "./MemoryUtils-BD0AS93P.js";
import { createRoot as je } from "react-dom/client";
function ke(s, e) {
  if (s === e)
    return !0;
  if (!s || !e)
    return s === e;
  for (const t in s)
    if (s[t] !== e[t])
      return !1;
  for (const t in e)
    if (s[t] !== e[t])
      return !1;
  return !0;
}
function te(s) {
  const e = T();
  return ke(e.current, s) || (e.current = s), e.current;
}
function Oe(s) {
  return /^on/g.test(s);
}
function Ae(s) {
  return s.replace(/^on/, "").replace(/[a-z][A-Z]/g, (e) => `${e[0]}-${e[1]}`).toLowerCase();
}
function ae(s) {
  return s.split("-");
}
function fe(s, e) {
  let t = s;
  const o = [...e];
  for (; o.length !== 0; ) {
    const n = o.shift();
    t = t[n];
  }
  return t;
}
function le(s, e, t) {
  const o = [...e], n = o.pop();
  fe(s, o)[n] = t;
}
function z(s, e, t = !1) {
  N(() => {
    if (s === null)
      return;
    const o = {}, n = {};
    for (const r in e)
      if (Oe(r) && s.addEventListener && !(r in s)) {
        const m = Ae(r);
        n[m] = e[r], s.addEventListener(m, e[r]);
      } else {
        const m = t ? [r] : ae(r);
        o[r] = fe(s, m), le(s, m, e[r]);
      }
    return () => {
      for (const r in n)
        s.removeEventListener(r, n[r]);
      for (const r in o) {
        const m = t ? [r] : ae(r);
        le(s, m, o[r]);
      }
    };
  }, [s, te(e)]);
}
function ze(s, e) {
  z(s, e, !0);
}
function D(s, ...e) {
  y(() => {
    e.forEach((t) => {
      t && (t instanceof Function ? t(s) : t.current = s);
    });
  }, [s, ...e]);
}
const P = G(null), De = G(null), ne = G(null);
function Qe({ children: s }) {
  const e = q(P), t = T();
  return y(() => {
    e && (t.current.matrixWorld = e.group.matrixWorld);
  }, [e]), /* @__PURE__ */ g("group", { ref: t, matrixWorldAutoUpdate: !1, matrixAutoUpdate: !1, children: s });
}
function rt(s) {
  const {
    lat: e = 0,
    lon: t = 0,
    height: o = 0,
    az: n = 0,
    el: r = 0,
    roll: m = 0,
    ellipsoid: u = Fe.clone(),
    children: l
  } = s, d = q(P), p = M((a) => a.invalidate), [i, f] = j(null), v = K(() => {
    if (i === null)
      return;
    const a = d && d.ellipsoid || u || null;
    i.matrix.identity(), i.visible = !!(d && d.root || u), a !== null && (a.getOrientedEastNorthUpFrame(e, t, o, n, r, m, i.matrix), i.matrix.decompose(i.position, i.quaternion, i.scale), i.updateMatrixWorld(), p());
  }, [p, d, e, t, o, n, r, m, u, i, te(u.radius)]);
  return y(() => {
    if (d !== null && i !== null)
      return i.updateMatrixWorld = function(a) {
        this.matrixAutoUpdate && this.updateMatrix(), (this.matrixWorldNeedsUpdate || a) && (this.matrixWorld.multiplyMatrices(d.group.matrixWorld, this.matrix), a = !0);
        const c = this.children;
        for (let h = 0, C = c.length; h < C; h++)
          c[h].updateMatrixWorld(a);
      }, () => {
        i.updateMatrixWorld = be.prototype.updateMatrixWorld;
      };
  }, [d, i]), y(() => {
    v();
  }, [v]), y(() => {
    if (d !== null)
      return d.addEventListener("load-tileset", v), () => {
        d.removeEventListener("load-tileset", v);
      };
  }, [d, v]), /* @__PURE__ */ g("group", { ref: f, children: l });
}
const it = _(function(e, t) {
  const { plugin: o, args: n, children: r, ...m } = e, u = q(P), [l, d] = j(null), [, p] = ye((i) => i + 1, 0);
  if (N(() => {
    if (u === null)
      return;
    let i;
    return Array.isArray(n) ? i = new o(...n) : i = new o(n), d(i), () => {
      d(null);
    };
  }, [o, u, te(n)]), z(l, m), N(() => {
    if (l !== null)
      return u.registerPlugin(l), p(), () => {
        u.unregisterPlugin(l);
      };
  }, [l]), D(l, t), !(!l || !u.plugins.includes(l)))
    return /* @__PURE__ */ g(De.Provider, { value: l, children: r });
}), ot = _(function(e, t) {
  const { url: o, group: n = {}, enabled: r = !0, children: m, ...u } = e, [l, d, p] = M((a) => [a.camera, a.gl, a.invalidate]), [i, f] = j(null);
  y(() => {
    const a = () => p(), c = new Se(o);
    return c.addEventListener("needs-render", a), c.addEventListener("needs-update", a), f(c), () => {
      c.removeEventListener("needs-render", a), c.removeEventListener("needs-update", a), c.dispose(), f(null);
    };
  }, [o, p]), F(() => {
    i === null || !r || (l.updateMatrixWorld(), i.setResolutionFromRenderer(l, d), i.update());
  }), N(() => {
    if (i !== null)
      return i.setCamera(l), () => {
        i.deleteCamera(l);
      };
  }, [i, l]), D(i, t), z(i, u);
  const v = L(() => i ? {
    ellipsoid: i.ellipsoid,
    frame: i.group
  } : null, [i == null ? void 0 : i.ellipsoid, i == null ? void 0 : i.group]);
  return i ? /* @__PURE__ */ S(H, { children: [
    /* @__PURE__ */ g("primitive", { object: i.group, ...n }),
    /* @__PURE__ */ g(P.Provider, { value: i, children: /* @__PURE__ */ g(ne.Provider, { value: v, children: /* @__PURE__ */ g(Qe, { children: m }) }) })
  ] }) : null;
}), Ue = _(function({ children: e, ...t }, o) {
  const [n] = M((l) => [l.gl]), [r, m] = j(null), u = L(() => document.createElement("div"), []);
  y(() => (u.style.pointerEvents = "none", u.style.position = "absolute", u.style.width = "100%", u.style.height = "100%", u.style.left = 0, u.style.top = 0, n.domElement.parentNode.appendChild(u), () => {
    u.remove();
  }), [u, n.domElement.parentNode]), y(() => {
    const l = je(u);
    return m(l), () => {
      l.unmount();
    };
  }, [u]), r !== null && r.render(
    /* @__PURE__ */ g(Ce, { children: /* @__PURE__ */ g("div", { ...t, ref: o, children: e }) })
  );
});
function Ie() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
}
function st({ children: s, style: e, generateAttributions: t, ...o }) {
  const n = q(P), [r, m] = j([]);
  y(() => {
    if (!n)
      return;
    let p = !1;
    const i = () => {
      p || (p = !0, queueMicrotask(() => {
        m(n.getAttributions()), p = !1;
      }));
    };
    return n.addEventListener("tile-visibility-change", i), n.addEventListener("load-tileset", i), () => {
      n.removeEventListener("tile-visibility-change", i), n.removeEventListener("load-tileset", i);
    };
  }, [n]);
  const u = L(() => "class_" + Ie(), []), l = L(() => `
		#${u} a {
			color: white;
		}

		#${u} img {
			max-width: 125px;
			display: block;
			margin: 5px 0;
		}
	`, [u]);
  let d;
  if (t)
    d = t(r, u);
  else {
    const p = [];
    r.forEach((i, f) => {
      let v = null;
      i.type === "string" ? v = /* @__PURE__ */ g("div", { children: i.value }, f) : i.type === "html" ? v = /* @__PURE__ */ g("div", { dangerouslySetInnerHTML: { __html: i.value }, style: { pointerEvents: "all" } }, f) : i.type === "image" && (v = /* @__PURE__ */ g("div", { children: /* @__PURE__ */ g("img", { src: i.value }) }, f)), v && p.push(v);
    }), d = /* @__PURE__ */ S(H, { children: [
      /* @__PURE__ */ g("style", { children: l }),
      p
    ] });
  }
  return /* @__PURE__ */ S(
    Ue,
    {
      id: u,
      style: {
        position: "absolute",
        bottom: 0,
        left: 0,
        padding: "10px",
        color: "rgba( 255, 255, 255, 0.75 )",
        fontSize: "10px",
        ...e
      },
      ...o,
      children: [
        s,
        d
      ]
    }
  );
}
const ve = _(function(e, t) {
  const { controlsConstructor: o, domElement: n, scene: r, camera: m, ellipsoid: u, ellipsoidFrame: l, ...d } = e, [p] = M((E) => [E.camera]), [i] = M((E) => [E.gl]), [f] = M((E) => [E.scene]), [v] = M((E) => [E.invalidate]), [a] = M((E) => [E.get]), [c] = M((E) => [E.set]), h = q(ne), C = m || p || null, b = r || f || null, ie = n || i.domElement || null, oe = u || (h == null ? void 0 : h.ellipsoid) || null, se = l || (h == null ? void 0 : h.frame) || null, x = L(() => new o(), [o]);
  D(x, t), y(() => {
    const E = () => v();
    return x.addEventListener("change", E), x.addEventListener("start", E), x.addEventListener("end", E), () => {
      x.removeEventListener("change", E), x.removeEventListener("start", E), x.removeEventListener("end", E);
    };
  }, [x, v]), y(() => {
    x.setCamera(C);
  }, [x, C]), y(() => {
    x.setScene(b);
  }, [x, b]), y(() => {
    x.isGlobeControls && x.setEllipsoid(oe, se);
  }, [x, oe, se]), y(() => (x.attach(ie), () => {
    x.detach();
  }), [x, ie]), y(() => {
    const E = a().controls;
    return c({ controls: x }), () => c({ controls: E });
  }, [x, a, c]), F(() => {
    x.update();
  }, -1), ze(x, d);
}), at = _(function(e, t) {
  return /* @__PURE__ */ g(ve, { ...e, ref: t, controlsConstructor: Re });
}), lt = _(function(e, t) {
  return /* @__PURE__ */ g(ve, { ...e, ref: t, controlsConstructor: Pe });
}), w = /* @__PURE__ */ new R(), W = /* @__PURE__ */ new R(), O = /* @__PURE__ */ new R(), $ = /* @__PURE__ */ new A(), B = /* @__PURE__ */ new A(), Q = /* @__PURE__ */ new ee(), J = {};
function Ne(s, e, t, o) {
  Q.origin.copy(s.position), Q.direction.set(0, 0, -1).transformDirection(s.matrixWorld), Q.applyMatrix4(t.matrixWorldInverse), e.closestPointToRayEstimate(Q, O), O.applyMatrix4(t.matrixWorld), W.set(0, 0, -1).transformDirection(s.matrixWorld);
  const n = O.sub(s.position).dot(W);
  return o.copy(s.position).addScaledVector(W, n), o;
}
function Ve(s) {
  const { defaultScene: e, defaultCamera: t, overrideRenderLoop: o = !0, renderPriority: n = 1 } = s, r = L(() => new Le(), []), [m, u, l, d] = M((p) => [p.set, p.size, p.gl, p.scene]);
  y(() => {
    m({ camera: r });
  }, [m, r]), y(() => {
    r.left = -u.width / 2, r.right = u.width / 2, r.top = u.height / 2, r.bottom = -u.height / 2, r.near = 0, r.far = 2e3, r.position.z = r.far / 2, r.updateProjectionMatrix();
  }, [r, u]), F(() => {
    o && l.render(e, t);
    const p = l.autoClear;
    l.autoClear = !1, l.clearDepth(), l.render(d, r), l.autoClear = p;
  }, n);
}
function ce() {
  const s = T();
  return y(() => {
    const t = s.current.attributes.position;
    for (let o = 0, n = t.count; o < n; o++)
      w.fromBufferAttribute(t, o), w.y > 0 && (w.x = 0, t.setXYZ(o, ...w));
  }), /* @__PURE__ */ g("boxGeometry", { ref: s });
}
function Ge({ northColor: s = 15684432, southColor: e = 16777215 }) {
  const [t, o] = j(), n = T();
  return y(() => {
    o(n.current);
  }, []), /* @__PURE__ */ S("group", { scale: 0.5, ref: n, children: [
    /* @__PURE__ */ g("ambientLight", { intensity: 1 }),
    /* @__PURE__ */ g("directionalLight", { position: [0, 2, 3], intensity: 3, target: t }),
    /* @__PURE__ */ g("directionalLight", { position: [0, -2, -3], intensity: 3, target: t }),
    /* @__PURE__ */ S("mesh", { children: [
      /* @__PURE__ */ g("sphereGeometry", {}),
      /* @__PURE__ */ g("meshBasicMaterial", { color: 0, opacity: 0.3, transparent: !0, side: qe })
    ] }),
    /* @__PURE__ */ S("group", { scale: [0.5, 1, 0.15], children: [
      /* @__PURE__ */ S("mesh", { "position-y": 0.5, children: [
        /* @__PURE__ */ g(ce, {}),
        /* @__PURE__ */ g("meshStandardMaterial", { color: s })
      ] }),
      /* @__PURE__ */ S("mesh", { "position-y": -0.5, "rotation-x": Math.PI, children: [
        /* @__PURE__ */ g(ce, {}),
        /* @__PURE__ */ g("meshStandardMaterial", { color: e })
      ] })
    ] })
  ] });
}
function ct({ children: s, overrideRenderLoop: e, mode: t = "3d", margin: o = 10, scale: n = 35, visible: r = !0, ...m }) {
  const [u, l, d] = M((c) => [c.camera, c.scene, c.size]), p = q(ne), i = T(null), f = L(() => new Me(), []);
  let v, a;
  return Array.isArray(o) ? (v = o[0], a = o[1]) : (v = o, a = o), F(() => {
    const c = p == null ? void 0 : p.ellipsoid, h = p == null ? void 0 : p.frame;
    if (!c || !h || i.current === null)
      return null;
    const C = i.current;
    if (Ne(u, c, h, O).applyMatrix4(h.matrixWorldInverse), c.getPositionToCartographic(O, J), c.getEastNorthUpFrame(J.lat, J.lon, 0, B).premultiply(h.matrixWorld), B.invert(), $.copy(u.matrixWorld).premultiply(B), t.toLowerCase() === "3d")
      C.quaternion.setFromRotationMatrix($).invert();
    else if (w.set(0, 1, 0).transformDirection($).normalize(), w.z = 0, w.normalize(), w.length() === 0)
      C.quaternion.identity();
    else {
      const b = W.set(0, 1, 0).angleTo(w);
      W.cross(w).normalize(), C.quaternion.setFromAxisAngle(W, -b);
    }
  }), s || (s = /* @__PURE__ */ g(Ge, {})), r ? Ee(
    /* @__PURE__ */ S(H, { children: [
      /* @__PURE__ */ g(
        "group",
        {
          ref: i,
          scale: n,
          position: [
            d.width / 2 - v - n / 2,
            -d.height / 2 + a + n / 2,
            0
          ],
          ...m,
          children: s
        }
      ),
      /* @__PURE__ */ g(
        Ve,
        {
          defaultCamera: u,
          defaultScene: l,
          overrideRenderLoop: e,
          renderPriority: 10
        }
      )
    ] }),
    f,
    { events: { priority: 10 } }
  ) : null;
}
const ut = _(function(e, t) {
  const {
    mode: o = "perspective",
    onBeforeToggle: n,
    perspectiveCamera: r,
    orthographicCamera: m,
    ...u
  } = e, [l, d, p, i, f, v] = M((c) => [c.set, c.get, c.invalidate, c.controls, c.camera, c.size]), a = L(() => {
    const c = new Te();
    return c.autoSync = !1, f.isOrthographicCamera ? (c.orthographicCamera.copy(f), c.mode = "orthographic") : c.perspectiveCamera.copy(f), c.syncCameras(), c.mode = o, c;
  }, []);
  y(() => {
    const { perspectiveCamera: c, orthographicCamera: h } = a, C = v.width / v.height;
    c.aspect = C, c.updateProjectionMatrix(), h.left = -h.top * C, h.right = -h.left, c.updateProjectionMatrix();
  }, [a, v]), D(a, t), y(() => {
    const c = ({ camera: h }) => {
      l(() => ({ camera: h }));
    };
    return l(() => ({ camera: a.camera })), a.addEventListener("camera-change", c), () => {
      a.removeEventListener("camera-change", c);
    };
  }, [a, l]), y(() => {
    const c = a.perspectiveCamera, h = a.orthographicCamera;
    return a.perspectiveCamera = r || c, a.orthographicCamera = m || h, l(() => ({ camera: a.camera })), () => {
      a.perspectiveCamera = c, a.orthographicCamera = h;
    };
  }, [r, m, a, l]), y(() => {
    if (o !== a.mode) {
      const c = o === "orthographic" ? a.orthographicCamera : a.perspectiveCamera;
      n ? n(a, c) : i && i.isEnvironmentControls ? (i.getPivotPoint(a.fixedPoint), a.syncCameras(), i.adjustCamera(a.perspectiveCamera), i.adjustCamera(a.orthographicCamera)) : (a.fixedPoint.set(0, 0, -1).transformDirection(a.camera.matrixWorld).multiplyScalar(50).add(a.camera.position), a.syncCameras()), a.toggle(), p();
    }
  }, [o, a, p, i, n]), y(() => {
    const c = () => p();
    return a.addEventListener("transition-start", c), a.addEventListener("change", c), a.addEventListener("transition-end", c), () => {
      a.removeEventListener("transition-start", c), a.removeEventListener("change", c), a.removeEventListener("transition-end", c);
    };
  }, [a, p]), z(a, u), F(() => {
    a.update(), i && (i.enabled = !a.animating);
    const { camera: c, size: h } = d();
    if (!m && c === a.orthographicCamera) {
      const C = h.width / h.height, b = a.orthographicCamera;
      C !== b.right && (b.bottom = -1, b.top = 1, b.left = -C, b.right = C, b.updateProjectionMatrix());
    }
    a.animating && p();
  }, -1);
});
function ge(...s) {
  return K((e) => {
    s.forEach((t) => {
      t && (typeof t == "function" ? t(e) : t.current = e);
    });
  }, s);
}
function Z(s, e) {
  e(s) || s.children.forEach((t) => {
    Z(t, e);
  });
}
class $e extends pe {
  constructor() {
    super(), this.objects = /* @__PURE__ */ new Set(), this.observed = /* @__PURE__ */ new Set(), this._addedCallback = ({ child: e }) => {
      Z(e, (t) => this.observed.has(t) ? !0 : (this.objects.add(t), t.addEventListener("childadded", this._addedCallback), t.addEventListener("childremoved", this._removedCallback), this.dispatchEvent({ type: "childadded", child: e }), !1));
    }, this._removedCallback = ({ child: e }) => {
      Z(e, (t) => this.observed.has(t) ? !0 : (this.objects.delete(t), t.removeEventListener("childadded", this._addedCallback), t.removeEventListener("childremoved", this._removedCallback), this.dispatchEvent({ type: "childremoved", child: e }), !1));
    };
  }
  observe(e) {
    const { observed: t } = this;
    this._addedCallback({ child: e }), t.add(e);
  }
  unobserve(e) {
    const { observed: t } = this;
    t.delete(e), this._removedCallback({ child: e });
  }
  dispose() {
    this.observed.forEach((e) => {
      this.unobserve(e);
    });
  }
}
const X = /* @__PURE__ */ new _e(), k = /* @__PURE__ */ new me(), U = /* @__PURE__ */ new me(), ue = /* @__PURE__ */ new we(), I = /* @__PURE__ */ new R(), de = /* @__PURE__ */ new A();
class Be extends pe {
  constructor() {
    super(), this.autoRun = !0, this.queryMap = /* @__PURE__ */ new Map(), this.index = 0, this.queued = [], this.scheduled = !1, this.duration = 1, this.objects = [], this.observer = new $e(), this.ellipsoid = new We(), this.frame = new A(), this.cameras = /* @__PURE__ */ new Set();
    const e = /* @__PURE__ */ (() => {
      let t = !1;
      return () => {
        t || (t = !0, queueMicrotask(() => {
          this.queryMap.forEach((o) => this._enqueue(o)), t = !1;
        }));
      };
    })();
    this.observer.addEventListener("childadded", e), this.observer.addEventListener("childremoved", e);
  }
  // job runner
  _enqueue(e) {
    e.queued || (this.queued.push(e), e.queued = !0, this._scheduleRun());
  }
  _runJobs() {
    const { queued: e, cameras: t, duration: o } = this, n = performance.now();
    for (t.forEach((r, m) => {
      de.copy(r.matrixWorldInverse).premultiply(r.projectionMatrix), I.set(0, 0, -1).transformDirection(r.matrixWorld), k.start.setFromMatrixPosition(r.matrixWorld), k.end.addVectors(I, k.start);
      for (let u = 0, l = e.length; u < l; u++) {
        const d = e[u], { ray: p } = d;
        let i, f;
        if (d.point === null)
          U.start.copy(p.origin), p.at(1, U.end), Je(k, U, ue), d.distance = ue.x * (1 - Math.abs(I.dot(p.direction))), d.inFrustum = !0;
        else {
          const v = U.start;
          v.copy(d.point).applyMatrix4(de), v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 && v.z > -1 && v.z < 1 ? (d.distance = v.subVectors(d.point, k.start).dot(I), d.inFrustum = !0) : (d.distance = 0, d.inFrustum = !1);
        }
        m === 0 ? (d.distance = i, d.inFrustum = f) : (d.inFrustum = d.inFrustum || f, d.distance = Math.min(d.distance, i));
      }
    }), t.length !== 0 && e.sort((r, m) => r.point === null != (m.point === null) ? r.point === null ? 1 : -1 : r.inFrustum !== m.inFrustum ? r.inFrustum ? 1 : -1 : r.distance < 0 != m.distance < 0 ? r.distance < 0 ? -1 : 1 : m.distance - r.distance); e.length !== 0 && performance.now() - n < o; ) {
      const r = e.pop();
      r.queued = !1, this._updateQuery(r);
    }
    e.length !== 0 && this._scheduleRun();
  }
  _scheduleRun() {
    this.autoRun && !this.scheduled && (this.scheduled = !0, requestAnimationFrame(() => {
      this.scheduled = !1, this._runJobs();
    }));
  }
  _updateQuery(e) {
    X.ray.copy(e.ray), X.far = "lat" in e ? 1e4 + Math.max(...this.ellipsoid.radius) : 1 / 0;
    const t = X.intersectObjects(this.objects)[0] || null;
    t !== null && (e.point === null ? e.point = t.point.clone() : e.point.copy(t.point)), e.callback(t);
  }
  // add and remove cameras used for sorting
  addCamera(e) {
    const { queryMap: t, cameras: o } = this;
    o.add(e), t.forEach((n) => this._enqueue(n));
  }
  deleteCamera(e) {
    const { cameras: t } = this;
    t.delete(e);
  }
  // run the given item index if possible
  runIfNeeded(e) {
    const { queryMap: t, queued: o } = this, n = t.get(e);
    n.queued && (this._updateQuery(n), n.queued = !1, o.splice(o.indexOf(n), 1));
  }
  // set the scene used for query
  setScene(...e) {
    const { observer: t } = this;
    t.dispose(), e.forEach((o) => t.observe(o)), this.objects = e, this._scheduleRun();
  }
  // update the ellipsoid and frame based on a tiles renderer, updating the item rays only if necessary
  setEllipsoidFromTilesRenderer(e) {
    const { queryMap: t, ellipsoid: o, frame: n } = this;
    (!o.radius.equals(e.ellipsoid.radius) || !n.equals(e.group.matrixWorld)) && (o.copy(e.ellipsoid), n.copy(e.group.matrixWorld), t.forEach((r) => {
      if ("lat" in r) {
        const { lat: m, lon: u, ray: l } = r;
        o.getCartographicToPosition(m, u, 1e4, l.origin).applyMatrix4(n), o.getCartographicToNormal(m, u, l.direction).transformDirection(n).multiplyScalar(-1);
      }
      this._enqueue(r);
    }));
  }
  // register query callbacks
  registerRayQuery(e, t) {
    const o = this.index++, n = {
      ray: e.clone(),
      callback: t,
      queued: !1,
      distance: -1,
      point: null
    };
    return this.queryMap.set(o, n), this._enqueue(n), o;
  }
  registerLatLonQuery(e, t, o) {
    const { ellipsoid: n, frame: r } = this, m = this.index++, u = new ee();
    n.getCartographicToPosition(e, t, 1e4, u.origin).applyMatrix4(r), n.getCartographicToNormal(e, t, u.direction).transformDirection(r).multiplyScalar(-1);
    const l = {
      ray: u.clone(),
      lat: e,
      lon: t,
      callback: o,
      queued: !1,
      distance: -1,
      point: null
    };
    return this.queryMap.set(m, l), this._enqueue(l), m;
  }
  unregisterQuery(e) {
    const { queued: t, queryMap: o } = this, n = o.get(e);
    o.delete(e), n && n.queued && (n.queued = !1, t.splice(t.indexOf(n), 1));
  }
  // dispose of everything
  dispose() {
    this.queryMap.clear(), this.queued.length = 0, this.objects.length = 0, this.observer.dispose();
  }
}
const Je = (function() {
  const s = new R(), e = new R(), t = new R();
  return function(n, r, m) {
    const u = n.start, l = s, d = r.start, p = e;
    t.subVectors(u, d), s.subVectors(n.end, n.start), e.subVectors(r.end, r.start);
    const i = t.dot(p), f = p.dot(l), v = p.dot(p), a = t.dot(l), h = l.dot(l) * v - f * f;
    let C, b;
    h !== 0 ? C = (i * f - a * v) / h : C = 0, b = (i + C * f) / v, m.x = C, m.y = b;
  };
})(), re = G(null), V = /* @__PURE__ */ new A(), Y = /* @__PURE__ */ new ee(), dt = _(function(e, t) {
  const {
    interpolationFactor: o = 0.025,
    onQueryUpdate: n = null,
    ...r
  } = e, m = q(P), u = q(re), l = M(({ invalidate: a }) => a), d = L(() => new R(), []), p = L(() => ({ value: !1 }), []), i = L(() => ({ value: !1 }), []), f = T(null), v = K((a) => {
    if (m === null || a === null || f.current === null)
      return;
    const { lat: c, lon: h, rayorigin: C, raydirection: b } = r;
    c !== null && h !== null ? (d.copy(a.point), i.value = !0, u.ellipsoid.getObjectFrame(c, h, 0, 0, 0, 0, V, he).premultiply(m.group.matrixWorld), f.current.quaternion.setFromRotationMatrix(V), l()) : C !== null && b !== null && (d.copy(a.point), i.value = !0, f.current.quaternion.identity(), l()), n && n(a);
  }, [l, i, u.ellipsoid, r, d, m, n]);
  return F((a, c) => {
    if (f.current && (f.current.visible = p.value), f.current && i.value)
      if (p.value === !1)
        p.value = !0, f.current.position.copy(d);
      else {
        const h = 1 - 2 ** (-c / o);
        f.current.position.distanceToSquared(d) > 1e-6 ? (f.current.position.lerp(
          d,
          o === 0 ? 1 : h
        ), l()) : f.current.position.copy(d);
      }
  }), /* @__PURE__ */ g(
    Xe,
    {
      ref: ge(f, t),
      onQueryUpdate: v,
      ...r
    }
  );
}), Xe = _(function(e, t) {
  const {
    component: o = /* @__PURE__ */ g("group", {}),
    lat: n = null,
    lon: r = null,
    rayorigin: m = null,
    raydirection: u = null,
    onQueryUpdate: l = null,
    ...d
  } = e, p = T(null), i = q(P), f = q(re), v = M(({ invalidate: c }) => c), a = L(() => new R(), []);
  return y(() => {
    const c = (h) => {
      l ? l(h) : i && h !== null && p.current !== null && (n !== null && r !== null ? (p.current.position.copy(h.point), f.ellipsoid.getObjectFrame(n, r, 0, 0, 0, 0, V, he).premultiply(i.group.matrixWorld), p.current.quaternion.setFromRotationMatrix(V), v()) : m !== null && u !== null && (p.current.position.copy(h.point), p.current.quaternion.identity(), v()));
    };
    if (n !== null && r !== null) {
      const h = f.registerLatLonQuery(n, r, c);
      return () => f.unregisterQuery(h);
    } else if (m !== null && u !== null) {
      Y.origin.copy(m), Y.direction.copy(u);
      const h = f.registerRayQuery(Y, c);
      return () => f.unregisterQuery(h);
    }
  }, [n, r, m, u, f, i, v, a, l]), xe(o, { ...d, ref: ge(p, t), raycast: () => !1 });
}), pt = _(function(e, t) {
  const o = M(({ scene: p }) => p), {
    scene: n = o,
    children: r,
    ...m
  } = e, u = q(P), l = L(() => new Be(), []), d = M(({ camera: p }) => p);
  return z(l, m), y(() => () => l.dispose(), [l]), y(() => {
    l.setScene(...Array.isArray(n) ? n : [n]);
  }, [l, n]), y(() => {
    l.addCamera(d);
  }, [l, d]), F(() => {
    u && l.setEllipsoidFromTilesRenderer(u);
  }), D(l, t), /* @__PURE__ */ g(re.Provider, { value: l, children: /* @__PURE__ */ g("group", { matrixAutoUpdate: !1, matrixWorldAutoUpdate: !1, children: r }) });
});
export {
  dt as AnimatedSettledObject,
  ut as CameraTransition,
  Ue as CanvasDOMOverlay,
  ct as CompassGizmo,
  rt as EastNorthUpFrame,
  ne as EllipsoidContext,
  at as EnvironmentControls,
  lt as GlobeControls,
  Xe as SettledObject,
  pt as SettledObjects,
  st as TilesAttributionOverlay,
  it as TilesPlugin,
  De as TilesPluginContext,
  ot as TilesRenderer,
  P as TilesRendererContext
};
//# sourceMappingURL=index.r3f.js.map
