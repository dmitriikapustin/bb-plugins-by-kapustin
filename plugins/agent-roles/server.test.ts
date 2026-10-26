import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin, { type Role, type Team } from './server.ts';

async function setup() {
  const host = createFakePluginHost({ pluginId: 'agent-roles' });
  await plugin(host.bb);
  return host;
}

test('a partial role update changes only the fields it names', async () => {
  const { harness } = await setup();
  try {
    const created = await harness.callRpc('roles_create', {
      slug: 'auditor', name: 'Auditor', description: 'Checks the books', instructions: 'Audit carefully.',
      providerId: 'provider-a', model: 'model-a', reasoningLevel: 'high', permissionMode: 'accept-edits', color: 'blue',
    }) as Role;
    const renamed = await harness.callRpc('roles_update', { id: created.id, name: 'Senior auditor' }) as Role;
    assert.equal(renamed.name, 'Senior auditor');
    for (const field of ['slug', 'description', 'instructions', 'providerId', 'model', 'reasoningLevel', 'permissionMode', 'color'] as const) {
      assert.equal(renamed[field], created[field], field);
    }
    const cleared = await harness.callRpc('roles_update', { id: created.id, model: null, providerId: null }) as Role;
    assert.equal(cleared.model, null);
    assert.equal(cleared.providerId, null);
    assert.equal(cleared.description, 'Checks the books');
  } finally { await harness.dispose(); }
});

test('a partial team update changes only the fields it names', async () => {
  const { harness } = await setup();
  try {
    const created = await harness.callRpc('teams_create', {
      slug: 'audit-team', name: 'Audit team', description: 'Two-step audit',
      nodes: [{ id: 'audit', roleSlug: 'reviewer', label: 'Audit', prompt: '{task}' }],
    }) as Team;
    const renamed = await harness.callRpc('teams_update', { id: created.id, name: 'Audit crew' }) as Team;
    assert.equal(renamed.name, 'Audit crew');
    assert.equal(renamed.description, 'Two-step audit');
    assert.deepEqual(renamed.nodes, created.nodes);
  } finally { await harness.dispose(); }
});
