// bb-plugin-agent-roles — frontend entry.
//
// One nav panel with three views: Roles (specialist profiles), Teams (staged
// multi-agent templates) and Runs (live progress of team runs with each
// worker's transcript inline). Routes:
//   /plugins/agent-roles/roles            roles
//   /plugins/agent-roles/roles/teams      teams (visual DAG constructor)
//   /plugins/agent-roles/roles/runs       runs
//   /plugins/agent-roles/roles/runs/<id>  one run
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_PermissionModePicker as PermissionModePicker,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Role, RoleTask, Team, TeamRun, TeamRunWithSteps, rpcContract } from "./server";
import { GraphCanvas } from "./graph-canvas";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ROLES_CHANGED, ROLE_COLORS, RUNS_CHANGED, SLUG_RE, REASONING_LEVELS, graphLayers, validateGraph, connectGraph, type RoleColor } from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PANEL_PATH = "roles";

const COLOR_DOT: Record<RoleColor, string> = {
  gray: "bg-muted-foreground/60",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

type Tab = "roles" | "teams" | "runs";

function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  // RPC validation errors carry per-field issues; surface them, not just
  // "input validation failed".
  const issues = (cause as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((i) => `${(i.path ?? []).join(".") || "input"}: ${i.message ?? "invalid"}`).join("; ");
  }
  return cause.message;
}

// Slugs must be ASCII (they are CLI arguments), so Cyrillic names are
// transliterated rather than dropped — "Аналитик" → "analitik".
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", є: "e", і: "i", ї: "i", ґ: "g",
};
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[а-яёєіїґ]/g, (ch) => CYRILLIC[ch] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Why a form cannot be saved yet; empty when it can. */
function ValidationHints({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="text-xs text-destructive">
      {problems.map((p) => <li key={p}>• {p}</li>)}
    </ul>
  );
}

function relative(ts: number | null, now: number): string {
  if (ts === null) return "—";
  const abs = Math.abs(now - ts);
  const v = abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return `${v} ago`;
}

