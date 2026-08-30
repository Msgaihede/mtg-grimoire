import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SyncPanel } from "./SyncPanel";

const meta = {
  title: "Settings/SyncPanel",
  component: SyncPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window. The layout risk
    // here is a 105-character code and a 176-character blob, both of which are one unbreakable
    // word to a browser, and this is the width at which `break-all` either saves the row or does
    // not.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Two halves. **Devices** pairs two of them into one group with no account and no " +
          "password: one device shows a code, the other reads it, and both then show the " +
          "same six digits for the reader to compare. **Membership** is what pays for the " +
          "server those devices hand changes through — a Patreon connection, a claim code " +
          "pasted back, and one status line.\n\n" +
          "**The six digits are the whole security argument** (spec §7.5 step 3), and the " +
          "panel is built so that neither side can move past them without saying so: the " +
          "offering device's *Codes match* button carries `aria-disabled` until the digits " +
          "exist, and the joining device does not reveal the blob it has to carry back until " +
          "the reader has said the numbers agree. A panel that advanced on its own would look " +
          "completely normal and defend nothing.\n\n" +
          "**There is no cryptography in the workbench and these stories do not pretend " +
          "there is.** The fake derives the six digits from the code with a plain hash and " +
          "draws a QR-shaped picture rather than a readable code — see `FakePairing` in " +
          "`.storybook/fake/db.ts`. What is real is everything a panel is drawn against: the " +
          "two blobs carried by hand, the one number both readers compare, the store that " +
          "keeps a removed device the status command does not answer with, and every refusal " +
          "in the crate's own words.\n\n" +
          "**Nor is there a Patreon.** The fake mints a claim code's answer rather than " +
          "exchanging one, so what these stories hold still is the thing that matters here: " +
          "that *not connected*, *payment problem* and *membership ended* are three " +
          "different sentences, and that only one of them takes sync away.\n\n" +
          "**A membership belongs to the group and not to the device that paid for it** " +
          "(spec §2.2). Every device in a group with a live membership mints its own relay " +
          "token from the group key, holding nothing Patreon ever issued — so the second " +
          "device reads *Supporting since …* with no Connect button, in either pairing order. " +
          "`SupportingThroughTheGroup` is that state, and it is the one this panel drew wrong.",
      },
    },
  },
} satisfies Meta<typeof SyncPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A well-shaped pairing code: 105 Crockford characters, which is what the payload forces.
 *
 * 16-byte group id + 32-byte X25519 public key + 16-byte token = 64 bytes, at five bits a
 * character, is 103 — plus a two-character checksum. The alphabet omits `I`, `L`, `O` and `U`,
 * so this string is only made of characters a real code can contain.
 */
const A_CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".repeat(3) + "012345678";

/**
 * A device that has never paired — what every install opens on.
 *
 * Two presses and no roster: this device can offer a pairing, or read a code another device is
 * offering. The paragraph above them is what says why the six digits exist, because a reader
 * meeting them mid-flow has no time to be told.
 */
export const NotPaired: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/not paired with anything yet/i)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /pair a device/i })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /enter a code/i })).toBeInTheDocument();
    // Nothing to compare and nothing to remove: the roster is not drawn at all rather than
    // drawn empty, because an empty list of devices reads as a group that has lost them.
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument();
  },
};

/**
 * The offer, with nothing answered yet — **the state the whole security claim rests on**.
 *
 * The code is on screen in both forms and *Codes match* is already drawn, greyed, with the
 * sentence saying why. That is deliberate: a button that appeared only once the digits arrived
 * would teach a reader that the digits are a step the app inserts, rather than the step the
 * pairing is for.
 */
export const OfferShown: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /pair a device/i }));
    await expect(await canvas.findByTestId("pairing-qr")).toBeInTheDocument();

    const confirm = canvas.getByRole("button", { name: /codes match/i });
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText(/nothing to compare yet/i)).toBeInTheDocument();
    await expect(canvas.queryByTestId("pairing-sas")).not.toBeInTheDocument();
  },
};

