// Three-way merge of two copies of the user state that both changed since they last agreed (`base`).
// Objects merge key by key; arrays of `{ id }` records (cards, spend entries) merge record by record,
// so edits to different cards, spends, bills or notes on two devices all survive. Only when both
// sides changed the same value differently does this device's edit win.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isKeyed = (v: unknown): v is { id: string }[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string");

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => equal(a[k], b[k]));
  }
  return false;
}

export function merge3<T>(base: unknown, local: T, remote: T): T {
  if (equal(local, remote)) return local;
  if (equal(base, local)) return remote;
  if (equal(base, remote)) return local;

  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out: Obj = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const v = merge3(b[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out as T;
  }

  if (isKeyed(local) && isKeyed(remote)) {
    const byId = (xs: { id: string }[]) => new Map(xs.map((x) => [x.id, x]));
    const b = isKeyed(base) ? byId(base) : new Map();
    const l = byId(local);
    const r = byId(remote);
    // the other device's order, then records added here
    const ids = [...r.keys(), ...[...l.keys()].filter((id) => !r.has(id))];
    return ids.map((id) => merge3(b.get(id), l.get(id), r.get(id))).filter((v) => v !== undefined) as T;
  }

  return local;
}
