# Card Scanner

This is a description of the card scanning feature for the MTG Grimoire app.

## Functionality

The card scanner should have 2 modes:

- Fast
- Precise

Separately from the scanner mode, the user should be able to set filters, such as allowed sets.

### Image cleanup

Card images will need to be cleaned up, rotated, skewed, etc. to get a clean image to compare to. We should research the best way to do this. Ideally it runs in rust.

### Fast Mode

Fast mode should try to match the card as fast as possible, with little latency, so a user can scan a lot of cards fast.

### Precise Mode

Precise mode should try to match the exact card / printing / set. We can use OCR, Match the entire card etc.
This should be a "tiered" scan, that narrows down the list of cards with each step of the scanner. Start with the cheapest scan first (such as matching just the card art), then OCR, then whole card, then AI Classifier.
If multiple cards match after all scanning steps, present the user with the remaining list of cards to select from.

### Filters

If the user knows they are gonna be scanning from exclusively a few sets, they should be able to set filters to help the scanner narrow down the exact card.
If filters are set, then only cards matching the filters should be valid for matching in the scanner.

## Architecture

The scanner should be independently runnable for testing purposes. then we can fully integrate it into our app later.

Everything should run locally on device, and should be runnable on a modern flagship smartphone as well as a desktop/laptop (provided it has a webcam).

### Camera

The scanner should use the users camera.
A camera could be a webcam on a PC, or a camera on a smartphone.

### Debugging

I want to be able to see the debug data, such as the rotated, normalized images, etc.
So lets make sure to save it and make it available somewhere for developers to use.

### Sample data / Testing

Some sample scans of cards can be found in ./scans/*.jpg
Use these to create a testing dataset, that we can verify against.
Test both precise and fast scanning