/**
 * The other device has answered, so both screens now show one number.
 *
 * Drawn at `text-3xl` with `tracking-[0.3em]` and `tabular-nums`, which is the one place in
 * this app a number is set that large: the reader is comparing *characters* across two screens,
 * and every one of those three choices is about making that a glance rather than a count.
 */
export const DigitsToCompare: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /pair a device/i }));
    await userEvent.type(
      await canvas.findByLabelText(/what the other device answered/i),
      "MNPQRSTVWXYZ0123456789ABCDEFGHJK",
    );
    await userEvent.click(canvas.getByRole("button", { name: /read their answer/i }));

    const digits = await canvas.findByTestId("pairing-sas");
    await expect(digits.textContent).toMatch(/^\d{6}$/);
    await expect(canvas.getByRole("button", { name: /codes match/i })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  },
};

/**
 * The last hand-carried hop: the wrapped group key, for the reader to take back.
 *
 * **This is the blob PR 7 deletes.** The relay carries it instead, and nothing else about the
 * flow moves — the crypto, the digits, the roster and the rotation are all this PR's. Until
 * then it is 176 characters in a box with a Copy button, which is a miserable thing to type and
 * exactly why §7.5 makes the QR primary.
 */
export const KeyToCarryBack: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /pair a device/i }));
    await userEvent.type(
      await canvas.findByLabelText(/what the other device answered/i),
      "MNPQRSTVWXYZ0123456789ABCDEFGHJK",
    );
    await userEvent.click(canvas.getByRole("button", { name: /read their answer/i }));
    await userEvent.click(await canvas.findByRole("button", { name: /codes match/i }));

    const blob = await canvas.findByLabelText(/wrapped key for the other device/i);
    await expect(blob).toHaveAttribute("readonly");
    await waitFor(async () => {
      await expect((blob as HTMLTextAreaElement).value.length).toBeGreaterThan(100);
    });
  },
};

/**
 * The joining half: read a code, compare the digits, and only then hand anything back.
 *
 * The gate here changes no protocol — the answer is already computed by the time the digits are
 * on screen — but a reader who has not looked at the digits has not compared them, and this is
 * the press that says they have.
 */
export const JoiningComparesFirst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /enter a code/i }));
    // **Pasted rather than typed, which is also what a reader does.** 105 characters is 105
    // keystrokes through `userEvent.type`, and the number is not incidental: it is what the
    // payload forces, and it is exactly why §7.5 makes the QR the primary form.
    await userEvent.click(await canvas.findByLabelText(/code the other device is showing/i));
    await userEvent.paste(A_CODE);
    await userEvent.click(canvas.getByRole("button", { name: /read the code/i }));

    await expect(await canvas.findByTestId("pairing-sas")).toBeInTheDocument();
    await expect(canvas.queryByLabelText(/your answer/i)).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /codes match/i }));
    await expect(await canvas.findByLabelText(/your answer/i)).toBeInTheDocument();
  },
};

/**
 * A code of the wrong length, refused in the crate's own words.
 *
 * **This refusal is reachable from a keyboard, which is why it is not a fault.** Half a paste is
 * the commonest thing that goes wrong with a 105-character code, and the sentence has to say
 * *that* rather than "pairing failed" — a different sentence pointing at a different fix.
 */
export const CodeRefused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /enter a code/i }));
    await userEvent.type(await canvas.findByLabelText(/code the other device is showing/i), "ABC");
    await userEvent.click(canvas.getByRole("button", { name: /read the code/i }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(/105 characters/i);
    await expect(canvas.queryByTestId("pairing-sas")).not.toBeInTheDocument();
  },
};

/**
 * The one refusal in this flow a reader cannot produce by typing.
 *
 * Every other way it can fail is a *shape* — a code of the wrong length, a character outside the
 * alphabet, a step pressed out of order — and all of those are raised by the handler itself.
 * What is left is the blob failing to open, which in the crate is an AEAD refusing to
 * authenticate. So it is a fault, and it lands on this one step.
 */
