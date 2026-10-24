# data-retrieved

Part of the Clusterflick project. This repo contains a single GitHub Actions
workflow that retrieves raw cinema/event data from venue websites and publishes
it as a release for downstream processing by `clusterflick/data-transformed`.

## Repo structure

- `.github/workflows/retrieve.yml` - The only file that typically changes.
  Contains all source definitions and job configuration.
- `package.json` - Pulls in `github:clusterflick/scripts` which contains the
  actual retrieval logic. There is intentionally no lock file so that
  `npm install` always pulls the latest version of the scripts dependency.

## Releases are all-or-nothing

`create_release` `needs` every retrieve job, so a release is only cut once all
of them have succeeded. This is deliberate. Downstream treats a release as a
complete snapshot of every venue, so a release with a venue missing is worse
than no release: the venue reads as having nothing on rather than as absent,
and `departed` treats its films as having finished their run.

The consequences follow from that and are not bugs to design around:

- One venue failing voids the whole run. That is the trade being made.
- Do not get a release out of a run that had a failure by relaxing the gate —
  no `if: always()` or `if: ${{ !cancelled() }}` on `create_release`, and no
  dropping jobs from its `needs` array.
- Resilience belongs upstream of the gate, in the retry budget:
  `retry_wait_seconds` and `max_attempts` on the step here, and the per-fetch
  retry config in `clusterflick/scripts`. The goal is that a venue does not
  fail in the first place.

Recover a failed run by re-running its failed jobs rather than the whole
workflow. Artifacts from jobs that already succeeded are retained across
attempts, so only the failures repeat.

The gate covers the retrieve jobs; `immutableCreate: true` covers the upload.
Left to itself `ncipollo/release-action` publishes the release first and
attaches the ~1.2GB of artifacts one at a time, so `releases/latest` spends the
whole upload pointing at a release missing most of its venues - the same wrong
answer the gate exists to prevent, arriving by a different route. With the flag
the action creates a draft, attaches everything, then publishes, so a release
becomes visible only once it is whole. `makeLatest` is passed again on that
publish, so the finished release still becomes latest.

A failed upload therefore leaves a draft rather than a published release. It
still needs deleting - the tag is a timestamp, so a re-run creates a new release
rather than resuming the old one - but until then it is invisible to anything
reading the latest release.

A failed upload is retried once in the same job, by `Retry Release Upload`. The
action's own retry handles only a 5xx, and a 5xx can arrive for an asset GitHub
has already stored, so its second upload of that asset fails `already_exists` -
a run whose every venue succeeded, voided on a duplicate name. The retry goes
again on the same tag with `allowUpdates`, which finds the draft and uploads
the whole release again. Before uploading, the action by default deletes any
asset already attached under the same name, so what the first attempt got up is
replaced rather than colliding. It must keep `draft: true`: an update publishes the release
before uploading unless told otherwise, which is the partial `releases/latest`
`immutableCreate` exists to prevent. `Publish Retried Release` publishes it once
the upload is done. This is not a relaxed gate - every retrieve job still has to
pass, and nothing is published until every asset is attached. Only if the retry
fails too is a draft left behind to delete.

## Adding a new source

Add a step to the appropriate job group in `retrieve.yml`:

```yaml
- name: source-identifier
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: 20
    max_attempts: 3
    command: npm run retrieve -- source-identifier
```

Or for lightweight sources that don't need retry:

```yaml
- name: source-identifier
  run: npm run retrieve -- source-identifier
```

### Playwright dependency

Some sources require browser automation (Playwright) and some don't. Check
whether the source's retriever needs Playwright - if it does, it must go in a
job that installs Playwright (`npx playwright install --with-deps`). Placing a
Playwright-dependent source in a job without it will fail.

### Job group selection

