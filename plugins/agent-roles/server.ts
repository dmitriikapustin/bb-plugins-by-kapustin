// bb-plugin-agent-roles — backend entry.
//
// Roles are reusable specialist profiles: instructions plus a default
// provider/model/reasoning/permission tuple. Teams are DAGs of role nodes; a
// team run starts every node whose inputs are done, as ordinary BB threads,
// feeding input outputs into the node's prompt. All
// state lives in this plugin's SQLite database; threads are plain BB threads
// parented to the invoking thread when there is one.
//
// Surfaces: the Agent roles page (app.tsx), the `bb role` CLI (what agents
// use), and the skill in skills/agent-roles.
import { randomUUID } from "node:crypto";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PERMISSION_MODES,
  REASONING_LEVELS,
  ROLE_COLORS,
  ROLES_CHANGED,
  RUNS_CHANGED,
  SLUG_RE,
  graphLayers,
  validateGraph,
  type RoleColor,
} from "./shared";
import {
  ROLE_LABEL_PREFIX,
  makeBbTasksRunner,
  makeTaskOps,
  makeTasksCli,
  resolveAgentsDir,
  runSync,
  type Canon,
  type SyncReport,
  type SyncState,
  type TaskRecord,
} from "./sync";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const slugSchema = z.string().regex(SLUG_RE, "lowercase letters, digits and dashes; max 40");

const roleSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable(),
  permissionMode: z.enum(PERMISSION_MODES).nullable(),
  color: z.enum(ROLE_COLORS),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Role = z.infer<typeof roleSchema>;

const roleInputSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(""),
    instructions: z.string().trim().min(1).max(20_000),
    providerId: z.string().min(1).nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    reasoningLevel: z.enum(REASONING_LEVELS).nullable().default(null),
    permissionMode: z.enum(PERMISSION_MODES).nullable().default(null),
    color: z.enum(ROLE_COLORS).default("gray"),
  })
  .strict();

// A team is a DAG: each node is one role invocation; `inputs` name the nodes
// whose outputs it receives. Nodes with no inputs start immediately; a node
// starts when every input finished. Nodes flagged `final` (or, when none is
// flagged, every sink) form the run's output.
const nodeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "node id: lowercase, digits, - or _");
const nodeSchema = z
  .object({
    id: nodeIdSchema,
    roleSlug: slugSchema,
    label: z.string().trim().min(1).max(80),
    /** Prompt template; may use {task}, {inputs} (= {prev}), {all}, {<nodeId>}. */
    prompt: z.string().trim().min(1).max(20_000),
    inputs: z.array(nodeIdSchema).max(16).default([]),
    final: z.boolean().default(false),
    position: z.object({ x: z.number().finite().min(0).max(10000), y: z.number().finite().min(0).max(10000) }).strict().optional(),
  })
  .strict();
export type GraphNode = z.infer<typeof nodeSchema>;

const graphSchema = z.array(nodeSchema).min(1).max(40);

const teamSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  name: z.string(),
  description: z.string(),
  nodes: graphSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Team = z.infer<typeof teamSchema>;

const teamInputSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(""),
    nodes: graphSchema,
  })
  .strict();

/** Legacy stage lists (pre-DAG teams) become a layered graph. */
function stagesToNodes(stages: Array<{ title: string; mode: string; members: Array<{ roleSlug: string; prompt: string }> }>): GraphNode[] {
  const nodes: GraphNode[] = [];
  let prevIds: string[] = [];
  stages.forEach((stage, si) => {
    const ids: string[] = [];
    stage.members.forEach((m, mi) => {
      const id = `s${si + 1}_${m.roleSlug}${stage.members.length > 1 ? `_${mi + 1}` : ""}`.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
      const inputs = stage.mode === "sequential" && mi > 0 ? [ids[mi - 1]!] : [...prevIds];
      nodes.push({ id, roleSlug: m.roleSlug, label: stage.members.length > 1 ? `${stage.title} · ${m.roleSlug}` : stage.title, prompt: m.prompt, inputs, final: false });
      ids.push(id);
    });
    prevIds = ids;
  });
  return nodes;
}

const runStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const stepStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);

const stepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  stageIndex: z.number().int(),
  stageTitle: z.string(),
  memberIndex: z.number().int(),
  roleSlug: z.string(),
  roleName: z.string(),
  threadId: z.string().nullable(),
  status: stepStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type Step = z.infer<typeof stepSchema>;

const runSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  task: z.string(),
  status: runStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().nullable(),
});
export type TeamRun = z.infer<typeof runSchema>;
const runWithStepsSchema = runSchema.extend({ steps: z.array(stepSchema) });
export type TeamRunWithSteps = z.infer<typeof runWithStepsSchema>;

const spawnInputSchema = z
  .object({
    roleSlug: slugSchema,
    prompt: z.string().trim().min(1).max(50_000),
    projectId: z.string().min(1),
    environmentId: z.string().min(1).nullable().default(null),
    parentThreadId: z.string().min(1).nullable().default(null),
    title: z.string().trim().min(1).max(120).optional(),
    hidden: z.boolean().default(false),
    /** Tasks record this thread works on; attached and reported to. */
    taskKey: z.string().trim().min(1).max(40).nullable().default(null),
  })
  .strict();

const roleTaskSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.string(),
  roleSlug: z.string().nullable(),
  updatedAt: z.string(),
  threadIds: z.array(z.string()),
});
export type RoleTask = z.infer<typeof roleTaskSchema>;

const threadRoleSchema = z.object({
  roleSlug: z.string(),
  roleName: z.string(),
  description: z.string(),
  color: z.enum(ROLE_COLORS),
  instructions: z.string(),
  taskKey: z.string().nullable(),
}).nullable();

const startRunInputSchema = z
  .object({
    teamSlug: slugSchema,
    task: z.string().trim().min(1).max(50_000),
    projectId: z.string().min(1),
    environmentId: z.string().min(1).nullable().default(null),
    parentThreadId: z.string().min(1).nullable().default(null),
    hidden: z.boolean().default(false),
  })
  .strict();

const okOutput = z.object({ ok: z.literal(true) }).strict();
const idInput = z.object({ id: z.string().min(1) }).strict();

const syncReportSchema = z.object({
  at: z.number(),
  agentsDir: z.string(),
  actions: z.array(z.object({ slug: z.string(), action: z.string(), detail: z.string().optional() })),
  problems: z.array(z.string()),
});
const syncStatusSchema = z.object({
  enabled: z.boolean(),
  agentsDir: z.string(),
  running: z.boolean(),
  last: syncReportSchema.nullable(),
  entries: z.array(z.object({ slug: z.string(), presetId: z.string().nullable(), syncedAt: z.number() })),
});

