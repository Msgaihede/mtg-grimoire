# Generated release notes — design

**Date:** 2026-10-11 · **Status:** approved by the owner, 2026-10-11 · **Plan:** `docs/superpowers/plans/2026-10-11-generated-release-notes.md`

## 1. Goal

What a user reads about a release is written from the pull requests in it — their titles and
their descriptions — and not from commit subjects. Each release gets a short **Highlights**
section and an itemized list with no duplicates, and that text is what the app shows.

release-please keeps everything else it does: versions, tags, the release PR, and `CHANGELOG.md`.

Success is: a release PR carries `changelog/<version>.md`, written by the generator and readable
in the PR; merging publishes that file as the GitHub release body; the desktop's Updates panel
draws it; and every release from 0.2.0 to 0.43.0 has a file and a release body in the same shape.

## 2. Decisions (the owner's, 2026-10-11)

| Question | Decision |
| --- | --- |
| Model | **Claude Haiku 5.5 through OpenRouter, reasoning effort medium.** |
| When the owner sees the notes | **On the release PR, before merging.** Merging publishes that text. |
| `CHANGELOG.md` | **Left as release-please's raw log.** Not read, not rewritten, not retired. |
| Where the notes live | **One file per release, named for its version**: `changelog/0.43.0.md`. Nothing edits a file that grows. |
| Hand-written notes | **None.** No `Unreleased` mechanism; the `## Unreleased` block in `CHANGELOG.md` is not read. |
| OpenRouter client | **Plain `fetch` against the REST API**, not the `@openrouter/agent` SDK. |
| History | **Backfilled**: a file for every past release, and the published release bodies rewritten. |

## 3. What was found (read 2026-10-11, at `34fb6f3f`)

- **The app never reads `CHANGELOG.md`.** `update_check` fetches
  `/repos/<repo>/releases?per_page=30`, caches the page in `app_meta`, and
  `packages/ui/lib/releaseNotes.ts` parses each release's body. The body is the channel, and it
  is the only way notes for a version *newer* than the running build can arrive.
- **Only the desktop draws it** — the Updates panel's offer and its version history.
  `LIGHT_SETTINGS` in `packages/ui/lib/edition.ts` has no `updates`.
- **The duplicates are release-please reading a merge twice**: the commit on the branch and the
  merge that carried it. 0.43.0 lists fourteen features, and six of them are repeats.
- **The inputs are there.** 660 merged pull requests, none with an empty description; the
  average is 3,086 characters and the longest 34,672.
- **Pull requests per release are recoverable from the tags.** 48 `v*` tags. 0.43.0's commit
  subjects name 16 numbers, 12 of them on the first-parent line; 0.41.0's name 47, and 0.18.0's
  77, the most. The earliest releases name none: 0.3.0 is 24 direct commits, and 0.2.0 is the 165
  commits before the first tag.
- **`anthropic/claude-haiku-5.5` is on OpenRouter** with `reasoning`, `response_format` and
  `structured_outputs` among its supported parameters, a 1,000,000-token context, and a price of
  $0.10 per million input tokens and $0.50 per million output (the public model list).
- **A bot push to the release branch already gets an approvable CI run.** Every push
  release-please has made to PR 877's branch, three of them force-pushes, produced a
  `pull_request` run in `action_required`. A second bot commit on that branch is the same event.
- **Nothing in CI can push to `main`.** `ci-ok` is required there and the workflow token is not
  an administrator's. A generated file reaches `main` by riding the release PR.
- **`release.yml` is fenced.** `scripts/release-rule.test.mjs` holds the seven jobs and their
  `needs`, one `if:` for every job after `release-please`, which job may read which secret, the
  two jobs that name an environment, and every line a secret-holding job runs.
  `scripts/workflow-scripts.test.mjs` refuses any `npm` line but the deploy tool's.
- **Release PR 877 (0.44.0) is open.** It is the first release this design writes notes for.
- **Two releases are drafts and stay drafts**: v0.5.0 and v0.34.0. `in-app-updates.md` records
  why v0.34.0 must never be published.

## 4. The notes

### The file