function statusTone(status: string): string {
  switch (status) {
    case "succeeded": return "text-emerald-600 dark:text-emerald-400";
    case "failed": case "interrupted": return "text-destructive";
    case "running": return "text-primary";
    default: return "text-muted-foreground";
  }
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "succeeded" ? "bg-emerald-500"
      : status === "failed" || status === "interrupted" ? "bg-destructive"
        : status === "running" ? "bg-primary animate-pulse"
          : "bg-muted-foreground/40";
  return <span className={cn("size-2 shrink-0 rounded-full", cls)} aria-hidden />;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

/** Inline editor: no box at all — generous vertical rhythm and a thin rule before the actions carry the structure. */
const editorCls = "flex flex-col gap-6 py-1";
/** Editor footer (validation + Cancel/Save) sits under a hairline. */
const editorFooterCls = "flex items-center gap-2 border-t border-border/60 pt-5";
/** Soft-filled fields: tint instead of an outline; the outline returns on focus. */
const softFieldCls = "border-transparent bg-muted/50 focus-visible:border-input focus-visible:bg-transparent";
/** Small inline action form (spawn / run) under a list row. */
const inlineFormCls = "mt-4 flex flex-col gap-3 rounded-xl border border-border/60 p-4";
/** Row actions stay hidden until hover/focus; always visible on touch devices. */
const rowActionsCls = "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

const textareaCls =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2.5 font-mono text-xs leading-5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const selectCls = "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground";

function useAsync() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await work();
      if (success) toast.success(success);
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

type RoleDraft = Omit<Role, "id" | "sortOrder" | "createdAt" | "updatedAt">;
const emptyRole = (): RoleDraft => ({
  slug: "", name: "", description: "", instructions: "",
  providerId: null, model: null, reasoningLevel: null, permissionMode: null, color: "gray",
});
/** Only the editable fields: an existing Role carries id/sortOrder/timestamps the strict RPC schema rejects. */
const roleDraft = (r: RoleDraft): RoleDraft => ({
  slug: r.slug.trim(), name: r.name.trim(), description: r.description, instructions: r.instructions,
  providerId: r.providerId, model: r.model, reasoningLevel: r.reasoningLevel, permissionMode: r.permissionMode, color: r.color,
});

function RoleCheckbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input {...props} type="checkbox" className={cn("peer sr-only", className)} />
      <span aria-hidden="true" className="pointer-events-none size-4 rounded border border-input bg-background shadow-sm transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-50" />
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100 peer-disabled:opacity-50">
        <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

type ExecModel = { id: string; displayName?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> };
/** Minimal provider/model/reasoning picker against bb's execution-options API.
 *  Works around experimental_ProviderModelPicker not emitting onChange in plugin panels (SDK 0.6.37). */
function SimpleModelPicker({ value, onChange }: {
  value: { providerId: string; model: string; reasoningLevel: string };
  onChange: (v: { providerId: string; model: string; reasoningLevel: string }) => void;
}) {
  const [providers, setProviders] = useState<Array<{ id: string; displayName: string }>>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [models, setModels] = useState<ExecModel[]>([]);
  const [modelsProviderId, setModelsProviderId] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [query, setQuery] = useState(value.model);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const controller = new AbortController();
    setProvidersLoading(true);
    fetch("/api/v1/system/execution-options", { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { providers?: Array<{ id: string; displayName: string }> }) => {
        if (!controller.signal.aborted) {
          setProviders(d.providers ?? []);
          setProviderError(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setProviderError("Could not load providers.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setProvidersLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const providerId = value.providerId;
    const controller = new AbortController();
    setModels([]);
    setModelsProviderId(null);
    setModelsLoading(Boolean(providerId));
    setModelError(null);
    setOpen(false);
    setActiveIndex(-1);
    if (!providerId) return () => controller.abort();
    fetch(`/api/v1/system/execution-options?providerId=${encodeURIComponent(providerId)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { models?: ExecModel[] }) => {
        if (!controller.signal.aborted) {
          setModels(d.models ?? []);
          setModelsProviderId(providerId);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setModelError("Could not load models for this provider.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [value.providerId]);

  useEffect(() => {
    setQuery(value.model);
    setActiveIndex(-1);
  }, [value.model]);

  const searchableModels = useMemo(
    () => models.map((model) => ({ model, search: `${model.id}\n${model.displayName ?? ""}`.toLowerCase() })),
    [models],
  );
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (modelsProviderId === value.providerId
      ? searchableModels.filter(({ search }) => !needle || search.includes(needle)).map(({ model }) => model)
      : []),
    [modelsProviderId, value.providerId, searchableModels, needle],
  );
  const filtered = matches.slice(0, 50);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const commit = (model: ExecModel) => {
    setQuery(model.id);
    setOpen(false);
    setActiveIndex(-1);
    if (model.id !== value.model) onChange({ ...value, model: model.id });
  };
  const inputCls = "h-[1.75rem] w-56 rounded-md border border-input bg-transparent px-2 text-xs text-foreground";
  const sel = { minHeight: "1.75rem", padding: "0 0.5rem", border: "1px solid var(--border, #ccc)", borderRadius: "0.375rem", background: "transparent", color: "inherit", fontSize: "0.8rem", maxWidth: "16rem" } as const;
  const current = modelsProviderId === value.providerId ? models.find((m) => m.id === value.model) : undefined;
  const efforts = (current?.supportedReasoningEfforts ?? [{ reasoningEffort: "medium" }]).map((e) => e.reasoningEffort).filter((e) => (REASONING_LEVELS as readonly string[]).includes(e));
  const status = modelsLoading ? "Loading models…" : `${matches.length} of ${models.length} models${matches.length > filtered.length ? " · refine search for more" : ""}${value.model ? ` · selected: ${value.model}` : ""}`;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
      <select style={sel} value={value.providerId} onChange={(e) => onChange({ providerId: e.target.value, model: "", reasoningLevel: value.reasoningLevel })}>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        {!providers.some((p) => p.id === value.providerId) ? <option value={value.providerId}>{value.providerId}</option> : null}
      </select>
      <span className="relative flex flex-col gap-0.5">
        <input
          className={inputCls}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          placeholder="Search models…"
          value={query}
          title={value.model}
          onFocus={(e) => { e.currentTarget.select(); setOpen(true); setActiveIndex(-1); }}
          onBlur={() => { setOpen(false); setActiveIndex(-1); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.max(index - 1, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (activeIndex >= 0 && filtered[activeIndex]) commit(filtered[activeIndex]);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
        />
        {open ? (
          <ul id={listboxId} role="listbox" className="absolute bottom-[calc(100%+0.125rem)] z-50 max-h-48 w-80 overflow-y-auto rounded-md border border-input bg-popover py-1 text-xs text-popover-foreground shadow-md">
            {filtered.map((model, index) => (
              <li
                key={model.id}
                id={`${listboxId}-option-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                role="option"
                aria-selected={index === activeIndex}
                className={cn("cursor-pointer px-2 py-1.5", index === activeIndex && "bg-accent text-accent-foreground")}
                onMouseDown={(e) => { e.preventDefault(); commit(model); }}
              >
                <span className="block truncate">{model.displayName ?? model.id}</span>
                {model.displayName ? <span className="block truncate text-[0.65rem] text-muted-foreground">{model.id}</span> : null}
              </li>
            ))}
            {!modelsLoading && filtered.length === 0 ? <li className="px-2 py-1.5 text-muted-foreground">No matching models.</li> : null}
          </ul>
        ) : null}
      </span>
      <select style={sel} value={value.reasoningLevel} onChange={(e) => onChange({ ...value, reasoningLevel: e.target.value })}>
        {(efforts.length ? efforts : ["medium"]).map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      {providersLoading ? <span className="text-xs text-muted-foreground">Loading providers…</span> : null}
      </span>
      <span className="break-all text-[0.65rem] text-muted-foreground">{status}</span>
      {providerError ? <span className="text-xs text-destructive">{providerError}</span> : null}
      {modelError ? <span className="text-xs text-destructive">{modelError}</span> : null}
    </span>
  );
}

type ModelDefaults = { providerId: string; model: string; reasoningLevel: string };
const FALLBACK_DEFAULTS: ModelDefaults = { providerId: "claude-code", model: "claude-opus-5[1m]", reasoningLevel: "medium" };
function RoleEditor({ initial, onSave, onCancel, busy }: { initial: RoleDraft; onSave: (draft: RoleDraft) => void; onCancel: () => void; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [d, setD] = useState<RoleDraft>(initial);
  const [slugTouched, setSlugTouched] = useState(initial.slug !== "");
  const [defaults, setDefaults] = useState<ModelDefaults>(FALLBACK_DEFAULTS);
  useEffect(() => {
    rpc.call("model_defaults").then(setDefaults).catch(() => undefined);
  }, [rpc]);
  const inherit = d.providerId === null || d.model === null;
  const set = <K extends keyof RoleDraft>(key: K, value: RoleDraft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const problems = [
    ...(d.name.trim() === "" ? ["Name is required."] : []),
    ...(SLUG_RE.test(d.slug) ? [] : ["Slug must be Latin lowercase letters, digits and dashes (1–40 chars)."]),
    ...(d.instructions.trim() === "" ? ["Instructions are required."] : []),
  ];
  const valid = problems.length === 0;
  return (
    <form
      className={editorCls}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        onSave(d.providerId && d.model ? d : { ...d, providerId: null, model: null, reasoningLevel: null });
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name">
          <Input className={softFieldCls} value={d.name} autoFocus onChange={(e) => { set("name", e.target.value); if (!slugTouched) set("slug", slugify(e.target.value)); }} />
        </Field>
        <Field label="Slug" hint="Used in bb role spawn <slug>">
          <Input value={d.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} className={cn(softFieldCls, "font-mono", !SLUG_RE.test(d.slug) && d.slug !== "" && "border-destructive")} />
        </Field>
      </div>
      <Field label="Description" hint="One line; shown in lists and to agents.">
        <Input className={softFieldCls} value={d.description} onChange={(e) => set("description", e.target.value)} maxLength={300} />
      </Field>
      <Field label="Instructions" hint="Prepended to every task this role receives.">
        <textarea className={cn(textareaCls, softFieldCls, "p-4 leading-6")} rows={8} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
        <Field label="Model">
          <div className="flex items-start gap-2">
            <label className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm">
              <RoleCheckbox disabled={busy} checked={inherit} onChange={(e) => {
                if (e.target.checked) {
                  set("providerId", null);
                  set("model", null);
                  set("reasoningLevel", null);
                } else {
                  set("providerId", defaults.providerId);
                  set("model", defaults.model);
                  set("reasoningLevel", defaults.reasoningLevel as RoleDraft["reasoningLevel"]);
                }
              }} />
              inherit from parent
            </label>
            {!inherit ? (
              <SimpleModelPicker
                value={{ providerId: d.providerId!, model: d.model!, reasoningLevel: d.reasoningLevel ?? "medium" }}
                onChange={(v) => { set("providerId", v.providerId); set("model", v.model); set("reasoningLevel", v.reasoningLevel as RoleDraft["reasoningLevel"]); }}
              />
            ) : null}
          </div>
        </Field>
        <Field label="Permissions">
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <RoleCheckbox disabled={busy} checked={d.permissionMode === null} onChange={(e) => set("permissionMode", e.target.checked ? null : "auto")} />
              inherit
            </label>
            {d.permissionMode !== null ? (
              <PermissionModePicker providerId={d.providerId ?? "claude-code"} value={d.permissionMode} onChange={(v) => set("permissionMode", v)} />
            ) : null}
          </div>
        </Field>
        <Field label="Color">
          <div className="flex items-center gap-1" role="radiogroup">
            {ROLE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} onClick={() => set("color", c)}
                className={cn("size-4 rounded-full ring-offset-background", COLOR_DOT[c], d.color === c && "ring-2 ring-foreground ring-offset-2")} />
            ))}
          </div>
        </Field>
      </div>
      <div className={editorFooterCls}>
        <ValidationHints problems={problems} />
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={!valid || busy}>Save role</Button>
      </div>
    </form>
  );
}

function SpawnBox({ role, onClose, onFiled }: { role: Role; onClose: () => void; onFiled: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const ctx = useBbContext();
  const { busy, run } = useAsync();
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(ctx.projectId ?? "");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    rpc.call("context_projects").then((r) => { setProjects(r.projects); setProjectId((p) => p || r.projects[0]?.id || ""); }).catch(() => undefined);
  }, [rpc]);
  const fileJob = () => run(async () => {
    const task = await rpc.call("role_task_create", { roleSlug: role.slug, prompt: prompt.trim(), project: null });
    toast.success(`Filed ${task.key} for ${role.name}`);
    onFiled();
    onClose();
  });
  const chatNow = () => run(async () => {
    const { threadId } = await rpc.call("role_spawn", { roleSlug: role.slug, prompt: prompt.trim(), projectId, environmentId: null, parentThreadId: ctx.threadId, hidden: false, taskKey: null });
    onClose();
    navigate.toThread(threadId);
  });
  return (
    <form className={inlineFormCls} onSubmit={(e) => { e.preventDefault(); void fileJob(); }}>
      <textarea className={textareaCls} rows={3} placeholder={`Task for ${role.name}…`} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || prompt.trim() === "" || !projectId} onClick={() => void chatNow()}>
          <Icon name="MessageSquare" className="size-4" /> Chat now
        </Button>
        <Button type="submit" size="sm" disabled={busy || prompt.trim() === ""}>
          <Icon name="Plus" className="size-4" /> Create job
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">A job is a Tasks record for this role — no thread until you open a chat from it.</p>
    </form>
  );
}

