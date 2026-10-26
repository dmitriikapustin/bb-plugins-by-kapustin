// Three-way sync between roles (this plugin's SQLite), Claude Code subagent
// files (~/.claude/agents/<slug>.md) and Tasks delegation presets (builtin
// Tasks plugin, reached through the `bb tasks preset` CLI because plugins
// cannot call each other's RPC).
//
// The file is the durable/exportable form; the role is the richest form
// (colour, description); the preset is what `bb tasks dispatch` needs. Any
// of the three may be edited; the last snapshot of each (a hash per side,
// kept in `sync_state`) tells which side changed since the previous sync,
// and that side wins. Deleting a role in the UI or deleting the file removes
// the other two; a deleted preset is recreated (it is derived).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PERMISSION_MODES, REASONING_LEVELS, ROLE_COLORS, SLUG_RE, type RoleColor } from "./shared.ts";

// ---------------------------------------------------------------------------
// Canonical record shared by the three sides
// ---------------------------------------------------------------------------

export interface Canon {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  permissionMode: string | null;
  color: RoleColor;
}

export interface SyncDefaults {
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
}

/** Values the preset gets when the role says "inherit". */
export function effective(c: Canon, d: SyncDefaults) {
  return {
    providerId: c.providerId ?? d.providerId,
    model: c.model ?? d.model,
    reasoningLevel: c.reasoningLevel ?? d.reasoningLevel,
    permissionMode: c.permissionMode ?? d.permissionMode,
  };
}

const sha = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");
export const roleHash = (c: Canon, d: SyncDefaults) =>
  sha([c.name, c.description, c.instructions, c.color, effective(c, d)]);
export const presetHash = (c: Canon, d: SyncDefaults) => sha([c.name, c.instructions, effective(c, d)]);

// ---------------------------------------------------------------------------
// Claude Code subagent files
// ---------------------------------------------------------------------------

/** Claude Code model aliases a hand-written file may use. */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5[1m]",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

export interface AgentFile {
  canon: Canon;
  /** `tools:` list, kept verbatim for Claude Code. */
  tools: string[] | null;
  /** Unknown top-level frontmatter lines, re-emitted verbatim. */
  extraLines: string[];
  mtimeMs: number;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}
function quote(v: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.,()/-]*$/.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) ? v : JSON.stringify(v);
}

/** Minimal YAML: scalars, `>`/`|` blocks, `[a, b]` or `- a` lists, one level of nested maps. */
function parseFrontmatter(text: string): { data: Record<string, unknown>; rawLines: Map<string, string[]> } {
  const data: Record<string, unknown> = {};
  const rawLines = new Map<string, string[]>();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1]!;
    const rest = m[2]!.trim();
    const block: string[] = [line];
    i++;
    const nested: string[] = [];
    while (i < lines.length && (/^\s+\S/.test(lines[i]!) || !lines[i]!.trim())) { nested.push(lines[i]!); block.push(lines[i]!); i++; }
    while (block.length && !block[block.length - 1]!.trim()) block.pop();
    const body = nested.filter((l) => l.trim());
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const joined = body.map((l) => l.trim());
      data[key] = rest.startsWith(">") ? joined.join(" ") : joined.join("\n");
    } else if (rest === "" && body.length && body.every((l) => /^\s*-\s/.test(l))) {
      data[key] = body.map((l) => unquote(l.replace(/^\s*-\s*/, "")));
    } else if (rest === "" && body.length) {
      const map: Record<string, string> = {};
      for (const l of body) { const mm = /^\s+([\w-]+):\s*(.*)$/.exec(l); if (mm) map[mm[1]!] = unquote(mm[2]!); }
      data[key] = map;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
    } else {
      data[key] = unquote(rest);
    }
    rawLines.set(key, block);
  }
  return { data, rawLines };
}

const KNOWN_KEYS = new Set(["name", "description", "model", "tools", "bb"]);