`changelog/<version>.md` holds one release's notes and nothing else: no version heading and no
date, because the release it becomes the body of already carries both, and so does the row the
app draws it under.

### The shape

```markdown
### Highlights

- **Scan cards from your phone or browser.** The Scanner comes to the Android and web apps.

### New

- **Android:** sync turns on by pairing with another device (#860)

### Changed

- **Decks:** a deck's cover is always the art of a card in it; uploaded pictures are gone (#870)

### Fixed

- **Sync:** a copy moved on one device is no longer skipped on another (#854, #856)
```

- **Highlights** is zero to five bullets, each a bold lead and one or two sentences, for what a
  person using the app would want to know first. A release with nothing of that weight has no
  Highlights section. Anything a user loses, or must do something about, is a highlight.
- **New**, **Changed** and **Fixed** are the itemized list. A section with no items is left out.
  The middle one was called *Improved* in the approved sketch; it is **Changed** here so that a
  removal has an honest place to go.
- **Each item names an area** from a closed list, kept in one constant: Decks, Collection,
  Wishlist, Search, Scanner, Sync, Import & export, Sharing, Prices, Backup, Settings, Android,
  Web, General.
- **Each item ends with the pull requests it came from**, as plain `(#860)`. GitHub links those
  in a release body by itself. Direct commits are counted but never printed.
- **A release with nothing user-facing** is one line: *Maintenance release with no user-facing
  changes.*

The words are for people who use the app. Work that changes nothing for them — CI, refactors,
tests, documentation, internal plumbing — is left out of the text and accounted for separately
(§5, *Check*).

## 5. The generator

Plain `.mjs` in `scripts/changelog/`, with no dependency beyond Node, shared by CI and the
backfill. Five modules and a command line:

| File | Does |
| --- | --- |
| `collect.mjs` | Turns a commit range into the list of entries the model reads. |
| `prompt.mjs` | Builds the instructions and the input from those entries. |
| `openrouter.mjs` | One request, with a timeout and retries. |
| `notes.mjs` | The JSON schema, the checks, and the markdown renderer. |
| `generate.mjs` | Asks, checks, and asks once more on a failed check (added while planning). |
| `cli.mjs` | `next`, `tag`, `backfill`, `push` — §6 and §8. |

`git`, the GitHub API and OpenRouter are passed in as functions, so each module is tested with
fakes and no test reaches the network.

### Collect

- The range is `<previous tag>..<head>`. For the first release it is everything up to `v0.2.0`.
- **Pull request numbers are read from every commit subject in the range**, in the two forms
  GitHub writes: `Merge pull request #N from …` and a trailing `(#N)`. Every commit and not only
  the first-parent line, so a pull request merged into another's branch is read too.
- **Each number is confirmed against the API**: it must be a pull request and it must be merged.
  A number that is an issue is dropped. The title and the description come from that answer.
- **A release PR is skipped** (its head branch starts `release-please--`).
- **A first-parent commit that is neither a merge nor a squash is a direct commit**, and goes in
  by its subject and body under its seven-character hash.
- An entry is an id (`#860` or a hash), a title and a body. A body is cut at 6,000 characters;
  descriptions here lead with what the change does.

### Write

One request per release, so the model sees the whole release at once — that is what removes the
duplicates. The two largest are 0.18.0, with about 80 entries, and 0.2.0, whose 163 direct
commits are about 185,000 characters of messages; both are far inside a 1,000,000-token context.
(This paragraph named 0.41.0 as the largest until the review measured every range.)

- `POST https://openrouter.ai/api/v1/chat/completions`
- `model: "anthropic/claude-haiku-5.5"`, `reasoning: { effort: "medium" }`
- `response_format`: a strict JSON schema, so the answer is data and not markdown
- 32,000 tokens for reasoning and the answer together, sized for 0.2.0, whose answer must name
  every one of those 163 commits.
- A five-minute deadline on the whole request, body included; a 429, a 5xx, or a request or a
  body that never completes is retried three times with a growing wait.

