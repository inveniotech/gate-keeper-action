import { appendFile } from 'node:fs/promises';
import { deploy } from './deploy.mjs';

try {
  const result = await deploy({
    app: process.env.HEROKU_DEPLOY_APP,
    token: process.env.HEROKU_DEPLOY_TOKEN,
    archive: process.env.HEROKU_DEPLOY_ARCHIVE,
    version: process.env.HEROKU_DEPLOY_VERSION,
    timeoutSeconds: Number(process.env.HEROKU_DEPLOY_TIMEOUT),
  });
  await appendFile(process.env.GITHUB_OUTPUT, [
    `build-id=${result.buildId}`,
    `release-id=${result.releaseId}`,
    `release-version=${result.releaseVersion}`,
    `checksum=${result.checksum}`,
    '',
  ].join('\n'));
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    '### Heroku source deployment',
    '',
    `Build: ${result.buildId}`, '',
    `Release: v${result.releaseVersion} (${result.releaseId})`, '',
    `Archive: ${result.checksum}`, '',
  ].join('\n'));
  console.log(`Heroku release v${result.releaseVersion} succeeded.`);
} catch (error) {
  // Only the deployment module's sanitised messages may be printed.
  console.error(error.message);
  process.exitCode = 1;
}