export const AnswerUnreadable: Story = {
  parameters: { fake: { fault: "pairingReadError" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /pair a device/i }));
    await userEvent.type(
      await canvas.findByLabelText(/what the other device answered/i),
      "MNPQRSTVWXYZ0123456789ABCDEFGHJK",
    );
    await userEvent.click(canvas.getByRole("button", { name: /read their answer/i }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(/could not be read/i);
    // The code is still on screen and the offer is still live: a refusal here has changed
    // nothing, and the reader can paste again.
    await expect(canvas.getByTestId("pairing-qr")).toBeInTheDocument();
  },
};

/**
 * A group of three, one of them taken off — the state §7.6 is about.
 *
 * **The removed device is on the roster and off the screen.** The `paired` seed still holds it,
 * because the backend still does — `add_device` clears the mark on a re-pair and the baseline
 * trigger reads it — and this story is where that separation is asserted. The key version beside
 * the group is `2` because the rotation *is* the removal, so the number is a count of them.
 *
 * **One mark per row, and it is `This device`** — orientation, the thing a reader scans a roster
 * for, and the question a real machine name leaves open once the rows stop reading identically.
 *
 * The two names here are what a reader who has renamed their devices sees. What a fresh
 * install mints is the machine itself — `MAIN-PC` on Windows, `OnePlus 12` on Android, a label
 * like `Chrome on Windows` in a browser — and `Rename` is the one press away from either.
 */
export const Paired: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText("Phone")).toBeInTheDocument();
    // The removed device is on the roster the backend holds and off the list the panel draws.
    // A reader who removed a device asked for it to be gone; the row survives only so a
    // re-pair can clear the mark and so the baseline trigger skips a peer that will not answer.
    await expect(canvas.queryByText("Old laptop")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Removed")).not.toBeInTheDocument();
    // Two of three, and the key version is still 2 — the epoch counts rotations, and the
    // rotation happened. The seed's third row is what stops the line above being vacuous.
    await expect(canvas.getByText(/in a group of 2, at key version 2/i)).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: /remove old laptop/i }),
    ).not.toBeInTheDocument();
    // This device offers no Remove either, because the backend refuses it.
    await expect(canvas.queryByRole("button", { name: /remove desk/i })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /remove phone/i })).toBeInTheDocument();

    // One pill, on one row, beside the name it belongs to — and never beside the buttons.
    const pill = canvas.getByText("This device");
    await expect(canvas.getAllByText("This device")).toHaveLength(1);
    await expect(pill).toHaveClass("rounded-full");
    const group = pill.parentElement as HTMLElement;
    await expect(within(group).getByText("Desk")).toBeInTheDocument();
    await expect(within(group).queryByRole("button")).not.toBeInTheDocument();
  },
};

/**
 * **A hostname long enough to fight the row — and the press that gets a reader out of one.**
 *
 * Two things are being drawn here at once. The pill has to stay against the end of the name at
 * every length: the name truncates and the group it shares with the pill takes the row's
 * stretch, so a 26-character machine name shortens rather than shoving `This device` and both
 * presses off the row. That failure is invisible to a screenshot of a short name, which is why
 * this story exists beside `Paired` rather than instead of it.
 *
 * The other half is `Rename` itself. A minted name is the machine's own — on Windows frequently
 * the owner's — and `sync_identity.name` is the copy every later pairing sends to every device
 * in the group. So the escape hatch is one press, on this device's own row, and it stayed there
 * when the pill arrived.
 */
export const ALongMachineNameStillFitsTheRow: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // This device's own row still offers Rename — it is the first in the roster.
    const renames = await canvas.findAllByRole("button", { name: "Rename" });
    await userEvent.click(renames[0]);
    const field = await canvas.findByLabelText(/name for desk/i);
    await userEvent.clear(field);
    await userEvent.type(field, "MARKUS-DESKTOP-WORKSTATION{Enter}");

    const renamed = await canvas.findByText("MARKUS-DESKTOP-WORKSTATION");
    await expect(renamed).toHaveClass("truncate");
    // Still the name's sibling, and still ahead of the presses.
    const pill = canvas.getByText("This device");
    await expect(pill.parentElement).toBe(renamed.parentElement);
    await expect(within(pill.parentElement as HTMLElement).queryByRole("button")).not
      .toBeInTheDocument();
  },
};

