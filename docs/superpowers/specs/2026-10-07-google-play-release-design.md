# Google Play release — design

**Date:** 2026-10-07 · **Tracks:** issue #761 (the light app) · **Status:** awaiting the owner's review

## 1. Goal

MTG Grimoire's light app is installable from Google Play, under `com.mtggrimoire.app`, from the
owner's personal developer account, and every later release reaches Play from the same tag as the
desktop and the web app.

Success is: the app is in production on Play; a release run leaves a bundle Play accepts as an
update; nothing in the Play build can earn a payments-policy strike.

## 2. Decisions (the owner's, 2026-10-07)

| Question | Decision |
| --- | --- |
| Distribution | **Play only.** No APK on a GitHub release. Sideloaders use `https://mtg-grimoire.app`. |
| Signing | **Play App Signing with a Google-generated app signing key.** CI holds an *upload* key. |
| Paid sync on Play | **Pair-only.** The Play build offers no Patreon link, code field, price or wording. |
| Existing members on Play | No sign-in either. A member with only a phone connects in the phone's browser at `mtg-grimoire.app` and pairs the app with it. |
| Upload | **By hand first.** An API upload job is a later, separate change (§8). |
| Architectures | **arm64 only.** |
| Privacy policy | `https://mtg-grimoire.app/privacy`, a static page in the web bundle. |

## 3. What was found (read 2026-10-07)

- **No release key has ever existed.** No `mobile/src-tauri/release-signer.sha256`, no secret in
  the `release` environment, and v0.42.0 attached no APK. Nothing installed anywhere is signed by
  a key that must be kept.
- **The release builds an APK and signs it with `apksigner`** (`scripts/android-sign.sh`). Play
  takes an Android App Bundle, which `apksigner` does not sign.
- `targetSdk 36`, `minSdk 26`, 16 KB alignment and a `versionCode` that rises with the version
  (`scripts/release-rule.test.mjs`) already meet Play's rules.
- **The launcher icon is Tauri's stock logo** (`gen/android/app/src/main/res/mipmap-*`,
  `drawable*/ic_launcher_*.xml`). The app's own mark is in `mobile/src-tauri/icons/icon.png` and
  `mobile/public/icons/`, rendered by `scripts/light-icons.mjs`.
- **There is no privacy policy** in the repository or on the web app.
- **The Sync panel's *Connect Patreon*** is drawn by the shared `SupporterSection`
  (`src/features/settings/SyncPanelBody.tsx`) on every host, and on Android opens the system
  browser.
- **Google's Payments policy** (support.google.com/googleplay/android-developer/answer/9858738
  and its FAQ, answer/10281818): an app "requiring or accepting payment for access to in-app
  features or services" must use Play's billing system, and may not lead users to another payment
  method by "buttons, links, messaging... or other calls to action". A link to an account page is
  allowed only if it "does not eventually lead to an alternate payment method". Linking out is
  open to US users (and, separately, EEA users) only through programs that need enrolment, an API
  integration and transaction reporting. What is allowed everywhere: "A user could log in when the
  app opens and access content paid for somewhere else."
- **Patreon's Android app bills through Patreon**, not Play, so opening it is still leading a user
  to another payment method.
- **A personal account created after 13 November 2023** needs a closed test with at least 12
  opted-in testers for 14 continuous days before production can be applied for.

## 4. Piece A — the release builds and signs a bundle

**Build.** `release.yml`'s `android` job runs `npx tauri android build --aab --target aarch64 --ci`
and hands the `.aab` to the sign job as an artifact. It still holds no secret. It also holds the
bundle to its version before handing it over: `gen/android/app/tauri.properties` (what Gradle
reads) must carry the tag's version and Tauri's `versionCode` for it, or the job fails.

`ci.yml`'s `android` job builds the bundle as well as the APK it already builds (the emulator
workflow installs an APK), so a pull request that breaks the bundle is red before a release is.

**Sign.** The rule that a signing secret never sits in a build leg is unchanged. A new
`scripts/android-sign-bundle.sh` replaces `scripts/android-sign.sh`, which is removed with the
GitHub APK it existed for. It runs only JDK and SDK tools:

1. refuses a keystore whose certificate is an Android debug one;
2. refuses a keystore whose certificate is not the one `release-signer.sha256` names;
3. strips the build's debug signature from the bundle and signs it with `jarsigner`;
4. reads the signer back out of the signed bundle with a second tool and requires exactly one
   signer, equal to the keystore's certificate;
5. on any refusal exits non-zero and leaves no output file.

`ci.yml` proves the script on a throwaway key in every pull request that can change the bundle,
refusals included, as it does for the APK script today.

**The key is an upload key.** The three secrets keep their names (`ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`) and the alias stays `mtg-grimoire`.
`release-signer.sha256` stays the committed pin and now names the upload certificate. Google can
reset a lost upload key, so replacing the pin becomes a recoverable event rather than the end of
the listing; it is still a pull request somebody chose to open.

**Where the signed bundle goes.** `android-sign` uploads `mtg-grimoire-<version>-android.aab` as a
workflow artifact (30 days) and writes its `versionCode`, signer and the Console page to upload
it on into the run summary. It attaches nothing to the GitHub release, so its permission drops to
`contents: read`. With no key it ends green and says so, as today.

**The release rule.** `publish` still needs `android-sign`. What changes is the sentence, not the
graph: the tag *produces* all three hosts, and the Android one reaches phones when the owner
uploads it and Play has reviewed it. Android can trail the desktop and the web app by hours or
days; a device on an older build holds a newer op until it updates, which sync already does.

**Fences and docs that change with it:** `scripts/release-rule.test.mjs` (the job graph, the
commands a secret-holding job may run, no `gh release upload` in `android-sign`),
`mobile/host.test.ts`, `scripts/ci-route.mjs` and its test (the new script routes to `android`),
`.github/CLAUDE.md`, `mobile/CLAUDE.md`, the root `CLAUDE.md`'s "Android APK", and
`docs/reference/ci-and-releases.md` — the release rule and *What only the owner can do*.

## 5. Piece B — the Play build is pair-only

**The seam is the existing one**: a host answers a name or refuses it, and the page draws only
what it was handed (`src/lib/core/hostStorage.ts`, `light_downloads`). The page never learns what
kind of host it is on, so `mobile/phone/fence.test.ts` holds untouched.

- **One new name**, `membership_elsewhere`, declared beside `hostStorage.ts`. A host that answers
  it hands back its own sentences: sync turns on when this device is paired with one that already
  syncs, and where pairing is. A host that offers membership itself refuses the name.
- **The light Tauri host answers it** (`mobile/src-tauri`, a module beside `downloads.rs`), on
  Android and in its desktop debugging window alike — that host *is* the Play build, and answering
  everywhere lets the panel be driven in `mobile:tauri`. The desktop app and the web host refuse
  it and draw exactly what they draw today.
- **The same host refuses `sync_patreon_begin` and `sync_patreon_claim`** in `core_call`, in
  words, before the core's table is reached. No path opens Patreon even if the panel regressed.
- **`SupporterSection`, when a host answered**, draws the host's sentences in place of: the
  "funded by supporters on Patreon" sentence, the membership status line (*Supporting since…*,
  *Payment problem…*, *Membership ended*), the connect paragraph, the *Connect Patreon* button,
  the re-claim warning and the claim-code field. The relay figures, *Sync now* and the live state
  stay: they say whether sync works and none of them names a payment.
- **No controls while the question is unanswered**, which is this panel's existing rule for the
  membership read: a *Connect Patreon* that flashes before the host answers is the defect.
- **Both faces.** A tablet at 1024px or wider draws the desktop face inside the Play build, and
  its Sync panel is the same component, so the one seam covers it.
- **A sweep** for every other place a Play build can show Patreon, a membership or a supporter:
  the share menu's publishing gate (`ShareFolderMenu.tsx`), the settings search words (`nav.ts`),
  and anything the sweep finds. Each either is unreachable in the light edition or takes the same
  answer.