export const rpcContract = defineRpcContract({
  roles_list: { input: z.null(), output: z.object({ roles: z.array(roleSchema) }) },
  roles_create: { input: roleInputSchema, output: roleSchema },
  roles_update: { input: roleInputSchema.partial().extend({ id: z.string().min(1) }).strip(), output: roleSchema },
  roles_delete: { input: idInput, output: okOutput },
  roles_reorder: { input: z.object({ ids: z.array(z.string()).max(500) }).strict(), output: okOutput },
  role_spawn: { input: spawnInputSchema, output: z.object({ threadId: z.string() }).strict() },
  teams_list: { input: z.null(), output: z.object({ teams: z.array(teamSchema) }) },
  teams_create: { input: teamInputSchema, output: teamSchema },
  teams_update: { input: teamInputSchema.partial().extend({ id: z.string().min(1) }).strip(), output: teamSchema },
  teams_delete: { input: idInput, output: okOutput },
  runs_list: {
    input: z.object({ limit: z.number().int().positive().max(200).optional() }).strict().nullable(),
    output: z.object({ runs: z.array(runSchema) }),
  },
  runs_get: { input: idInput, output: runWithStepsSchema },
  runs_start: { input: startRunInputSchema, output: runSchema },
  runs_cancel: { input: idInput, output: okOutput },
  runs_delete: { input: idInput, output: okOutput },
  context_projects: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  model_defaults: {
    input: z.null(),
    output: z.object({ providerId: z.string().min(1), model: z.string().min(1), reasoningLevel: z.enum(REASONING_LEVELS) }),
  },
  sync_run: { input: z.null(), output: syncReportSchema },
  sync_status: { input: z.null(), output: syncStatusSchema },
  role_task_create: {
    input: z.object({ roleSlug: slugSchema, prompt: z.string().trim().min(1).max(50_000), project: z.string().nullable().default(null) }).strict(),
    output: z.object({ key: z.string(), title: z.string() }).strict(),
  },
  role_chat: {
    input: z.object({
      taskKey: z.string().min(1),
      projectId: z.string().min(1),
      environmentId: z.string().min(1).nullable().default(null),
      parentThreadId: z.string().min(1).nullable().default(null),
    }).strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
  role_tasks_list: { input: z.null(), output: z.object({ tasks: z.array(roleTaskSchema), project: z.string().nullable() }) },
  thread_role: { input: z.object({ threadId: z.string().min(1) }).strict(), output: threadRoleSchema },
});

// ---------------------------------------------------------------------------
// Defaults seeded on first load
// ---------------------------------------------------------------------------

const SEED_ROLES: Array<Omit<z.input<typeof roleInputSchema>, "providerId" | "model" | "reasoningLevel" | "permissionMode">> = [
  {
    slug: "analyst",
    name: "Analyst",
    color: "blue",
    description: "Turns a fuzzy task into a concrete plan with scope, risks and acceptance criteria.",
    instructions: `You are the Analyst. You do not write production code.
- Restate the task in one paragraph. List assumptions explicitly.
- Inspect the repository / documents that the task touches before planning.
- Produce: goal, scope (in/out), step-by-step plan, risks, open questions, acceptance criteria.
- Prefer the smallest change that satisfies the task.
- Output Markdown with those headings. Be concrete: file paths, commands, names.`,
  },
  {
    slug: "developer",
    name: "Developer",
    color: "green",
    description: "Implements the plan: code, migrations, docs. Runs the tests.",
    instructions: `You are the Developer.
- Follow the plan you are given; if it is wrong, say why and propose the minimal deviation.
- Match the surrounding code style. No drive-by refactors.
- Run the relevant tests / type checks and report the exact output.
- Finish with: what changed (files), how it was verified, what is left.`,
  },
  {
    slug: "reviewer",
    name: "Reviewer",
    color: "violet",
    description: "Adversarial code review: correctness, edge cases, regressions.",
    instructions: `You are the Reviewer. Assume the change has bugs; find them.
- Read the diff and the surrounding code, not just the diff.
- For each finding: file:line, severity (blocker / major / minor / nit), what breaks, concrete fix.
- No praise, no style nits unless they change behaviour.
- End with a verdict: APPROVE or REQUEST_CHANGES and the list of blockers.`,
  },
  {
    slug: "qa",
    name: "QA",
    color: "amber",
    description: "Writes and runs tests, reproduces bugs, checks acceptance criteria.",
    instructions: `You are QA.
- Derive test cases from the acceptance criteria and from edge cases the plan missed.
- Write automated tests where the repo has a test setup; otherwise a manual checklist with exact steps.
- Run everything you wrote and report pass/fail with output.
- Report: coverage of criteria, failures found, flaky or blocked checks.`,
  },
  {
    slug: "researcher",
    name: "Researcher",
    color: "teal",
    description: "Collects facts from docs, code and the web; cites sources.",
    instructions: `You are the Researcher.
- Answer the question with evidence: quote sources (URL, file path, command output).
- Separate facts from inference. Flag anything you could not verify.
- Output: summary (5 lines max), findings with sources, recommendation, open questions.`,
  },
  {
    slug: "writer",
    name: "Writer",
    color: "pink",
    description: "Turns results into clear text: docs, posts, summaries in the author's voice.",
    instructions: `You are the Writer.
- Write for the stated audience; if none, assume a busy technical reader.
- Short sentences, concrete examples, no filler. Keep the author's voice when a sample is given.
- Output the final text only, ready to publish, plus a 3-line changelog of what you cut or added.`,
  },
];

const SEED_TEAMS: z.input<typeof teamInputSchema>[] = [
  {
    slug: "feature",
    name: "Feature: plan → build + tests → review",
    description: "Analyst plans, Developer and QA work in parallel, Reviewer verifies.",
    nodes: [
      { id: "plan", roleSlug: "analyst", label: "Plan", prompt: "{task}", inputs: [] },
      { id: "build", roleSlug: "developer", label: "Build", prompt: "Implement this plan.\n\nTask: {task}\n\nPlan:\n{plan}", inputs: ["plan"] },
      { id: "tests", roleSlug: "qa", label: "Tests", prompt: "Write tests for this plan (the Developer is implementing it in parallel; write tests against the planned interfaces).\n\nTask: {task}\n\nPlan:\n{plan}", inputs: ["plan"] },
      { id: "review", roleSlug: "reviewer", label: "Review", prompt: "Review the implementation and tests.\n\nTask: {task}\n\nWork so far:\n{all}", inputs: ["build", "tests"], final: true },
    ],
  },
  {
    slug: "research-brief",
    name: "Research → write-up",
    description: "Two researchers in parallel, then a writer merges into one brief.",
    nodes: [
      { id: "primary", roleSlug: "researcher", label: "Primary sources", prompt: "Research this from primary sources (docs, code, official pages):\n\n{task}", inputs: [] },
      { id: "practice", roleSlug: "researcher", label: "Practitioner sources", prompt: "Research this from practitioner sources (issues, forums, blog posts, comparisons):\n\n{task}", inputs: [] },
      { id: "brief", roleSlug: "writer", label: "Brief", prompt: "Merge these research notes into one brief for the question below. Deduplicate, keep sources.\n\nQuestion: {task}\n\nNotes:\n{inputs}", inputs: ["primary", "practice"], final: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    syncEnabled: { type: "boolean", label: "Sync Claude agents and Tasks presets", description: "Opt in to reading and writing local agent files and Tasks presets.", default: false },
    stepTimeoutMinutes: {
      type: "number",
      label: "Step timeout (minutes)",
      description: "A team-run step whose thread has not gone idle within this time fails.",
      default: 45,
    },
    agentsDir: {
      type: "string",
      label: "Claude agents directory",
      description: "Roles are mirrored as Claude Code subagent files here (one <slug>.md per role) and edits to those files flow back.",
      default: "~/.claude/agents",
    },
    syncIntervalSeconds: {
      type: "number",
      label: "Sync interval (seconds)",
      description: "How often to reconcile roles with the agents directory and Tasks presets. 0 disables the periodic sync (manual `bb role sync` still works).",
      default: 30,
    },
    syncDefaultProvider: { type: "string", label: "Preset default provider", description: "Used for a role that inherits its provider.", default: "claude-code" },
    syncDefaultModel: { type: "string", label: "Preset default model", description: "Used for a role that inherits its model.", default: "claude-opus-5[1m]" },
    syncDefaultReasoning: { type: "string", label: "Preset default reasoning", description: "Used for a role that inherits its reasoning level.", default: "medium" },
    syncDefaultPermission: { type: "string", label: "Preset default permission", description: "Used for a role that inherits its permission mode (accept-edits, auto, full).", default: "accept-edits" },
    tasksProject: {
      type: "string",
      label: "Tasks project for role jobs",
      description: "Prefix or id of the Tasks project where `bb role spawn` files its jobs. Empty = the first Tasks project.",
      default: "",
    },
    bbBinary: { type: "string", label: "bb CLI path", description: "Leave empty to use $BB_CLI or the app bundle. The Tasks plugin is reached through `bb tasks preset`.", default: "" },
  });

  // ------------------------------------------------------------------ storage
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS roles (
       id TEXT PRIMARY KEY,
       slug TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       instructions TEXT NOT NULL,
       provider_id TEXT,
       model TEXT,
       reasoning_level TEXT,
       permission_mode TEXT,
       color TEXT NOT NULL DEFAULT 'gray',
       sort_order INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS teams (
       id TEXT PRIMARY KEY,
       slug TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       stages TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS team_runs (
       id TEXT PRIMARY KEY,
       team_id TEXT NOT NULL,
       team_name TEXT NOT NULL,
       project_id TEXT NOT NULL,
       environment_id TEXT,
       parent_thread_id TEXT,
       task TEXT NOT NULL,
       status TEXT NOT NULL,
       output TEXT,
       error TEXT,
       started_at INTEGER NOT NULL,
       finished_at INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS team_run_steps (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
       stage_index INTEGER NOT NULL,
       stage_title TEXT NOT NULL,
       member_index INTEGER NOT NULL,
       role_slug TEXT NOT NULL,
       role_name TEXT NOT NULL,
       thread_id TEXT,
       status TEXT NOT NULL,
       output TEXT,
       error TEXT,
       started_at INTEGER,
       finished_at INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS team_run_steps_run_idx ON team_run_steps(run_id, stage_index, member_index)`,
    `ALTER TABLE teams ADD COLUMN graph TEXT`,
    `ALTER TABLE team_run_steps ADD COLUMN node_id TEXT NOT NULL DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS sync_state (
       slug TEXT PRIMARY KEY,
       role_hash TEXT,
       file_hash TEXT,
       preset_hash TEXT,
       preset_id TEXT,
       file_keep TEXT,
       synced_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS role_threads (
       thread_id TEXT PRIMARY KEY,
       role_slug TEXT NOT NULL,
       task_key TEXT,
       last_report_hash TEXT,
       created_at INTEGER NOT NULL
     )`,
  ]);
  db.pragma("foreign_keys = ON");

  // Sync scheduling state is declared early: role CRUD below calls
  // scheduleSync() (also during seeding), and syncNow() is hoisted.
  let syncTimer: NodeJS.Timeout | null = null;
  let syncRunning = false;
  let syncPending = false;
  let syncInFlight: Promise<SyncReport> | null = null;
  let lastSync: SyncReport | null = null;
  /** Coalesce bursts of edits into one reconciliation shortly after. */
  function scheduleSync(delayMs = 400): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; void syncNow().catch(() => undefined); }, delayMs);
  }

  const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  // ------------------------------------------------------------------ roles
  interface RoleRow {
    id: string; slug: string; name: string; description: string; instructions: string;
    provider_id: string | null; model: string | null; reasoning_level: string | null;
    permission_mode: string | null; color: string; sort_order: number; created_at: number; updated_at: number;
  }
  const toRole = (r: RoleRow): Role =>
    roleSchema.parse({
      id: r.id, slug: r.slug, name: r.name, description: r.description, instructions: r.instructions,
      providerId: r.provider_id, model: r.model,
      reasoningLevel: r.reasoning_level, permissionMode: r.permission_mode,
      color: (ROLE_COLORS as readonly string[]).includes(r.color) ? r.color : "gray",
      sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
    });

  const roleStmts = {
    list: db.prepare(`SELECT * FROM roles ORDER BY sort_order, created_at`),
    get: db.prepare(`SELECT * FROM roles WHERE id = ?`),
    bySlug: db.prepare(`SELECT * FROM roles WHERE slug = ?`),
    maxSort: db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM roles`),
    insert: db.prepare(`INSERT INTO roles (id, slug, name, description, instructions, provider_id, model, reasoning_level, permission_mode, color, sort_order, created_at, updated_at)
      VALUES (@id, @slug, @name, @description, @instructions, @providerId, @model, @reasoningLevel, @permissionMode, @color, @sortOrder, @now, @now)`),
    update: db.prepare(`UPDATE roles SET slug=@slug, name=@name, description=@description, instructions=@instructions, provider_id=@providerId, model=@model,
      reasoning_level=@reasoningLevel, permission_mode=@permissionMode, color=@color, updated_at=@now WHERE id=@id`),
    setSort: db.prepare(`UPDATE roles SET sort_order = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM roles WHERE id = ?`),
  };
  const listRoles = () => (roleStmts.list.all() as RoleRow[]).map(toRole);
  const getRole = (id: string) => { const r = roleStmts.get.get(id) as RoleRow | undefined; return r ? toRole(r) : null; };
  const roleBySlug = (slug: string) => { const r = roleStmts.bySlug.get(slug) as RoleRow | undefined; return r ? toRole(r) : null; };
  /** Resolve by slug, id, or case-insensitive name. */
  function findRole(ref: string): Role | null {
    return roleBySlug(ref) ?? getRole(ref) ?? listRoles().find((r) => r.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  }
  const publishRoles = () => bb.realtime.publish(ROLES_CHANGED, { at: Date.now() });

  function createRole(input: z.infer<typeof roleInputSchema>): Role {
    if (roleBySlug(input.slug)) throw new Error(`Role slug "${input.slug}" already exists`);
    const id = newId("role");
    const { m } = roleStmts.maxSort.get() as { m: number };
    roleStmts.insert.run({ id, ...input, sortOrder: m + 1, now: Date.now() });
    publishRoles();
    scheduleSync();
    return getRole(id)!;
  }
  function updateRole(id: string, patch: Partial<z.infer<typeof roleInputSchema>>): Role {
    const current = getRole(id);
    if (!current) throw new Error(`No role with id ${id}`);
    const next = { ...current, ...patch };
    if (next.slug !== current.slug && roleBySlug(next.slug)) throw new Error(`Role slug "${next.slug}" already exists`);
    roleStmts.update.run({ ...next, id, now: Date.now() });
    publishRoles();
    scheduleSync();
    return getRole(id)!;
  }
  function deleteRole(id: string): boolean {
    const ok = roleStmts.delete.run(id).changes > 0;
    if (ok) { publishRoles(); scheduleSync(); }
    return ok;
  }
  const reorderRoles = db.transaction((ids: string[]) => {
    const known = listRoles();
    const seen = new Set<string>();
    let order = 0;
    for (const id of ids) if (!seen.has(id) && known.some((r) => r.id === id)) { seen.add(id); roleStmts.setSort.run(order++, id); }
    for (const r of known) if (!seen.has(r.id)) roleStmts.setSort.run(order++, r.id);
  });

  // ------------------------------------------------------------------ teams
  interface TeamRow { id: string; slug: string; name: string; description: string; stages: string; graph: string | null; created_at: number; updated_at: number }
  const toTeam = (t: TeamRow): Team => {
    // Rows written before the DAG model carry only `stages`; convert once.
    const nodes: GraphNode[] = t.graph ? JSON.parse(t.graph) : stagesToNodes(JSON.parse(t.stages));
    return teamSchema.parse({ id: t.id, slug: t.slug, name: t.name, description: t.description, nodes, createdAt: t.created_at, updatedAt: t.updated_at });
  };
  const teamStmts = {
    list: db.prepare(`SELECT * FROM teams ORDER BY created_at`),
    get: db.prepare(`SELECT * FROM teams WHERE id = ?`),
    bySlug: db.prepare(`SELECT * FROM teams WHERE slug = ?`),
    insert: db.prepare(`INSERT INTO teams (id, slug, name, description, stages, graph, created_at, updated_at) VALUES (@id, @slug, @name, @description, '[]', @graph, @now, @now)`),
    update: db.prepare(`UPDATE teams SET slug=@slug, name=@name, description=@description, graph=@graph, updated_at=@now WHERE id=@id`),
    delete: db.prepare(`DELETE FROM teams WHERE id = ?`),
  };
  const listTeams = () => (teamStmts.list.all() as TeamRow[]).map(toTeam);
  const getTeam = (id: string) => { const t = teamStmts.get.get(id) as TeamRow | undefined; return t ? toTeam(t) : null; };
  const teamBySlug = (slug: string) => { const t = teamStmts.bySlug.get(slug) as TeamRow | undefined; return t ? toTeam(t) : null; };
  const findTeam = (ref: string) => teamBySlug(ref) ?? getTeam(ref) ?? listTeams().find((t) => t.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;

  function assertGraph(nodes: GraphNode[]): void {
    validateGraph(nodes);
    for (const n of nodes) if (!roleBySlug(n.roleSlug)) throw new Error(`Node "${n.label}" references unknown role "${n.roleSlug}"`);
  }
  function createTeam(input: z.infer<typeof teamInputSchema>): Team {
    if (teamBySlug(input.slug)) throw new Error(`Team slug "${input.slug}" already exists`);
    assertGraph(input.nodes);
    const id = newId("team");
    teamStmts.insert.run({ id, slug: input.slug, name: input.name, description: input.description, graph: JSON.stringify(input.nodes), now: Date.now() });
    publishRoles();
    return getTeam(id)!;
  }
  function updateTeam(id: string, patch: Partial<z.infer<typeof teamInputSchema>>): Team {
    const current = getTeam(id);
    if (!current) throw new Error(`No team with id ${id}`);
    const next = { ...current, ...patch };
    if (next.slug !== current.slug && teamBySlug(next.slug)) throw new Error(`Team slug "${next.slug}" already exists`);
    assertGraph(next.nodes);
    teamStmts.update.run({ id, slug: next.slug, name: next.name, description: next.description, graph: JSON.stringify(next.nodes), now: Date.now() });
    publishRoles();
    return getTeam(id)!;
  }
  function deleteTeam(id: string): boolean {
    const ok = teamStmts.delete.run(id).changes > 0;
    if (ok) publishRoles();
    return ok;
  }

  // Seed once, on an empty database.
  if (listRoles().length === 0) {
    for (const r of SEED_ROLES) createRole(roleInputSchema.parse(r));
    bb.log.info("seeded default roles");
  }
  if (listTeams().length === 0) {
    try {
      for (const t of SEED_TEAMS) createTeam(teamInputSchema.parse(t));
      bb.log.info("seeded default teams");
    } catch (cause) {
      bb.log.warn(`default teams not seeded: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // ------------------------------------------------------------------ sync (files ↔ roles ↔ Tasks presets)
  interface SyncRow { slug: string; role_hash: string | null; file_hash: string | null; preset_hash: string | null; preset_id: string | null; file_keep: string | null; synced_at: number }
  const syncStmts = {
    all: db.prepare(`SELECT * FROM sync_state ORDER BY slug`),
    put: db.prepare(`INSERT INTO sync_state (slug, role_hash, file_hash, preset_hash, preset_id, file_keep, synced_at)
      VALUES (@slug, @roleHash, @fileHash, @presetHash, @presetId, @fileKeep, @syncedAt)
      ON CONFLICT(slug) DO UPDATE SET role_hash=excluded.role_hash, file_hash=excluded.file_hash, preset_hash=excluded.preset_hash,
        preset_id=excluded.preset_id, file_keep=excluded.file_keep, synced_at=excluded.synced_at`),
    remove: db.prepare(`DELETE FROM sync_state WHERE slug = ?`),
  };
  const syncStore = {
    all: (): SyncState[] => (syncStmts.all.all() as SyncRow[]).map((r) => ({
      slug: r.slug, roleHash: r.role_hash, fileHash: r.file_hash, presetHash: r.preset_hash, presetId: r.preset_id,
      fileKeep: r.file_keep ? JSON.parse(r.file_keep) : null, syncedAt: r.synced_at,
    })),
    put: (s: SyncState) => { syncStmts.put.run({ ...s, fileKeep: s.fileKeep ? JSON.stringify(s.fileKeep) : null }); },
    remove: (slug: string) => { syncStmts.remove.run(slug); },
  };
  const canonInput = (c: Canon) => roleInputSchema.parse({
    slug: c.slug, name: c.name, description: c.description.slice(0, 300), instructions: c.instructions,
    providerId: c.providerId, model: c.model, reasoningLevel: c.reasoningLevel, permissionMode: c.permissionMode, color: c.color,
  });
  const roleSide = {
    list: () => listRoles(),
    create: (c: Canon) => { createRole(canonInput(c)); },
    update: (id: string, c: Canon) => { updateRole(id, canonInput(c)); },
    remove: (id: string) => { deleteRole(id); },
  };

  function syncNow(): Promise<SyncReport> {
    // A caller that arrives mid-run gets the running reconciliation's report
    // and queues one more pass for anything that changed meanwhile.
    if (syncInFlight) { syncPending = true; return syncInFlight; }
    syncInFlight = syncOnce().finally(() => { syncInFlight = null; });
    return syncInFlight;
  }

  async function syncOnce(): Promise<SyncReport> {
    syncRunning = true;
    try {
      const s = await settings.get();
      if (!s.syncEnabled) return { at: Date.now(), actions: [], problems: [], agentsDir: "" };
      const tasks = makeTasksCli(makeBbTasksRunner({ serverUrl: () => bb.server.loopbackBaseUrl, bbBinary: String(s.bbBinary ?? "") }));
      const report = await runSync({
        agentsDir: resolveAgentsDir(String(s.agentsDir ?? "")),
        defaults: {
          providerId: String(s.syncDefaultProvider || "claude-code"),
          model: String(s.syncDefaultModel || "claude-opus-5[1m]"),
          reasoningLevel: String(s.syncDefaultReasoning || "medium"),
          permissionMode: String(s.syncDefaultPermission || "accept-edits"),
        },
        roles: roleSide,
        store: syncStore,
        tasks,
        log: (m) => bb.log.info(`sync ${m}`),
      });
      for (const p of report.problems) bb.log.warn(`sync: ${p}`);
      lastSync = report;
      return report;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`sync failed: ${message}`);
      lastSync = { at: Date.now(), actions: [], problems: [message], agentsDir: "" };
      return lastSync;
    } finally {
      syncRunning = false;
      if (syncPending) { syncPending = false; scheduleSync(200); }
    }
  }

  let agentsWatcher: FSWatcher | null = null;
  bb.background.service("sync", {
    async start(signal) {
      // First reconciliation shortly after load, then periodic polling (the
      // Tasks plugin has no change events we can subscribe to) plus a
      // filesystem watch on the agents directory for quick file edits.
      scheduleSync(1500);
      const armWatcher = async () => {
        agentsWatcher?.close();
        agentsWatcher = null;
        const current = await settings.get();
        if (!current.syncEnabled || signal.aborted) return;
        const dir = resolveAgentsDir(String(current.agentsDir ?? ""));
        try {
          agentsWatcher = fsWatch(dir, { persistent: false }, () => scheduleSync(600));
          agentsWatcher.on("error", (cause) => bb.log.warn(`agents watcher: ${cause.message}`));
        } catch (cause) {
          bb.log.warn(`agents watcher not started: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      };
      // The directory may not exist until the first sync creates it.
      const watcherTimer = setTimeout(() => { void armWatcher(); }, 4000);
      settings.onChange(() => { void armWatcher(); scheduleSync(); });
      let interval: NodeJS.Timeout | null = null;
      const armInterval = async () => {
        if (interval) clearInterval(interval);
        const current = await settings.get();
        const secs = current.syncEnabled ? Math.max(0, Number(current.syncIntervalSeconds) || 0) : 0;
        interval = secs > 0 ? setInterval(() => { void syncNow().catch(() => undefined); }, secs * 1000) : null;
      };
      await armInterval();
      settings.onChange(() => { void armInterval(); });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      clearTimeout(watcherTimer);
      if (interval) clearInterval(interval);
      agentsWatcher?.close();
      agentsWatcher = null;
    },
  });

  // ------------------------------------------------------------------ spawning
  // The role's instructions never travel in the chat: they are injected as
  // hidden dynamic instructions (bb.agents.configure) keyed by the thread's
  // plugin metadata, so the first message is just the task.
  const threadStmts = {
    insert: db.prepare(`INSERT OR REPLACE INTO role_threads (thread_id, role_slug, task_key, last_report_hash, created_at) VALUES (?, ?, ?, NULL, ?)`),
    get: db.prepare(`SELECT * FROM role_threads WHERE thread_id = ?`),
    setReport: db.prepare(`UPDATE role_threads SET last_report_hash = ? WHERE thread_id = ?`),
  };
  interface RoleThreadRow { thread_id: string; role_slug: string; task_key: string | null; last_report_hash: string | null; created_at: number }
  const roleThread = (threadId: string) => threadStmts.get.get(threadId) as RoleThreadRow | undefined;

  async function spawnRole(input: z.infer<typeof spawnInputSchema>): Promise<string> {
    const role = findRole(input.roleSlug);
    if (!role) throw new Error(`No role "${input.roleSlug}". Run "bb role list".`);
    const title = input.title ?? `[${role.name}] ${input.taskKey ? input.taskKey + " · " : ""}${input.prompt.split("\n")[0]!.slice(0, 80)}`;
    const tuple =
      role.providerId && role.model
        ? { providerId: role.providerId, model: role.model, ...(role.reasoningLevel ? { reasoningLevel: role.reasoningLevel } : {}) }
        : {};
    const args = {
      projectId: input.projectId,
      environment: input.environmentId ? { type: "reuse", environmentId: input.environmentId } : { type: "project-default" },
      prompt: input.prompt,
      title,
      ...tuple,
      ...(role.permissionMode ? { permissionMode: role.permissionMode } : {}),
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.hidden ? { visibility: "hidden" } : {}),
      pluginMetadata: { roleId: role.id, roleSlug: role.slug, roleName: role.name, roleColor: role.color, taskKey: input.taskKey },
    } as unknown as Parameters<typeof bb.sdk.threads.spawn>[0];
    const thread = await bb.sdk.threads.spawn(args);
    threadStmts.insert.run(thread.id, role.slug, input.taskKey, Date.now());
    return thread.id;
  }

  const INSTRUCTION_BUDGET = 3900; // bb truncates configure() instructions at 4096 chars
  bb.agents.configure((ctx) => {
    const slug = typeof ctx.pluginMetadata.roleSlug === "string" ? ctx.pluginMetadata.roleSlug : roleThread(ctx.thread.id)?.role_slug;
    const role = slug ? roleBySlug(slug) : null;
    if (!role) return { tools: [], skills: ["agent-roles"] };
    const taskKey = typeof ctx.pluginMetadata.taskKey === "string" ? ctx.pluginMetadata.taskKey : roleThread(ctx.thread.id)?.task_key ?? null;
    const head = [
      `# Your role: ${role.name}`,
      role.description ? role.description : "",
      "",
      `Begin your first reply with this exact line so BB renders your role card: ::agent-role{slug="${role.slug}"}`,
      taskKey ? `You are working on task ${taskKey}. Read it with \`bb tasks show ${taskKey}\`; your final answer is posted there as a comment automatically.` : "",
      "",
    ].join("\n");
    let body = role.instructions;
    if (head.length + body.length > INSTRUCTION_BUDGET) {
      bb.log.warn(`role ${role.slug}: instructions exceed the ${INSTRUCTION_BUDGET}-char budget and were truncated for thread ${ctx.thread.id}`);
      body = body.slice(0, INSTRUCTION_BUDGET - head.length - 20) + "\n[…truncated]";
    }
    return { tools: [], skills: ["agent-roles"], instructions: head + body };
  });

  // ------------------------------------------------------------------ role jobs in Tasks
  const tasksRunner = async () => makeBbTasksRunner({ serverUrl: () => bb.server.loopbackBaseUrl, bbBinary: String((await settings.get()).bbBinary ?? "") });
  const taskOps = async () => makeTaskOps(await tasksRunner());

  async function resolveTasksProject(explicit: string | null): Promise<string> {
    if (explicit) return explicit;
    const configured = String((await settings.get()).tasksProject ?? "").trim();
    if (configured) return configured;
    const projects = await (await taskOps()).projects();
    if (!projects.length) throw new Error("No Tasks project exists yet. Create one in Tasks or run: bb tasks project create");
    return projects[0]!.prefix;
  }

  /** File the request as a Tasks record labelled with the role; no thread yet. */
  async function createRoleTask(roleSlug: string, prompt: string, project: string | null): Promise<{ key: string; title: string }> {
    const role = findRole(roleSlug);
    if (!role) throw new Error(`No role "${roleSlug}". Run "bb role list".`);
    const ops = await taskOps();
    const proj = await resolveTasksProject(project);
    const label = ROLE_LABEL_PREFIX + role.slug;
    await ops.ensureLabel(proj, label);
    const firstLine = prompt.split("\n").find((l) => l.trim())?.trim() ?? prompt;
    const title = `[${role.name}] ${firstLine.slice(0, 100)}`;
    const task = await ops.create({ project: proj, title, description: prompt, labels: [label] });
    return { key: task.key, title: task.title };
  }

  const roleSlugOfTask = (labels: Array<{ name: string }>) =>
    labels.map((l) => l.name).find((n) => n.startsWith(ROLE_LABEL_PREFIX))?.slice(ROLE_LABEL_PREFIX.length) ?? null;

  /** Open a thread for a task's role, attach it and mark the task in progress. */
  async function chatRoleTask(input: { taskKey: string; projectId: string; environmentId: string | null; parentThreadId: string | null }): Promise<string> {
    const ops = await taskOps();
    const detail = await ops.show(input.taskKey);
    const slug = roleSlugOfTask(detail.labels ?? []);
    if (!slug) throw new Error(`Task ${input.taskKey} has no role label (${ROLE_LABEL_PREFIX}<slug>).`);
    const prompt = detail.task.description?.trim() || detail.task.title;
    const threadId = await spawnRole({ roleSlug: slug, prompt, projectId: input.projectId, environmentId: input.environmentId, parentThreadId: input.parentThreadId, hidden: false, taskKey: detail.task.key });
    try { await ops.attach(detail.task.key, threadId); } catch (cause) { bb.log.warn(`attach ${detail.task.key}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (detail.task.status === "backlog" || detail.task.status === "todo") {
      try { await ops.setStatus(detail.task.key, "in_progress"); } catch { /* status is cosmetic */ }
    }
    return threadId;
  }

  async function listRoleTasks(): Promise<{ tasks: RoleTask[]; project: string | null }> {
    const ops = await taskOps();
    let project: string | null = null;
    try { project = await resolveTasksProject(null); } catch { return { tasks: [], project: null }; }
    const labels = new Set(listRoles().map((r) => ROLE_LABEL_PREFIX + r.slug));
    const rows: TaskRecord[] = await ops.list({ project, statuses: ["backlog", "todo", "in_progress", "in_review"], limit: 200 });
    const detailed = await Promise.all(rows.map(async (t) => {
      const d = await ops.show(t.key).catch(() => null);
      const slug = d ? roleSlugOfTask(d.labels ?? []) : null;
      if (!slug || !labels.has(ROLE_LABEL_PREFIX + slug)) return null;
      return roleTaskSchema.parse({
        key: t.key, title: t.title, description: t.description ?? "", status: t.status, priority: t.priority, roleSlug: slug,
        updatedAt: t.updatedAt, threadIds: (d?.taskThreads ?? []).map((x) => x.threadId),
      });
    }));
    return { tasks: detailed.filter((t): t is RoleTask => t !== null), project };
  }

  // When a role thread goes idle, its answer lands on the task as one comment.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const row = roleThread(thread.id);
    if (!row?.task_key || !lastAssistantText?.trim()) return;
    const text = lastAssistantText.replace(/^::agent-role\{[^}]*\}\s*$/m, "").trim();
    if (!text) return;
    const hash = String(text.length) + ":" + text.slice(0, 64);
    if (row.last_report_hash === hash) return;
    try {
      const ops = await taskOps();
      const body = text.length > 6000 ? text.slice(0, 6000) + "\n\n[…truncated; full answer in the thread]" : text;
      await ops.comment(row.task_key, `**${roleBySlug(row.role_slug)?.name ?? row.role_slug}** (thread ${thread.id}):\n\n${body}`);
      threadStmts.setReport.run(hash, thread.id);
    } catch (cause) {
      bb.log.warn(`report to ${row.task_key}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });

  // ------------------------------------------------------------------ team runs
  interface RunRow {
    id: string; team_id: string; team_name: string; project_id: string; environment_id: string | null;
    parent_thread_id: string | null; task: string; status: string; output: string | null; error: string | null;
    started_at: number; finished_at: number | null;
  }
  interface StepRow {
    id: string; run_id: string; node_id: string; stage_index: number; stage_title: string; member_index: number; role_slug: string;
    role_name: string; thread_id: string | null; status: string; output: string | null; error: string | null;
    started_at: number | null; finished_at: number | null;
  }
  const toRun = (r: RunRow): TeamRun =>
    runSchema.parse({
      id: r.id, teamId: r.team_id, teamName: r.team_name, projectId: r.project_id, environmentId: r.environment_id,
      parentThreadId: r.parent_thread_id, task: r.task, status: r.status, output: r.output, error: r.error,
      startedAt: r.started_at, finishedAt: r.finished_at,
    });
  const toStep = (s: StepRow): Step =>
    stepSchema.parse({
      id: s.id, runId: s.run_id, nodeId: s.node_id, stageIndex: s.stage_index, stageTitle: s.stage_title, memberIndex: s.member_index,
      roleSlug: s.role_slug, roleName: s.role_name, threadId: s.thread_id, status: s.status, output: s.output,
      error: s.error, startedAt: s.started_at, finishedAt: s.finished_at,
    });
  const runStmts = {
    list: db.prepare(`SELECT * FROM team_runs ORDER BY started_at DESC LIMIT ?`),
    get: db.prepare(`SELECT * FROM team_runs WHERE id = ?`),
    insert: db.prepare(`INSERT INTO team_runs (id, team_id, team_name, project_id, environment_id, parent_thread_id, task, status, started_at)
      VALUES (@id, @teamId, @teamName, @projectId, @environmentId, @parentThreadId, @task, 'running', @now)`),
    finish: db.prepare(`UPDATE team_runs SET status=@status, output=@output, error=@error, finished_at=@now WHERE id=@id`),
    delete: db.prepare(`DELETE FROM team_runs WHERE id = ?`),
    markInterrupted: db.prepare(`UPDATE team_runs SET status='interrupted', error='bb restarted while the run was in progress', finished_at=? WHERE status='running'`),
    steps: db.prepare(`SELECT * FROM team_run_steps WHERE run_id = ? ORDER BY stage_index, member_index`),
    insertStep: db.prepare(`INSERT INTO team_run_steps (id, run_id, node_id, stage_index, stage_title, member_index, role_slug, role_name, status)
      VALUES (@id, @runId, @nodeId, @stageIndex, @stageTitle, @memberIndex, @roleSlug, @roleName, 'pending')`),
    startStep: db.prepare(`UPDATE team_run_steps SET status='running', thread_id=@threadId, started_at=@now WHERE id=@id`),
    finishStep: db.prepare(`UPDATE team_run_steps SET status=@status, output=@output, error=@error, finished_at=@now WHERE id=@id`),
    cancelPendingSteps: db.prepare(`UPDATE team_run_steps SET status='cancelled', finished_at=? WHERE run_id = ? AND status IN ('pending','running')`),
  };
  const getRun = (id: string): TeamRunWithSteps | null => {
    const r = runStmts.get.get(id) as RunRow | undefined;
    if (!r) return null;
    return { ...toRun(r), steps: (runStmts.steps.all(id) as StepRow[]).map(toStep) };
  };
  const publishRuns = () => bb.realtime.publish(RUNS_CHANGED, { at: Date.now() });

  // Anything still "running" when the factory runs was orphaned by a restart.
  runStmts.markInterrupted.run(Date.now());

  const controllers = new Map<string, AbortController>();

  function fill(template: string, vars: { task: string; inputs: string; all: string; byNode: Map<string, string> }): string {
    return template.replace(/\{([a-z0-9_-]+)\}/gi, (whole, key: string) => {
      if (key === "task") return vars.task;
      if (key === "inputs" || key === "prev") return vars.inputs;
      if (key === "all") return vars.all;
      return vars.byNode.has(key) ? vars.byNode.get(key)! : whole;
    });
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  /** Poll until the thread settles; returns its final output. */
  async function awaitThread(threadId: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    // Give the dispatcher a moment to move the thread out of "pending".
    await sleep(4000, signal);
    while (!signal.aborted) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "idle") {
        const { output } = await bb.sdk.threads.output({ threadId });
        return output ?? "";
      }
      if (thread.status === "error") throw new Error(`Thread ${threadId} ended in error`);
      if (Date.now() > deadline) throw new Error(`Thread ${threadId} did not finish within ${Math.round(timeoutMs / 60000)} min`);
      await sleep(3000, signal);
    }
    throw new Error("cancelled");
  }

  async function executeRun(run: TeamRun, team: Team, hidden: boolean): Promise<void> {
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const { signal } = controller;
    const { stepTimeoutMinutes } = await settings.get();
    const timeoutMs = Math.max(1, Number(stepTimeoutMinutes) || 45) * 60_000;
    const steps = (runStmts.steps.all(run.id) as StepRow[]).map(toStep);
    const stepByNode = new Map(steps.map((s) => [s.nodeId, s] as const));
    const nodeById = new Map(team.nodes.map((n) => [n.id, n] as const));
    const outputs = new Map<string, string>(); // nodeId → raw output
    const promises = new Map<string, Promise<string>>();

    const labelled = (id: string) => {
      const n = nodeById.get(id)!;
      const role = roleBySlug(n.roleSlug);
      return `### ${n.label} (${role?.name ?? n.roleSlug})\n${outputs.get(id) ?? ""}`;
    };
    const runNode = (node: GraphNode): Promise<string> => {
      const existing = promises.get(node.id);
      if (existing) return existing;
      const p = (async () => {
        // Wait for every input first; a failed input rejects here and the
        // step is left pending (cancelled at the end).
        await Promise.all(node.inputs.map((i) => runNode(nodeById.get(i)!)));
        if (signal.aborted) throw new Error("cancelled");
        const step = stepByNode.get(node.id)!;
        const role = roleBySlug(node.roleSlug);
        if (!role) throw new Error(`Role "${node.roleSlug}" was deleted`);
        const done = team.nodes.filter((n) => outputs.has(n.id)).map((n) => n.id);
        const prompt = fill(node.prompt, {
          task: run.task,
          inputs: node.inputs.map(labelled).join("\n\n"),
          all: done.map(labelled).join("\n\n"),
          byNode: new Map(done.map((id) => [id, outputs.get(id)!] as const)),
        });
        const threadId = await spawnRole({
          roleSlug: role.slug, prompt, projectId: run.projectId, environmentId: run.environmentId,
          parentThreadId: run.parentThreadId, hidden, taskKey: null,
          title: `[${role.name}] ${team.name} · ${node.label}`,
        });
        runStmts.startStep.run({ id: step.id, threadId, now: Date.now() });
        publishRuns();
        try {
          const output = await awaitThread(threadId, signal, timeoutMs);
          outputs.set(node.id, output);
          runStmts.finishStep.run({ id: step.id, status: "succeeded", output, error: null, now: Date.now() });
          publishRuns();
          return output;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          runStmts.finishStep.run({ id: step.id, status: message === "cancelled" ? "cancelled" : "failed", output: null, error: message, now: Date.now() });
          publishRuns();
          throw cause;
        }
      })();
      promises.set(node.id, p);
      return p;
    };

    try {
      const settled = await Promise.allSettled(team.nodes.map(runNode));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      const finals = team.nodes.filter((n) => n.final);
      const sinks = finals.length ? finals : team.nodes.filter((n) => !team.nodes.some((m) => m.inputs.includes(n.id)));
      const output = sinks.map((n) => (sinks.length > 1 ? labelled(n.id) : outputs.get(n.id) ?? "")).join("\n\n");
      runStmts.finish.run({ id: run.id, status: "succeeded", output, error: null, now: Date.now() });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = message === "cancelled";
      // Surface the first *real* failure rather than a dependant's "input failed".
      const firstError = steps.map((s) => (runStmts.steps.all(run.id) as StepRow[]).find((r) => r.id === s.id)?.error ?? null).find((e) => e && e !== "cancelled") ?? message;
      runStmts.cancelPendingSteps.run(Date.now(), run.id);
      const partial = [...outputs.keys()].map(labelled).join("\n\n");
      runStmts.finish.run({ id: run.id, status: cancelled ? "cancelled" : "failed", output: partial || null, error: cancelled ? null : firstError, now: Date.now() });
      bb.log.warn(`team run ${run.id} ${cancelled ? "cancelled" : "failed"}: ${firstError}`);
    } finally {
      controllers.delete(run.id);
      publishRuns();
    }
  }

  function startRun(input: z.infer<typeof startRunInputSchema>): TeamRun {
    const team = findTeam(input.teamSlug);
    if (!team) throw new Error(`No team "${input.teamSlug}". Run "bb role teams".`);
    assertGraph(team.nodes);
    const layers = graphLayers(team.nodes);
    const id = newId("trun");
    const now = Date.now();
    db.transaction(() => {
      runStmts.insert.run({ id, teamId: team.id, teamName: team.name, projectId: input.projectId, environmentId: input.environmentId, parentThreadId: input.parentThreadId, task: input.task, now });
      team.nodes.forEach((n, mi) => {
        const role = roleBySlug(n.roleSlug)!;
        runStmts.insertStep.run({ id: newId("step"), runId: id, nodeId: n.id, stageIndex: layers.get(n.id) ?? 0, stageTitle: n.label, memberIndex: mi, roleSlug: role.slug, roleName: role.name });
      });
    })();
    const run = toRun(runStmts.get.get(id) as RunRow);
    publishRuns();
    void executeRun(run, team, input.hidden);
    return run;
  }

  function cancelRun(id: string): void {
    const run = getRun(id);
    if (!run) throw new Error(`No run with id ${id}`);
    const c = controllers.get(id);
    if (c) c.abort();
    else if (run.status === "running") {
      runStmts.cancelPendingSteps.run(Date.now(), id);
      runStmts.finish.run({ id, status: "cancelled", output: null, error: null, now: Date.now() });
      publishRuns();
    }
  }

  /** Resolve project + environment for a CLI call from the invoking thread. */
  async function contextFor(ctx: { threadId?: string; projectId?: string }, explicitProject?: string) {
    let projectId = explicitProject ?? ctx.projectId ?? null;
    let environmentId: string | null = null;
    if (ctx.threadId) {
      try {
        const t = await bb.sdk.threads.get({ threadId: ctx.threadId });
        projectId ??= t.projectId;
        environmentId = t.environmentId ?? null;
      } catch { /* thread gone — fall through */ }
    }
    if (!projectId) throw new Error("No project: pass --project <id> or run inside a thread.");
    return { projectId, environmentId };
  }

  // ------------------------------------------------------------------ RPC
  bb.rpc.register(rpcContract, {
    roles_list: () => ({ roles: listRoles() }),
    roles_create: (input) => createRole(input),
    roles_update: ({ id, ...patch }) => updateRole(id, patch),
    roles_delete: ({ id }) => { if (!deleteRole(id)) throw new Error(`No role with id ${id}`); return { ok: true as const }; },
    roles_reorder: ({ ids }) => { reorderRoles(ids); publishRoles(); return { ok: true as const }; },
    role_spawn: async (input) => ({ threadId: await spawnRole(input) }),
    teams_list: () => ({ teams: listTeams() }),
    teams_create: (input) => createTeam(input),
    teams_update: ({ id, ...patch }) => updateTeam(id, patch),
    teams_delete: ({ id }) => { if (!deleteTeam(id)) throw new Error(`No team with id ${id}`); return { ok: true as const }; },
    runs_list: (input) => ({ runs: (runStmts.list.all(input?.limit ?? 50) as RunRow[]).map(toRun) }),
    runs_get: ({ id }) => { const r = getRun(id); if (!r) throw new Error(`No run with id ${id}`); return r; },
    runs_start: (input) => startRun(input),
    runs_cancel: ({ id }) => { cancelRun(id); return { ok: true as const }; },
    runs_delete: ({ id }) => {
      if (controllers.has(id)) throw new Error("Cancel the run before deleting it");
      if (runStmts.delete.run(id).changes === 0) throw new Error(`No run with id ${id}`);
      publishRuns();
      return { ok: true as const };
    },
    context_projects: async () => {
      const result = await bb.sdk.projects.list();
      const list = (Array.isArray(result) ? result : (result as { projects?: unknown[] }).projects ?? []) as Array<{ id: string; name: string }>;
      return { projects: list.map((p) => ({ id: p.id, name: p.name })) };
    },
    role_task_create: ({ roleSlug, prompt, project }) => createRoleTask(roleSlug, prompt, project),
    role_chat: async (input) => ({ threadId: await chatRoleTask(input) }),
    role_tasks_list: () => listRoleTasks(),
    thread_role: async ({ threadId }) => {
      let slug: string | null = roleThread(threadId)?.role_slug ?? null;
      let taskKey: string | null = roleThread(threadId)?.task_key ?? null;
      if (!slug) {
        try {
          const meta = (await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown>;
          if (typeof meta.roleSlug === "string") slug = meta.roleSlug;
          if (typeof meta.taskKey === "string") taskKey = meta.taskKey;
        } catch { /* not a role thread */ }
      }
      const role = slug ? roleBySlug(slug) : null;
      if (!role) return null;
      return { roleSlug: role.slug, roleName: role.name, description: role.description, color: role.color, instructions: role.instructions, taskKey };
    },
    model_defaults: async () => {
      const s = await settings.get();
      return {
        providerId: String(s.syncDefaultProvider || "claude-code"),
        model: String(s.syncDefaultModel || "claude-opus-5[1m]"),
        reasoningLevel: (REASONING_LEVELS as readonly string[]).includes(String(s.syncDefaultReasoning))
          ? (String(s.syncDefaultReasoning) as (typeof REASONING_LEVELS)[number])
          : "medium",
      };
    },
    sync_run: () => syncNow(),
    sync_status: async () => {
      const current = await settings.get();
      return {
        enabled: current.syncEnabled,
        agentsDir: current.syncEnabled ? resolveAgentsDir(String(current.agentsDir ?? "")) : "",
        running: syncRunning,
        last: lastSync,
        entries: syncStore.all().map((s) => ({ slug: s.slug, presetId: s.presetId, syncedAt: s.syncedAt })),
      };
    },
  });

  // ------------------------------------------------------------------ agent instructions
  bb.agents.contributeInstructions(() => {
    const roles = listRoles();
    if (roles.length === 0) return null;
    return `Specialist agent roles (${roles.map((r) => r.slug).join(", ")}): \`bb role spawn <role> --prompt "..."\` files a Tasks job for that role (no thread yet; the user can open a chat from it), \`bb role spawn ... --thread --parent-self\` starts the specialist thread right away, \`bb role chat <TASK-KEY> --parent-self\` opens a thread for an existing job, and \`bb role run <team> --task "..."\` runs a multi-agent team. Role instructions are injected into the specialist thread automatically. See the agent-roles skill.`;
  });

  // ------------------------------------------------------------------ CLI
  const usage = [
    "Usage:",
    "  bb role list [--json]                         roles",
    "  bb role show <role>                           full instructions",
    "  bb role spawn <role> --prompt <text> [--tasks-project <prefix>]   file a Tasks job for the role (no thread)",
    "  bb role spawn <role> --prompt <text> --thread [--parent-self | --parent <threadId>] [--project <id>] [--title <t>] [--hidden] [--wait]",
    "  bb role chat <TASK-KEY> [--parent-self] [--project <id>] [--wait]  open a thread for a role job",
    "  bb role tasks [--json]                        open role jobs",
    "  bb role teams [--json]                        team templates",
    "  bb role run <team> --task <text> [--parent-self] [--project <id>] [--hidden] [--wait]",
    "  bb role runs [--json]                         recent team runs",
    "  bb role status <runId> [--json]               run progress, per-step threads and outputs",
    "  bb role cancel <runId>",
    "  bb role sync [--json]                         reconcile roles ↔ ~/.claude/agents ↔ Tasks presets now",
    "  bb role sync --status [--json]                last sync report",
    "",
    "Create and edit roles/teams on the Agent roles page (sidebar).",
  ].join("\n");

  function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith("--")) {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); i++; }
        else flags.set(key, true);
      } else positional.push(a);
    }
    return { positional, flags };
  }
  const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

  bb.cli.register({
    name: "role",
    summary: "Specialist agent roles and multi-agent teams: spawn a role thread or run a team on a task",
    commands: [
      { name: "list", summary: "List roles", usage: "bb role list [--json]" },
      { name: "show", summary: "Show a role's instructions", usage: "bb role show <role>" },
      { name: "spawn", summary: "File a Tasks job for a role (or --thread to start a thread now)", usage: "bb role spawn <role> --prompt <text> [--thread] [--parent-self] [--project <id>] [--title <t>] [--hidden] [--wait]" },
      { name: "chat", summary: "Open a thread for a role job", usage: "bb role chat <TASK-KEY> [--parent-self] [--project <id>] [--wait]" },
      { name: "tasks", summary: "List open role jobs", usage: "bb role tasks [--json]" },
      { name: "teams", summary: "List team templates", usage: "bb role teams [--json]" },
      { name: "run", summary: "Run a team on a task", usage: "bb role run <team> --task <text> [--parent-self] [--project <id>] [--hidden] [--wait]" },
      { name: "runs", summary: "List recent team runs", usage: "bb role runs [--json]" },
      { name: "status", summary: "Show a team run", usage: "bb role status <runId> [--json]" },
      { name: "cancel", summary: "Cancel a team run", usage: "bb role cancel <runId>" },
      { name: "sync", summary: "Reconcile roles with Claude agent files and Tasks presets", usage: "bb role sync [--status] [--json]" },
    ],
    async run(argv, ctx) {
      const { positional, flags } = parseFlags(argv);
      const signal = ctx.signal ?? new AbortController().signal;
      const json = flags.has("json");
      const [command, ...rest] = positional;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const parentFor = () => (flags.has("parent-self") ? ctx.threadId ?? null : str(flags.get("parent")) ?? null);
      const formatRun = (r: TeamRunWithSteps) => {
        const lines = [`${r.id}  ${r.status.padEnd(11)} ${r.teamName}`, `  task: ${r.task.split("\n")[0]!.slice(0, 120)}`];
        if (r.error) lines.push(`  error: ${r.error}`);
        for (const s of r.steps) {
          lines.push(`  ${s.status.padEnd(9)} ${s.stageTitle.padEnd(22)} ${s.roleName.padEnd(12)} ${s.threadId ?? ""}${s.error ? "  " + s.error : ""}`);
        }
        if (r.output && r.status !== "running") lines.push("", "output:", r.output);
        return lines.join("\n");
      };
      try {
        switch (command) {
          case undefined: case "help": case "--help":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const roles = listRoles();
            return reply(roles, roles.map((r) => `${r.slug.padEnd(12)} ${r.name.padEnd(14)} ${r.providerId && r.model ? `${r.providerId}/${r.model}` : "(inherit model)"}  ${r.description}`).join("\n") || "No roles.");
          }
          case "show": {
            const role = rest[0] ? findRole(rest[0]) : null;
            if (!role) return fail(`No role "${rest[0] ?? ""}".`);
            return reply(role, `${role.name} (${role.slug})\n${role.description}\nmodel: ${role.providerId ?? "inherit"}/${role.model ?? "inherit"} reasoning: ${role.reasoningLevel ?? "inherit"} permissions: ${role.permissionMode ?? "inherit"}\n\n${role.instructions}`);
          }
          case "spawn": {
            const role = rest[0] ? findRole(rest[0]) : null;
            if (!role) return fail(`No role "${rest[0] ?? ""}". Run "bb role list".`);
            const prompt = str(flags.get("prompt"));
            if (!prompt) return fail("--prompt is required");
            if (!flags.has("thread")) {
              const task = await createRoleTask(role.slug, prompt, str(flags.get("tasks-project")) ?? null);
              return reply(task, `Filed ${task.key} for ${role.name}. Open a chat with: bb role chat ${task.key}\n::task{key="${task.key}"}`);
            }
            const { projectId, environmentId } = await contextFor(ctx, str(flags.get("project")));
            const threadId = await spawnRole({ roleSlug: role.slug, prompt, projectId, environmentId, parentThreadId: parentFor(), title: str(flags.get("title")), hidden: flags.has("hidden"), taskKey: str(flags.get("task")) ?? null });
            if (flags.has("wait")) {
              const { stepTimeoutMinutes } = await settings.get();
              const output = await awaitThread(threadId, signal, Math.max(1, Number(stepTimeoutMinutes) || 45) * 60_000);
              return reply({ threadId, output }, output);
            }
            return reply({ threadId }, `Spawned ${role.name} thread ${threadId}. Wait with: bb thread wait ${threadId}; read with: bb thread output ${threadId}`);
          }
          case "chat": {
            if (!rest[0]) return fail("Task key is required, e.g. bb role chat TEST-3");
            const { projectId, environmentId } = await contextFor(ctx, str(flags.get("project")));
            const threadId = await chatRoleTask({ taskKey: rest[0], projectId, environmentId, parentThreadId: parentFor() });
            if (flags.has("wait")) {
              const { stepTimeoutMinutes } = await settings.get();
              const output = await awaitThread(threadId, signal, Math.max(1, Number(stepTimeoutMinutes) || 45) * 60_000);
              return reply({ threadId, output }, output);
            }
            return reply({ threadId }, `Opened thread ${threadId} for ${rest[0]}. Wait with: bb thread wait ${threadId}`);
          }
          case "tasks": {
            const { tasks, project } = await listRoleTasks();
            return reply(tasks, tasks.map((t) => `${t.key.padEnd(10)} ${t.status.padEnd(12)} ${(t.roleSlug ?? "").padEnd(12)} ${t.threadIds.length ? t.threadIds.length + " thread(s)  " : ""}${t.title}`).join("\n") || `No open role jobs${project ? ` in ${project}` : ""}.`);
          }
          case "teams": {
            const teams = listTeams();
            return reply(teams, teams.map((t) => `${t.slug.padEnd(16)} ${t.name}\n    ${t.nodes.map((n) => `${n.id} (${n.roleSlug})${n.inputs.length ? " ← " + n.inputs.join(", ") : ""}${n.final ? " [final]" : ""}`).join("\n    ")}`).join("\n") || "No teams.");
          }
          case "run": {
            const team = rest[0] ? findTeam(rest[0]) : null;
            if (!team) return fail(`No team "${rest[0] ?? ""}". Run "bb role teams".`);
            const task = str(flags.get("task"));
            if (!task) return fail("--task is required");
            const { projectId, environmentId } = await contextFor(ctx, str(flags.get("project")));
            const run = startRun({ teamSlug: team.slug, task, projectId, environmentId, parentThreadId: parentFor(), hidden: flags.has("hidden") });
            if (flags.has("wait")) {
              while (!signal.aborted) {
                const current = getRun(run.id)!;
                if (current.status !== "running") return { exitCode: current.status === "succeeded" ? 0 : 1, stdout: json ? JSON.stringify(current, null, 2) : formatRun(current) };
                await sleep(3000, signal);
              }
              return fail("interrupted");
            }
            return reply(run, `Started team run ${run.id} (${team.name}). Check: bb role status ${run.id}`);
          }
          case "runs": {
            const runs = (runStmts.list.all(30) as RunRow[]).map(toRun);
            return reply(runs, runs.map((r) => `${r.id}  ${r.status.padEnd(11)} ${new Date(r.startedAt).toISOString()}  ${r.teamName}  — ${r.task.split("\n")[0]!.slice(0, 80)}`).join("\n") || "No runs.");
          }
          case "status": {
            const run = rest[0] ? getRun(rest[0]) : null;
            if (!run) return fail(`No run "${rest[0] ?? ""}".`);
            return reply(run, formatRun(run));
          }
          case "cancel": {
            if (!rest[0]) break;
            cancelRun(rest[0]);
            return reply({ cancelled: rest[0] }, `Cancelled ${rest[0]}`);
          }
          case "sync": {
            const report = flags.has("status") ? lastSync : await syncNow();
            if (!report) return reply(null, "No sync has run yet.");
            const lines = [`agents dir: ${report.agentsDir}`, `at: ${new Date(report.at).toISOString()}`];
            lines.push(report.actions.length ? "actions:" : "actions: none (everything in sync)");
            for (const a of report.actions) lines.push(`  ${a.slug.padEnd(14)} ${a.action}${a.detail ? " — " + a.detail : ""}`);
            if (report.problems.length) { lines.push("problems:"); for (const p of report.problems) lines.push(`  ${p}`); }
            return { exitCode: report.problems.length ? 1 : 0, stdout: json ? JSON.stringify(report, null, 2) : lines.join("\n") };
          }
        }
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    if (syncTimer) clearTimeout(syncTimer);
    agentsWatcher?.close();
    for (const c of controllers.values()) c.abort();
    controllers.clear();
    bb.log.info("disposed");
  });
}
