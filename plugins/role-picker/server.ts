import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { presets } from './presets.ts';
// iconDataUrl comes from Agent Roles; older versions omit it, and anything but a PNG data URL becomes null.
const icon = z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/).max(100_000).nullable().optional().catch(null);
const role = z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string(), instructions: z.string(), color: z.string(), iconDataUrl: icon });
const rolesOutput = z.object({ roles: z.array(role) });
const metadata = z.object({ roleId: z.string(), roleSlug: z.string(), roleName: z.string(), roleColor: z.string() });
export type Role = z.infer<typeof role>;
export const rpcContract = defineRpcContract({
  roles: { input: z.null(), output: rolesOutput },
  current: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ roleSlug: z.string().nullable() }) },
  prepare: {
    input: z.object({ roleSlug: z.string().min(1).max(100).nullable(), threadId: z.string().min(1).nullable() }).strict(),
    output: z.object({ metadata, context: z.string() }),
  },
});
export default function (bb: BbPluginApi) {
  const companionAvailable = async () => (await bb.sdk.plugins.list()).plugins.some(p => p.id === 'agent-roles' && p.enabled && p.status === 'running');
  const shared = () => bb.sdk.plugins.callRpc({ pluginId: 'agent-roles', method: 'roles_list', input: null, outputSchema: rolesOutput });
  const list = async () => {
    let imported: Role[] = [];
    try { if (await companionAvailable()) imported = (await shared()).roles.map(r => ({ ...r, slug: 'shared:'+r.slug, name: r.name+' · Agent Roles' })); } catch { bb.log.warn('Agent Roles is unavailable; local presets remain usable.'); }
    return { roles: [...presets, ...imported] };
  };
  bb.rpc.register(rpcContract, {
    roles: list,
    current: async ({ threadId }) => {
      const own = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId });
      if (typeof own.roleSlug === 'string') return { roleSlug: own.roleSlug || null };
      if (!await companionAvailable()) return { roleSlug: null };
      const meta = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: 'agent-roles' });
      if (typeof meta.roleSlug === 'string') return { roleSlug: meta.roleSlug ? `shared:${meta.roleSlug}` : null };
      const legacy = await bb.sdk.plugins.callRpc({ pluginId: 'agent-roles', method: 'thread_role', input: { threadId }, outputSchema: z.object({ roleSlug: z.string() }).nullable() });
      return { roleSlug: legacy ? `shared:${legacy.roleSlug}` : null };
    },
    prepare: async ({ roleSlug, threadId }) => {
      const local = presets.find(r => r.slug === roleSlug);
      const available = await companionAvailable();
      const sharedSlug = roleSlug?.startsWith('shared:') ? roleSlug.slice(7) : null;
      const selected = local ?? (sharedSlug && available ? (await shared()).roles.find(r => r.slug === sharedSlug) : null);
      if (roleSlug && !selected) throw new Error('This role is unavailable. Enable its source or choose a built-in role.');
      const meta = { roleId: selected?.id ?? '', roleSlug: roleSlug ?? '', roleName: selected?.name ?? '', roleColor: selected?.color ?? '' };
      if (threadId) {
        if (available) await bb.sdk.threads.updatePluginMetadata({ threadId, pluginId: 'agent-roles', set: {
          roleId: sharedSlug ? meta.roleId : '', roleSlug: sharedSlug ?? '', roleName: sharedSlug ? meta.roleName : '', roleColor: sharedSlug ? meta.roleColor : '',
        } });
        await bb.sdk.threads.updatePluginMetadata({ threadId, pluginId: bb.pluginId, set: meta });
      }
      return { metadata: meta, context: selected
        ? `The user selected your role for this thread: ${selected.name}. Apply this role starting with this message and subsequent messages until the user changes it. Keep the user's chosen provider, model and permissions.\n\n${selected.instructions}`
        : 'The user deselected the specialist role. Continue as the general assistant; previous role instructions no longer apply.' };
    },
  });
}
