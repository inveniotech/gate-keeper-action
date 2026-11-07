import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { deploy } from './deploy.mjs';

const buildId = '11111111-1111-1111-1111-111111111111';
const releaseId = '22222222-2222-2222-2222-222222222222';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'heroku-action-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'source.tar.gz');
  const bytes = gzipSync('synthetic source archive');
  await writeFile(archive, bytes);
  const requests = [];
  let elapsed = 0;
  const replies = [
    { generation: { name: 'cedar' }, build_stack: { name: 'heroku-24' } },
    { source_blob: { put_url: 'https://upload.example.test/source?signature=private', get_url: 'https://download.example.test/source?signature=private' } },
    null,
    { id: buildId, status: 'pending' },
    { id: buildId, status: 'succeeded', release: { id: releaseId } },
    { id: releaseId, status: 'succeeded', version: 42 },
  ];
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    const reply = replies.shift();
    return new Response(reply === null ? null : JSON.stringify(reply), { status: 200 });
  };
  return {
    archive, bytes, requests, replies,
    run: (options = {}, dependencies = {}) => deploy({
      app: 'example-site', token: 'synthetic-secret', archive, version: 'abc123', timeoutSeconds: 30,
      ...overrides, ...options,
    }, { fetch, now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, ...dependencies }),
  };
}

test('Deploy should upload generated archive bytes and report the release when the build succeeds', async (t) => {
  const f = await fixture(t);
  const output = await f.run();
  assert.deepEqual(output, { buildId, releaseId, releaseVersion: 42, checksum: `SHA256:${createHash('sha256').update(f.bytes).digest('hex')}` });
  assert.deepEqual(f.requests.map((r) => r.method), ['GET', 'POST', 'PUT', 'POST', 'GET', 'GET']);
  assert.deepEqual(f.requests[2].body, f.bytes);
  assert.equal(f.requests[2].headers.Authorization, undefined);
  assert.equal(f.requests[2].redirect, 'error');
  const body = JSON.parse(f.requests[3].body);
  assert.equal(body.source_blob.version, 'abc123');
  assert.equal(body.source_blob.checksum, output.checksum);
  assert.equal(body.source_blob.url, 'https://download.example.test/source?signature=private');
  assert.equal(body.buildpacks, undefined);
});

for (const [name, options] of [
  ['application name', { app: '../other' }],
  ['token', { token: '' }],
  ['version', { version: 'bad\nversion' }],
  ['timeout', { timeoutSeconds: 0 }],
]) {
  test(`Deploy should reject invalid ${name} before contacting Heroku`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run(options));
    assert.equal(f.requests.length, 0);
  });
}

test('Deploy should reject a non-gzip archive before contacting Heroku', async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, 'not an archive');
  await assert.rejects(f.run(), /gzip/);
  assert.equal(f.requests.length, 0);
});

for (const app of [{ generation: { name: 'fir' }, build_stack: { name: 'heroku-24' } }, { generation: { name: 'cedar' }, build_stack: { name: 'container' } }]) {
  test(`Deploy should refuse unsupported application configuration ${JSON.stringify(app)}`, async (t) => {
    const f = await fixture(t);
    f.replies[0] = app;
    await assert.rejects(f.run(), /Cedar|buildpack/);
    assert.equal(f.requests.length, 1);
  });
}

test('Deploy should stop without creating an application when the target is missing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, { fetch: async () => new Response('sensitive response', { status: 404 }) }), /HTTP 404/);
});

test('Deploy should reject insecure upload URLs before sending archive bytes', async (t) => {
  const f = await fixture(t);
  f.replies[1].source_blob.put_url = 'http://upload.example.test/source';
  await assert.rejects(f.run(), /HTTPS/);
  assert.equal(f.requests.length, 2);
});

test('Deploy should fail when uploading fails without starting a build', async (t) => {
  const f = await fixture(t);
  let count = 0;
  await assert.rejects(f.run({}, { fetch: async () => {
    const reply = f.replies.shift();
    return new Response(JSON.stringify(reply), { status: ++count === 3 ? 503 : 200 });
  } }), /HTTP 503/);
  assert.equal(count, 3);
});

test('Deploy should report a failed build without polling a release', async (t) => {
  const f = await fixture(t);
  f.replies[4] = { id: buildId, status: 'failed' };
  await assert.rejects(f.run(), /build.*failed/i);
  assert.equal(f.requests.length, 5);
});

test('Deploy should not report success when a successful build has no release', async (t) => {
  const f = await fixture(t);
  f.replies[4] = { id: buildId, status: 'succeeded', release: null };
  await assert.rejects(f.run(), /release/i);
});

test('Deploy should fail when the release fails after the build succeeds', async (t) => {
  const f = await fixture(t);
  f.replies[5] = { id: releaseId, status: 'failed', version: 42 };
  await assert.rejects(f.run(), /release.*failed/i);
});

test('Deploy should stop polling when the overall deadline expires', async (t) => {
  const f = await fixture(t);
  f.replies[4] = { id: buildId, status: 'pending' };
  await assert.rejects(f.run({ timeoutSeconds: 1 }), /timed out/i);
  assert.equal(f.requests.length, 4);
});

test('Deploy should sanitise network errors that contain signed URLs or credentials', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, { fetch: async () => { throw new Error('private signed URL synthetic-secret'); } }), (error) => {
    assert.doesNotMatch(error.message, /private|synthetic-secret/);
    return true;
  });
});