/**
 * The sentence a removal owes, and the press behind it.
 *
 * §7.6: *"It cannot be un-told what it already knows."* Rotating the key stops the removed
 * device reading anything **new**; nothing here can reach into it and take back what it already
 * synced, and no server has a copy to delete. A dialog that said only "Remove" would imply a
 * lost phone had been wiped, which is the opposite of what happens.
 *
 * It goes all the way down: the press rotates the fake's key and the panel re-reads it, so the
 * version beside the group moves from 2 to 3 on screen and the row goes with it. **The row
 * leaving is the assertion worth having**, because the backend still holds it — `sync_devices`
 * keeps the stamp and `sync_pairing_status` filters it — so this is the one story where a
 * removal is watched happening rather than read out of a fixture.
 */
export const RemovingSaysWhatItCannotDo: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The dialog draws at the app root, so its body is outside the panel's canvas.
    const page = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole("button", { name: /remove phone/i }));
    await expect(await page.findByText(/changes the key your devices share/i)).toBeInTheDocument();
    await expect(page.getByText(/cannot reach into it/i)).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: /remove device/i }));
    await expect(await canvas.findByText(/in a group of 1, at key version 3/i)).toBeInTheDocument();
    // The row is gone from the screen, and it is gone from the *panel* rather than from the
    // store: the fake still holds the stamped row, exactly as `sync_devices` does.
    await expect(canvas.queryByText("Phone")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Removed")).not.toBeInTheDocument();
  },
};
/* -------------------------------------------------------------- the membership ---------- */

/**
 * The claim code the relay's landing page shows, in the shape it shows it.
 *
 * Crockford base32 with a positional checksum, reusing `sync_pair::invite`'s alphabet — which
 * omits `I`, `L`, `O` and `U` precisely because this string is copied between two screens by a
 * person. Twelve characters in three groups is short enough to type and long enough to be
 * one-time; the ten-minute expiry at the far end does the rest.
 */
const A_CLAIM_CODE = "PQRS-TVWX-YZ01";

/**
 * Nothing connected — **which is what every installation opens on.**
 *
 * Two presses and one field: open Patreon, then paste back what its landing page gives you.
 * *Not connected* is a state and not a fault, so it is said plainly and the reassurance a lapse
 * gets is deliberately absent — a reader who has never connected has lost nothing, and telling
 * them their collection is safe teaches them there is something to worry about.
 *
 * There is no *Sync now* either. `sync_now` with no entitlement answers `null` rather than
 * refusing, so the press would be harmless — and a control that can only ever report
 * "there was nothing to do" is one a reader learns to distrust.
 */
export const NotConnected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/not connected/i)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
    await expect(canvas.getByLabelText(/claim code/i)).toHaveValue("");
    await expect(canvas.getByText(/sync is off/i)).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
    // The lapse copy belongs to a lapse. This reader has not had one.
    await expect(canvas.queryByText(/stays on this device/i)).not.toBeInTheDocument();
    // **The one warning that does belong here**, because it is about the press below it:
    // connecting founds a group of one, and a device in a group can never join another.
    await expect(canvas.getByText(/pair this one to them first/i)).toBeInTheDocument();
  },
};

/**
 * The claim, pasted back — and the membership it switches on.
 *
 * **The code is the whole of the hop back into the app.** Patreon's consent and the token
 * exchange both happen where the `client_secret` can live, which is the relay; what returns to
 * the reader is twelve characters on a page, and pasting them is the only step this window owns.
 *
 * Once it lands the block says *Supporting since …* with a date rather than "3 days ago": a
 * start date is a fact about a subscription, where the app's relative-time rule is about
 * freshness.
 */
