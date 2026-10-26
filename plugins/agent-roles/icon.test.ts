import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ICON_PREFIX, iconProblem } from './icon.ts';
import plugin, { type Role } from './server.ts';

// Minimal PNG writer, so the tests build real images byte by byte.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type PngOptions = { depth?: number; colorType?: number; interlace?: number; compression?: number; pixels?: Buffer; before?: Buffer[]; extra?: Buffer[]; end?: Buffer };
function png(width: number, height: number, options: PngOptions = {}) {
  const { depth = 8, colorType = 6 } = options; // 8-bit RGBA by default
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[10] = options.compression ?? 0;
  header[12] = options.interlace ?? 0;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 4;
  const pixels = options.pixels ?? Buffer.alloc(height * (1 + Math.ceil((width * channels * depth) / 8)));
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', header), ...(options.before ?? []), chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', options.end ?? Buffer.alloc(0)), ...(options.extra ?? []),
  ]);
}
const url = (bytes: Buffer) => ICON_PREFIX + bytes.toString('base64');

test('a small PNG whose image data matches its header is accepted', () => {
  assert.equal(iconProblem(url(png(2, 2))), null);
  assert.equal(iconProblem(url(png(64, 64))), null);
  assert.equal(iconProblem(url(png(5, 3, { depth: 1, colorType: 3, before: [chunk('PLTE', Buffer.alloc(6))] }))), null);
  assert.equal(iconProblem(url(png(3, 3, { depth: 16, colorType: 0, extra: [] }))), null);
});

test('images that fail the structural checks are rejected', () => {
  const valid = png(2, 2);
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 20]! ^= 0xff; // inside IDAT, so its CRC no longer matches
  const cases: Array<[string, string]> = [
    ['data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'PNG data URL'],
    [ICON_PREFIX + 'iVBORw0KGgoAAAAA', 'truncated'], // PNG signature, then nothing usable
    [ICON_PREFIX + 'iVBORw0KGgo=!', 'base64'],
    [url(Buffer.from('not an image at all')), 'not a PNG'],
    [url(corrupt), 'corrupt'],
    [url(valid.subarray(0, valid.length - 12)), 'truncated'], // IEND removed
    [url(png(2, 2, { extra: [Buffer.from('trailing')] })), 'after the end'],
    [url(Buffer.concat([SIGNATURE, chunk('IEND', Buffer.alloc(0))])), 'image header'],
    [url(png(512, 512)), 'at most 256×256'],
    [url(png(2, 2, { depth: 4, colorType: 6 })), 'invalid image header'], // RGBA has no 4-bit form
    [url(png(2, 2, { compression: 1 })), 'invalid image header'],
    [url(png(2, 2, { interlace: 1 })), 'interlaced'],
    [url(png(2, 2, { colorType: 3 })), 'no palette'],
    [url(png(2, 2, { before: [chunk('IHDR', Buffer.alloc(13))] })), 'more than one image header'],
    [url(png(2, 2, { before: [chunk('ABCD', Buffer.alloc(1))] })), 'unsupported ABCD'],
    [url(png(2, 2, { end: Buffer.from('x') })), 'malformed end'],
    [url(png(2, 2, { pixels: Buffer.alloc(0) })), 'declared size'], // empty image data
    [url(png(2, 2, { pixels: Buffer.alloc(8) })), 'declared size'], // too short for two rows
    [url(png(1, 1, { pixels: Buffer.alloc(500_000) })), 'declared size'], // far too long for one pixel
    [url(png(2, 2, { pixels: Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) })), 'row filter'],
  ];
  for (const [value, problem] of cases) {
    const found = iconProblem(value);
    assert.ok(found?.includes(problem), `${problem}: got ${found}`);
  }
  assert.ok(iconProblem('x'.repeat(100_001))?.includes('at most'));
});