The instructions say what the app is and who reads the notes, give the shape's rules, and carry
a short glossary so *tags*, *labels*, *keywords* and *notes* are used as
`docs/agent/DOMAIN_VOCABULARY.md` uses them.

The answer:

```json
{
  "highlights": [{ "lead": "…", "text": "…", "refs": ["#861"] }],
  "new":        [{ "area": "Android", "text": "…", "refs": ["#860"] }],
  "changed":    [],
  "fixed":      [],
  "omitted":    [{ "ref": "#848", "reason": "planning document" }]
}
```

### Check

Code checks the answer before anything is written:

1. **Every ref is an entry that was sent.** A number the model made up fails.
2. **Every entry is either cited by an item or listed in `omitted`.** Nothing is dropped without
   a reason on record. This is what "scan through all the PRs" is held to.
3. **No text carries a link or a URL**, and every text is one line. A pull request's description
   is text somebody else wrote, the app opens `https:` links, and this closes that path. Since
   the review that includes what GitHub's own page would link: raw HTML, any `scheme://`, an
   `@name` and a `#number`. A reason for leaving something out is held to one line too, because
   it is printed in a workflow's log.
4. At most five highlights; every area is one from the list.

A failed check is sent back once with what failed. A second failure ends that release with an
error and no file. The backfill reports it, goes on to the next release, and exits non-zero.

### Render

Code writes the markdown from the checked JSON, so the shape is fixed and the app's reader knows
it. The `omitted` list is printed to the run's log and summary, and is not in the file.

## 6. The pipeline

Two jobs join `release.yml`, and `publish` gains a step. Nothing `needs` the two new jobs, so
they can fail without holding anything up.

```
release-please ─┬─ (on a release)  build, android, android-sign, web, web-deploy ── publish
                └─ (otherwise)     changelog-write ── changelog-commit
```

### `changelog-write` — on a push that cut no release

- `needs: release-please`, `if: needs.release-please.outputs.release_created != 'true'`
- `environment: changelog`, `contents: read` and `pull-requests: read`, a ten-minute deadline
- Reads two secrets: `OPENROUTER_API_KEY` and `GITHUB_TOKEN`.
- **Installs nothing.** A checkout with full history, Node from `.nvmrc`, and
  `node scripts/changelog/cli.mjs next`. No pnpm, no cache.
- `next` reads the released version from `main`'s `.release-please-manifest.json` and the coming
  one from the release branch's copy. **With no release branch, or the same version on both, it
  does nothing and ends green.**
- **With no key it writes nothing and ends green**, saying so in the summary — `android-sign`'s
  rule, so the pipeline can merge before the key exists.
- It leaves the file as the artifact `release-notes`.

### `changelog-commit` — after it

- `contents: write`, no environment, no OpenRouter key, no checkout.
- Puts the file on the release branch through the contents API as
  `docs(changelog): notes for <version> from <main's short hash>`.
- With no artifact it does nothing.

The split is the fence's existing rule: the job that holds a key and sends text to another
service cannot write to the repository, and the job that writes holds no key.

### `publish` — one step before the flip

- Reads `changelog/<version>.md` at the commit the run is on, through the API, and sets it as
  the release body with `gh release edit --notes-file`.
- **If the file is missing or empty, or the read fails, the release keeps release-please's
  notes.** The summary says so and the release is published. Notes never hold a release up.
- It is written here, after the builds, so nothing a build leg does to the draft can undo it.

No model is called on a release. The text published is the text that was merged.

### What the owner sees

- The release PR gains one file. Its diff is the whole text; *View file* renders it.
- **The file is rewritten whenever `main` moves**, because release-please rebuilds the branch and
  the notes are generated again from the full set. A hand edit therefore lasts only if it is the
  last thing before the merge. A correction that should last is made to the pull request's
  description, which is what the next run reads.
- The CI run to approve is the one on the generator's commit, which is the branch's newest.

## 7. The app

- `packages/ui/lib/releaseNotes.ts` gains one rule: a group of pull request references closing a
  bullet — `(#860)`, `(#854, #856)` — is dropped, for the reason a commit hash is. End of line
  only, `#` and digits only.
- Its other rules stay. An install's cache can hold release-please bodies until its next check,
  and they must still draw.
