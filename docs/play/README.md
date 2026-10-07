# Google Play — what is pasted into the Console

Everything Play Console asks for about **MTG Grimoire** (`com.mtggrimoire.app`), written down so
filling the Console is pasting. The order is the Console's own. The design is
`docs/superpowers/specs/2026-10-07-google-play-release-design.md`; the release side is
`docs/reference/ci-and-releases.md`, *What only the owner can do*.

**Two rules for the listing — its text, its graphics and its screenshots:** nothing names
Patreon, a membership, a price of the app or a way to pay — Play forbids an app to lead a
reader to a payment made elsewhere — and nothing claims to be official. **Two store
fields lead to something that names Patreon**: the privacy policy, which says as a fact about
data what the relay stores when a membership was connected from another install, and links
nowhere; and the Website field, because the web app's own Sync panel offers the membership —
that is the web app, not this listing. The owner publishes both knowing that.

## The order

Only the owner signs in, creates, accepts, sets a secret or submits.

1. **Create the app** in Play Console: *MTG Grimoire*, app, free. When the first release is created
   the Console offers Play App Signing: accept it, with a Google-generated key. Start collecting twelve testers' Google account addresses now — it
   is the longest wait here.
2. **The upload key**: restrict the `release` environment to `main`, make the key, commit its
   fingerprint and merge that pull request, set the three Android values, back the keystore
   up — `docs/reference/ci-and-releases.md`, *What only the owner can do*. **The web app's
   deploy is a separate pair of values** in the same runbook (`CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`): with them set a release deploys the web app; without them it
   does not, and the web app is deployed by hand from the tag (`app-worker/README.md`).
3. **Merge the three changes, then the release PR.** The run leaves the signed bundle as the
   artifact `play-upload-bundle`. The privacy policy goes live with the web app's deploy —
   the release's own, or the one made by hand.
4. **Ask the live address**, before anything links to it:

   ```powershell
   curl.exe -s https://mtg-grimoire.app/privacy | Select-String -SimpleMatch -Quiet "<h1>MTG Grimoire privacy policy</h1>"
   ```

   It prints `True`. If it prints nothing, the host is answering something else — the app, or a
   plain "Not found" because the web app has not been deployed yet: stop here, paste no privacy address anywhere, and open an issue. `/privacy.html` is no way
   round it — the host redirects that address to `/privacy`.
5. **Internal testing**: first set the privacy policy's address in the Console (*Policy* →
   *App content* → *Privacy policy*): the bundle asks for the camera, and the Console wants a
   policy on file for that. Then upload the bundle — the first upload registers the upload certificate
   and fixes the package name for good. Install from Play on a phone. Check the launcher's
   icon is the book, and that Settings → Sync offers pairing and nothing about a membership.
   Take the five screenshots. If the phone has a build from a CI artifact on it, uninstall
   that first — Play cannot install over a debug-signed build, and the uninstall wipes that
   build's collection and its pairing. To install from the internal track, add your own Google
   account to the track's tester list and open its opt-in link on the phone.
6. **Fill the listing and *App content*** from the sections below.
7. **Closed testing**: create the track, add the testers, roll the same bundle out, send the
   opt-in link. Twelve stay opted in for fourteen days running.
8. **Apply for production**, answer Google's questions about the test, wait for the review,
   create the production release.

After that, every release: download `play-upload-bundle` from the release's run, upload it to
the track, roll it out.

## Store listing → Main store listing

| Field | Limit | Text |
| --- | --- | --- |
| App name | 30 | `MTG Grimoire` |
| Short description | 80 | `Track your Magic: The Gathering collection, build decks, and search every card.` |

**Full description** (limit 4000):

```text
MTG Grimoire is a collection tracker and deck builder for Magic: The Gathering. It keeps the
whole card database on your phone, so searching, building and browsing work offline.

SEARCH EVERY CARD
• The full card database, with every printing
• Scryfall's search syntax: type, colour, cost, rules text, format legality and more
• Card pictures, kept on your device once you have seen them

TRACK YOUR COLLECTION
• Record what you own, down to the printing, finish and condition
• Organise cards into folders
• See what your collection is worth, with prices from Card Kingdom or Mana Pool

BUILD DECKS
• Build for Commander and the other constructed formats, with legality checked as you go
• See which cards in a deck you already own
• Keep a wishlist of what you still need

YOUR DATA STAYS YOURS
• No account, no advertising, no tracking
• Everything you record is stored on your device
• Pair your phone with MTG Grimoire on your computer to keep your devices in step, end-to-end
  encrypted

MTG Grimoire is free and open source.

MTG Grimoire is unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
Coast. ©Wizards of the Coast LLC. Card data and images are provided by Scryfall.
```

Before pasting, check each bullet against the build being listed: the description must not
claim a feature the phone face does not have. The last paragraph is Wizards of the Coast's own
required wording and is not to be edited.

| Graphic | Requirement | File |
| --- | --- | --- |
| App icon | 512×512 PNG | `docs/play/listing-icon-512.png` |
| Feature graphic | 1024×500, no alpha | `docs/play/feature-graphic-1024x500.jpg` |
| Phone screenshots | 2–8, JPEG or 24-bit PNG, each side 320–3840px, the longer side at most twice the shorter | taken on a phone — below |

Both graphics are rendered by `node scripts/light-icons.mjs` from `logos/svg/mtg-grimoire-mark.svg`.

**Screenshots.** Taken on a phone from the internal-testing install, because Play requires them
to show the app as it is. Five, in this order:

1. Search — a wall of results for a recognisable query, such as `t:dragon`.
2. A card's sheet, open over the results.
3. A deck — its list, with the Owned count showing. A row is marked only where a copy is
   missing or a rule is broken, so a legal, owned deck shows no marks.
4. The collection — a folder with its value.
5. Settings → Sync on a paired phone, showing the devices list.

A tall phone's screenshot (1080×2400) is longer than twice its width; if the Console refuses
one, crop it to 1080×2160.

Before each: no notification icons worth hiding, a full battery and a plain clock (Android's
*Demo mode* under Developer options does all three). Never a screenshot showing a real pairing
code.

## Store listing → Store settings

| Field | Value |
| --- | --- |
| App or game | App |
| Category | Tools |
| Tags | leave empty |
| Email address | `markus@seerup.com` — published on the listing |
| Website | `https://mtg-grimoire.app` |
| Privacy policy | `https://mtg-grimoire.app/privacy` |

## App content

Each row is a declaration the owner makes. The reasons are the code's, read on 2026-10-07.

| Declaration | Answer | Why |
| --- | --- | --- |
| Privacy policy | `https://mtg-grimoire.app/privacy` | — |
| Ads | No, the app does not contain ads | No ad code is in the build |
| App access | All functionality is available without special access | No sign-in exists. Add the note below |
| Content rating | Complete the questionnaire as a *Utility, productivity, communication or other* app. Violence: **yes, mild fantasy violence in images** — card art depicts fantasy combat and creatures. Everything else: no | The pictures are Wizards of the Coast's card art; answering "none" is what gets a rating challenged |
| Target audience | Ages 13–15, 16–17 and 18 and over. Not designed for children | The app is not directed at children; the game's own packaging says 13+ |
| News app | No | — |
| Data safety | Below | — |
| Government app | No | — |
| Financial features | None | Prices shown are a list from a card shop, not a financial service |
| Health | None | — |
| Advertising ID | The app does not use an advertising ID | No such permission is in the manifest |

**App access — the note for reviewers:**

```text
MTG Grimoire needs no account and no sign-in; every feature is available immediately.

On first launch the app downloads the public card database (about 80 MB) before search works.
On a metered connection it asks first.

Settings > Sync is optional and cannot be turned on from inside this app: it only joins this
device to a group of the user's own devices that already sync, by a one-time code shown on one
of them. Nothing is sold in this app, and every other feature works without it.
```

### Data safety

Google counts data as *collected* when it leaves the device, and does not count data that is
end-to-end encrypted so that the developer cannot read it.

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | Sync, when a reader turns it on, sends the relay a device identifier |
| Is all of the user data collected by your app encrypted in transit? | Yes | Every host the engine asks is an `https://` constant in `crates/grimoire-core`, and the relay's socket is `wss://`; a release build also sets `usesCleartextTraffic="false"` |
| Does your app allow users to create an account? | No | The app has no accounts; pairing links a user's own devices and creates no login |
| Do you provide a way for users to request that their data is deleted? | Yes | The privacy policy's *Removing your data* and its contact. The Console asks for an address: `https://mtg-grimoire.app/privacy` |

**Data types — declare one:**

| Type | Collected | Shared | Processed ephemerally | Required or optional | Purpose |
| --- | --- | --- | --- | --- | --- |
| Device or other IDs | Yes | No | No | Optional — only if the reader pairs devices | App functionality |

Everything else: **not collected**. In particular:

- *App activity, App info and performance, Personal info, Photos and videos, Files and docs,
  Location, Contacts, Financial info, Messages, Audio, Calendar, Health, Web browsing*: none
  leaves the device. The camera's pictures are examined on the device and discarded.
- **A reader's collection and decks do leave the device when sync is on, and are not declared**:
  they are encrypted with a key only the reader's own devices hold, which is the exemption
  above.
- The requests for card data go from the device straight to Scryfall, Commander Spellbook,
  Card Kingdom and Mana Pool and carry nothing about the reader's collection or decks. Each
  sees the request's IP address, as the privacy policy says.

**The one judgement in this section**, for the owner: Cloudflare keeps a log of each request to
the relay in his own account for up to seven days (`observability` is on in
`relay/wrangler.jsonc`), and a log line holds the group identifier, in the request's path,
beside the request's IP address. The privacy policy says so. Declaring *Device or other IDs*
covers the identifier. Turning request logs off for the relay
(`"observability": { "enabled": true, "logs": { "invocation_logs": false } }`, then a relay
deploy — his alone) stops the line Cloudflare writes for each request, which is the one that
holds the address and the path. The lines the relay writes itself when something fails are
still kept for the seven days; one of them names a membership's Patreon user id. So the
policy's sentence about the log is then reworded, not dropped — or `"enabled": false` keeps
no log at all, and the sentence can go.

## Testing → Closed testing

A personal developer account created after 13 November 2023 must run a closed test with **12
testers opted in for 14 days running** before production can be applied for.

- Testers are added by Google account address, as an email list on the track.
- Send each the track's opt-in link; they must accept it and install from Play.
- A tester who opts out inside the fourteen days can drop the count below twelve and restart
  it. Recruit a few more than twelve.
- Tell testers the truth about sync: it pairs with another install they already have, and the
  app is complete without it. `https://mtg-grimoire.app` is the same app in a browser.
- Applying for production asks how the test went. Keep notes of what testers reported and
  what changed.