test('image data that decompresses to more than the header allows is rejected', () => {
  // 256×256 RGBA is 263,168 bytes of image data; 4 MB of zeros deflates to a few KB.
  const bomb = png(256, 256, { pixels: Buffer.alloc(4 * 1024 * 1024) });
  assert.ok(bomb.length < 100_000);
  assert.ok(iconProblem(url(bomb))?.includes('decompress'));
});

async function setup() {
  const host = createFakePluginHost({ pluginId: 'agent-roles', sdk: { threads: {
    spawn: () => ({ id: 'thr_spawned' }),
    getPluginMetadata: () => ({}),
  } } });
  await plugin(host.bb);
  return host;
}
const fields = { name: 'Auditor', instructions: 'Audit carefully.', color: 'blue' } as const;

test('a role keeps, replaces and removes its icon through the RPC', async () => {
  const { harness } = await setup();
  try {
    const icon = url(png(4, 4));
    const created = await harness.callRpc('roles_create', { slug: 'auditor', ...fields, iconDataUrl: icon }) as Role;
    assert.equal(created.iconDataUrl, icon);
    const plain = await harness.callRpc('roles_create', { slug: 'plain', ...fields }) as Role;
    assert.equal(plain.iconDataUrl, null);

    // An update that does not name the icon keeps it.
    const renamed = await harness.callRpc('roles_update', { id: created.id, name: 'Senior auditor' }) as Role;
    assert.equal(renamed.iconDataUrl, icon);
    const listed = (await harness.callRpc('roles_list', null) as { roles: Role[] }).roles;
    assert.equal(listed.find((r) => r.id === created.id)?.iconDataUrl, icon);

    const other = url(png(8, 8));
    assert.equal((await harness.callRpc('roles_update', { id: created.id, iconDataUrl: other }) as Role).iconDataUrl, other);
    assert.equal((await harness.callRpc('roles_update', { id: created.id, iconDataUrl: null }) as Role).iconDataUrl, null);

    await assert.rejects(harness.callRpc('roles_update', { id: created.id, iconDataUrl: ICON_PREFIX + 'iVBORw0KGgoAAAAA' }));
    await assert.rejects(harness.callRpc('roles_update', { id: created.id, iconDataUrl: url(png(2, 2, { pixels: Buffer.alloc(0) })) }));
    await assert.rejects(harness.callRpc('roles_create', { slug: 'bad', ...fields, iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }));
  } finally { await harness.dispose(); }
});

test('an icon-only update leaves every other role field unchanged', async () => {
  const { harness } = await setup();
  try {
    const created = await harness.callRpc('roles_create', {
      slug: 'auditor', ...fields, description: 'Checks the books.', providerId: 'codex', model: 'gpt-5',
      reasoningLevel: 'high', permissionMode: 'auto', color: 'green',
    }) as Role;
    const others = ({ iconDataUrl: _icon, updatedAt: _updated, ...rest }: Role) => rest;
    const replaced = await harness.callRpc('roles_update', { id: created.id, iconDataUrl: url(png(4, 4)) }) as Role;
    assert.deepEqual(others(replaced), others(created));
    const removed = await harness.callRpc('roles_update', { id: created.id, iconDataUrl: null }) as Role;
    assert.deepEqual(others(removed), others(created));
    assert.equal(removed.iconDataUrl, null);
  } finally { await harness.dispose(); }
});

test('deleting a role deletes its icon; the CLI leaves icons out', async () => {
  const { bb, harness } = await setup();
  try {
    const created = await harness.callRpc('roles_create', { slug: 'auditor', ...fields, iconDataUrl: url(png(4, 4)) }) as Role;
    const icons = () => (bb.storage.database().prepare('SELECT COUNT(*) AS n FROM role_icons').get() as { n: number }).n;
    assert.equal(icons(), 1);
    const shown = await harness.runCli(['show', 'auditor', '--json']);
    assert.equal(shown.exitCode, 0);
    assert.equal('iconDataUrl' in JSON.parse(shown.stdout), false);
    await harness.callRpc('roles_delete', { id: created.id });
    assert.equal(icons(), 0);
  } finally { await harness.dispose(); }
});