export function parseAgentFile(slug: string, text: string, mtimeMs: number): AgentFile {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!fm) throw new Error("missing frontmatter");
  const { data, rawLines } = parseFrontmatter(fm[1]!);
  const bb = (typeof data.bb === "object" && data.bb && !Array.isArray(data.bb) ? data.bb : {}) as Record<string, string>;
  const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : "");
  // A non-claude provider keeps its model under `bb.model`; Claude Code reads the top-level key.
  let model: string | null = (bb.model ?? "").trim() || str(data.model).trim() || null;
  if (model && model.toLowerCase() === "inherit") model = null;
  if (model && MODEL_ALIASES[model.toLowerCase()]) model = MODEL_ALIASES[model.toLowerCase()]!;
  const providerId = (bb.provider ?? "").trim() || (model ? "claude-code" : null);
  const reasoning = (bb.reasoning ?? "").trim();
  const permission = (bb.permission ?? "").trim();
  const color = (bb.color ?? "").trim();
  const extraLines: string[] = [];
  for (const [k, l] of rawLines) if (!KNOWN_KEYS.has(k)) extraLines.push(...l);
  const tools = Array.isArray(data.tools) ? (data.tools as string[]) : null;
  return {
    canon: {
      slug,
      name: (bb.title ?? "").trim() || titleCase(slug),
      description: str(data.description).trim(),
      instructions: fm[2]!.trim(),
      providerId,
      model,
      reasoningLevel: (REASONING_LEVELS as readonly string[]).includes(reasoning) ? reasoning : null,
      permissionMode: (PERMISSION_MODES as readonly string[]).includes(permission) ? permission : null,
      color: (ROLE_COLORS as readonly string[]).includes(color) ? (color as RoleColor) : "gray",
    },
    tools,
    extraLines,
    mtimeMs,
  };
}

const titleCase = (s: string) => s.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

export function serializeAgentFile(c: Canon, keep: { tools: string[] | null; extraLines: string[] } | null): string {
  const out = ["---", `name: ${c.slug}`];
  if (c.description) out.push(`description: ${quote(c.description)}`);
  if (c.model && (c.providerId === null || c.providerId === "claude-code")) out.push(`model: ${quote(c.model)}`);
  if (keep?.tools?.length) out.push(`tools: [${keep.tools.join(", ")}]`);
  const bb: string[] = [`  title: ${quote(c.name)}`];
  if (c.providerId) bb.push(`  provider: ${c.providerId}`);
  if (c.model && c.providerId && c.providerId !== "claude-code") bb.push(`  model: ${quote(c.model)}`);
  if (c.reasoningLevel) bb.push(`  reasoning: ${c.reasoningLevel}`);
  if (c.permissionMode) bb.push(`  permission: ${c.permissionMode}`);
  if (c.color && c.color !== "gray") bb.push(`  color: ${c.color}`);
  out.push("bb:", ...bb);
  if (keep?.extraLines.length) out.push(...keep.extraLines);
  out.push("---", "", c.instructions.trim(), "");
  return out.join("\n");
}

export function resolveAgentsDir(setting: string): string {
  const raw = setting.trim() || "~/.claude/agents";
  return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}

export async function readAgentFiles(dir: string): Promise<{ files: Map<string, AgentFile>; problems: string[]; unreadable: Set<string> }> {
  const files = new Map<string, AgentFile>();
  const problems: string[] = [];
  /** Slugs whose file exists but could not be parsed (often an editor mid-write); the engine must not treat them as deleted. */
  const unreadable = new Set<string>();
  if (!existsSync(dir)) return { files, problems, unreadable };
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.slice(0, -3);
    if (!SLUG_RE.test(slug)) { problems.push(`${entry}: file name is not a valid slug, skipped`); continue; }
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      files.set(slug, parseAgentFile(slug, await fs.readFile(full, "utf8"), st.mtimeMs));
    } catch (cause) {
      unreadable.add(slug);
      problems.push(`${entry}: ${cause instanceof Error ? cause.message : String(cause)} (skipped this pass)`);
    }
  }
  return { files, problems, unreadable };
}

// ---------------------------------------------------------------------------
// Tasks presets through the bb CLI
// ---------------------------------------------------------------------------

export interface Preset {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  permissionMode: string;
  instructions: string;
}

export interface TasksCli {
  list(): Promise<Preset[]>;
  create(p: Omit<Preset, "id">): Promise<Preset>;
  update(id: string, patch: Partial<Omit<Preset, "id">>): Promise<Preset>;
  remove(id: string): Promise<void>;
}

function findBbBinary(override: string): string {
  const candidates = [override.trim(), process.env.BB_CLI ?? "", "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb"].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "bb";
}

