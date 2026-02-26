import { t as et, L as st } from "./LoaderBase-2yhE3Jur.js";
class it {
  constructor(t = {}) {
    const { apiToken: e, autoRefreshToken: s = !1 } = t;
    this.apiToken = e, this.autoRefreshToken = s, this.authURL = null, this._tokenRefreshPromise = null, this._bearerToken = null;
  }
  async fetch(t, e) {
    await this._tokenRefreshPromise;
    const s = { ...e };
    s.headers = s.headers || {}, s.headers = {
      ...s.headers,
      Authorization: this._bearerToken
    };
    const i = await fetch(t, s);
    return i.status >= 400 && i.status <= 499 && this.autoRefreshToken ? (await this.refreshToken(e), s.headers.Authorization = this._bearerToken, fetch(t, s)) : i;
  }
  refreshToken(t) {
    if (this._tokenRefreshPromise === null) {
      const e = new URL(this.authURL);
      e.searchParams.set("access_token", this.apiToken), this._tokenRefreshPromise = fetch(e, t).then((s) => {
        if (!s.ok)
          throw new Error(`CesiumIonAuthPlugin: Failed to load data with error code ${s.status}`);
        return s.json();
      }).then((s) => (this._bearerToken = `Bearer ${s.accessToken}`, this._tokenRefreshPromise = null, s));
    }
    return this._tokenRefreshPromise;
  }
}
class nt {
  constructor() {
    this.creditsCount = {};
  }
  _adjustAttributions(t, e) {
    const s = this.creditsCount, i = t.split(/;/g);
    for (let o = 0, r = i.length; o < r; o++) {
      const l = i[o];
      l in s || (s[l] = 0), s[l] += e ? 1 : -1, s[l] <= 0 && delete s[l];
    }
  }
  addAttributions(t) {
    this._adjustAttributions(t, !0);
  }
  removeAttributions(t) {
    this._adjustAttributions(t, !1);
  }
  toString() {
    return Object.entries(this.creditsCount).sort((e, s) => {
      const i = e[1];
      return s[1] - i;
    }).map((e) => e[0]).join("; ");
  }
}
const ot = "https://tile.googleapis.com/v1/3dtiles/root.json";
class rt {
  constructor({
    apiToken: t,
    sessionOptions: e = null,
    autoRefreshToken: s = !1,
    logoUrl: i = null,
    useRecommendedSettings: o = !0
  }) {
    this.name = "GOOGLE_CLOUD_AUTH_PLUGIN", this.apiToken = t, this.useRecommendedSettings = o, this.logoUrl = i, this.auth = new at({ apiToken: t, autoRefreshToken: s, sessionOptions: e }), this.tiles = null, this._visibilityChangeCallback = null, this._attributionsManager = new nt(), this._logoAttribution = {
      value: "",
      type: "image",
      collapsible: !1
    }, this._attribution = {
      value: "",
      type: "string",
      collapsible: !0
    };
  }
  init(t) {
    const { useRecommendedSettings: e, auth: s } = this;
    t.resetFailedTiles(), t.rootURL == null && (t.rootURL = ot), s.sessionOptions || (s.authURL = t.rootURL), e && !s.isMapTilesSession && (t.errorTarget = 20), this.tiles = t, this._visibilityChangeCallback = ({ tile: i, visible: o }) => {
      var l, a;
      const r = ((a = (l = i.engineData.metadata) == null ? void 0 : l.asset) == null ? void 0 : a.copyright) || "";
      o ? this._attributionsManager.addAttributions(r) : this._attributionsManager.removeAttributions(r);
    }, t.addEventListener("tile-visibility-change", this._visibilityChangeCallback);
  }
  getAttributions(t) {
    this.tiles.visibleTiles.size > 0 && (this.logoUrl && (this._logoAttribution.value = this.logoUrl, t.push(this._logoAttribution)), this._attribution.value = this._attributionsManager.toString(), t.push(this._attribution));
  }
  dispose() {
    this.tiles.removeEventListener("tile-visibility-change", this._visibilityChangeCallback);
  }
  async fetchData(t, e) {
    return this.auth.fetch(t, e);
  }
}
let lt = class {
  get apiToken() {
    return this.auth.apiToken;
  }
  set apiToken(t) {
    this.auth.apiToken = t;
  }
  get autoRefreshToken() {
    return this.auth.autoRefreshToken;
  }
  set autoRefreshToken(t) {
    this.auth.autoRefreshToken = t;
  }
  constructor(t = {}) {
    const {
      apiToken: e,
      assetId: s = null,
      autoRefreshToken: i = !1,
      useRecommendedSettings: o = !0,
      assetTypeHandler: r = (l, a, w) => {
        console.warn(`CesiumIonAuthPlugin: Cesium Ion asset type "${l}" unhandled.`);
      }
    } = t;
    this.name = "CESIUM_ION_AUTH_PLUGIN", this.auth = new it({ apiToken: e, autoRefreshToken: i }), this.assetId = s, this.autoRefreshToken = i, this.useRecommendedSettings = o, this.assetTypeHandler = r, this.tiles = null, this._tileSetVersion = -1, this._attributions = [];
  }
  init(t) {
    this.assetId !== null && (t.rootURL = `https://api.cesium.com/v1/assets/${this.assetId}/endpoint`), this.tiles = t, this.auth.authURL = t.rootURL, t.resetFailedTiles();
  }
  loadRootTileset() {
    return this.auth.refreshToken().then((t) => (this._initializeFromAsset(t), this.tiles.invokeOnePlugin((e) => e !== this && e.loadRootTileset && e.loadRootTileset()))).catch((t) => {
      this.tiles.dispatchEvent({
        type: "load-error",
        tile: null,
        error: t,
        url: this.auth.authURL
      });
    });
  }
  preprocessURL(t) {
    return t = new URL(t), /^http/.test(t.protocol) && this._tileSetVersion != -1 && t.searchParams.set("v", this._tileSetVersion), t.toString();
  }
  fetchData(t, e) {
    return this.tiles.getPluginByName("GOOGLE_CLOUD_AUTH_PLUGIN") !== null ? null : this.auth.fetch(t, e);
  }
  getAttributions(t) {
    this.tiles.visibleTiles.size > 0 && t.push(...this._attributions);
  }
  _initializeFromAsset(t) {
    const e = this.tiles;
    if ("externalType" in t) {
      const s = new URL(t.options.url);
      e.rootURL = t.options.url, e.registerPlugin(new rt({
        apiToken: s.searchParams.get("key"),
        autoRefreshToken: this.autoRefreshToken,
        useRecommendedSettings: this.useRecommendedSettings
      }));
    } else {
      t.type !== "3DTILES" && this.assetTypeHandler(t.type, e, t), e.rootURL = t.url;
      const s = new URL(t.url);
      s.searchParams.has("v") && this._tileSetVersion === -1 && (this._tileSetVersion = s.searchParams.get("v")), t.attributions && (this._attributions = t.attributions.map((i) => ({
        value: i.html,
        type: "html",
        collapsible: i.collapsible
      })));
    }
  }
};
const D = "https://tile.googleapis.com/v1/createSession";
class at {
  get isMapTilesSession() {
    return this.authURL === D;
  }
  constructor(t = {}) {
    const { apiToken: e, sessionOptions: s = null, autoRefreshToken: i = !1 } = t;
    this.apiToken = e, this.autoRefreshToken = i, this.authURL = D, this.sessionToken = null, this.sessionOptions = s, this._tokenRefreshPromise = null;
  }
  async fetch(t, e) {
    this.sessionToken === null && this.isMapTilesSession && this.refreshToken(e), await this._tokenRefreshPromise;
    const s = new URL(t);
    s.searchParams.set("key", this.apiToken), this.sessionToken && s.searchParams.set("session", this.sessionToken);
    let i = await fetch(s, e);
    return i.status >= 400 && i.status <= 499 && this.autoRefreshToken && (await this.refreshToken(e), this.sessionToken && s.searchParams.set("session", this.sessionToken), i = await fetch(s, e)), this.sessionToken === null && !this.isMapTilesSession ? i.json().then((o) => (this.sessionToken = N(o), o)) : i;
  }
  refreshToken(t) {
    if (this._tokenRefreshPromise === null) {
      const e = new URL(this.authURL);
      e.searchParams.set("key", this.apiToken);
      const s = { ...t };
      this.isMapTilesSession && (s.method = "POST", s.body = JSON.stringify(this.sessionOptions), s.headers = s.headers || {}, s.headers = {
        ...s.headers,
        "Content-Type": "application/json"
      }), this._tokenRefreshPromise = fetch(e, s).then((i) => {
        if (!i.ok)
          throw new Error(`GoogleCloudAuth: Failed to load data with error code ${i.status}`);
        return i.json();
      }).then((i) => (this.sessionToken = N(i), this._tokenRefreshPromise = null, i));
    }
    return this._tokenRefreshPromise;
  }
}
function N(h) {
  if ("session" in h)
    return h.session;
  {
    let t = null;
    const e = h.root;
    return et(e, (s) => {
      if (s.content && s.content.uri) {
        const [, i] = s.content.uri.split("?");
        return t = new URLSearchParams(i).get("session"), !0;
      }
      return !1;
    }), t;
  }
}
function v(h) {
  return h >> 1 ^ -(h & 1);
}
class ct extends st {
  constructor(...t) {
    super(...t), this.fetchOptions.header = {
      Accept: "application/vnd.quantized-mesh,application/octet-stream;q=0.9"
    };
  }
  loadAsync(...t) {
    const { fetchOptions: e } = this;
    return e.header = e.header || {}, e.header.Accept = "application/vnd.quantized-mesh,application/octet-stream;q=0.9", e.header.Accept += ";extensions=octvertexnormals-watermask-metadata", super.loadAsync(...t);
  }
  parse(t) {
    let e = 0;
    const s = new DataView(t), i = () => {
      const n = s.getFloat64(e, !0);
      return e += 8, n;
    }, o = () => {
      const n = s.getFloat32(e, !0);
      return e += 4, n;
    }, r = () => {
      const n = s.getUint32(e, !0);
      return e += 4, n;
    }, l = () => {
      const n = s.getUint8(e);
      return e += 1, n;
    }, a = (n, u) => {
      const f = new u(t, e, n);
      return e += n * u.BYTES_PER_ELEMENT, f;
    }, w = {
      center: [i(), i(), i()],
      minHeight: o(),
      maxHeight: o(),
      sphereCenter: [i(), i(), i()],
      sphereRadius: i(),
      horizonOcclusionPoint: [i(), i(), i()]
    }, c = r(), $ = a(c, Uint16Array), q = a(c, Uint16Array), J = a(c, Uint16Array), m = new Float32Array(c), R = new Float32Array(c), P = new Float32Array(c);
    let C = 0, S = 0, I = 0;
    const U = 32767;
    for (let n = 0; n < c; ++n)
      C += v($[n]), S += v(q[n]), I += v(J[n]), m[n] = C / U, R[n] = S / U, P[n] = I / U;
    const M = c > 65536, k = M ? Uint32Array : Uint16Array;
    M ? e = Math.ceil(e / 4) * 4 : e = Math.ceil(e / 2) * 2;
    const Q = r(), _ = a(Q * 3, k);
    let O = 0;
    for (var b = 0; b < _.length; ++b) {
      const n = _[b];
      _[b] = O - n, n === 0 && ++O;
    }
    const x = (n, u) => R[u] - R[n], X = (n, u) => -x(n, u), E = (n, u) => m[n] - m[u], Z = (n, u) => -E(n, u), Y = r(), B = a(Y, k);
    B.sort(x);
    const j = r(), z = a(j, k);
    z.sort(E);
    const K = r(), F = a(K, k);
    F.sort(X);
    const W = r(), G = a(W, k);
    G.sort(Z);
    const tt = {
      westIndices: B,
      southIndices: z,
      eastIndices: F,
      northIndices: G
    }, A = {};
    for (; e < s.byteLength; ) {
      const n = l(), u = r();
      if (n === 1) {
        const f = a(c * 2, Uint8Array), p = new Float32Array(c * 3);
        for (let d = 0; d < c; d++) {
          let g = f[2 * d + 0] / 255 * 2 - 1, T = f[2 * d + 1] / 255 * 2 - 1;
          const y = 1 - (Math.abs(g) + Math.abs(T));
          if (y < 0) {
            const V = g;
            g = (1 - Math.abs(T)) * H(V), T = (1 - Math.abs(V)) * H(T);
          }
          const L = Math.sqrt(g * g + T * T + y * y);
          p[3 * d + 0] = g / L, p[3 * d + 1] = T / L, p[3 * d + 2] = y / L;
        }
        A.octvertexnormals = {
          extensionId: n,
          normals: p
        };
      } else if (n === 2) {
        const f = u === 1 ? 1 : 256, p = a(f * f, Uint8Array);
        A.watermask = {
          extensionId: n,
          mask: p,
          size: f
        };
      } else if (n === 4) {
        const f = r(), p = a(f, Uint8Array), d = new TextDecoder().decode(p);
        A.metadata = {
          extensionId: n,
          json: JSON.parse(d)
        };
      }
    }
    return {
      header: w,
      indices: _,
      vertexData: {
        u: m,
        v: R,
        height: P
      },
      edgeIndices: tt,
      extensions: A
    };
  }
}
function H(h) {
  return h < 0 ? -1 : 1;
}
export {
  it as C,
  at as G,
  ct as Q,
  rt as a,
  lt as b,
  v as z
};
//# sourceMappingURL=QuantizedMeshLoaderBase-Bbby1xf8.js.map
