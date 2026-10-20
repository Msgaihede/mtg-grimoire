//! The gallery: one row per **look**, and the search over them.
//!
//! A look is the printings that photograph alike — the same art in the same frame, Lightning
//! Bolt in MM2, A25, 2X2, JMP and FDC — and each face of a double-faced card is a look of its
//! own. So the picture alone names a look, a look names a card and the short list of printings
//! it [`covers`](Gallery::covers), and only a collector line could say which of those.
//!
//! **`models/gallery.bin` (`CNGALLR1`)**, little-endian, the sections in this order:
//!
//! | section | size |
//! | --- | --- |
//! | magic `CNGALLR1`, `n`, `dim`, `covers` | 8 + 3 × 4 |
//! | each row's scale, `f32` | `n × 4` |
//! | the rows, `i8` (value × scale ≈ the unit-length row) | `n × dim` |
//! | the pictured printing's Scryfall id | `n × 16` |
//! | the card group (one per oracle card), `u32` | `n × 4` |
//! | the face, `u8` (0 front, 1 back) | `n` |
//! | where each look's covers start, `u32` | `(n + 1) × 4` |
//! | the covered printings' Scryfall ids | `covers × 16` |
//! | the names' length, `u32`, then each look's name, `\n` after each | `4 + …` |
//!
//! **int8 rather than the f32 the export writes**: a quarter of the size, in a file in git and
//! in a browser's memory that is never given back. Measured on the spike's replay of the 124
//! readers' scans: every one of 2 336 frames named the same best card as with f32 rows, and the
//! cross-validated totals were identical (the scanner lab's replays, `E:\mtg-scanner`).
//!
//! **The bytes are kept as they came and read in place** — a view, not a parse into a second
//! copy — and the search reads the rows where they lie.

use crate::Error;
use std::borrow::Cow;

pub const MAGIC: &[u8; 8] = b"CNGALLR1";
pub const ID_LEN: usize = 16;
pub type Id = [u8; ID_LEN];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Face {
    Front,
    Back,
}

/// Where each section starts in the bytes.
#[derive(Clone, Copy, Debug)]
struct Layout {
    scales: usize,
    rows: usize,
    printings: usize,
    cards: usize,
    faces: usize,
    cover_at: usize,
    covers: usize,
    names: usize,
}

pub struct Gallery {
    /// Borrowed where the file is compiled in, so a native host holds no second copy of it.
    bytes: Cow<'static, [u8]>,
    n: usize,
    dim: usize,
    at: Layout,
    /// Where each name starts in the names section; `n + 1` entries.
    name_at: Vec<u32>,
}

/// The looks a set of filters lets the search answer: one flag per row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admit {
    rows: Vec<bool>,
    count: usize,
}

impl Admit {
    pub fn admits(&self, entry: u32) -> bool {
        self.rows.get(entry as usize).copied().unwrap_or(false)
    }

    /// How many looks the filters leave.
    pub fn count(&self) -> usize {
        self.count
    }
}

/// One look, as [`Gallery::build`] takes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub printing: Id,
    pub card: u32,
    pub face: Face,
    /// Every printing that looks like this, `printing` first.
    pub covers: Vec<Id>,
    pub name: String,
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().expect("four bytes"))
}

