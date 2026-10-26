// Values shared by server.ts and app.tsx. No server-only imports here.
export const ROLE_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

export const ROLES_CHANGED = "roles-changed";
export const RUNS_CHANGED = "runs-changed";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Placeholders a stage prompt may use. */
export const PROMPT_PLACEHOLDERS = {
  task: "the run's task text",
  prev: "outputs of the previous stage (all members, labelled by role)",
  all: "outputs of every earlier stage",
} as const;

/** One node of a team graph (mirrors the server's zod schema). */
export interface GraphNodeShape {
  id: string;
  roleSlug: string;
  label: string;
  prompt: string;
  inputs: string[];
  final: boolean;
  position?: { x: number; y: number };
}

/** Validate ids, edges and acyclicity; returns nodes in a topological order. */
export function validateGraph(nodes: GraphNodeShape[]): GraphNodeShape[] {
  const byId = new Map<string, GraphNodeShape>();
  for (const n of nodes) {
    if (byId.has(n.id)) throw new Error(`Duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  for (const n of nodes) for (const i of n.inputs) {
    if (!byId.has(i)) throw new Error(`Node "${n.id}" has unknown input "${i}"`);
    if (i === n.id) throw new Error(`Node "${n.id}" cannot depend on itself`);
  }
  const order: GraphNodeShape[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: GraphNodeShape, trail: string[]) => {
    const st = state.get(n.id);
    if (st === 2) return;
    if (st === 1) throw new Error(`Cycle: ${[...trail, n.id].join(" → ")}`);
    state.set(n.id, 1);
    for (const i of n.inputs) visit(byId.get(i)!, [...trail, n.id]);
    state.set(n.id, 2);
    order.push(n);
  };
  for (const n of nodes) visit(n, []);
  return order;
}

/** Longest-path depth per node — the column it renders in. */
export function graphLayers(nodes: GraphNodeShape[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const n of validateGraph(nodes)) depth.set(n.id, n.inputs.reduce((d, i) => Math.max(d, (depth.get(i) ?? 0) + 1), 0));
  return depth;
}


export interface GraphEdge { source: string; target: string }

/** Replace a connection in one validated change; failures leave the original intact. */
export function connectGraph<T extends GraphNodeShape>(nodes: T[], next: GraphEdge, previous?: GraphEdge): T[] {
  if (!nodes.some((n) => n.id === next.source) || !nodes.some((n) => n.id === next.target)) {
    throw new Error("Connection endpoint no longer exists.");
  }
  if (previous && !nodes.some((n) => n.id === previous.target && n.inputs.includes(previous.source))) {
    throw new Error("Connection no longer exists.");
  }
  const result = nodes.map((n) => {
    let inputs = previous?.target === n.id ? n.inputs.filter((id) => id !== previous.source) : n.inputs;
    if (n.id === next.target && !inputs.includes(next.source)) inputs = [...inputs, next.source];
    if (inputs.length > 16) throw new Error("Maximum 16 inputs per step.");
    return inputs === n.inputs ? n : { ...n, inputs };
  });
  validateGraph(result);
  return result;
}

/** Role icons: a PNG data URL of at most this many characters. */
export const MAX_ICON_DATA_URL = 100_000;
/** Longest side, in pixels, of the icon the editor stores. */
export const ICON_SIDE = 64;
