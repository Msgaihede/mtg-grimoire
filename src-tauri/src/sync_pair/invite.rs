//! The pairing invite: 64 bytes, as a typed code and as a picture.
//!
//! **105 characters is a floor and not a design failure.** The payload is a 16-byte group id, a
//! 32-byte X25519 public key and a 16-byte one-time token; base32 is 5 bits per character, so
//! 64 bytes is `ceil(512 / 5)` = 103 characters, and the checksum adds two. The public key is
//! the irreducible half — an invite that omitted it would need the relay to supply it, which is
//! precisely the hop the six-digit SAS exists to distrust. That is why §7.5 makes the QR
//! primary; the typed form is for the machine with no camera pointed at it.

/// Crockford base32, in encode order. No `I`, `L`, `O` or `U`.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// How many payload bytes an invite carries.
const PAYLOAD: usize = 16 + 32 + 16;

/// Payload characters, before the checksum. `ceil(64 * 8 / 5)`.
const BODY_CHARS: usize = 103;

/// Characters per hyphen-separated group in the displayed form. Cosmetic; the decoder strips
/// every separator before it looks at anything.
const GROUP: usize = 5;

/// What a reader is shown, and what device B is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub group_id: [u8; 16],
    pub public_key: [u8; 32],
    pub token: [u8; 16],
}

/// Why a typed code was refused.
///
/// Four variants because they are four different sentences to a reader: the code is the wrong
/// length (they pasted half of it), it has a character no code contains (they pasted something
/// else entirely), it has a typo (they typed it and slipped), or it is too long to draw. Only
/// the third is worth "check the code and try again".
///
/// **The order the checks run in is what makes the second sentence reachable at all.**
/// `decode` asks about the alphabet before it asks about the checksum, because a string with a
/// `U` in it fails a position-weighted sum too — and telling somebody who pasted an email
/// address that their pairing code has a typo in it is a sentence that points at the wrong fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InviteError {
    #[error("that is not a full pairing code — it should be 105 characters")]
    Length,
    #[error("that does not look like a pairing code")]
    Alphabet,
    #[error("that pairing code has a typo in it")]
    Checksum,
    #[error("that pairing code is too long to draw as a QR code")]
    TooLong,
}

impl Invite {
    /// The typed form: 105 base32 characters in groups of five, separated by hyphens.
    pub fn encode(&self) -> String {
        let mut bytes = Vec::with_capacity(PAYLOAD);
        bytes.extend_from_slice(&self.group_id);
        bytes.extend_from_slice(&self.public_key);
        bytes.extend_from_slice(&self.token);

        let mut body = base32_encode(&bytes);
        body.push_str(&checksum(&body));

        let mut out = String::with_capacity(body.len() + body.len() / GROUP);
        for (i, c) in body.chars().enumerate() {
            if i > 0 && i % GROUP == 0 {
                out.push('-');
            }
            out.push(c);
        }
        out
    }

    /// The other half. Tolerant of case, of separators, and of the three letters a person
    /// substitutes for digits; intolerant of everything else.
    pub fn decode(code: &str) -> Result<Invite, InviteError> {
        let cleaned: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| match c.to_ascii_uppercase() {
                // Crockford's own folding rule, and the whole reason this alphabet was chosen:
                // these are the three confusions a person actually makes.
                'I' | 'L' => '1',
                'O' => '0',
                other => other,
            })
            .collect();

        if cleaned.len() != BODY_CHARS + 2 {
            return Err(InviteError::Length);
        }
        // Before the checksum, so that "this is not a pairing code" and "this pairing code has
        // a typo" stay two different answers. A character outside the alphabet fails a
        // weighted sum as reliably as a transposition does, and the two mean nothing alike.
        if cleaned.bytes().any(|c| !ALPHABET.contains(&c)) {
            return Err(InviteError::Alphabet);
        }
        let (body, given) = cleaned.split_at(BODY_CHARS);
        if checksum(body) != given {
            return Err(InviteError::Checksum);
        }
        let bytes = base32_decode(body)?;

        let mut inv = Invite {
            group_id: [0; 16],
            public_key: [0; 32],
            token: [0; 16],
        };
        inv.group_id.copy_from_slice(&bytes[..16]);
        inv.public_key.copy_from_slice(&bytes[16..48]);
        inv.token.copy_from_slice(&bytes[48..64]);
        Ok(inv)
    }
}