impl Gallery {
    /// Quantise unit-length `rows` (`looks.len() × dim` f32) and lay them out with the looks.
    pub fn build(rows: &[f32], dim: usize, looks: &[Look]) -> Result<Gallery, Error> {
        let n = looks.len();
        if dim == 0 || rows.len() != n * dim {
            return Err(Error::Gallery(format!(
                "{} values are not {n} rows of {dim}",
                rows.len()
            )));
        }
        let covers: usize = looks.iter().map(|l| l.covers.len()).sum();
        let mut b = Vec::with_capacity(20 + n * (dim + 30) + covers * ID_LEN);
        b.extend_from_slice(MAGIC);
        for v in [n, dim, covers] {
            b.extend_from_slice(&(v as u32).to_le_bytes());
        }
        let scales: Vec<f32> = rows
            .chunks_exact(dim)
            .map(|r| r.iter().fold(0f32, |m, v| m.max(v.abs())) / 127.0)
            .collect();
        for s in &scales {
            b.extend_from_slice(&s.to_le_bytes());
        }
        for (r, s) in rows.chunks_exact(dim).zip(&scales) {
            for v in r {
                let q = if *s > 0.0 {
                    (v / s).round().clamp(-127.0, 127.0)
                } else {
                    0.0
                };
                b.push(q as i8 as u8);
            }
        }
        for l in looks {
            b.extend_from_slice(&l.printing);
        }
        for l in looks {
            b.extend_from_slice(&l.card.to_le_bytes());
        }
        for l in looks {
            b.push(match l.face {
                Face::Front => 0,
                Face::Back => 1,
            });
        }
        let mut at = 0u32;
        for l in looks {
            b.extend_from_slice(&at.to_le_bytes());
            at += l.covers.len() as u32;
        }
        b.extend_from_slice(&at.to_le_bytes());
        for l in looks {
            for c in &l.covers {
                b.extend_from_slice(c);
            }
        }
        let names: String = looks.iter().map(|l| format!("{}\n", l.name)).collect();
        b.extend_from_slice(&(names.len() as u32).to_le_bytes());
        b.extend_from_slice(names.as_bytes());
        Gallery::from_vec(b)
    }

    /// Read a gallery, keeping its bytes.
    pub fn from_vec(bytes: Vec<u8>) -> Result<Gallery, Error> {
        Gallery::from_bytes(Cow::Owned(bytes))
    }

    /// Read a gallery where it lies — compiled in (borrowed) or received (owned).
    pub fn from_bytes(bytes: Cow<'static, [u8]>) -> Result<Gallery, Error> {
        let bad = |why: &str| Error::Gallery(why.to_string());
        if bytes.len() < 20 || &bytes[..8] != MAGIC {
            return Err(bad("not a CNGALLR1 gallery"));
        }
        let (n, dim, covers) = (
            u32_at(&bytes, 8) as usize,
            u32_at(&bytes, 12) as usize,
            u32_at(&bytes, 16) as usize,
        );
        // Checked: on a 32-bit target (the browser) a damaged header's counts could wrap past
        // the length check below and index out of the file.
        let sections = || -> Option<[usize; 8]> {
            let scales = 20usize;
            let rows = scales.checked_add(n.checked_mul(4)?)?;
            let printings = rows.checked_add(n.checked_mul(dim)?)?;
            let cards = printings.checked_add(n.checked_mul(ID_LEN)?)?;
            let faces = cards.checked_add(n.checked_mul(4)?)?;
            let cover_at = faces.checked_add(n)?;
            let covers_start = cover_at.checked_add(n.checked_add(1)?.checked_mul(4)?)?;
            let names = covers_start.checked_add(covers.checked_mul(ID_LEN)?)?;
            names.checked_add(4)?;
            Some([
                scales,
                rows,
                printings,
                cards,
                faces,
                cover_at,
                covers_start,
                names,
            ])
        };
        let Some([scales, rows, printings, cards, faces, cover_at, covers_start, names]) =
            sections()
        else {
            return Err(bad("cut short"));
        };
        if bytes.len() < names + 4 {
            return Err(bad("cut short"));
        }
        let names_len = u32_at(&bytes, names) as usize;
        if bytes.len() - (names + 4) != names_len {
            return Err(bad("the names' length does not reach the end"));
        }
        let at = Layout {
            scales,
            rows,
            printings,
            cards,
            faces,
            cover_at,
            covers: covers_start,
            names: names + 4,
        };
        // Every look's covers inside the covers section, in order, the last ending at its end —
        // so no read of a look can reach past the file.
        let mut last = 0;
        for e in 0..=n {
            let at = u32_at(&bytes, cover_at + e * 4) as usize;
            if at < last || at > covers || (e == n && at != covers) {
                return Err(bad("the covers do not add up"));
            }
            last = at;
        }
        let text =
            std::str::from_utf8(&bytes[at.names..]).map_err(|_| bad("a name is not UTF-8"))?;
        let mut name_at = Vec::with_capacity(n + 1);
        name_at.push(0u32);
        for (i, c) in text.bytes().enumerate() {
            if c == b'\n' {
                name_at.push(i as u32 + 1);
            }
        }
        if name_at.len() != n + 1 {
            return Err(bad("there is not one name a look"));
        }
        Ok(Gallery {
            bytes,
            n,
            dim,
            at,
            name_at,
        })
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// The gallery's bytes, as [`Gallery::from_vec`] reads them.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    fn id_at(&self, at: usize) -> &Id {
        self.bytes[at..at + ID_LEN]
            .try_into()
            .expect("sixteen bytes")
    }