- The file's opening comment, `ReleaseNotes.tsx`'s and the story's stop describing the body as
  release-please's output. One fixture release in `packages/fake/fixtures.ts` takes a body in
  the new shape.
- No Rust changes and no new command: the body is still stored as GitHub served it.

## 8. The backfill

Two steps, the second only on the owner's word.

1. **Files.** `node scripts/changelog/cli.mjs backfill` runs the generator over every `v*` tag
   that has no file yet, oldest first, and writes `changelog/<version>.md` — 48 files, 0.2.0 to
   0.43.0, both drafts included. It can be stopped and started again. `cli.mjs tag v0.41.0
   --force` writes one again. The files land in this feature's pull request. The whole run is
   expected to cost well under one dollar.
2. **Release bodies.** `node scripts/changelog/cli.mjs push <version>…` sets a published
   release's body from its file. For the backfill it is run over the 46 published releases;
   v0.5.0 and v0.34.0 are refused because they are drafts. Each release's current body is saved
   to a local folder first, and is in `CHANGELOG.md` besides.

`push` is also how a published note is corrected later: change the file in a pull request, then
push that version.

## 9. Fences and tests

- **`scripts/changelog/*.test.mjs`** — the two subject forms and what is not one; a number that
  is an issue; a release PR skipped; the cut at 6,000 characters; each of the four checks, with
  an answer that breaks it; the retry; the rendering of every section, of an empty section and
  of a maintenance release.
- **`scripts/release-rule.test.mjs`** — nine jobs. The seven keep `ON_A_RELEASE`; the two new
  ones carry the opposite condition, to the letter; nothing needs them. `MAY_READ` gains
  `changelog-write` (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) and `changelog-commit`
  (`GITHUB_TOKEN`). Three jobs name an environment, and `changelog-write` names `changelog`.
  `RUNS` gains every line `changelog-write` runs. Both new jobs have a deadline.
- **`packages/ui/lib/releaseNotes.test.ts`** — a body in the new shape draws as headings and
  lists, and a maintenance release as its one line; the references are dropped at the end of a
  bullet and kept in the middle of a sentence.
- **Before the backfill**, one real run against 0.43.0, read by hand against its pull requests.

## 10. Documentation, in the same commit

- `.github/CLAUDE.md` — the two jobs, the `changelog` environment, the step in `publish`.
- `docs/reference/ci-and-releases.md` — the release rule's table and *What only the owner can do*.
- `docs/reference/in-app-updates.md` — where the body comes from and what the reader expects.
- `docs/agent/WORKFLOW.md` — **a pull request's description is now what the release notes are
  written from**: it opens with what changes for a person using the app, or says plainly that
  nothing does.

## 11. What only the owner can do

- Create an OpenRouter API key with a spend limit.
- Create the `changelog` environment, restrict it to `main`, and add the key as
  `OPENROUTER_API_KEY`.
- Export the same key in a shell for the backfill.
- Say when the 46 release bodies may be rewritten.

## 12. What can go wrong

- **The model says something false.** The checks hold it to the pull requests it was given, not
  to the truth. The owner's read of the file in the release PR is the gate.
- **`changelog-write` fails** — OpenRouter is down, or the checks fail twice. That push's Release
  run is red, and the release branch has no file, or an older one if release-please did not
  rebuild it. The commit message names the `main` hash the notes were written from, so an old
  file can be told from a current one. Merging without one publishes release-please's notes.
- **A hand edit is lost** when `main` moves after it (§6).
- **A non-release run takes a minute or two** where it took seconds, and `concurrency: release`
  queues the next run behind it. A queued run that a newer push replaces is cancelled, as today,
  and the newer run does the same work.
- **The two jobs first run for real on `main`**, because `release.yml` runs nowhere else. They
  are built to fail without consequence: nothing waits on them.

## 13. Not in this design

- A changelog in the Android or the web app.
- More than the newest thirty releases in the app.
- Any change to `CHANGELOG.md`, `release-please-config.json`, or how a version is chosen.
- Drawing Highlights differently from the other sections in the app.
