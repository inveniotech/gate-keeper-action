import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const api = 'https://api.heroku.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value, label) {
  if (!uuid.test(value ?? '')) throw new Error(`Heroku returned an invalid ${label} identifier.`);
  return value;
}

function sourceUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Heroku returned an invalid source URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Heroku source URLs must use HTTPS without embedded credentials or fragments.');
  }
  return parsed.href;
}

/**
 * Uploads a gzip source archive and waits for its Heroku build and release.
 * Uses the existing application's buildpacks. Does not create apps or change configuration.
 * Throws a sanitised error on invalid input, API failure, build/release failure or timeout.
 * @param {{app: string, token: string, archive: string, version: string, timeoutSeconds: number}} options Deployment inputs.
 * @param {{fetch?: typeof globalThis.fetch, now?: () => number, sleep?: (ms: number) => Promise<unknown>}} dependencies Test seams.
 * @returns {Promise<{buildId: string, releaseId: string, releaseVersion: number, checksum: string}>} Release provenance.
 */
export async function deploy(options, dependencies = {}) {
  const { app, token, archive, version, timeoutSeconds } = options;
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(app ?? '')) throw new Error('Supply a valid Heroku application name.');
  if (!token?.trim() || /[\r\n]/.test(token)) throw new Error('Supply a non-empty Heroku API token.');
  if (!/^[a-z0-9._/-]{1,200}$/i.test(version ?? '')) throw new Error('Supply a source version without whitespace or control characters.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('The timeout must be an integer between 1 and 3600 seconds.');
  }
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? setTimeout;
  const deadline = now() + timeoutSeconds * 1000;
  const remaining = () => {
    const ms = deadline - now();
    if (ms <= 0) throw new Error('Heroku deployment timed out. The remote build may still be running; inspect it before retrying.');
    return Math.ceil(ms);
  };
  let bytes;
  try { bytes = await readFile(archive); } catch { throw new Error('Cannot read the source archive. Check the archive path.'); }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('The source archive must be a gzip-compressed tar archive.');
  const checksum = `SHA256:${createHash('sha256').update(bytes).digest('hex')}`;

  async function request(url, options, label, limit = 30000) {
    const timeout = Math.min(remaining(), limit);
    let response;
    try {
      response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new Error(`Heroku ${label} request failed or timed out. Check connectivity and deployment status before retrying.`);
    }
    if (!response.ok) throw new Error(`Heroku ${label} returned HTTP ${response.status}. Check access and deployment status.`);
    return response;
  }

  async function json(path, method = 'GET', body) {
    const response = await request(`${api}/apps/${app}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json',
        'User-Agent': 'gate-keeper-heroku-source-deploy',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'API');
    try { return await response.json(); } catch { throw new Error('Heroku returned an unreadable API response.'); }
  }

  async function pause() {
    await sleep(Math.min(3000, remaining()));
    remaining();
  }

  const target = await json('');
  if (target.generation?.name !== 'cedar') throw new Error('This action currently supports Cedar applications only.');
  if (!/^heroku-\d+$/.test(target.build_stack?.name ?? '')) {
    throw new Error('Configure a supported Heroku buildpack stack before deploying this application.');
  }
  const source = await json('/sources', 'POST');
  const putUrl = sourceUrl(source.source_blob?.put_url);
  const getUrl = sourceUrl(source.source_blob?.get_url);
  // Heroku's signed source-upload contract requires no Content-Type header.
  await request(putUrl, {
    method: 'PUT', headers: {}, body: bytes,
  }, 'source upload', 120000);

  let build = await json('/builds', 'POST', { source_blob: { url: getUrl, checksum, version } });
  const buildId = requireId(build.id, 'build');
  while (build.status === 'pending') {
    await pause();
    build = await json(`/builds/${buildId}`);
  }
  if (build.status !== 'succeeded') throw new Error(`Heroku build ${buildId} failed. Inspect the build output in Heroku.`);
  const releaseId = requireId(build.release?.id, 'release');
  let release = await json(`/releases/${releaseId}`);
  while (release.status === 'pending') {
    await pause();
    release = await json(`/releases/${releaseId}`);
  }
  if (release.status !== 'succeeded') throw new Error(`Heroku release ${releaseId} failed. Inspect the release in Heroku.`);
  if (!Number.isSafeInteger(release.version) || release.version < 1) throw new Error('Heroku returned an invalid release version.');
  return { buildId, releaseId, releaseVersion: release.version, checksum };
}