    /// The Scryfall id of the printing in the look's reference picture.
    pub fn printing(&self, entry: u32) -> &Id {
        self.id_at(self.at.printings + entry as usize * ID_LEN)
    }

    /// The card group: two looks with the same value are the same card. The margin is
    /// measured against the best look of *another* card.
    pub fn card(&self, entry: u32) -> u32 {
        u32_at(&self.bytes, self.at.cards + entry as usize * 4)
    }

    pub fn face(&self, entry: u32) -> Face {
        match self.bytes[self.at.faces + entry as usize] {
            0 => Face::Front,
            _ => Face::Back,
        }
    }

    /// Every printing the look stands for, the pictured one first.
    pub fn covers(&self, entry: u32) -> impl ExactSizeIterator<Item = &Id> {
        let e = entry as usize;
        let (a, b) = (
            u32_at(&self.bytes, self.at.cover_at + e * 4) as usize,
            u32_at(&self.bytes, self.at.cover_at + (e + 1) * 4) as usize,
        );
        (a..b).map(move |i| self.id_at(self.at.covers + i * ID_LEN))
    }

    pub fn name(&self, entry: u32) -> &str {
        let e = entry as usize;
        let (a, b) = (self.name_at[e] as usize, self.name_at[e + 1] as usize - 1);
        std::str::from_utf8(&self.bytes[self.at.names + a..self.at.names + b])
            .expect("checked at load")
    }

    /// The looks a filter lets through: a look is admitted when any printing it covers is.
    pub fn admit(&self, permits: impl Fn(&Id) -> bool) -> Admit {
        let rows: Vec<bool> = (0..self.n as u32)
            .map(|e| self.covers(e).any(&permits))
            .collect();
        let count = rows.iter().filter(|a| **a).count();
        Admit { rows, count }
    }

    /// The `k` admitted looks with the highest cosine against the unit-length `q`, best first.
    /// A brute-force scan: 128 dimensions × 70 000 looks is 9 M multiply-adds, a few
    /// milliseconds.
    pub fn top(
        &self,
        q: &[f32],
        k: usize,
        admit: Option<&Admit>,
    ) -> Result<Vec<(u32, f32)>, Error> {
        if q.len() != self.dim {
            return Err(Error::Gallery(format!(
                "a {}-d query against a {}-d gallery",
                q.len(),
                self.dim
            )));
        }
        let mut best: Vec<(u32, f32)> = Vec::with_capacity(k + 1);
        for i in 0..self.n {
            if admit.is_some_and(|a| !a.rows[i]) {
                continue;
            }
            let s = self.score(i as u32, q);
            if best.len() < k || s > best[best.len() - 1].1 {
                let at = best.partition_point(|&(_, v)| v >= s);
                best.insert(at, (i as u32, s));
                best.truncate(k);
            }
        }
        Ok(best)
    }