export const Supporting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText(/claim code/i));
    await userEvent.paste(A_CLAIM_CODE);
    await userEvent.click(canvas.getByRole("button", { name: /^connect$/i }));

    await expect(await canvas.findByText(/supporting since/i)).toBeInTheDocument();
    // Connected, so the two presses that were the whole block are gone and sync has one.
    await expect(canvas.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
    // ...and the advice about *which* device to connect on goes with the press it was about.
    await expect(canvas.queryByText(/pair this one to them first/i)).not.toBeInTheDocument();
  },
};

/**
 * **The second device — supporting on somebody else's membership, and never asked to connect.**
 *
 * This is the reader's own bug report (2026-08-30) and spec §2.2's answer to it. A phone paired
 * to a desktop whose reader pays holds **no refresh secret at all**: the pairing blob stopped
 * carrying one, because a device that holds it could re-register the group auth and evict the
 * devices that removed it. What it holds instead is the group key, and `crypto::relay_auth` is
 * one-way from that — so `/token`'s second door mints this device a token of its own, and the
 * answer carries `status` and `since` with it. Hence a **dated** *Supporting since …* rather
 * than the dateless *Supporting. Thank you.* the old sealed grant left behind.
 *
 * **What this story exists to hold still is the button that is not there.** *Connect Patreon*
 * drawn here is the whole of what the reader reported: a supporter told, on every device but
 * the one they pressed it on, that they are not connected. The sentence alone would not catch
 * it — the bug drew *Not connected* **and** the button, so a story asserting only the absence of
 * the button, or only the presence of the sentence, would pass against half of it.
 *
 * **It is a fault rather than a press for `patreonLapsed`'s reason**: the entitlement is another
 * device's and it reaches this one over a relay the workbench has not got. It differs from that
 * lapse in exactly one stored field — `active` against `dead` — which is why `db.ts` derives
 * `entitled` instead of storing it.
 */
export const SupportingThroughTheGroup: Story = {
  parameters: { fake: { seed: "paired", fault: "patreonGroupEntitled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/supporting since/i)).toBeInTheDocument();
    // **The half the bug got wrong.** Both presses of the `offering` block are gone: the button
    // and the field it sits above, because neither has anything to do on a device that is
    // already covered.
    await expect(canvas.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText(/claim code/i)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/not connected/i)).not.toBeInTheDocument();
    // ...nor the lapse, which is the state this one is a single stored field away from.
    await expect(canvas.queryByText(/membership ended/i)).not.toBeInTheDocument();
    // And it can sync, which is what the group door was built to give it — the difference
    // between a panel that merely reads right and a device that actually works.
    await expect(canvas.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
    // The advice about which device to connect on goes with the press it was about.
    await expect(canvas.queryByText(/pair this one to them first/i)).not.toBeInTheDocument();
    // Still in the group it is entitled through, at the key version the removal left.
    await expect(canvas.getByText(/key version 2/i)).toBeInTheDocument();
  },
};

/**
 * A code that has already been spent, refused in the crate's own words.
 *
 * **This refusal is reachable by an ordinary reader, which is why it is not a fault.** A claim
 * code is one-time and expires in ten minutes, so pasting yesterday's — or the same one twice
 * after a reinstall — is the commonest thing that goes wrong here, and the sentence has to say
 * *that* rather than "claim failed": a different sentence pointing at a different fix, which is
 * pressing Connect Patreon again.
 */
export const ClaimCodeRefused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText(/claim code/i), "ABCD");
    await userEvent.click(canvas.getByRole("button", { name: /^connect$/i }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(/code/i);
    // Refused, so the reader is still where they were — including the code still in the field,
    // because a code that was mistyped is one keystroke from being right. Only a claim that
    // *worked* clears it.
    await expect(canvas.getByLabelText(/claim code/i)).toHaveValue("ABCD");
    await expect(canvas.getByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
  },
};

/**
 * A card Patreon is still retrying — **and sync that keeps working through it.**
 *
 * Spec §7.2: `declined_patron` is a failed card, not a decision. It opens a seven-day grace
 * window in which tokens are still minted, so the one thing this story exists to hold is the
 * *Sync now* button being on screen. Taking sync away here would punish a reader for something
 * they did not choose, and the sentence would be teaching them to cancel.
 *
 * It must also not read as a cancellation: *Membership ended* is a different state with a
 * different fix, and the two are one field apart in the answer this panel is drawn from.
 */
export const PaymentProblem: Story = {
  parameters: { fake: { seed: "paired", fault: "patreonDeclined" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/payment problem/i)).toBeInTheDocument();
    await expect(canvas.getByText(/keeps working/i)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/membership ended/i)).not.toBeInTheDocument();
  },
};

