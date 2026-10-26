import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { route, matches, decorate } from './submit-bridge.ts';
const role = {id:'r1', slug:'qa', name:'QA', description:'Checks', instructions:'Check the acceptance criteria.', color:'gray'};
function setup(companion = true) {
  const writes: unknown[] = [];
  const host = createFakePluginHost({ pluginId:'role-picker', sdk: { plugins: { list: () => ({plugins: companion ? [{id:'agent-roles',enabled:true,status:'running'}] : []}), callRpc: () => ({roles:[role]}) }, threads: {
    getPluginMetadata: args => args.pluginId === 'role-picker' ? {} : ({roleSlug:'qa'}), updatePluginMetadata: args => { writes.push(args); return args.set; },
  } } });
  plugin(host.bb); return {...host, writes};
}
test('existing thread receives role metadata without creating or sending a thread', async () => {
  const {harness,writes} = setup(); try {
    const result: any = await harness.callRpc('prepare', {threadId:'current', roleSlug:'shared:qa'});
    assert.match(result.context, /Check the acceptance criteria/);
    assert.deepEqual(writes, [{threadId:'current', pluginId:'agent-roles', set:{roleId:'r1',roleSlug:'qa',roleName:'QA',roleColor:'gray'}},{threadId:'current',pluginId:'role-picker',set:{roleId:'r1',roleSlug:'shared:qa',roleName:'QA',roleColor:'gray'}}]);
    assert.equal(harness.sdk.callsTo('threads.spawn').length,0);
    assert.equal(harness.sdk.callsTo('threads.send').length,0);
  } finally {await harness.dispose();}
});
test('new thread preparation creates no thread; invalid role fails closed; clear overrides legacy role', async () => {
 const {harness,writes} = setup(); try {
   await harness.callRpc('prepare',{threadId:null,roleSlug:'shared:qa'}); assert.equal(writes.length,0);
   await assert.rejects(harness.callRpc('prepare',{threadId:'current',roleSlug:'missing'})); assert.equal(writes.length,0);
   const result: any = await harness.callRpc('prepare',{threadId:'current',roleSlug:null}); assert.equal(result.metadata.roleSlug,'');
   assert.match(result.context,/deselected/);
   assert.deepEqual(await harness.callRpc('current',{threadId:'current'}),{roleSlug:'shared:qa'});
 } finally {await harness.dispose();}
});
test('only same-origin native create/send endpoints are decorated', () => {
 assert.deepEqual(route('/api/v1/threads/t1/send','https://bb.test','POST'),{threadId:'t1'});
 assert.deepEqual(route('/api/v1/threads','https://bb.test','POST'),{threadId:null});
 for(const url of ['https://evil.test/api/v1/threads','/api/v1/threads/t1/retry','/api/v1/plugins/role-picker/rpc/prepare']) assert.equal(route(url,'https://bb.test','POST'),null);
 assert.equal(route('/api/v1/threads','https://bb.test','GET'),null);
});
test('new composer matching excludes unrelated projects, forks, plugins and drafts', () => {
 const selection={roleSlug:'qa',threadId:null,projectId:'p1',text:'Hello'};
 const body={projectId:'p1',origin:'web',input:[{type:'text',text:'Hello'}]};
 assert.equal(matches(selection,null,body),true);
 for (const patch of [{projectId:'p2'},{origin:'plugin'},{parentThreadId:'t1'},{input:[{type:'text',text:'Other'}]}]) assert.equal(matches(selection,null,{...body,...patch}),false);
});
test('decoration preserves native attachments, mentions, settings, schedule and original text', () => {
 const input=[{type:'text',text:'Hello',mentions:[{start:0,end:5,resource:{kind:'file',path:'a'}}]},{type:'localFile',path:'/tmp/a'}];
 const original={input,projectId:'p1',model:'model',environment:{type:'reuse',environmentId:'e1'},sendAt:123,mode:'queue'};
 const prepared={metadata:{roleSlug:'shared:qa'},context:'Role instructions'};
 const next=decorate(original,prepared,true);
 assert.equal(next.originPluginId,'role-picker'); assert.deepEqual(next.pluginMetadata,{roleSlug:'shared:qa'});
 assert.deepEqual((next.input as any[]).slice(0,2),input);
 assert.equal((next.input as any[])[2].visibility,'agent-only'); assert.equal(input.length,2);
 for(const key of ['projectId','model','environment','sendAt','mode']) assert.deepEqual(next[key],original[key as keyof typeof original]);
 assert.equal(decorate(original,prepared,false).originPluginId,undefined);
});

test('standalone installation provides six usable roles without calling another plugin', async () => {
 const {harness,writes} = setup(false); try {
  const list: any = await harness.callRpc('roles',null);
  assert.equal(list.roles.length,6);
  const result: any = await harness.callRpc('prepare',{threadId:'current',roleSlug:'local-reviewer'});
  assert.match(result.context,/Review for correctness/);
  assert.equal(writes.length,1);
  assert.equal((writes[0] as any).pluginId,'role-picker');
  assert.equal(harness.sdk.callsTo('plugins.callRpc').length,0);
  await assert.rejects(harness.callRpc('prepare',{threadId:'current',roleSlug:'shared:qa'}),/unavailable/);
  assert.equal(writes.length,1);
 } finally {await harness.dispose();}
});
test('companion roles coexist with local presets without replacing their identities', async () => {
 const {harness} = setup(); try {
  const list: any = await harness.callRpc('roles',null);
  assert.equal(list.roles.length,7);
  assert.ok(list.roles.some((r:any)=>r.slug==='local-qa'));
  assert.ok(list.roles.some((r:any)=>r.slug==='shared:qa'));
 } finally {await harness.dispose();}
});
test('an unhealthy companion does not hide the independent preset list',async()=>{
 const host=createFakePluginHost({pluginId:'role-picker',sdk:{plugins:{list:()=>({plugins:[{id:'agent-roles',enabled:true,status:'running'}]}),callRpc:()=>{throw new Error('Companion unavailable');}}}});
 try{plugin(host.bb);const result:any=await host.harness.callRpc('roles',null);assert.equal(result.roles.length,6);await assert.rejects(host.harness.callRpc('prepare',{roleSlug:'shared:qa',threadId:null}));}finally{await host.harness.dispose();}
});
test('Agent Roles icons pass through when shaped like PNG data URLs; others become null and missing ones stay absent', async () => {
 // Role Picker only checks the shape and length; Agent Roles checks the image itself.
 const png='data:image/png;base64,iVBORw0KGgo=';
 const roles=[{...role,slug:'a',iconDataUrl:png},{...role,slug:'b',iconDataUrl:'javascript:alert(1)'},{...role,slug:'c',iconDataUrl:null},{...role,slug:'d'}];
 const host=createFakePluginHost({pluginId:'role-picker',sdk:{plugins:{list:()=>({plugins:[{id:'agent-roles',enabled:true,status:'running'}]}),callRpc:()=>({roles})}}});
 try{plugin(host.bb);const list:any=await host.harness.callRpc('roles',null);
  const icon=(slug:string)=>list.roles.find((r:any)=>r.slug==='shared:'+slug).iconDataUrl;
  assert.equal(icon('a'),png); assert.equal(icon('b'),null); assert.equal(icon('c'),null); assert.equal('iconDataUrl' in list.roles.find((r:any)=>r.slug==='shared:d'),false);
  assert.equal(list.roles.filter((r:any)=>r.slug.startsWith('local-')&&r.iconDataUrl).length,0);
 }finally{await host.harness.dispose();}
});