    /// One look's cosine against the unit-length `q` (`dim` long), through its int8 row.
    pub fn score(&self, entry: u32, q: &[f32]) -> f32 {
        let i = entry as usize;
        let row = &self.bytes[self.at.rows + i * self.dim..self.at.rows + (i + 1) * self.dim];
        let dot: f32 = row.iter().zip(q).map(|(r, v)| (*r as i8) as f32 * v).sum();
        dot * f32::from_le_bytes(
            self.bytes[self.at.scales + i * 4..self.at.scales + i * 4 + 4]
                .try_into()
                .expect("four bytes"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(b: u8) -> Id {
        [b; ID_LEN]
    }

    fn look(printing: u8, card: u32, covers: &[u8], name: &str) -> Look {
        Look {
            printing: id(printing),
            card,
            face: if name.ends_with("back") {
                Face::Back
            } else {
                Face::Front
            },
            covers: covers.iter().map(|c| id(*c)).collect(),
            name: name.into(),
        }
    }

    fn sample() -> Gallery {
        let rows = [1.0, 0.0, 0.0, 1.0, 0.6, 0.8];
        let looks = [
            look(1, 0, &[1], "Lightning Bolt"),
            look(2, 1, &[2, 3, 4], "Forest"),
            look(5, 2, &[5], "Delver // back"),
        ];
        Gallery::build(&rows, 2, &looks).unwrap()
    }

    #[test]
    fn a_built_gallery_reads_back_every_look() {
        let g = sample();
        let back = Gallery::from_vec(g.as_bytes().to_vec()).unwrap();
        assert_eq!((back.len(), back.dim()), (3, 2));
        assert_eq!(back.printing(1), &id(2));
        assert_eq!(back.card(2), 2);
        assert_eq!(back.face(2), Face::Back);
        assert_eq!(
            back.covers(1).copied().collect::<Vec<_>>(),
            [id(2), id(3), id(4)]
        );
        assert_eq!(back.name(0), "Lightning Bolt");
        assert_eq!(back.name(2), "Delver // back");
    }

    #[test]
    fn the_search_ranks_by_cosine_through_the_int8_rows() {
        let g = sample();
        let top = g.top(&[0.8, 0.6], 2, None).unwrap();
        assert_eq!(top.iter().map(|t| t.0).collect::<Vec<_>>(), [2, 0]);
        assert!((top[0].1 - 0.96).abs() < 0.01, "{}", top[0].1);
        assert!(g.top(&[1.0], 1, None).is_err());
    }

    #[test]
    fn an_admit_keeps_a_look_any_of_whose_printings_passes() {
        let g = sample();
        // Only printing 4 passes: Forest's look covers it, so Forest alone is searched.
        let admit = g.admit(|p| *p == id(4));
        assert_eq!(admit.count(), 1);
        assert!(admit.admits(1) && !admit.admits(0) && !admit.admits(9));
        let top = g.top(&[0.8, 0.6], 3, Some(&admit)).unwrap();
        assert_eq!(top.iter().map(|t| t.0).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn a_damaged_file_is_refused() {
        let bytes = sample().as_bytes().to_vec();
        assert!(Gallery::from_vec(bytes[..bytes.len() - 1].to_vec()).is_err());
        assert!(Gallery::from_vec(b"NSGALLR1\0\0\0\0".to_vec()).is_err());
        let mut wrong = bytes.clone();
        wrong[16] += 1; // one more cover than the offsets say
        assert!(Gallery::from_vec(wrong).is_err());
    }

    #[test]
    fn counts_too_large_for_the_file_are_refused_without_wrapping() {
        // Every count at its largest: on a 32-bit target the section arithmetic would wrap.
        let mut huge = MAGIC.to_vec();
        huge.extend_from_slice(&[0xff; 12]);
        huge.extend_from_slice(&[0; 64]);
        assert!(Gallery::from_vec(huge).is_err());
        // A look whose covers run backwards: refused before any read can follow them.
        let mut bytes = sample().as_bytes().to_vec();
        let g = sample();
        let cover_at = g.at.cover_at;
        bytes[cover_at + 4..cover_at + 8].copy_from_slice(&3u32.to_le_bytes());
        bytes[cover_at + 8..cover_at + 12].copy_from_slice(&1u32.to_le_bytes());
        assert!(Gallery::from_vec(bytes).is_err());
    }
}