/**
 * The lapse — **the state this whole block is worth having for.**
 *
 * §7.1: cancelling drops the relay's log at once, and the relay's log is a transport buffer with
 * a 30-day tail rather than anybody's collection. Every device already holds the whole thing in
 * its own SQLite. So the panel says *Membership ended*, says in the next breath that nothing
 * local was touched, and offers the connect button again.
 *
 * **What it must never say is that something went wrong.** "Could not reach the relay" points a
 * reader at their network when the fix is their pledge, and a reader who lapses and reads it as
 * data loss is the one failure in this design that cannot be undone by connecting again.
 */
export const MembershipEnded: Story = {
  parameters: { fake: { seed: "paired", fault: "patreonLapsed" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/membership ended/i)).toBeInTheDocument();
    await expect(canvas.getByText(/stays on this device/i)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/could not|failed|error/i)).not.toBeInTheDocument();
    // The devices stay paired through a lapse, which is what makes reconnecting one press.
    await expect(canvas.getByText(/key version 2/i)).toBeInTheDocument();
  },
};

/**
 * Connecting before pairing — **which founds a group of one** (spec §6.3).
 *
 * `sync_patreon_claim` runs `ensure_group` before the request that has to name a group, so a
 * reader who connects Patreon on a device that has never paired does not end up with an
 * entitlement bound to nothing: they end up in a group of themselves, at key version 1, with a
 * roster where the pairing offer was a moment ago.
 *
 * **That is why the panel's *nowhere to sync to yet* line is not what a new supporter sees.**
 * `RelayStatus.paired` is `identity::group(conn).is_some()`, and a group of one satisfies it —
 * so the sentence a fresh connection lands on is *Nothing has synced yet*, and the reader's next
 * step is Pair a device rather than anything about the relay. The panel keeps the *unpaired*
 * sentence for a state the shipped build can no longer reach; see this task's report.
 */
export const ConnectingBeforePairing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/not paired with anything yet/i)).toBeInTheDocument();

    await userEvent.click(await canvas.findByLabelText(/claim code/i));
    await userEvent.paste(A_CLAIM_CODE);
    await userEvent.click(canvas.getByRole("button", { name: /^connect$/i }));

    // A group of one, made by the claim rather than by a pairing press.
    await expect(await canvas.findByText(/in a group of 1/i)).toBeInTheDocument();
    await expect(canvas.getByText(/nothing has synced yet/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/nowhere to sync to yet/i)).not.toBeInTheDocument();
  },
};

/**
 * A group, a membership, and one round trip.
 *
 * The `paired` world has **three changes written and never handed over**, which is where a
 * reader stands after pairing and before connecting, so the *waiting* line has something true to
 * say the moment the claim lands and the trip has something to send.
 *
 * There is no network in the workbench and this story does not pretend there is: what the fake
 * models is the shape of the answer — everything waiting goes, nothing comes back, and the stamp
 * moves. The two outcomes spec 7.4 surfaces are seeded rows in the `needsReview` world rather
 * than something a press invents; see `Settings/ReviewPanel`.
 *
 * **This press is also this device's first exchange**, so the line carries the baseline's two
 * sentences as well — which is not a leak between stories but the shape of the real thing: a
 * reader's first press after connecting is both trips at once, and it is exactly the press the
 * baseline clause exists to explain. `AFirstExchange` below is that half on its own, and takes
 * the second press to show the ordinary trip after it.
 */
