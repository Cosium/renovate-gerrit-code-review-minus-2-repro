# Renovate on Gerrit: a change voted Code-Review -2 is abandoned

On Gerrit, Renovate abandons every open change of its own voted
`Code-Review -2` at the start of each repository run. Gerrit defines -2 as
"This shall not be submitted": it blocks submission and stays on the change
until the reviewer lifts it
([config-labels](https://gerrit-review.googlesource.com/Documentation/config-labels.html#label_Code-Review)).
A reviewer who votes -2 to hold an update back while a question is open sees
Renovate abandon the change at its next run, and Renovate then ignores the
update (here every 7.x release), as it does for a pull request closed without
merging.

Renovate does this on purpose: each change description tells reviewers to
"Abandon or vote this change with Code-Review -2" to ignore an update. That
use of -2 conflicts with its meaning in Gerrit.

Discussion: https://github.com/renovatebot/renovate/discussions/48060
Proposed fix: https://github.com/renovatebot/renovate/pull/48061

## Reproduction

Prerequisites: Docker with Compose v2, git, Node.js 24 or later (it runs the
TypeScript script directly). To run Renovate from source, also a Renovate
checkout with its dependencies installed (`pnpm install`). `RENOVATE_*`
variables of your shell are not passed to Renovate.

```sh
node scripts/run.ts released                 # renovate/renovate:44.252.1
node scripts/run.ts source ~/src/renovate    # any Renovate checkout, via pnpm start
docker compose down -v                       # clean up
```

Each invocation takes about 30 seconds once the images are pulled. It starts a
fresh Gerrit 3.15.0 (development auth, default `admin`/`secret`) and then:

1. creates the user `renovate` and the project `code-review-minus-2-demo` with
   an outdated `package.json`;
2. Renovate run 1 creates a change for `is-number`
   ([`config.js`](config.js));
3. `admin` votes `Code-Review -2` on the change with a question. Any account
   allowed to vote -2 gives the same state;
4. Renovate run 2 processes the repository again;
5. the script reads the change's status and messages.

Renovate logs (debug) go to `logs/`. The script ends with `Reproduced` (exit
code 1) when the change is abandoned, or `Not reproduced` (exit code 0) when
it is still open. It fails if run 1 did not leave an open change, or if the
-2 is missing from the change after run 2.

## Current behavior

Output with Renovate 44.252.1:

```
==> Change after run 2
  change 1: Update dependency is-number to v7
  status: ABANDONED
  Code-Review rejected by: admin
  messages:
    renovate: Uploaded patch set 1.
    renovate: Patch Set 1:
      This change contains the following updates:
    admin: Patch Set 1: Code-Review-2
      Hold on until we know whether v7 drops a runtime we support.
    renovate: Abandoned
      This change has been abandoned as it was voted with Code-Review -2.
    renovate: Patch Set 1:
      Because you closed this PR without merging, Renovate will ignore this update. You will not get PRs f…

==> Reproduced: Renovate abandoned the change voted Code-Review -2
```

Renovate run from source on the pull request's base (`da9664321d`) gives the
same output.

## Expected behavior

The change stays open, blocked from submission by the -2 as Gerrit intends,
until the reviewer lifts the vote or abandons the change. Output with the
proposed fix (`f547d5e098`, run from source):

```
==> Change after run 2
  change 1: Update dependency is-number to v7
  status: NEW
  Code-Review rejected by: admin
  messages:
    renovate: Uploaded patch set 1.
    renovate: Patch Set 1:
      This change contains the following updates:
    admin: Patch Set 1: Code-Review-2
      Hold on until we know whether v7 drops a runtime we support.

==> Not reproduced: the change voted Code-Review -2 stays open
```

## Files

- [`docker-compose.yml`](docker-compose.yml): Gerrit, and the released Renovate image (profile `renovate`)
- [`config.js`](config.js): self-hosted Renovate configuration for both runs
- [`project/`](project): content of the demo project's first commit
- [`scripts/run.ts`](scripts/run.ts): the whole scenario, from a clean Gerrit