/// Two characters over the body, position-weighted.
///
/// **The weighting is what catches a transposition.** A plain sum of symbol values is identical
/// for `AB` and `BA`, and swapping two adjacent characters is the commonest typing error there
/// is — so the sum is over `value * (position + 1)`, which moves when the order does. Swapping
/// positions `i` and `i + 1` shifts the total by exactly `v[i] - v[i + 1]`, which is non-zero
/// whenever the two characters differ and is far below the modulus, so it can never wrap back
/// onto itself.
///
/// **It is not security.** It catches the typo, so the reader is told "that code has a typo in
/// it" instead of being told the pairing failed — a different sentence pointing at a different
/// fix. A *tampered* code fails at the SAS, which is where tampering is supposed to fail.
///
/// `unwrap_or(0)` for a character outside the alphabet is unreachable from [`Invite::decode`],
/// which refuses one before it gets here; it is what makes this function total rather than a
/// panic waiting for a second caller.
fn checksum(body: &str) -> String {
    let mut acc: u32 = 0;
    for (i, c) in body.bytes().enumerate() {
        let v = ALPHABET.iter().position(|a| *a == c).unwrap_or(0) as u32;
        acc = acc.wrapping_add(v.wrapping_mul(i as u32 + 1));
    }
    let acc = acc % 1024;
    let hi = ALPHABET[(acc / 32) as usize] as char;
    let lo = ALPHABET[(acc % 32) as usize] as char;
    format!("{hi}{lo}")
}