export const OneRoundTrip: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText(/claim code/i));
    await userEvent.paste(A_CLAIM_CODE);
    await userEvent.click(canvas.getByRole("button", { name: /^connect$/i }));
    await expect(await canvas.findByText(/3 changes waiting to go/i)).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /sync now/i }));

    await expect(
      await canvas.findByText(/sent 3 changes and received 0 changes/i),
    ).toBeInTheDocument();
    // The pile is empty and the stamp has moved, so both lines change together.
    await expect(canvas.getByText(/nothing is waiting to go/i)).toBeInTheDocument();
    await expect(canvas.getByText(/last synced just now/i)).toBeInTheDocument();
  },
};

/**
 * The first exchange with a device that had not heard from this one — and the ordinary trip
 * right behind it.
 *
 * **A baseline is three orders of magnitude larger than the sync around it** (baseline spec §13:
 * 1 069 rows against the four or nine a press usually carries), so a number that size with no
 * sentence attached reads as a fault. The panel says what it is instead, and names the
 * `deck_audit` rows on their own — §7's reason: history is the one synced table with no ceiling,
 * so it is the part of the total that can surprise, and a reader told only the sum cannot tell a
 * large collection from a long one.
 *
 * **The second press is the whole point of the first two clauses being conditional.** A baseline
 * goes to each peer once, so every sync a reader ever makes but one says nothing about it — and
 * a panel that kept the sentence would teach them the number was about this trip.
 *
 * There is no relay here and no peer to have never been heard from, so the fake stands the state
 * up out of the one fact the world does hold: a device that has never completed a round trip.
 * The counts are the world's own eleven synced tables read back rather than figures written for
 * the sentence, which is why nothing here asserts a particular one.
 */
export const AFirstExchange: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText(/claim code/i));
    await userEvent.paste(A_CLAIM_CODE);
    await userEvent.click(canvas.getByRole("button", { name: /^connect$/i }));
    await userEvent.click(await canvas.findByRole("button", { name: /sync now/i }));

    const line = await canvas.findByText(/first exchange with a device/i);
    await expect(line).toHaveTextContent(/everything here went across — \d+ rows/i);
    await expect(line).toHaveTextContent(/\d+ of those are deck history/i);

    await userEvent.click(canvas.getByRole("button", { name: /sync now/i }));

    // The pile went with the first press, so the second is a trip with nothing in it — which is
    // what makes the absence below an assertion about the clause rather than about the render.
    await waitFor(async () => {
      await expect(canvas.getByText(/sent 0 changes and received 0 changes/i)).toBeInTheDocument();
    });
    await expect(canvas.queryByText(/first exchange/i)).not.toBeInTheDocument();
  },
};

/**
 * A sync holding the write connection — **and both of this block's reads refused at once.**
 *
 * `sync_relay_status` and `sync_supporter_status` each take `sync::with_write` in the crate, so
 * both really do answer `BUSY` while a card update is in flight — the second by the crate's own
 * choice, so that it cannot answer from beside a claim that has just written. They are two
 * queries over one connection, so in practice they fail together.
 *
 * **What the panel must not do is guess.** Drawing the block empty would read exactly like a
 * membership that has never been connected — *Not connected*, with a Connect Patreon button
 * inviting a reader who is already a supporter to claim a second time — and drawing "Nothing is
 * waiting to go" over an unanswered count would be the same mistake one line down. Both are
 * withheld here, and the one sentence on screen is what is true: nobody knows yet.
 */
export const TheReadsAreRefused: Story = {
  parameters: { fake: { seed: "paired", fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/could not be read/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/not connected/i)).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: /connect patreon/i }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByText(/nothing is waiting to go/i)).not.toBeInTheDocument();
  },
};
