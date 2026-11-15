# opsbuf CI

A small CI for the opsbuf projects. It builds a project, runs its tests and shows the results on one page:
https://opsbuf-ci.local. Node without dependencies, like the roadmap.

## How a build starts

Every project has a bare repo on the Mac mini, `~/Apps/opsbuf-ci/repos/<project>.git`. Its `post-receive` hook starts a
run for every branch the push moved. In each project `git push` sends to GitHub and to that repo at once:

```bash
git remote set-url --add --push origin git@github.com:pawelpolakk2/<project>.git
git remote set-url --add --push origin macmini@macmini:Apps/opsbuf-ci/repos/<project>.git
```

The page also has **Run** for any project and branch, and **Run again** on a run.

## Projects

`config.json` lists them: the repo, the default branch, extra environment and the steps. A step is a shell command run
in the project's checkout. `stopOnFailure` ends the run when it fails; other steps run anyway, so every test step
reports. A step with `report` gives test results:

| `report`                               | Reads                                                  |
|----------------------------------------|--------------------------------------------------------|
| `{"type": "cargo"}`                    | the step's own `cargo test` output                     |
| `{"type": "junit", "file": "x.xml"}`   | a JUnit file the step wrote to `$CI_REPORTS`           |
| `{"type": "junit", "dir": "a/b"}`      | every JUnit file in a folder of the checkout (Gradle)  |

Steps get `CI=true`, `CI_PROJECT`, `CI_RUN`, `CI_SHA`, `CI_BRANCH` and `CI_REPORTS`. One run builds at a time. A
project keeps its checkout in `data/workspaces/<project>`; `target`, `node_modules`, `.angular` and the project's
`keep` folders survive between runs, so a run takes minutes.

## Releases

A project's `release` steps run only on its default branch and only when every step before them passed; a red build
ships nothing. The run then shows **released**. Each project releases itself with a script from its own repo:

| Project        | Release                          | Where                              |
|----------------|----------------------------------|------------------------------------|
| opsbuf-web     | `deploy/release.sh`              | https://opsbuf.local               |
| opsbuf-issues  | `scripts/release.sh`             | https://opsbuf-issue-tracker.local |
| opsbuf-roadmap | `scripts/release.sh`             | https://opsbuf-roadmap.local       |
| opsbuf-ci      | `scripts/release.sh`             | https://opsbuf-ci.local            |

The CI's own release copies the code and asks for a restart (`data/restart-requested`); the server exits when the queue
is empty and launchd starts the new code. A new https name for an app: `scripts/add-site.sh <host> <port> <name> <label>`.

## Run and deploy

```bash
npm test                 # parsers and the runner, on a temporary git repo
bash scripts/deploy.sh   # code, push repos, certificate, nginx and LaunchAgents on the mini
```

On the mini: LaunchAgent `pl.opsbuf.ci` serves 127.0.0.1:7460, `pl.opsbuf.ci.name` announces `opsbuf-ci.local`, and
nginx (as `macmini`, no sudo) serves https on 443 with a certificate from the local CA. Runs live in
`~/Apps/opsbuf-ci/data/runs/<id>/`; the last 200 are kept. Logs: `~/Apps/logs/opsbuf-ci*.log`.
