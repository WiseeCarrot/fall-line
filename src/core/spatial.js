// Uniform grid for broad-phase lookups. Tens of thousands of trees make a
// linear scan per frame untenable; this keeps collision queries to the handful
// of cells actually near the skier.

export class SpatialHash {
  constructor(cellSize = 12) {
    this.cell = cellSize;
    this.map = new Map();
    this.count = 0;
  }

  key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  /**
   * Insert into every cell the item's extent touches, not just the cell its
   * centre falls in. A tree occupies one cell either way, but a 100 m building
   * stored only at its midpoint is invisible to a query taken anywhere along
   * its wall — you'd ski straight through it and collide only near the centre.
   */
  insert(item) {
    const r = item.r || 0;
    const c = this.cell;
    const x0 = Math.floor((item.x - r) / c), x1 = Math.floor((item.x + r) / c);
    const z0 = Math.floor((item.z - r) / c), z1 = Math.floor((item.z + r) / c);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = this.key(cx, cz);
        let bucket = this.map.get(k);
        if (!bucket) { bucket = []; this.map.set(k, bucket); }
        bucket.push(item);
      }
    }
    this.count++;
  }

  insertAll(items) {
    for (const i of items) this.insert(i);
    return this;
  }

  /** Everything whose cell overlaps a disc of `radius` around (x, z). */
  query(x, z, radius, out = []) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c), z1 = Math.floor((z + radius) / c);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.map.get(this.key(cx, cz));
        if (bucket) for (const item of bucket) out.push(item);
      }
    }
    return out;
  }

  /** Nearest item within radius, or null. */
  nearest(x, z, radius) {
    const items = this.query(x, z, radius);
    let best = null, bestD = radius * radius;
    for (const it of items) {
      const d = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  clear() { this.map.clear(); this.count = 0; }
}