/** Runs `bb tasks <args> --json` against this server and returns the parsed JSON. */
export type BbTasksRunner = (args: string[]) => Promise<Record<string, unknown>>;

export function makeBbTasksRunner(opts: { serverUrl: () => string; bbBinary: string }): BbTasksRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      let url = "";
      try { url = opts.serverUrl(); } catch { /* not listening yet */ }
      execFile(
        findBbBinary(opts.bbBinary),
        ["tasks", ...args, "--json"],
        { env: { ...process.env, ...(url ? { BB_SERVER_URL: url } : {}) }, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`bb tasks ${args.slice(0, 2).join(" ")}: ${stderr.trim() || err.message}`));
          const text = String(stdout);
          const at = text.indexOf("{");
          try { resolve(JSON.parse(at >= 0 ? text.slice(at) : text)); } catch { resolve({}); }
        },
      );
    });
}

export function makeTasksCli(run: BbTasksRunner): TasksCli {
  const flags = (p: Partial<Omit<Preset, "id">>) => [
    ...(p.name !== undefined ? ["--name", p.name] : []),
    ...(p.providerId !== undefined ? ["--provider", p.providerId] : []),
    ...(p.modelId !== undefined ? ["--model", p.modelId] : []),
    ...(p.reasoningLevel !== undefined ? ["--reasoning", p.reasoningLevel] : []),
    ...(p.permissionMode !== undefined ? ["--permission", p.permissionMode] : []),
    ...(p.instructions !== undefined ? ["--instructions", p.instructions] : []),
  ];
  return {
    list: async () => ((await run(["preset", "list"])).presets as Preset[] | undefined) ?? [],
    create: async (p) => (await run(["preset", "create", ...flags(p)])).preset as Preset,
    update: async (id, patch) => (await run(["preset", "update", id, ...flags(patch)])).preset as Preset,
    remove: async (id) => { await run(["preset", "delete", id]); },
  };
}

// ---------------------------------------------------------------------------
// Tasks records (the lightweight "job" a role spawn creates)
// ---------------------------------------------------------------------------

export interface TasksProject { id: string; name: string; prefix: string; linkedBbProjectId: string | null }
export interface TaskRecord {
  id: string; key: string; title: string; description: string; status: string; priority: string;
  projectId: string; labelIds: string[]; createdAt: string; updatedAt: string;
}
export interface TaskDetail {
  task: TaskRecord;
  project: TasksProject;
  labels: Array<{ id: string; name: string }>;
  taskThreads: Array<{ threadId: string; title?: string; liveStatus?: string; presetName?: string }>;
}

export const ROLE_LABEL_PREFIX = "role:";

export function makeTaskOps(run: BbTasksRunner) {
  const labelCache = new Map<string, Set<string>>();
  const ops = {
    projects: async (): Promise<TasksProject[]> => ((await run(["project", "list"])).projects as TasksProject[] | undefined) ?? [],
    /** Create the `role:<slug>` label once per project. */
    ensureLabel: async (project: string, name: string): Promise<void> => {
      let known = labelCache.get(project);
      if (!known) {
        const labels = ((await run(["label", "list", "--project", project])).labels as Array<{ name: string }> | undefined) ?? [];
        known = new Set(labels.map((l) => l.name.toLowerCase()));
        labelCache.set(project, known);
      }
      if (known.has(name.toLowerCase())) return;
      await run(["label", "create", "--project", project, "--name", name]);
      known.add(name.toLowerCase());
    },
    create: async (input: { project: string; title: string; description: string; labels: string[] }): Promise<TaskRecord> => {
      const args = ["create", "--project", input.project, "--title", input.title, "--description", input.description];
      for (const l of input.labels) args.push("--label", l);
      return (await run(args)).task as TaskRecord;
    },
    show: async (key: string): Promise<TaskDetail> => (await run(["show", key])) as unknown as TaskDetail,
    list: async (input: { project?: string; label?: string; statuses?: string[]; limit?: number }): Promise<TaskRecord[]> => {
      const args = ["list"];
      if (input.project) args.push("--project", input.project);
      if (input.label) args.push("--label", input.label);
      for (const st of input.statuses ?? []) args.push("--status", st);
      args.push("--limit", String(input.limit ?? 100));
      return ((await run(args)).tasks as TaskRecord[] | undefined) ?? [];
    },
    attach: async (key: string, threadId: string): Promise<void> => { await run(["attach", key, "--thread", threadId]); },
    setStatus: async (key: string, status: string): Promise<void> => { await run(["update", key, "--status", status]); },
    comment: async (key: string, body: string): Promise<void> => { await run(["comment", key, "--body", body]); },
  };
  return ops;
}
export type TaskOps = ReturnType<typeof makeTaskOps>;

