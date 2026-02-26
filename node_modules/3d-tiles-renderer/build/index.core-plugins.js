import { C as I, b as N, G as U, a as S, Q as R, z as V } from "./QuantizedMeshLoaderBase-Bbby1xf8.js";
import { L as d, r as T, b as v } from "./LoaderBase-2yhE3Jur.js";
function p(u) {
  return u.implicitTilingData.root.implicitTiling.subdivisionScheme === "OCTREE";
}
function m(u) {
  return p(u) ? 8 : 4;
}
function y(u, i) {
  if (!u)
    return [0, 0, 0];
  const e = u.implicitTilingData.x, t = u.implicitTilingData.y, r = u.implicitTilingData.z, n = 2 * e + i % 2, s = 2 * t + Math.floor(i / 2) % 2, l = p(u) ? 2 * r + Math.floor(i / 4) % 2 : 0;
  return [n, s, l];
}
class b {
  constructor(i, e) {
    this.parent = i, this.children = [], this.geometricError = 0, this.boundingVolume = null;
    const [t, r, n] = y(i, e);
    this.implicitTilingData = {
      level: i.implicitTilingData.level + 1,
      root: i.implicitTilingData.root,
      subtreeIdx: e,
      x: t,
      y: r,
      z: n
    };
  }
  static clone(i) {
    return {
      parent: i.parent,
      children: [],
      geometricError: i.geometricError,
      boundingVolume: i.boundingVolume,
      implicitTilingData: {
        ...i.implicitTilingData
      }
    };
  }
}
class A extends d {
  constructor(i) {
    super(), this.tile = i, this.rootTile = i.implicitTilingData.root, this.workingPath = null;
  }
  /**
   * A helper object for storing the two parts of the subtree binary
   *
   * @typedef {object} Subtree
   * @property {number} version
   * @property {JSON} subtreeJson
   * @property {ArrayBuffer} subtreeByte
   * @private
   */
  /**
   *
   * @param buffer
   * @return {Subtree}
   */
  parseBuffer(i) {
    const e = new DataView(i);
    let t = 0;
    const r = T(e);
    console.assert(r === "subt", 'SUBTREELoader: The magic bytes equal "subt".'), t += 4;
    const n = e.getUint32(t, !0);
    console.assert(n === 1, 'SUBTREELoader: The version listed in the header is "1".'), t += 4;
    const s = e.getUint32(t, !0);
    t += 8;
    const l = e.getUint32(t, !0);
    t += 8;
    const o = JSON.parse(v(new Uint8Array(i, t, s)));
    t += s;
    const a = i.slice(t, t + l);
    return {
      version: n,
      subtreeJson: o,
      subtreeByte: a
    };
  }
  async parse(i) {
    const e = this.parseBuffer(i), t = e.subtreeJson;
    t.contentAvailabilityHeaders = [].concat(t.contentAvailability);
    const r = this.preprocessBuffers(t.buffers), n = this.preprocessBufferViews(
      t.bufferViews,
      r
    );
    this.markActiveBufferViews(t, n);
    const s = await this.requestActiveBuffers(
      r,
      e.subtreeByte
    ), l = this.parseActiveBufferViews(n, s);
    this.parseAvailability(e, t, l), this.expandSubtree(this.tile, e);
  }
  /**
   * Determine which buffer views need to be loaded into memory. This includes:
   *
   * <ul>
   * <li>The tile availability bitstream (if a bitstream is defined)</li>
   * <li>The content availability bitstream(s) (if a bitstream is defined)</li>
   * <li>The child subtree availability bitstream (if a bitstream is defined)</li>
   * </ul>
   *
   * <p>
   * This function modifies the buffer view headers' isActive flags in place.
   * </p>
   *
   * @param {JSON} subtreeJson The JSON chunk from the subtree
   * @param {BufferViewHeader[]} bufferViewHeaders The preprocessed buffer view headers
   * @private
   */
  markActiveBufferViews(i, e) {
    let t;
    const r = i.tileAvailability;
    isNaN(r.bitstream) ? isNaN(r.bufferView) || (t = e[r.bufferView]) : t = e[r.bitstream], t && (t.isActive = !0, t.bufferHeader.isActive = !0);
    const n = i.contentAvailabilityHeaders;
    for (let l = 0; l < n.length; l++)
      t = void 0, isNaN(n[l].bitstream) ? isNaN(n[l].bufferView) || (t = e[n[l].bufferView]) : t = e[n[l].bitstream], t && (t.isActive = !0, t.bufferHeader.isActive = !0);
    t = void 0;
    const s = i.childSubtreeAvailability;
    isNaN(s.bitstream) ? isNaN(s.bufferView) || (t = e[s.bufferView]) : t = e[s.bitstream], t && (t.isActive = !0, t.bufferHeader.isActive = !0);
  }
  /**
   * Go through the list of buffers and gather all the active ones into
   * a dictionary.
   * <p>
   * The results are put into a dictionary object. The keys are indices of
   * buffers, and the values are Uint8Arrays of the contents. Only buffers
   * marked with the isActive flag are fetched.
   * </p>
   * <p>
   * The internal buffer (the subtree's binary chunk) is also stored in this
   * dictionary if it is marked active.
   * </p>
   * @param {BufferHeader[]} bufferHeaders The preprocessed buffer headers
   * @param {ArrayBuffer} internalBuffer The binary chunk of the subtree file
   * @returns {object} buffersU8 A dictionary of buffer index to a Uint8Array of its contents.
   * @private
   */
  async requestActiveBuffers(i, e) {
    const t = [];
    for (let s = 0; s < i.length; s++) {
      const l = i[s];
      if (!l.isActive)
        t.push(Promise.resolve());
      else if (l.isExternal) {
        const o = this.parseImplicitURIBuffer(
          this.tile,
          this.rootTile.implicitTiling.subtrees.uri,
          l.uri
        ), a = fetch(o, this.fetchOptions).then((c) => {
          if (!c.ok)
            throw new Error(`SUBTREELoader: Failed to load external buffer from ${l.uri} with error code ${c.status}.`);
          return c.arrayBuffer();
        }).then((c) => new Uint8Array(c));
        t.push(a);
      } else
        t.push(Promise.resolve(new Uint8Array(e)));
    }
    const r = await Promise.all(t), n = {};
    for (let s = 0; s < r.length; s++) {
      const l = r[s];
      l && (n[s] = l);
    }
    return n;
  }
  /**
   * Go through the list of buffer views, and if they are marked as active,
   * extract a subarray from one of the active buffers.
   *
   * @param {BufferViewHeader[]} bufferViewHeaders
   * @param {object} buffersU8 A dictionary of buffer index to a Uint8Array of its contents.
   * @returns {object} A dictionary of buffer view index to a Uint8Array of its contents.
   * @private
   */
  parseActiveBufferViews(i, e) {
    const t = {};
    for (let r = 0; r < i.length; r++) {
      const n = i[r];
      if (!n.isActive)
        continue;
      const s = n.byteOffset, l = s + n.byteLength, o = e[n.buffer];
      t[r] = o.slice(s, l);
    }
    return t;
  }
  /**
   * A buffer header is the JSON header from the subtree JSON chunk plus
   * a couple extra boolean flags for easy reference.
   *
   * Buffers are assumed inactive until explicitly marked active. This is used
   * to avoid fetching unneeded buffers.
   *
   * @typedef {object} BufferHeader
   * @property {boolean} isActive Whether this buffer is currently used.
   * @property {string} [uri] The URI of the buffer (external buffers only)
   * @property {number} byteLength The byte length of the buffer, including any padding contained within.
   * @private
   */
  /**
   * Iterate over the list of buffers from the subtree JSON and add the isActive field for easier parsing later.
   * This modifies the objects in place.
   * @param {Object[]} [bufferHeaders=[]] The JSON from subtreeJson.buffers.
   * @returns {BufferHeader[]} The same array of headers with additional fields.
   * @private
   */
  preprocessBuffers(i = []) {
    for (let e = 0; e < i.length; e++) {
      const t = i[e];
      t.isActive = !1, t.isExternal = !!t.uri;
    }
    return i;
  }
  /**
   * A buffer view header is the JSON header from the subtree JSON chunk plus
   * the isActive flag and a reference to the header for the underlying buffer.
   *
   * @typedef {object} BufferViewHeader
   * @property {BufferHeader} bufferHeader A reference to the header for the underlying buffer
   * @property {boolean} isActive Whether this bufferView is currently used.
   * @property {number} buffer The index of the underlying buffer.
   * @property {number} byteOffset The start byte of the bufferView within the buffer.
   * @property {number} byteLength The length of the bufferView. No padding is included in this length.
   * @private
   */
  /**
   * Iterate the list of buffer views from the subtree JSON and add the
   * isActive flag. Also save a reference to the bufferHeader.
   *
   * @param {Object[]} [bufferViewHeaders=[]] The JSON from subtree.bufferViews.
   * @param {BufferHeader[]} bufferHeaders The preprocessed buffer headers.
   * @returns {BufferViewHeader[]} The same array of bufferView headers with additional fields.
   * @private
   */
  preprocessBufferViews(i = [], e) {
    for (let t = 0; t < i.length; t++) {
      const r = i[t];
      r.bufferHeader = e[r.buffer], r.isActive = !1, r.isExternal = r.bufferHeader.isExternal;
    }
    return i;
  }
  /**
   * Parse the three availability bitstreams and store them in the subtree.
   *
   * @param {Subtree} subtree The subtree to modify.
   * @param {Object} subtreeJson The subtree JSON.
   * @param {Object} bufferViewsU8 A dictionary of buffer view index to a Uint8Array of its contents.
   * @private
   */
  parseAvailability(i, e, t) {
    const r = m(this.rootTile), n = this.rootTile.implicitTiling.subtreeLevels, s = (Math.pow(r, n) - 1) / (r - 1), l = Math.pow(r, n);
    i._tileAvailability = this.parseAvailabilityBitstream(
      e.tileAvailability,
      t,
      s
    ), i._contentAvailabilityBitstreams = [];
    for (let o = 0; o < e.contentAvailabilityHeaders.length; o++) {
      const a = this.parseAvailabilityBitstream(
        e.contentAvailabilityHeaders[o],
        t,
        // content availability has the same length as tile availability.
        s
      );
      i._contentAvailabilityBitstreams.push(a);
    }
    i._childSubtreeAvailability = this.parseAvailabilityBitstream(
      e.childSubtreeAvailability,
      t,
      l
    );
  }
  /**
   * Given the JSON describing an availability bitstream, turn it into an
   * in-memory representation using an object. This handles bitstreams from a bufferView.
   *
   * @param {Object} availabilityJson A JSON object representing the availability.
   * @param {Object} bufferViewsU8 A dictionary of buffer view index to its Uint8Array contents.
   * @param {number} lengthBits The length of the availability bitstream in bits.
   * @returns {object}
   * @private
   */
  parseAvailabilityBitstream(i, e, t) {
    if (!isNaN(i.constant))
      return {
        constant: !!i.constant,
        lengthBits: t
      };
    let r;
    return isNaN(i.bitstream) ? isNaN(i.bufferView) || (r = e[i.bufferView]) : r = e[i.bitstream], {
      bitstream: r,
      lengthBits: t
    };
  }
  /**
   * Expand a single subtree tile. This transcodes the subtree into
   * a tree of {@link SubtreeTile}. The root of this tree is stored in
   * the placeholder tile's children array. This method also creates
   * tiles for the child subtrees to be lazily expanded as needed.
   *
   * @param {Object | SubtreeTile} subtreeRoot The first node of the subtree.
   * @param {Subtree} subtree The parsed subtree.
   * @private
   */
  expandSubtree(i, e) {
    const t = b.clone(i);
    for (let s = 0; e && s < e._contentAvailabilityBitstreams.length; s++)
      if (e && this.getBit(e._contentAvailabilityBitstreams[s], 0)) {
        t.content = { uri: this.parseImplicitURI(i, this.rootTile.content.uri) };
        break;
      }
    i.children.push(t);
    const r = this.transcodeSubtreeTiles(
      t,
      e
    ), n = this.listChildSubtrees(e, r);
    for (let s = 0; s < n.length; s++) {
      const l = n[s], o = l.tile, a = this.deriveChildTile(
        null,
        o,
        null,
        l.childMortonIndex
      );
      a.content = { uri: this.parseImplicitURI(a, this.rootTile.implicitTiling.subtrees.uri) }, o.children.push(a);
    }
  }
  /**
   * Transcode the implicitly defined tiles within this subtree and generate
   * explicit {@link SubtreeTile} objects. This function only transcodes tiles,
   * child subtrees are handled separately.
   *
   * @param {Object | SubtreeTile} subtreeRoot The root of the current subtree.
   * @param {Subtree} subtree The subtree to get availability information.
   * @returns {Array} The bottom row of transcoded tiles. This is helpful for processing child subtrees.
   * @private
   */
  transcodeSubtreeTiles(i, e) {
    let t = [i], r = [];
    for (let n = 1; n < this.rootTile.implicitTiling.subtreeLevels; n++) {
      const s = m(this.rootTile), l = (Math.pow(s, n) - 1) / (s - 1), o = s * t.length;
      for (let a = 0; a < o; a++) {
        const c = l + a, h = a >> Math.log2(s), f = t[h];
        if (!this.getBit(e._tileAvailability, c)) {
          r.push(void 0);
          continue;
        }
        const g = this.deriveChildTile(
          e,
          f,
          c,
          a
        );
        f.children.push(g), r.push(g);
      }
      t = r, r = [];
    }
    return t;
  }
  /**
   * Given a parent tile and information about which child to create, derive
   * the properties of the child tile implicitly.
   * <p>
   * This creates a real tile for rendering.
   * </p>
   *
   * @param {Subtree} subtree The subtree the child tile belongs to.
   * @param {Object | SubtreeTile} parentTile The parent of the new child tile.
   * @param {number} childBitIndex The index of the child tile within the tile's availability information.
   * @param {number} childMortonIndex The morton index of the child tile relative to its parent.
   * @returns {SubtreeTile} The new child tile.
   * @private
   */
  deriveChildTile(i, e, t, r) {
    const n = new b(e, r);
    n.boundingVolume = this.getTileBoundingVolume(n), n.geometricError = this.getGeometricError(n);
    for (let s = 0; i && s < i._contentAvailabilityBitstreams.length; s++)
      if (i && this.getBit(i._contentAvailabilityBitstreams[s], t)) {
        n.content = { uri: this.parseImplicitURI(n, this.rootTile.content.uri) };
        break;
      }
    return n;
  }
  /**
   * Get a bit from the bitstream as a Boolean. If the bitstream
   * is a constant, the constant value is returned instead.
   *
   * @param {ParsedBitstream} object
   * @param {number} index The integer index of the bit.
   * @returns {boolean} The value of the bit.
   * @private
   */
  getBit(i, e) {
    if (e < 0 || e >= i.lengthBits)
      throw new Error("Bit index out of bounds.");
    if (i.constant !== void 0)
      return i.constant;
    const t = e >> 3, r = e % 8;
    return (new Uint8Array(i.bitstream)[t] >> r & 1) === 1;
  }
  /**
   * //TODO Adapt for Sphere
   * To maintain numerical stability during this subdivision process,
   * the actual bounding volumes should not be computed progressively by subdividing a non-root tile volume.
   * Instead, the exact bounding volumes are computed directly for a given level.
   * @param {Object | SubtreeTile} tile
   * @return {Object} object containing the bounding volume.
   */
  getTileBoundingVolume(i) {
    const e = {};
    if (this.rootTile.boundingVolume.region) {
      const t = [...this.rootTile.boundingVolume.region], r = t[0], n = t[2], s = t[1], l = t[3], o = (n - r) / Math.pow(2, i.implicitTilingData.level), a = (l - s) / Math.pow(2, i.implicitTilingData.level);
      t[0] = r + o * i.implicitTilingData.x, t[2] = r + o * (i.implicitTilingData.x + 1), t[1] = s + a * i.implicitTilingData.y, t[3] = s + a * (i.implicitTilingData.y + 1);
      for (let c = 0; c < 4; c++) {
        const h = t[c];
        h < -Math.PI ? t[c] += 2 * Math.PI : h > Math.PI && (t[c] -= 2 * Math.PI);
      }
      if (p(i)) {
        const c = t[4], f = (t[5] - c) / Math.pow(2, i.implicitTilingData.level);
        t[4] = c + f * i.implicitTilingData.z, t[5] = c + f * (i.implicitTilingData.z + 1);
      }
      e.region = t;
    }
    if (this.rootTile.boundingVolume.box) {
      const t = [...this.rootTile.boundingVolume.box], r = 2 ** i.implicitTilingData.level - 1, n = Math.pow(2, -i.implicitTilingData.level), s = p(i) ? 3 : 2;
      for (let l = 0; l < s; l++) {
        t[3 + l * 3 + 0] *= n, t[3 + l * 3 + 1] *= n, t[3 + l * 3 + 2] *= n;
        const o = t[3 + l * 3 + 0], a = t[3 + l * 3 + 1], c = t[3 + l * 3 + 2], h = l === 0 ? i.implicitTilingData.x : l === 1 ? i.implicitTilingData.y : i.implicitTilingData.z;
        t[0] += 2 * o * (-0.5 * r + h), t[1] += 2 * a * (-0.5 * r + h), t[2] += 2 * c * (-0.5 * r + h);
      }
      e.box = t;
    }
    return e;
  }
  /**
   * Each child’s geometricError is half of its parent’s geometricError.
   * @param {Object | SubtreeTile} tile
   * @return {number}
   */
  getGeometricError(i) {
    return this.rootTile.geometricError / Math.pow(2, i.implicitTilingData.level);
  }
  /**
   * Determine what child subtrees exist and return a list of information.
   *
   * @param {Object} subtree The subtree for looking up availability.
   * @param {Array} bottomRow The bottom row of tiles in a transcoded subtree.
   * @returns {[]} A list of identifiers for the child subtrees.
   * @private
   */
  listChildSubtrees(i, e) {
    const t = [], r = m(this.rootTile);
    for (let n = 0; n < e.length; n++) {
      const s = e[n];
      if (s !== void 0)
        for (let l = 0; l < r; l++) {
          const o = n * r + l;
          this.getBit(i._childSubtreeAvailability, o) && t.push({
            tile: s,
            childMortonIndex: o
          });
        }
    }
    return t;
  }
  /**
   * Replaces placeholder tokens in a URI template with the corresponding tile properties.
   *
   * The URI template should contain the tokens:
   * - `{level}` for the tile's subdivision level.
   * - `{x}` for the tile's x-coordinate.
   * - `{y}` for the tile's y-coordinate.
   * - `{z}` for the tile's z-coordinate.
   *
   * @param {Object} tile - The tile object containing properties __level, __x, __y, and __z.
   * @param {string} uri - The URI template string with placeholders.
   * @returns {string} The URI with placeholders replaced by the tile's properties.
   */
  parseImplicitURI(i, e) {
    return e = e.replace("{level}", i.implicitTilingData.level), e = e.replace("{x}", i.implicitTilingData.x), e = e.replace("{y}", i.implicitTilingData.y), e = e.replace("{z}", i.implicitTilingData.z), e;
  }
  /**
   * Generates the full external buffer URI for a tile by combining an implicit URI with a buffer URI.
   *
   * First, it parses the implicit URI using the tile properties and the provided template. Then, it creates a new URL
   * relative to the tile's base path, removes the last path segment, and appends the buffer URI.
   *
   * @param {Object} tile - The tile object that contains properties:
   *   - __level: the subdivision level,
   *   - __x, __y, __z: the tile coordinates,
   * @param {string} uri - The URI template string with placeholders for the tile (e.g., `{level}`, `{x}`, `{y}`, `{z}`).
   * @param {string} bufUri - The buffer file name to append (e.g., "0_1.bin").
   * @returns {string} The full external buffer URI.
   */
  parseImplicitURIBuffer(i, e, t) {
    const r = this.parseImplicitURI(i, e), n = new URL(r, this.workingPath + "/");
    return n.pathname = n.pathname.substring(0, n.pathname.lastIndexOf("/")), new URL(n.pathname + "/" + t, this.workingPath + "/").toString();
  }
}
class w {
  constructor() {
    this.name = "IMPLICIT_TILING_PLUGIN";
  }
  init(i) {
    this.tiles = i;
  }
  preprocessNode(i, e, t) {
    var r;
    i.implicitTiling ? (i.internal.hasUnrenderableContent = !0, i.internal.hasRenderableContent = !1, i.implicitTilingData = {
      // Keep this tile as an Implicit Root Tile
      root: i,
      // Idx of the tile in its subtree
      subtreeIdx: 0,
      // Coords of the tile
      x: 0,
      y: 0,
      z: 0,
      level: 0
    }) : /.subtree$/i.test((r = i.content) == null ? void 0 : r.uri) && (i.internal.hasUnrenderableContent = !0, i.internal.hasRenderableContent = !1);
  }
  parseTile(i, e, t) {
    if (/^subtree$/i.test(t)) {
      const r = new A(e);
      return r.workingPath = e.internal.basePath, r.fetchOptions = this.tiles.fetchOptions, r.parse(i);
    }
  }
  preprocessURL(i, e) {
    if (e && e.implicitTiling) {
      const t = e.implicitTiling.subtrees.uri.replace("{level}", e.implicitTilingData.level).replace("{x}", e.implicitTilingData.x).replace("{y}", e.implicitTilingData.y).replace("{z}", e.implicitTilingData.z);
      return new URL(t, e.internal.basePath + "/").toString();
    }
    return i;
  }
  disposeTile(i) {
    var e;
    /.subtree$/i.test((e = i.content) == null ? void 0 : e.uri) && (i.children.forEach((t) => {
      this.tiles.processNodeQueue.remove(t);
    }), i.children.length = 0);
  }
}
class x {
  constructor() {
    this.name = "ENFORCE_NONZERO_ERROR", this.priority = -1 / 0, this.originalError = /* @__PURE__ */ new Map();
  }
  preprocessNode(i) {
    if (i.geometricError === 0) {
      let e = i.parent, t = 1;
      for (; e !== null; ) {
        if (e.geometricError !== 0) {
          i.geometricError = e.geometricError * 2 ** -t;
          break;
        }
        e = e.parent, t++;
      }
    }
  }
}
export {
  I as CesiumIonAuth,
  N as CesiumIonAuthPlugin,
  x as EnforceNonZeroErrorPlugin,
  U as GoogleCloudAuth,
  S as GoogleCloudAuthPlugin,
  w as ImplicitTilingPlugin,
  R as QuantizedMeshLoaderBase,
  V as zigZagDecode
};
//# sourceMappingURL=index.core-plugins.js.map
