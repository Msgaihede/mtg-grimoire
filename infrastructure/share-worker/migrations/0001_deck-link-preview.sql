-- A deck share's link preview (issue #1032): the deck's format, which the OpenGraph card's
-- description leads with ("Commander deck · 100 cards · updated today"), and the picture it shows
-- as `og:image` — the deck's commander, as `share::deck::preview_image` chose it. Both NULL on
-- every other kind of share, and on every row published before this file.
--
-- Additive, so the previous release's code runs on it unchanged for the moment between this
-- migration and the deploy (`../../relay/migrations/README.md`).
ALTER TABLE shares ADD COLUMN format TEXT;
ALTER TABLE shares ADD COLUMN image TEXT;
