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
          "Pairing two devices into one group, with no account, no password and — in this " +
          "PR — no network at all. One device shows a code, the other reads it, and both then " +
          "show the same six digits for the reader to compare.\n\n" +
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
          "two blobs carried by hand, the one number both readers compare, the roster that " +
          "keeps a removed device on it, and every refusal in the crate's own words.",
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
 * **The removed device is still on the roster**, struck through and labelled, because a row that
 * was deleted could not answer "who did I take off, and when". The key version beside the group
 * is `2` for the same reason: the rotation *is* the removal, so the number is a count of them.
 *
 * **This is where the two marks are drawn side by side, and they are deliberately not the same
 * weight.** `This device` is a pill — orientation, the thing a reader scans a roster for, and
 * the question a real machine name leaves open once the rows stop reading identically.
 * `Removed` stays a plain word, because history that looked like status would compete with it,
 * and the struck-through name plus both missing presses already say what that row is.
 *
 * The three names here are what a reader who has renamed their devices sees. What a fresh
 * install mints is the machine itself — `MAIN-PC` on Windows, `OnePlus 12` on Android, a label
 * like `Chrome on Windows` in a browser — and `Rename` is the one press away from either.
 */
export const Paired: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText("Phone")).toBeInTheDocument();
    await expect(canvas.getByText("Old laptop")).toBeInTheDocument();
    await expect(canvas.getByText(/key version 2/i)).toBeInTheDocument();
    // Removed rows offer neither press: they are history rather than a control. This device
    // offers no Remove either, because the backend refuses it.
    await expect(
      canvas.queryByRole("button", { name: /remove old laptop/i }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /remove desk/i })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /remove phone/i })).toBeInTheDocument();

    // One pill, on one row, beside the name it belongs to — and never beside the buttons.
    const pill = canvas.getByText("This device");
    await expect(canvas.getAllByText("This device")).toHaveLength(1);
    await expect(pill).toHaveClass("rounded-full");
    const group = pill.parentElement as HTMLElement;
    await expect(within(group).getByText("Desk")).toBeInTheDocument();
    await expect(within(group).queryByRole("button")).not.toBeInTheDocument();

    // And the second mark is a word, not a second pill.
    await expect(canvas.getByText("Removed")).not.toHaveClass("rounded-full");
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
 * version beside the group moves from 2 to 3 on screen.
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
    await expect(await canvas.findByText(/key version 3/i)).toBeInTheDocument();
    await expect(canvas.getAllByText(/^removed$/i)).toHaveLength(2);
  },
};
/* ------------------------------------------------------------------ the relay ---------- */

/**
 * The relay half, switched off — **which is what every installation opens on.**
 *
 * An empty address is not a form waiting to be filled in, it is sync being off, and the panel
 * says so in words. A blank box with nothing beside it is unreadable in exactly the place it
 * matters: a reader cannot tell "off" from "not loaded yet".
 *
 * There is no *Sync now* either. `sync_now` over an empty address answers `null` rather than
 * refusing, so the press would be harmless — and a control that can only ever report
 * "there was nothing to do" is one a reader learns to distrust.
 */
export const RelayOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/sync is off/i)).toBeInTheDocument();
    await expect(canvas.getByLabelText(/relay address/i)).toHaveValue("");
    await expect(canvas.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
  },
};

/**
 * An address with no scheme on it, refused in the crate's own words.
 *
 * **This refusal is reachable from a keyboard, which is why it is not a fault.** Pasting a
 * hostname without its `https://` is the commonest thing that goes wrong here, and the sentence
 * has to say *that* rather than "invalid URL" — a different sentence pointing at a
 * different fix.
 */
export const AddressWithoutAScheme: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText(/relay address/i), "relay.example");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));

    await expect(await canvas.findByText(/has to start with https/i)).toBeInTheDocument();
  },
};

/**
 * An address, and nothing to sync to yet.
 *
 * **`null` is the backend's "there was nothing to do" and it is not a failure.** No relay
 * address, or no pairing group — and this device has the first and not the second. The
 * sentence says what is missing rather than reporting a fault, which is the difference between
 * a button that explains itself and one that looks broken on the first press of a fresh
 * install.
 */
export const NothingToSyncTo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(
      await canvas.findByLabelText(/relay address/i),
      "https://relay.example.workers.dev",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));

    // The address is stored, so there is somewhere for the press to go — and the panel now
    // says what is still missing rather than that sync is off.
    await expect(await canvas.findByText(/nowhere to sync to yet/i)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /sync now/i }));
    await expect(await canvas.findByText(/there was nothing to sync/i)).toBeInTheDocument();
  },
};

/**
 * A group, an address, and one round trip.
 *
 * The `paired` world has **three changes written and never handed over**, which is where a
 * reader stands after pairing and before typing an address, so the *waiting* line has something
 * true to say the moment the address is saved and the trip has something to send.
 *
 * There is no network in the workbench and this story does not pretend there is: what the fake
 * models is the shape of the answer — everything waiting goes, nothing comes back, and the
 * stamp moves. The two outcomes spec 7.4 surfaces are seeded rows in the `needsReview` world
 * rather than something a press invents; see `Settings/ReviewPanel`.
 *
 * **This press is also this device's first exchange**, so the line carries the baseline's two
 * sentences as well — which is not a leak between stories but the shape of the real thing: a
 * reader's first press after pairing is both trips at once, and it is exactly the press the
 * baseline clause exists to explain. `AFirstExchange` below is that half on its own, and takes
 * the second press to show the ordinary trip after it.
 */
export const OneRoundTrip: Story = {
  parameters: { fake: { seed: "paired" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(
      await canvas.findByLabelText(/relay address/i),
      "https://relay.example.workers.dev",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
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

    await userEvent.type(
      await canvas.findByLabelText(/relay address/i),
      "https://relay.example.workers.dev",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
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
 * A sync holding the write connection — the one way the relay's own read is refused.
 *
 * `sync_relay_status` takes `sync::with_write` in the crate, because it counts unpushed rows of
 * `sync_ops` on the write connection, so it really does answer `BUSY` while a card update is in
 * flight. The panel says the relay could not be read rather than drawing an empty address
 * field, which would be the one sentence a reader must not be shown by accident: it reads
 * exactly like sync having been switched off.
 */
export const RelayCouldNotBeRead: Story = {
  parameters: { fake: { seed: "paired", fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/could not be read/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/sync is off/i)).not.toBeInTheDocument();
  },
};