/** The role card shown in thread headers and via `::agent-role{slug="…"}` in messages. */
function RoleCard({ role, taskKey, compact }: { role: Pick<Role, "name" | "slug" | "description" | "color"> & { instructions?: string }; taskKey?: string | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("inline-flex max-w-full flex-col rounded-lg border border-border/70 bg-muted/30", compact ? "px-2 py-1" : "px-3 py-2")}>
      <button type="button" className="flex items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Agent role ${role.name}`}>
        <span className={cn("size-2.5 shrink-0 rounded-full", COLOR_DOT[role.color])} />
        <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{role.name}</span>
        <code className="text-[11px] text-muted-foreground/70">{role.slug}</code>
        {taskKey ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{taskKey}</span> : null}
      </button>
      {open ? (
        <div className="mt-2 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
          {role.description ? <p>{role.description}</p> : null}
          {role.instructions ? <pre className="mt-2 whitespace-pre-wrap font-sans text-[11px]">{role.instructions}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoleDirective({ attributes }: { attributes: Readonly<Record<string, string>> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [role, setRole] = useState<Role | null | undefined>(undefined);
  const slug = attributes.slug ?? "";
  useEffect(() => {
    rpc.call("roles_list").then((r) => setRole(r.roles.find((x) => x.slug === slug) ?? null)).catch(() => setRole(null));
  }, [rpc, slug]);
  if (role === undefined) return <span className="text-xs text-muted-foreground">…</span>;
  if (role === null) return <span className="text-xs text-muted-foreground">agent role “{slug}”</span>;
  return <RoleCard role={role} taskKey={attributes.task ?? null} />;
}

function ThreadRoleBadge({ threadId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof rpc.call<"thread_role">>> | undefined>(undefined);
  useEffect(() => {
    rpc.call("thread_role", { threadId }).then(setInfo).catch(() => setInfo(null));
  }, [rpc, threadId]);
  if (!info) return null;
  return <RoleCard role={{ name: info.roleName, slug: info.roleSlug, description: info.description, color: info.color, instructions: info.instructions }} taskKey={info.taskKey} compact={isCompactViewport} />;
}

function RoleJobs({ roles, refreshKey }: { roles: Role[]; refreshKey: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const ctx = useBbContext();
  const { busy, run } = useAsync();
  const [tasks, setTasks] = useState<RoleTask[] | null>(null);
  const refetch = useCallback(() => { rpc.call("role_tasks_list").then((r) => setTasks(r.tasks)).catch(() => setTasks([])); }, [rpc]);
  useEffect(refetch, [refetch, refreshKey]);
  if (!tasks || tasks.length === 0) return null;
  const roleOf = (slug: string | null) => roles.find((r) => r.slug === slug);
  const chat = (t: RoleTask) => run(async () => {
    const projectId = ctx.projectId ?? "";
    if (!projectId) throw new Error("Open a project first");
    const { threadId } = await rpc.call("role_chat", { taskKey: t.key, projectId, environmentId: null, parentThreadId: ctx.threadId });
    refetch();
    navigate.toThread(threadId);
  });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Jobs</h3>
        <span className="text-xs text-muted-foreground">Tasks filed for a role · open a chat to start the agent</span>
      </div>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {tasks.map((t) => {
          const role = roleOf(t.roleSlug);
          return (
            <li key={t.key} className="flex items-center gap-3 px-3 py-2">
              <span className={cn("size-2.5 shrink-0 rounded-full", COLOR_DOT[role?.color ?? "gray"])} />
              <code className="shrink-0 text-xs text-muted-foreground">{t.key}</code>
              <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t.status.replace("_", " ")}</span>
              {t.threadIds.length ? (
                <Button variant="ghost" size="sm" onClick={() => navigate.toThread(t.threadIds[t.threadIds.length - 1]!)}>
                  <Icon name="MessageSquare" className="size-4" /> Open thread
                </Button>
              ) : null}
              <Button variant="outline" size="sm" disabled={busy || !role} onClick={() => void chat(t)}>
                <Icon name="Play" className="size-4" /> Chat with {role?.name ?? "agent"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface SyncStatus {
  enabled: boolean;
  agentsDir: string;
  running: boolean;
  last: { at: number; agentsDir: string; actions: Array<{ slug: string; action: string; detail?: string }>; problems: string[] } | null;
  entries: Array<{ slug: string; presetId: string | null; syncedAt: number }>;
}

function SyncBar({ status, busy, onSync }: { status: SyncStatus | null; busy: boolean; onSync: () => void }) {
  if (!status) return null;
  if (!status.enabled) return <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">File and Tasks preset synchronization is off. Enable it in plugin settings when you need it.</div>;
  const last = status.last;
  const when = last ? new Date(last.at).toLocaleTimeString() : "never";
  const summary = last
    ? last.problems.length
      ? `${last.problems.length} problem${last.problems.length === 1 ? "" : "s"}`
      : last.actions.length
        ? `${last.actions.length} change${last.actions.length === 1 ? "" : "s"}`
        : "in sync"
    : "not run yet";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <span>
        Mirrored to <code>{status.agentsDir}</code> and Tasks presets · last sync {when} · {summary}
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy || status.running} onClick={onSync}>
        <Icon name="RotateCcw" className={cn("size-3.5", status.running && "animate-spin")} /> Sync now
      </Button>
      {last?.problems.length ? (
        <ul className="basis-full list-disc pl-5 text-destructive">
          {last.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function RolesView() {
  const rpc = useRpc<typeof rpcContract>();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [jobsKey, setJobsKey] = useState(0);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [spawning, setSpawning] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const refetch = useCallback(() => {
    rpc.call("roles_list").then((r) => setRoles(r.roles)).catch((c) => toast.error(errorMessage(c)));
    rpc.call("sync_status").then((st) => setSync(st as SyncStatus)).catch(() => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ROLES_CHANGED, refetch);
  const syncNow = () => run(async () => {
    const report = await rpc.call("sync_run");
    refetch();
    if (report.problems.length) throw new Error(report.problems[0]);
  }, "Synced");

  const save = (id: string | "new", draft: RoleDraft) =>
    run(async () => {
      const body = roleDraft(draft);
      if (id === "new") await rpc.call("roles_create", body);
      else await rpc.call("roles_update", { id, ...body });
      setEditing(null);
      refetch();
    }, "Saved");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <p className="text-sm leading-relaxed text-muted-foreground">Specialist profiles. Agents use them with <code>bb role spawn &lt;slug&gt;</code>.</p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing("new")} disabled={editing !== null}>
          <Icon name="Plus" className="size-4" /> New role
        </Button>
      </div>
      <SyncBar status={sync} busy={busy} onSync={() => void syncNow()} />
      <RoleJobs roles={roles ?? []} refreshKey={jobsKey} />
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent className="flex max-h-[92dvh] w-[96vw] max-w-3xl flex-col overflow-y-auto" hideCloseButton={busy} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => {
          if (document.activeElement?.matches('input[role="combobox"][aria-expanded="true"]')) e.preventDefault();
        }}>
          <DialogTitle>{editing === "new" ? "New agent" : "Edit agent"}</DialogTitle>
          <DialogDescription>Instructions, model, and permissions for this agent.</DialogDescription>
          {editing !== null && (editing === "new" || roles?.some((x) => x.id === editing)) ? (
            <RoleEditor key={editing} initial={editing === "new" ? emptyRole() : roles!.find((x) => x.id === editing)!} busy={busy} onCancel={() => setEditing(null)} onSave={(d) => void save(editing, d)} />
          ) : null}
        </DialogContent>
      </Dialog>
      {roles === null ? <EmptyState>Loading…</EmptyState> : roles.length === 0 ? <EmptyState>No roles yet.</EmptyState> : (
        <ul className="divide-y divide-border/60">
          {roles.map((r) => (
            <li key={r.id} className="group py-5 first:pt-0">
              <>
                  <div className="flex items-start gap-3">
                    <span className={cn("mt-[7px] size-2.5 shrink-0 rounded-full", COLOR_DOT[r.color])} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2.5">
                        <span className="text-[15px] font-medium">{r.name}</span>
                        <code className="text-xs text-muted-foreground/70">{r.slug}</code>
                      </div>
                      {r.description ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.description}</p> : null}
                      <p className="mt-1.5 text-xs text-muted-foreground/70">
                        {r.providerId && r.model ? `${r.providerId} · ${r.model}${r.reasoningLevel ? ` · ${r.reasoningLevel}` : ""}` : "inherits model"}
                        {r.permissionMode ? ` · ${r.permissionMode}` : ""}
                        {sync?.entries.some((e) => e.slug === r.slug) ? ` · ${r.slug}.md` : ""}
                        {sync?.entries.find((e) => e.slug === r.slug)?.presetId ? ` · preset "${r.name}"` : ""}
                      </p>
                    </div>
                    <div className={rowActionsCls}>
                      <Button variant="ghost" size="sm" onClick={() => setSpawning(spawning === r.id ? null : r.id)}><Icon name="Play" className="size-4" /> Spawn</Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Edit role" onClick={() => setEditing(r.id)}><Icon name="Edit" className="size-4" /></Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Delete role" disabled={busy}
                        onClick={() => { if (window.confirm(`Delete role "${r.name}"? Teams referencing it will fail to run.`)) void run(() => rpc.call("roles_delete", { id: r.id }).then(refetch), "Deleted"); }}>
                        <Icon name="Trash2" className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {spawning === r.id ? <SpawnBox role={r} onClose={() => setSpawning(null)} onFiled={() => setJobsKey((k) => k + 1)} /> : null}
              </>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

type TeamDraft = Pick<Team, "slug" | "name" | "description" | "nodes">;
type Node = Team["nodes"][number];

function uniqueId(base: string, taken: Set<string>): string {
  const root = (slugify(base).replace(/-/g, "_") || "step").slice(0, 24);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}_${i}`)) return `${root}_${i}`;
}

const emptyTeam = (firstRole: string): TeamDraft => ({
  slug: "", name: "", description: "",
  nodes: [{ id: "step_1", roleSlug: firstRole, label: "Step 1", prompt: "{task}", inputs: [], final: false }],
});

/**
 * Emit the same DAG as a builtin BB workflow script, so a team can also run
 * under `bb workflows run` (durable, resumable) instead of this plugin's
 * scheduler. Nodes become `agent()` calls; independent nodes of one layer run
 * inside `parallel()`.
 */
function toWorkflowScript(team: TeamDraft, roles: Role[]): string {
  const layers = graphLayers(team.nodes);
  const byLayer = new Map<number, Node[]>();
  for (const n of team.nodes) { const d = layers.get(n.id) ?? 0; (byLayer.get(d) ?? byLayer.set(d, []).get(d)!).push(n); }
  const role = (slug: string) => roles.find((r) => r.slug === slug);
  const js = (v: string) => JSON.stringify(v);
  const v = (id: string) => `out_${id.replace(/[^a-z0-9_]/gi, "_")}`;
  const promptExpr = (n: Node) => {
    const r = role(n.roleSlug);
    const head = `# Role: ${r?.name ?? n.roleSlug}\n${r?.instructions ?? ""}\n\n# Task\n`;
    // Split the template on placeholders and rebuild as a JS concatenation.
    const parts = n.prompt.split(/(\{[a-z0-9_-]+\})/i).filter(Boolean).map((part) => {
      const m = /^\{([a-z0-9_-]+)\}$/i.exec(part);
      if (!m) return js(part);
      const key = m[1]!;
      if (key === "task") return "args.task";
      if (key === "inputs" || key === "prev") return `[${n.inputs.map((i) => `${js(`### ${i}\n`)} + ${v(i)}`).join(", ")}].join("\n\n")`;
      if (key === "all") return `[${team.nodes.filter((o) => (layers.get(o.id) ?? 0) < (layers.get(n.id) ?? 0)).map((o) => `${js(`### ${o.id}\n`)} + ${v(o.id)}`).join(", ")}].join("\n\n")`;
      if (team.nodes.some((o) => o.id === key)) return v(key);
      return js(part);
    });
    return [js(head), ...parts].join(" + ");
  };
  const lines = [
    "export const meta = {",
    `  name: ${js(team.slug || "team")},`,
    `  description: ${js(team.description || team.name)},`,
    `  inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },`,
    `  phases: [${[...byLayer.keys()].sort((a, b) => a - b).map((d) => `{ title: ${js(`Stage ${d + 1}`)} }`).join(", ")}],`,
    "};",
  ];
  for (const d of [...byLayer.keys()].sort((a, b) => a - b)) {
    const ns = byLayer.get(d)!;
    lines.push(`phase(${js(`Stage ${d + 1}`)});`);
    if (ns.length === 1) {
      const n = ns[0]!;
      lines.push(`const ${v(n.id)} = await agent(${promptExpr(n)}, { label: ${js(n.label)} });`);
    } else {
      lines.push(`const [${ns.map((n) => v(n.id)).join(", ")}] = await parallel([`);
      for (const n of ns) lines.push(`  () => agent(${promptExpr(n)}, { label: ${js(n.label)} }),`);
      lines.push("]);");
    }
  }
  const finals = team.nodes.filter((n) => n.final);
  const sinks = finals.length ? finals : team.nodes.filter((n) => !team.nodes.some((m) => m.inputs.includes(n.id)));
  lines.push(`return ${sinks.length === 1 ? v(sinks[0]!.id) : `{ ${sinks.map((n) => `${JSON.stringify(n.id)}: ${v(n.id)}`).join(", ")} }`};`);
  return lines.join("\n");
}

function NodeEditor({ node, nodes, roles, onChange, onClose }: { node: Node; nodes: Node[]; roles: Role[]; onChange: (patch: Partial<Node>) => void; onClose: () => void }) {
  const others = nodes.filter((n) => n.id !== node.id);
  return (
    <div className="mt-1 rounded-xl border border-border/60 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Node</span>
        <code className="text-xs text-muted-foreground">{node.id}</code>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Done</Button>
      </div>
      <div className="grid gap-4">
        <Field label="Label"><Input className={softFieldCls} value={node.label} onChange={(e) => onChange({ label: e.target.value })} /></Field>
        <Field label="Role">
          <select className={cn(selectCls, softFieldCls, "w-full")} value={node.roleSlug} onChange={(e) => onChange({ roleSlug: e.target.value })}>
            {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Prompt" hint={`Placeholders: {task}, {inputs} (all inputs, labelled), {all} (everything finished so far)${others.length ? `, ${others.map((o) => `{${o.id}}`).join(" ")}` : ""}`}>
          <textarea className={cn(textareaCls, softFieldCls)} rows={5} value={node.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-6">
        <div>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Inputs (runs after)</span>
          {others.length === 0 ? <span className="text-xs text-muted-foreground">No other nodes yet.</span> : (
            <div className="flex flex-wrap gap-2">
              {others.map((o) => (
                <label key={o.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                  <input type="checkbox" checked={node.inputs.includes(o.id)}
                    onChange={(e) => onChange({ inputs: e.target.checked ? [...node.inputs, o.id] : node.inputs.filter((i) => i !== o.id) })} />
                  {o.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <label className="inline-flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={node.final} onChange={(e) => onChange({ final: e.target.checked })} />
          <Icon name="Star" className="size-3.5 text-amber-500" /> part of final output
        </label>
      </div>
    </div>
  );
}

function TeamEditor({ initial, roles, busy, onSave, onCancel }: { initial: TeamDraft; roles: Role[]; busy: boolean; onSave: (d: TeamDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState<TeamDraft>(initial);
  const [slugTouched, setSlugTouched] = useState(initial.slug !== "");
  const [selected, setSelected] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  const roleOf = (slug: string) => roles.find((r) => r.slug === slug);
  const setNodes = (fn: (nodes: Node[]) => Node[]) => {
    try {
      const next = fn(d.nodes);
      validateGraph(next);
      if (next.length > 40) throw new Error("Maximum 40 steps per workflow.");
      if (next.some((n) => n.inputs.length > 16)) throw new Error("Maximum 16 inputs per step.");
      setD((p) => ({ ...p, nodes: next }));
      return true;
    } catch (cause) { toast.error(errorMessage(cause)); return false; }
  };
  const graphError = useMemo(() => { try { validateGraph(d.nodes); return null; } catch (c) { return errorMessage(c); } }, [d.nodes]);
  const problems = [
    ...(d.name.trim() === "" ? ["Name is required."] : []),
    ...(SLUG_RE.test(d.slug) ? [] : ["Slug must be Latin lowercase letters, digits and dashes (1–40 chars)."]),
    ...(d.nodes.length === 0 ? ["Add at least one node."] : []),
    ...(graphError ? [graphError] : []),
    ...d.nodes.filter((n) => !n.label.trim() || !n.prompt.trim()).map((n) => `Node "${n.label || n.id}" needs a label and a prompt.`),
  ];
  const valid = problems.length === 0;

  const addNode = (inputs: string[], roleSlug = roles[0]?.slug ?? "") => {
    if (d.nodes.length >= 40) { toast.error("Maximum 40 steps per workflow."); return; }
    const taken = new Set(d.nodes.map((n) => n.id));
    const label = `Step ${d.nodes.length + 1}`;
    const id = uniqueId(label, taken);
    setNodes((ns) => [...ns, { id, roleSlug, label, prompt: inputs.length ? "{task}\n\n{inputs}" : "{task}", inputs, final: false }]);
    setSelected(id);
  };
  const edit = {
    onAddRoot: (roleSlug?: string) => addNode([], roleSlug),
    onMove: (id: string, position: { x: number; y: number }) => setNodes((ns) => ns.map((n) => n.id === id ? { ...n, position } : n)),
    onArrange: () => setNodes((ns) => ns.map(({ position, ...n }) => n)),
    onDuplicate: (id: string) => {
      const source = d.nodes.find((n) => n.id === id);
      if (!source || d.nodes.length >= 40) return;
      const copyId = uniqueId(source.id, new Set(d.nodes.map((n) => n.id)));
      setNodes((ns) => [...ns, { ...source, id: copyId, label: `${source.label.slice(0, 73)} copy`, inputs: [...source.inputs], final: false, ...(source.position ? { position: { x: source.position.x, y: Math.min(10000, source.position.y + 170) } } : {}) }]);
      setSelected(copyId);
    },
    onAddAfter: (src: string) => addNode([src]),
    onConnect: (source: string, target: string, previous?: { source: string; target: string }) =>
      setNodes((ns) => connectGraph(ns, { source, target }, previous)),
    onToggleEdge: (src: string, dst: string) => setNodes((ns) => ns.map((n) => {
      if (n.id !== dst) return n;
      return { ...n, inputs: n.inputs.includes(src) ? n.inputs.filter((i) => i !== src) : [...n.inputs, src] };
    })),
    onDelete: (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: n.inputs.filter((i) => i !== id) })));
      setSelected((s) => (s === id ? null : s));
    },
  };
  const selectedNode = d.nodes.find((n) => n.id === selected) ?? null;
  const script = useMemo(() => { if (!showScript || graphError) return ""; try { return toWorkflowScript(d, roles); } catch (c) { return `// ${errorMessage(c)}`; } }, [showScript, d, roles, graphError]);

  return (
    <form className="flex min-h-0 flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) onSave(d); }}>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name"><Input className={softFieldCls} value={d.name} autoFocus onChange={(e) => { setD((p) => ({ ...p, name: e.target.value })); if (!slugTouched) setD((p) => ({ ...p, slug: slugify(e.target.value) })); }} /></Field>
        <Field label="Slug" hint="bb role run <slug>"><Input className={cn(softFieldCls, "font-mono")} value={d.slug} onChange={(e) => { setSlugTouched(true); setD((p) => ({ ...p, slug: e.target.value })); }} /></Field>
      </div>
      <Field label="Description"><Input className={softFieldCls} value={d.description} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} maxLength={300} /></Field>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <GraphCanvas
        roles={roles}
        nodes={d.nodes}
        selectedId={selected}
        onSelect={setSelected}
        edit={edit}
        meta={(n) => ({ dot: COLOR_DOT[roleOf(n.roleSlug)?.color ?? "gray"], subtitle: roleOf(n.roleSlug)?.name ?? n.roleSlug })}
      />
      {selectedNode ? (
        <NodeEditor node={selectedNode} nodes={d.nodes} roles={roles} onClose={() => setSelected(null)}
          onChange={(patch) => setNodes((ns) => ns.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n)))} />
      ) : <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">Select a step to edit its agent, prompt and inputs.</div>}
      </div>
      <div className={cn(editorFooterCls, "sticky bottom-0 z-10 flex-wrap bg-background pb-2")}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowScript((v) => !v)} disabled={graphError !== null}>
          <Icon name="Code" className="size-4" /> {showScript ? "Hide" : "Show"} as bb workflow script
        </Button>
        <ValidationHints problems={problems} />
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={!valid || busy}>Save team</Button>
      </div>
      {showScript && script ? (
        <div className="relative">
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-snug">{script}</pre>
          <Button type="button" variant="outline" size="sm" className="absolute right-2 top-2"
            onClick={() => { void navigator.clipboard.writeText(script).then(() => toast.success("Copied — save as .bb/workflows/<name>.js and run with bb workflows run")); }}>
            <Icon name="Copy" className="size-3.5" /> Copy
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function RunBox({ team, onStarted, onClose }: { team: Team; onStarted: (run: TeamRun) => void; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const ctx = useBbContext();
  const { busy, run } = useAsync();
  const [task, setTask] = useState("");
  const [hidden, setHidden] = useState(false);
  const [projectId, setProjectId] = useState(ctx.projectId ?? "");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    rpc.call("context_projects").then((r) => { setProjects(r.projects); setProjectId((p) => p || r.projects[0]?.id || ""); }).catch(() => undefined);
  }, [rpc]);
  return (
    <form className={inlineFormCls}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await rpc.call("runs_start", { teamSlug: team.slug, task: task.trim(), projectId, environmentId: null, parentThreadId: ctx.threadId, hidden });
          onStarted(r);
        }, "Team run started");
      }}>
      <textarea className={textareaCls} rows={3} placeholder="Task…" value={task} onChange={(e) => setTask(e.target.value)} autoFocus />
      <div className="flex flex-wrap items-center gap-3">
        <select className={selectCls} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden worker threads</label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || task.trim() === "" || !projectId}><Icon name="Play" className="size-4" /> Run team</Button>
      </div>
    </form>
  );
}

function TeamPreview({ team, roleName }: { team: Team; roleName: (slug: string) => string }) {
  const columns = useMemo(() => {
    try {
      const depth = graphLayers(team.nodes);
      const cols: Node[][] = [];
      for (const n of team.nodes) (cols[depth.get(n.id) ?? 0] ??= []).push(n);
      return cols;
    } catch { return [team.nodes]; }
  }, [team]);
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/80">
      {columns.map((col, i) => (
        <li key={i} className="flex items-center gap-1.5">
          {i > 0 ? <Icon name="ArrowRight" className="size-3 opacity-60" /> : null}
          <span className="rounded-md bg-muted/60 px-1.5 py-0.5">{col.map((n) => `${n.label} (${roleName(n.roleSlug)})`).join(" ∥ ")}</span>
        </li>
      ))}
    </ol>
  );
}

function TeamsView({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const refetch = useCallback(() => {
    Promise.all([rpc.call("teams_list"), rpc.call("roles_list")]).then(([t, r]) => { setTeams(t.teams); setRoles(r.roles); }).catch((c) => toast.error(errorMessage(c)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ROLES_CHANGED, refetch);
  const save = (id: string | "new", d: TeamDraft) =>
    run(async () => { if (id === "new") await rpc.call("teams_create", d); else await rpc.call("teams_update", { id, ...d }); setEditing(null); refetch(); }, "Saved");
  const roleName = (slug: string) => roles.find((r) => r.slug === slug)?.name ?? slug;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <p className="text-sm leading-relaxed text-muted-foreground">Pipelines of roles. Each node is one agent thread; arrows carry outputs into the next prompt, and nodes without pending inputs run in parallel. Agents: <code>bb role run &lt;slug&gt; --task …</code></p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing("new")} disabled={editing !== null || roles.length === 0}><Icon name="Plus" className="size-4" /> New team</Button>
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent className="flex h-[96dvh] max-h-[96dvh] w-[98vw] max-w-none flex-col overflow-y-auto" hideCloseButton={busy} onInteractOutside={(e) => e.preventDefault()}>
          <DialogTitle>{editing === "new" ? "New workflow" : "Edit workflow"}</DialogTitle>
          <DialogDescription>Add steps, connect outputs to inputs, and configure each agent on the canvas.</DialogDescription>
          {editing !== null && (editing === "new" || teams?.some((x) => x.id === editing)) ? (
            <TeamEditor key={editing} initial={editing === "new" ? emptyTeam(roles[0]?.slug ?? "") : teams!.find((x) => x.id === editing)!} roles={roles} busy={busy} onCancel={() => setEditing(null)} onSave={(d) => void save(editing, d)} />
          ) : null}
        </DialogContent>
      </Dialog>
      {teams === null ? <EmptyState>Loading…</EmptyState> : teams.length === 0 ? <EmptyState>No teams yet.</EmptyState> : (
        <ul className="divide-y divide-border/60">
          {teams.map((t) => (
            <li key={t.id} className="group py-5 first:pt-0">
              <>
                  <div className="flex items-start gap-3">
                    <Icon name="Layers" className="mt-1 size-4 shrink-0 text-muted-foreground/70" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2.5">
                        <span className="text-[15px] font-medium">{t.name}</span>
                        <code className="text-xs text-muted-foreground/70">{t.slug}</code>
                      </div>
                      {t.description ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.description}</p> : null}
                      <TeamPreview team={t} roleName={roleName} />
                    </div>
                    <div className={rowActionsCls}>
                      <Button variant="ghost" size="sm" onClick={() => setRunning(running === t.id ? null : t.id)}><Icon name="Play" className="size-4" /> Run</Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Edit team" onClick={() => setEditing(t.id)}><Icon name="Edit" className="size-4" /></Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Delete team" disabled={busy}
                        onClick={() => { if (window.confirm(`Delete team "${t.name}"?`)) void run(() => rpc.call("teams_delete", { id: t.id }).then(refetch), "Deleted"); }}>
                        <Icon name="Trash2" className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {running === t.id ? <RunBox team={t} onClose={() => setRunning(null)} onStarted={(r) => { setRunning(null); onOpenRun(r.id); }} /> : null}
              </>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunsView({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAsync();
  const refetch = useCallback(() => { rpc.call("runs_list", { limit: 100 }).then((r) => setRuns(r.runs)).catch((c) => toast.error(errorMessage(c))); }, [rpc]);
  useEffect(() => { refetch(); const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, [refetch]);
  useRealtime(RUNS_CHANGED, refetch);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm leading-relaxed text-muted-foreground">Team runs. Click one for per-step threads and outputs.</p>
      {runs === null ? <EmptyState>Loading…</EmptyState> : runs.length === 0 ? <EmptyState>No runs yet. Start one from the Teams tab.</EmptyState> : (
        <ul className="divide-y divide-border/60">
          {runs.map((r) => (
            <li key={r.id} className="group flex items-center gap-3 py-3 text-sm first:pt-0">
              <StatusDot status={r.status} />
              <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen(r.id)}>
                <span className="font-medium">{r.teamName}</span>
                <span className="ml-2 text-muted-foreground">{r.task.split("\n")[0]!.slice(0, 100)}</span>
              </button>
              <span className={cn("w-20 shrink-0 text-xs", statusTone(r.status))}>{r.status}</span>
              <span className="w-16 shrink-0 text-xs text-muted-foreground/70">{relative(r.startedAt, now)}</span>
              {r.status === "running" ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => rpc.call("runs_cancel", { id: r.id }), "Cancelled")}>Cancel</Button>
              ) : (
                <Button variant="ghost" size="icon" className={cn("size-8 text-muted-foreground hover:text-destructive", rowActionsCls)} aria-label="Delete run" disabled={busy} onClick={() => void run(() => rpc.call("runs_delete", { id: r.id }).then(refetch))}><Icon name="Trash2" className="size-4" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [run, setRun] = useState<TeamRunWithSteps | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, run: act } = useAsync();
  const refetch = useCallback(() => {
    rpc.call("runs_get", { id }).then((r) => {
      setRun(r); setError(null);
      rpc.call("teams_list").then((t) => setTeam(t.teams.find((x) => x.id === r.teamId) ?? null)).catch(() => undefined);
    }).catch((c) => setError(errorMessage(c)));
  }, [rpc, id]);
  useEffect(() => { refetch(); const t = setInterval(refetch, 10_000); return () => clearInterval(t); }, [refetch]);
  useRealtime(RUNS_CHANGED, refetch);

  // Reconstruct the graph from the run's steps (the team may have changed
  // since), falling back to the team definition for edges.
  const nodes = useMemo<Node[]>(() => {
    if (!run) return [];
    const teamNodes = new Map((team?.nodes ?? []).map((n) => [n.id, n] as const));
    return run.steps.map((s) => {
      const t = teamNodes.get(s.nodeId);
      return { id: s.nodeId || s.id, roleSlug: s.roleSlug, label: s.stageTitle, prompt: t?.prompt ?? "", inputs: (t?.inputs ?? []).filter((i) => run.steps.some((x) => x.nodeId === i)), final: t?.final ?? false };
    });
  }, [run, team]);
  const stepByNode = useMemo(() => new Map((run?.steps ?? []).map((s) => [s.nodeId || s.id, s] as const)), [run]);
  const selectedStep = selected ? stepByNode.get(selected) ?? null : null;

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"><Icon name="ChevronLeft" className="size-4" /> Runs</button>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {run === null ? <EmptyState>Loading…</EmptyState> : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 text-lg font-semibold"><StatusDot status={run.status} /> {run.teamName} <span className={cn("text-sm font-normal", statusTone(run.status))}>{run.status}</span></h1>
              <pre className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{run.task}</pre>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{new Date(run.startedAt).toLocaleString()}</span>
                {run.parentThreadId ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate.toThread(run.parentThreadId!)}>parent {run.parentThreadId}</button> : null}
                <code>{run.id}</code>
              </div>
            </div>
            {run.status === "running" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => rpc.call("runs_cancel", { id: run.id }), "Cancelled")}>Cancel run</Button> : null}
          </div>
          {run.error ? <pre className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{run.error}</pre> : null}
          <GraphCanvas
            nodes={nodes}
            selectedId={selected}
            onSelect={setSelected}
            meta={(n) => {
              const s = stepByNode.get(n.id);
              return { subtitle: `${s?.roleName ?? n.roleSlug} · ${s?.status ?? "pending"}`, status: s?.status ?? "pending", badge: s?.status === "running" ? <Icon name="Loading" className="size-3.5 animate-spin text-primary" /> : null };
            }}
          />
          <p className="text-xs text-muted-foreground">Click a node for its thread and output.</p>
          {selectedStep ? (
            <div className="rounded-lg border border-primary/40">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
                <StatusDot status={selectedStep.status} />
                <span className="font-medium">{selectedStep.stageTitle}</span>
                <span className="text-muted-foreground">{selectedStep.roleName}</span>
                <span className={cn("text-xs", statusTone(selectedStep.status))}>{selectedStep.status}</span>
                {selectedStep.threadId ? <code className="text-xs text-muted-foreground">{selectedStep.threadId}</code> : null}
                <span className="flex-1" />
                {selectedStep.threadId ? <Button variant="ghost" size="sm" onClick={() => navigate.toThread(selectedStep.threadId!)}>Open thread <Icon name="ArrowUpRight" className="size-3.5" /></Button> : null}
              </div>
              {selectedStep.error ? <pre className="m-3 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{selectedStep.error}</pre> : null}
              {selectedStep.threadId ? (
                <div className="max-h-[32rem] overflow-auto"><ThreadChat threadId={selectedStep.threadId} variant="timeline" layout="document" /></div>
              ) : <p className="px-3 py-3 text-xs text-muted-foreground">Not started — waiting for its inputs.</p>}
            </div>
          ) : null}
          {run.output && run.status !== "running" ? (
            <section>
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Final output</h2>
              <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs">{run.output}</pre>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function RootPage() {
  return <div className="h-full min-h-0 flex-1 overflow-y-auto"><div className="mx-auto box-border w-full max-w-3xl px-5 pb-16 pt-6 md:px-8 md:pt-8"><RolesView /></div></div>;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "agent-role", component: RoleDirective });
  app.slots.experimental_threadHeaderAction({ id: "role-badge", title: "Agent role", component: ThreadRoleBadge });
  app.slots.navPanel({
    id: "roles",
    title: "Agent roles",
    icon: "UserRound",
    path: PANEL_PATH,
    component: RootPage,
  });
});
