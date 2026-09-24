# Agent notes

## Branch naming

Only push work to branches with one of these prefixes:

- `feature/<name>`
- `bugfix/<name>`
- `experiment/<name>`
- `release/<name>`

The GitHub Pages workflow ([.github/workflows/deploy-web.yml](.github/workflows/deploy-web.yml)) builds and deploys a preview of the web app only for pushes to `master` or to branches with these prefixes. Other branch names are never built or deployed.

Each branch deploys to a path named after the branch, with any run of characters other than letters, digits, `.`, `_` and `-` replaced by `-`. For example, `feature/save-prompts` deploys to `feature-save-prompts`. Deleting the branch removes its preview.

## Adding script files

The app loads plain `<script>` tags; there are no modules. A new file under `js/` must be added in two places:

- a `<script>` tag in `index.html`
- the file list in `gulpfile.js`, which `gulp web-dist` uses to build the deployed web app

If the file is missing from `gulpfile.js`, it works on the local dev server but is missing from the deployed site.
