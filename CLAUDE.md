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

| Job group                               | Runner          | Playwright | Use for                                                          |
| --------------------------------------- | --------------- | ---------- | ---------------------------------------------------------------- |
| `retrieve_sources`                      | `self-hosted`   | Yes        | Event/ticketing platforms (outsavvy, dice.fm, feverup, etc.)     |
| `retrieve_source_only_1` through `_4`   | `ubuntu-latest` | No         | Source-only venues (no website to scrape, retrieve returns `{}`) |
| `retrieve_remaining_cinemas_1` and `_2` | `self-hosted`   | Yes        | Standalone venues with their own retriever                       |
| Named groups (e.g. `retrieve_everyman`) | Varies          | Varies     | Chain cinemas with many locations                                |

### Parallelisation and load balancing

Jobs with numbered suffixes (e.g. `retrieve_source_only_1` through `_4`) are the
same type of source chunked across multiple jobs. This balances the overhead of
spinning up a new runner against the speed and confined blast radius of running
fewer venues per job. If adding many sources to a chunked group, consider
whether the groups need rebalancing or a new group needs creating.

When adding a new job group, it must also be added to the `needs` array in the
`create_release` job at the bottom of the file — a group left out of `needs`
is one whose failure would not hold the release back.

### Source identifier conventions

- Domain-based: `outsavvy.com`, `dice.fm`
- Domain with location: `curzon.com-aldgate`, `bfi.org.uk-imax`

## Commit style

Short imperative messages describing the change, e.g. "Add new source and rename
venue".