/// Big-endian bit packing, five bits at a time. The tail is zero-padded, which is why the
/// decoder is allowed to discard the trailing bits it cannot fill.
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for b in bytes {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

fn base32_decode(text: &str) -> Result<Vec<u8>, InviteError> {
    let mut out = Vec::with_capacity(PAYLOAD);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in text.bytes() {
        let v = ALPHABET
            .iter()
            .position(|a| *a == c)
            .ok_or(InviteError::Alphabet)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    // 103 characters carry 515 bits and the payload is 512; the last three are the encoder's
    // zero padding and are dropped rather than trusted.
    out.truncate(PAYLOAD);
    if out.len() != PAYLOAD {
        return Err(InviteError::Length);
    }
    Ok(out)
}

/// A QR code as a grid of booleans — `true` is a dark module.
///
/// **A fact, not a picture.** The webview draws it as an SVG, which is where a decision about
/// colour, quiet-zone width and pixel size belongs; this side answers only what the encoder
/// produced. `modules` is row-major and `width * width` long, always.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub width: usize,
    pub modules: Vec<bool>,
}

/// Encode `text` at error-correction level M — the default, and the level the 105-character
/// invite fits comfortably at.
pub fn qr_matrix(text: &str) -> Result<QrMatrix, InviteError> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|_| InviteError::TooLong)?;
    let width = code.width();
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| c.select(true, false))
        .collect();
    Ok(QrMatrix { width, modules })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Invite {
        Invite {
            group_id: [0x11; 16],
            public_key: [0x22; 32],
            token: [0x33; 16],
        }
    }

    #[test]
    fn an_invite_round_trips_through_the_typed_code() {
        let inv = sample();
        let code = inv.encode();
        let back = Invite::decode(&code).unwrap();
        assert_eq!(back.group_id, inv.group_id);
        assert_eq!(back.public_key, inv.public_key);
        assert_eq!(back.token, inv.token);
    }

    /// The three fields must not be able to swap places. A round trip over one sample says
    /// nothing about the offsets: `[0x11; 16]` and `[0x33; 16]` are both blocks of one byte,
    /// so a decoder that read the token where the group id is would still pass above.
    #[test]
    fn every_field_lands_back_at_its_own_offset() {
        let mut inv = sample();
        inv.group_id[0] = 0xA1;
        inv.group_id[15] = 0xA2;
        inv.public_key[0] = 0xB1;
        inv.public_key[31] = 0xB2;
        inv.token[0] = 0xC1;
        inv.token[15] = 0xC2;

        let back = Invite::decode(&inv.encode()).unwrap();
        assert_eq!(back, inv);
    }

    /// 64 payload bytes at 5 bits per character is 103 characters, plus a 2-character
    /// checksum. The groups are cosmetic and the decoder ignores them.
    #[test]
    fn the_code_is_the_length_the_payload_forces() {
        let raw: String = sample().encode().chars().filter(|c| *c != '-').collect();
        assert_eq!(
            raw.len(),
            105,
            "103 payload characters plus a 2-character checksum"
        );
    }

    /// The three confusions a person actually makes, corrected rather than rejected.
    #[test]
    fn the_decoder_folds_the_letters_that_look_like_digits() {
        let code = sample().encode();
        let bent: String = code
            .chars()
            .map(|c| match c {
                '1' => 'I',
                '0' => 'O',
                other => other,
            })
            .collect();
        assert_eq!(
            Invite::decode(&bent).unwrap().public_key,
            sample().public_key,
            "I for 1 and O for 0 must decode, not fail"
        );
    }

    /// Spaces, hyphens and case are the reader's, not the format's.
    #[test]
    fn separators_and_case_are_ignored() {
        let code = sample().encode();
        let messy = format!("  {}  ", code.to_lowercase().replace('-', " "));
        assert_eq!(Invite::decode(&messy).unwrap().token, sample().token);
    }

    /// One transposed pair — the commonest typing error there is — must be caught by the
    /// checksum and named as a typo, rather than reaching the ECDH as a valid-looking key.
    #[test]
    fn a_transposition_is_caught_by_the_checksum() {
        let code: String = sample().encode().chars().filter(|c| *c != '-').collect();
        let mut chars: Vec<char> = code.chars().collect();
        // Two adjacent characters that actually differ, so the swap is a real change.
        let i = (0..chars.len() - 1)
            .find(|&i| chars[i] != chars[i + 1])
            .expect("the code has two adjacent characters that differ");
        chars.swap(i, i + 1);
        let bent: String = chars.into_iter().collect();
        assert_eq!(Invite::decode(&bent), Err(InviteError::Checksum));
    }

    /// Every adjacent transposition, not one. A weighted sum catches all of them and the
    /// arithmetic says why — the difference it makes is `v[i] - v[i+1]`, which is non-zero
    /// whenever the two characters differ — so the test that pins the claim is the sweep.
    #[test]
    fn no_adjacent_transposition_anywhere_in_the_code_slips_through() {
        let code: String = sample().encode().chars().filter(|c| *c != '-').collect();
        let chars: Vec<char> = code.chars().collect();
        let mut swapped = 0;
        for i in 0..chars.len() - 1 {
            if chars[i] == chars[i + 1] {
                continue;
            }
            let mut bent = chars.clone();
            bent.swap(i, i + 1);
            let text: String = bent.into_iter().collect();
            assert_eq!(
                Invite::decode(&text),
                Err(InviteError::Checksum),
                "a swap at {i} was not caught"
            );
            swapped += 1;
        }
        assert!(swapped > 20, "only {swapped} pairs actually differed");
    }

    #[test]
    fn a_short_or_junk_code_is_refused_by_shape() {
        assert_eq!(Invite::decode("ABC"), Err(InviteError::Length));
        let code: String = sample().encode().chars().filter(|c| *c != '-').collect();
        // `U` is not in Crockford's alphabet and is not one of the folded letters, so this is
        // not a typo in a pairing code — it is not a pairing code, and it says so.
        let bent = format!("U{}", &code[1..]);
        assert_eq!(Invite::decode(&bent), Err(InviteError::Alphabet));
    }

    /// The matrix is square, non-empty, and both colours occur — a matrix of all-light is
    /// what an encoder that silently did nothing produces.
    #[test]
    fn the_qr_matrix_is_square_and_has_both_colours() {
        let m = qr_matrix(&sample().encode()).unwrap();
        assert_eq!(m.modules.len(), m.width * m.width);
        assert!(m.width >= 21, "the smallest QR version is 21 modules");
        assert!(m.modules.iter().any(|d| *d), "no dark modules at all");
        assert!(m.modules.iter().any(|d| !*d), "no light modules at all");
    }

    /// Two different invites must not draw the same picture.
    #[test]
    fn two_invites_draw_different_matrices() {
        let a = qr_matrix(&sample().encode()).unwrap();
        let mut other = sample();
        other.token = [0x44; 16];
        let b = qr_matrix(&other.encode()).unwrap();
        assert_ne!(a.modules, b.modules);
    }
}
