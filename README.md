# data-retrieved

This repository contains the automated workflow for retrieving raw cinema data
for the Clusterflick project.

## Purpose

The workflow runs `retrieve` commands for all venues and event sources, pulling
raw data from venue websites and event listing platforms. This collected data is
then published as a release on this repository for downstream processing.

## How It Works

The workflow executes the retrieve command for each venue:

```bash
npm run retrieve -- <venue-identifier>
```

This command:

- Connects to the venue website or event listing platform
- Extracts raw event data
- Saves the data for downstream transformation

Each retrieve command includes automatic retry logic to handle transient
failures.

## Schedule

The workflow runs automatically every day at 3am UTC and can also be triggered
manually via workflow dispatch.

## Workflow Structure

Retrieve commands are organized into parallel job groups to:

- Minimize total wall clock time
- Confine the blast radius of a failure (a failing job does not stop the other
  jobs from running)
- Enable individual job restarts when issues occur

## Maintenance

### Adding New Venues

When a new venue is added to the system, this workflow **must be updated** to
include the retrieval step. To add a venue:

1. Identify the appropriate job group (or create a new one if needed)
2. Add a new step to run the retrieve command for the venue:
   ```yaml
   - name: venue-identifier
     run: npm run retrieve -- venue-identifier
   ```

**Note:** Consider using `nick-fields/retry@v3` for venues with unreliable
connections or rate limiting issues.

### Handling Failures

- No release is published unless every retrieve job succeeds. The release is a
  complete snapshot of every venue or it is not cut at all
- Failed jobs can typically be restarted individually without rerunning the
  entire workflow — artifacts from jobs that already succeeded are reused
- Code fixes should be applied to the
  [clusterflick/scripts](https://github.com/clusterflick/scripts) repository,
  which is pulled in at build time

## Licence

The code in this repository is licensed under the [MIT licence](LICENSE).

The releases are **not licensed at all**. They are raw scrapes — the responses
each venue website and ticketing platform gave us, stored close to verbatim so
the transform stage can be re-run without hitting the source site again. That
content belongs to the sites it came from; Clusterflick holds no rights in it
and grants none. There are no schema guarantees either: each file's shape is
whatever the source returned that day.

For data you can use, see the
[data licence](https://clusterflick.com/data-licence). The exact terms for this
repository are in [LICENSE-DATA](LICENSE-DATA).