**Tests:** the panel with a host that answers and one that refuses (Vitest, and a Storybook fake
`fault`/seed so it can be driven at a phone's width); the host's two refusals and its answer
(cargo); and the existing desktop and web panel tests, unchanged, as the proof nothing moved there.

## 6. Piece C — what the store asks for

**Launcher icon.** `scripts/light-icons.mjs` grows the Android set from the mark it already
renders: an adaptive icon (`mipmap-anydpi-v26`, foreground and background layers inside the safe
zone), the legacy and round mipmaps at five densities, and the 512×512 listing icon. The stock
Tauri vectors are deleted. `mobile/host.test.ts` holds that the committed files are the script's
output on the manifest's ground colour, as it does for the web icons.

**Privacy policy.** A static document at `/privacy` in the web bundle: readable with no script,
styled under the bundle's `style-src 'self'`, and answered as itself — not by the service
worker's navigation fallback and not by the Worker's single-page fallback. `web:smoke` asks for it
and reads its heading. Settings links to it on both faces through `openExternal`, because Play
wants the link in the app as well as on the listing.

Its content is written from the code, not from memory, and the owner approves every sentence
before it merges, because it is his statement:

- what stays on the device (both databases, the image cache, the error log);
- every host the app asks, taken from the web policy's `connect-src` list in
  `app-worker/_headers`, and what each is sent;
- what the sync relay stores and for how long, read from `relay/`, including what a membership
  links to a group;
- the camera: asked for on first use, frames never leave the device;
- no ads, no analytics, no account with the app;
- how to remove data (leave a group, remove a device, reset) and an address to ask at.

**It goes live with a web deploy**, which is the next release. It must be live before the closed
test starts.

**The listing kit**, committed under `docs/play/` so the Console is filled by pasting:

- title, short description (80 characters), full description, ending with Wizards of the Coast's
  Fan Content Policy notice; no Patreon, no price, no "sync subscription";
- at least four phone screenshots and the 1024×500 feature graphic, rendered from the phone face
  by a script so they can be re-made;
- the answers for *App content*: ads (none), app access (nothing needs a login; reviewer notes on
  pairing), content rating, target audience, data safety (from the privacy policy's facts), and
  that the app creates no account.

## 7. Piece D — the owner's runbook

Only the owner signs in, creates, accepts, sets a secret or submits. In order:

1. **Now, in parallel with the code:** create the app in Play Console (*MTG Grimoire*, app, free),
   accept Play App Signing with a Google-generated key, and start collecting 12 testers' Google
   account addresses. Recruiting is the longest lead in this document.
2. Restrict the `release` environment to `main`, make the upload key, commit its fingerprint, set
   the three secrets, back the keystore up — `docs/reference/ci-and-releases.md`, rewritten by
   piece A for an upload key.
3. Merge A, B and C; merge the release PR. The run leaves a signed bundle and deploys `/privacy`.
4. **Internal testing:** upload the bundle (the first upload registers the upload certificate),
   install from Play on the owner's phone, check the icon and the pair-only panel.
5. Fill the store listing and *App content* from `docs/play/`.
6. **Closed testing:** create the track, add the testers, roll the same bundle out, send the
   opt-in link. Twelve must stay opted in for fourteen days running.
7. Apply for production, answer Google's questions about the test, wait for the review, then
   create the production release.

`com.mtggrimoire.app` is permanent from step 4.

## 8. Not in this design

- Play Billing for sync, the US and EEA link-out programs, and sign-in for existing members.
- An APK on a GitHub release, and any second signing key.
- `armv7` and `x86_64` in the store bundle.
- **Uploading to Play from CI.** After one release has gone through by hand: a job in the
  `release` environment that builds nothing and pushes the signed bundle to the internal track
  through the Play Developer API with a service account, promotion staying the owner's click. It
  gets its own short design then, because it cannot be exercised before the app exists.

## 9. Risks the owner is accepting

- **Review of the name and the card art.** "MTG" and Wizards' art are theirs; the listing carries
  the Fan Content Policy notice and many such apps are on Play, but a reviewer can still object.
- **A phone-only user cannot turn sync on inside the Play app.** That is the cost of pair-only.
- **Android trails the other hosts after each release** until the bundle is uploaded and reviewed.
- **The tester clock can reset** if opted-in testers fall below twelve inside the fourteen days.
