# Gate-Keeper shared GitHub Actions

Reusable automation for Gate-Keeper repositories. Each action lives under `actions/` so that
additional actions can be introduced independently.

- [Heroku source deployment](actions/heroku-source-deploy/README.md) uploads prepared source
  archives, including generated files, without Git pushes or deployment commits.

Run the action tests with Node.js 26 or later:

```bash
node --test actions/heroku-source-deploy/deploy.test.mjs
```
