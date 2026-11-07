# Heroku source deployment

Uploads a prepared `.tar.gz` archive through Heroku's Sources API, starts a build with the
application's configured buildpacks, and waits for the build and release to succeed. Generated
files in the archive do not need to be tracked by Git. There are no runtime package dependencies.

The caller supplies Node.js 26 or later, an existing Cedar application on a buildpack stack,
and a Heroku API token. Container-stack and Fir applications are rejected before upload.
This action does not create applications, change configuration or select a language buildpack.

## Use

After publishing a reviewed action commit, replace `FULL_COMMIT_SHA` with its immutable revision:

```yaml
- uses: inveniotech/gate-keeper-action/actions/heroku-source-deploy@FULL_COMMIT_SHA
  id: deploy
  with:
    app-name: ${{ vars.HEROKU_APP_NAME }}
    api-token: ${{ secrets.HEROKU_API_KEY }}
    archive-path: ${{ runner.temp }}/website-source.tar.gz
    source-version: ${{ github.sha }}
    timeout-seconds: '900'
```

`app-name`, `api-token`, `archive-path` and `source-version` are required. The timeout defaults
to 900 seconds and covers upload, build and release. Archive paths may be absolute or relative
to the calling step's working directory. The archive must contain the buildpack's required
files at its root. Package from the filesystem rather than using `git archive` when including
generated files. No GitHub write permission or Heroku command-line installation is needed.

The outputs are `build-id`, `release-id`, `release-version` and `checksum`. The checksum uses
Heroku's `SHA256:<hex>` representation. Release identifiers and the archive checksum are also
written to the GitHub job summary. Input versions must contain only letters, digits, dots,
underscores, slashes and hyphens, with at most 200 characters.

## Failure and recovery

Invalid inputs, inaccessible apps, upload failures, failed builds, missing releases, failed
releases and timeouts fail the calling step. API errors expose HTTP status codes but do not
print response bodies, tokens or signed source URLs. API mutations are not automatically
retried because a disconnected request can already have created a remote build.

A successful build can release the app immediately. A timeout or cancelled workflow does not
cancel the remote build. Inspect Heroku before retrying. The caller owns deployment concurrency,
environment protection, route checks and recovery policy. Tests inject the network, elapsed
time and polling delay; they never contact Heroku or wait in real time.

Run `node --test actions/heroku-source-deploy/deploy.test.mjs` from the repository root.

See [Heroku's build and release API guide](https://devcenter.heroku.com/articles/build-and-release-using-the-api)
and the [Platform API reference](https://devcenter.heroku.com/articles/platform-api-reference).
