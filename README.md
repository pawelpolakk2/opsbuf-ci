# CI

A small CI for the projects on the Mac mini: opsbuf, elektryka, instalacje and any other added to `config.json`. It
builds a project, runs its tests, releases green main builds and shows the results on one page: https://ci.local.
Node without dependencies.

The folders and names on the mini still say `opsbuf-ci` (`~/Apps/opsbuf-ci`, `repos/<project>.git`, `pl.opsbuf.ci`),
because every project pushes to those paths; renaming them would mean changing the push remote of every project.

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
| opsbuf-app     | `scripts/ci-package.sh`          | a zip of opsbuf.app on the run's page |
| opsbuf-app     | `apps/testing/scripts/release.sh` | https://testing.local              |
| opsbuf-web     | `deploy/release.sh`              | https://opsbuf.local               |
| opsbuf-issues  | `scripts/release.sh`             | https://issues.local               |
| opsbuf-ci      | `scripts/release.sh`             | https://ci.local                   |
| elektryka      | `scripts/release.sh`             | https://elektryka.local            |
| instalacje     | `scripts/release.sh`             | https://instalacje.local           |

A step may leave files in `$CI_ARTIFACTS`; the run's page offers them for download, and
`/api/projects/<project>/latest` always points at the newest released file. Only the newest 10 runs (`keepArtifacts`)
keep their files.

## Jobs

A job is a named task of a project in `config.json`, started on demand, not by a push:

```json
"jobs": { "e2e": { "name": "End-to-end", "run": "bash apps/testing/scripts/e2e.sh", "params": ["tests"],
                   "report": { "type": "junit", "file": "e2e.xml", "title": "End-to-end" }, "every": "1h" } }
```

A job run has Checkout and the job's step. It runs on the commit it was given, by default the last released one. Each
declared param reaches the step as `CI_PARAM_<NAME>` (`tests` -> `CI_PARAM_TESTS`); a param it does not declare is
refused. The CI runs one run at a time, so a second start waits in the queue. Cancel takes a waiting run out of the
queue, or stops the running step's process group; the run ends as **cancelled**.

Start a job from a project's tab on the page (**Run job**, with its params), or from the API. Starting and cancelling
need the token in `apiTokenFile` (on the mini the tracker token); without that file the API refuses them all.

```bash
curl -s https://ci.local/api/projects/opsbuf-app/jobs
curl -s -X POST https://ci.local/api/projects/opsbuf-app/jobs/e2e -H "Authorization: Bearer $(cat ~/.config/opsbuf-issues/token)" -d '{"params": {"tests": "T-12,T-40"}}'
curl -s https://ci.local/api/runs/12
curl -s -X POST https://ci.local/api/runs/12/cancel -H "Authorization: Bearer $(cat ~/.config/opsbuf-issues/token)"
```

### On a schedule

A job with `every` also starts by itself, with the trigger `schedule`. Every minute the CI checks: a run starts when the
project's last released commit differs from the job's last scheduled run, at most once per `every`, and never while one
of the job waits or runs. Nothing released, nothing runs. It follows the released commit, not main, because the tests
run the build the release installed. opsbuf-app's `e2e` job runs `apps/testing/scripts/e2e.sh`: the testing scenarios,
headless, against https://testing.local's build; `tests` (T-12 or scenario ids) runs only those.

A scheduled run's tests are compared with the job's last scheduled run. A test that passed then and fails now is a
regression: one ticket for main (label = the job, one `dedupe_key` per test, so an open one is not opened again) with
the failure and both runs. Tests that failed before too are only listed. The run page shows the summary. A run started
by hand only shows its summary and opens no ticket: it may test anything, on any commit.

## Ticket branches merge themselves

Off by default: a project turns it on with `"autoMerge": true` in `config.json`; today every project has it off, and
agents merge their own branches. With it on, a branch named `<type>/PTX-<id>-…` or `<type>/OPS-<id>-…` gets one more
step after its checks: **Merge into main**
(`scripts/merge-into-main.sh`). On green it fast-forwards main when it can, else it makes a merge commit; it never
forces. The push to the CI repo starts main's own run, which releases as above, and the same main goes to the
project's `mirror` (its GitHub repo). A red check skips the merge; a conflict fails the step and lists the files. Either
way a `PTX` ticket gets a note from author `ci` with the reason and the run (`tracker` in `config.json`). Other branches
are only tested.

The CI's own release copies the code and asks for a restart (`data/restart-requested`); the server exits when the queue
is empty and launchd starts the new code. A new https name for an app: `scripts/add-site.sh <host> <port> <name> <label>`.

## Run and deploy

```bash
npm test                 # parsers and the runner, on a temporary git repo
bash scripts/deploy.sh   # code, push repos, certificate, nginx and LaunchAgents on the mini
```

On the mini: LaunchAgent `pl.opsbuf.ci` serves 127.0.0.1:7460, `pl.opsbuf.ci.name` announces `ci.local`, and
nginx (as `macmini`, no sudo) serves https on 443 with a certificate from the local CA. Runs live in
`~/Apps/opsbuf-ci/data/runs/<id>/`; the last 200 are kept. Logs: `~/Apps/logs/opsbuf-ci*.log`.