export const presetToCanon = (p: Preset, base: Canon | null, d: SyncDefaults, slug: string): Canon => ({
  slug,
  name: p.name,
  description: base?.description ?? "",
  instructions: p.instructions,
  providerId: p.providerId === d.providerId && base?.providerId === null ? null : p.providerId,
  model: p.modelId === d.model && base?.model === null ? null : p.modelId,
  reasoningLevel: p.reasoningLevel === d.reasoningLevel && base?.reasoningLevel === null ? null : p.reasoningLevel,
  permissionMode: p.permissionMode === d.permissionMode && base?.permissionMode === null ? null : p.permissionMode,
  color: base?.color ?? "gray",
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SyncState {
  slug: string;
  roleHash: string | null;
  fileHash: string | null;
  presetHash: string | null;
  presetId: string | null;
  fileKeep: { tools: string[] | null; extraLines: string[] } | null;
  syncedAt: number;
}

export interface SyncStore {
  all(): SyncState[];
  put(s: SyncState): void;
  remove(slug: string): void;
}

export interface RoleSide {
  list(): Array<Canon & { id: string; updatedAt: number }>;
  create(c: Canon): void;
  update(id: string, c: Canon): void;
  remove(id: string): void;
}

export interface SyncAction { slug: string; action: string; detail?: string }

export interface SyncReport { at: number; actions: SyncAction[]; problems: string[]; agentsDir: string }

export async function runSync(io: {
  agentsDir: string;
  defaults: SyncDefaults;
  roles: RoleSide;
  store: SyncStore;
  tasks: TasksCli;
  log: (m: string) => void;
}): Promise<SyncReport> {
  const actions: SyncAction[] = [];
  const problems: string[] = [];
  const act = (slug: string, action: string, detail?: string) => { actions.push({ slug, action, detail }); io.log(`${slug}: ${action}${detail ? " — " + detail : ""}`); };
  const d = io.defaults;

  await fs.mkdir(io.agentsDir, { recursive: true });
  const { files, problems: fileProblems, unreadable } = await readAgentFiles(io.agentsDir);
  problems.push(...fileProblems);
  const roles = new Map(io.roles.list().map((r) => [r.slug, r]));
  let presets: Preset[] = [];
  let presetsOk = true;
  try { presets = await io.tasks.list(); } catch (cause) { presetsOk = false; problems.push(cause instanceof Error ? cause.message : String(cause)); }
  const presetById = new Map(presets.map((p) => [p.id, p]));
  const presetByName = new Map(presets.map((p) => [p.name.toLowerCase(), p]));
  const states = new Map(io.store.all().map((s) => [s.slug, s]));

  const slugs = new Set<string>([...roles.keys(), ...files.keys(), ...states.keys()]);
  const fileMtime = (slug: string) => { try { return statSync(path.join(io.agentsDir, `${slug}.md`)).mtimeMs; } catch { return null; } };
  for (const slug of slugs) {
    if (unreadable.has(slug)) continue;
    try {
      const st = states.get(slug) ?? null;
      const role = roles.get(slug) ?? null;
      const file = files.get(slug) ?? null;
      const base: Canon | null = role ?? file?.canon ?? null;
      let preset = (st?.presetId ? presetById.get(st.presetId) : undefined) ?? (base ? presetByName.get(base.name.toLowerCase()) : undefined) ?? null;
      const rc = role ? (role as Canon) : null;
      const fc = file?.canon ?? null;
      const pc = preset && base ? presetToCanon(preset, base, d, slug) : null;
      const rh = rc ? roleHash(rc, d) : null;
      const fh = fc ? roleHash(fc, d) : null;
      const ph = pc ? presetHash(pc, d) : null;

      // Deletions: a side we synced before and that is now gone wins.
      if (st && !role && st.roleHash) {
        if (file) { await fs.unlink(path.join(io.agentsDir, `${slug}.md`)); act(slug, "file deleted", "role removed in BB"); }
        if (preset && presetsOk && st.presetId === preset.id) { await io.tasks.remove(preset.id); act(slug, "preset deleted", "role removed in BB"); }
        io.store.remove(slug);
        continue;
      }
      if (st && !file && st.fileHash) {
        if (fileMtime(slug) !== null) { problems.push(`${slug}: file reappeared during the pass; retry next pass`); continue; }
        if (role) { io.roles.remove(role.id); act(slug, "role deleted", "file removed"); }
        if (preset && presetsOk && st.presetId === preset.id) { await io.tasks.remove(preset.id); act(slug, "preset deleted", "file removed"); }
        io.store.remove(slug);
        continue;
      }
      if (!rc && !fc) { io.store.remove(slug); continue; }

      // Pick the source of truth for this round.
      let src: Canon;
      let why: string;
      if (!st) {
        src = rc ?? fc!; why = rc ? "role (first sync)" : "file (first sync)";
      } else {
        const roleChanged = rh !== st.roleHash;
        const fileChanged = fh !== st.fileHash;
        const presetChanged = presetsOk && ph !== st.presetHash;
        if (!roleChanged && !fileChanged && !presetChanged) continue;
        if (roleChanged && fileChanged && rc && fc) { const roleNewer = role!.updatedAt >= file!.mtimeMs; src = roleNewer ? rc : fc; why = roleNewer ? "role (newer than file)" : "file (newer than role)"; }
        else if (roleChanged && rc) { src = rc; why = "role"; }
        else if (fileChanged && fc) { src = fc; why = "file"; }
        else if (presetChanged && pc) { src = pc; why = "preset"; }
        else { src = rc ?? fc!; why = "role"; }
      }

      // Apply to the role.
      if (!role) { io.roles.create(src); act(slug, "role created", `from ${why}`); }
      else if (roleHash(role, d) !== roleHash(src, d)) { io.roles.update(role.id, src); act(slug, "role updated", `from ${why}`); }

      // Apply to the file (keep tools/unknown keys from the existing file).
      const keep = file ? { tools: file.tools, extraLines: file.extraLines } : st?.fileKeep ?? null;
      const wanted = serializeAgentFile(src, keep);
      const full = path.join(io.agentsDir, `${slug}.md`);
      if (!file || roleHash(file.canon, d) !== roleHash(src, d)) {
        // The snapshot was taken before awaiting Tasks; an edit that landed
        // meanwhile must win the next pass, not be overwritten now.
        const nowMtime = fileMtime(slug);
        if ((file && nowMtime !== file.mtimeMs) || (!file && nowMtime !== null)) { problems.push(`${slug}: file changed during the pass; retry next pass`); continue; }
        await fs.writeFile(full, wanted, "utf8");
        act(slug, file ? "file updated" : "file written", `from ${why}`);
      }

      // Apply to the preset.
      let presetId = preset?.id ?? null;
      if (presetsOk) {
        const eff = effective(src, d);
        const want = { name: src.name, providerId: eff.providerId, modelId: eff.model, reasoningLevel: eff.reasoningLevel, permissionMode: eff.permissionMode, instructions: src.instructions };
        if (!preset) { preset = await io.tasks.create(want); presetId = preset.id; act(slug, "preset created", preset.name); }
        else {
          const patch: Partial<typeof want> = {};
          for (const k of Object.keys(want) as Array<keyof typeof want>) if (preset[k] !== want[k]) patch[k] = want[k];
          if (Object.keys(patch).length) { preset = await io.tasks.update(preset.id, patch); act(slug, "preset updated", Object.keys(patch).join(", ")); }
        }
      }

      io.store.put({
        slug,
        roleHash: roleHash(src, d),
        fileHash: roleHash(src, d),
        presetHash: presetsOk && preset ? presetHash(presetToCanon(preset, src, d, slug), d) : st?.presetHash ?? null,
        presetId,
        fileKeep: keep,
        syncedAt: Date.now(),
      });
    } catch (cause) {
      problems.push(`${slug}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { at: Date.now(), actions, problems, agentsDir: io.agentsDir };
}