| Job group                                | Runner          | Playwright  | Use for                                                             |
| ---------------------------------------- | --------------- | ----------- | ------------------------------------------------------------------- |
| `retrieve_sources_1`                     | `self-hosted`   | Yes         | Event/ticketing platforms (outsavvy, dice.fm, feverup, etc.)        |
| `retrieve_sources_2`                     | `self-hosted`   | Yes         | Sources that fail most often                                        |
| `retrieve_source_only`                   | `ubuntu-latest` | No          | Source-only venues (no website to scrape, retrieve returns `{}`)    |
| `retrieve_remaining_cinemas_1` to `_6`   | `ubuntu-latest` | Only in `5` | Standalone venues confirmed to retrieve from GitHub's runners       |
| `retrieve_remaining_cinemas_7`           | `ubuntu-latest` | No          | Standalone venues newly moved to GitHub's runners                   |
| `retrieve_remaining_cinemas_8`           | `self-hosted`   | Yes         | Self-hosted standalone venues that fail most often                  |
| `retrieve_remaining_cinemas_self_hosted` | `self-hosted`   | Yes         | Standalone venues needing Camoufox, refused by GitHub's IPs, or new |
| Named groups (e.g. `retrieve_everyman`)  | Varies          | Varies      | Chain cinemas with many locations                                   |

### Runner selection

Every self-hosted runner shares one public IP, and venue firewalls have started
dropping it: the David Lean Cinema's for hours at a time, and Museum of the
Home's on every self-hosted runner while it answered from elsewhere. A venue
that accepts GitHub's datacenter IPs is better off on `ubuntu-latest`, which
also takes its requests off the home IP. Needing a browser is no reason to stay
self-hosted - `ubuntu-latest` installs Chromium just as well - but Camoufox is
only provisioned on the self-hosted runners.

Test a venue with `experiment.yml` on `ubuntu-latest` before moving it, and
compare the artifact with the latest release: a challenge page served with a 200
is still a refusal. If a moved venue starts refusing GitHub's IPs, the same
workflow on a self-hosted runner confirms it before moving it back.

### How the groups are drawn

A failed job is recovered by re-running it, and a re-run repeats every venue in
the job, so a group is sized by what re-running it costs:

- **Chains stay together.** A chain's venues share a site and a retriever, so
  they fail together, and running them one after another keeps the chain's
  requests from arriving in parallel from one IP.
- **Standalone venues are small groups.** Their failures are independent, so
  the more of them in a job, the more often that job fails. The ubuntu-latest
  groups are about seven venues each, balanced by runtime.
- **Flaky venues are kept apart** (`retrieve_sources_2` and
  `retrieve_remaining_cinemas_8`), so re-running one doesn't repeat the steady
  venues with it. A venue that has stopped failing
  can move back; one that starts failing regularly moves in.
- **Source-only venues are one group.** They fetch nothing of their own, so all
  of them together take a couple of minutes and rarely fail.

A job's cost is its setup plus a runner. On `ubuntu-latest` setup is about a
minute and there are runners to spare. Self-hosted runners are the scarce
resource: there are ten, BFI and Eventbrite hold two of them for most of the
run, and a self-hosted job that waits for a free runner can wait 15 minutes. So
add GitHub-hosted groups freely, and self-hosted groups sparingly. A new
standalone venue goes into the smallest of `retrieve_remaining_cinemas_1` to
`_6`, or `retrieve_remaining_cinemas_self_hosted` if it can't run on
`ubuntu-latest` - never straight into the flaky or recently moved groups.

Installing Chromium adds to setup, so a group passes `playwright: true` only if
one of its venues needs a browser.

When adding a new job group, it must also be added to the `needs` array in the
`create_release` job at the bottom of the file — a group left out of `needs`
is one whose failure would not hold the release back.

### Source identifier conventions

- Domain-based: `outsavvy.com`, `dice.fm`
- Domain with location: `curzon.com-aldgate`, `bfi.org.uk-imax`

## Commit style

Short imperative messages describing the change, e.g. "Add new source and rename
venue".
