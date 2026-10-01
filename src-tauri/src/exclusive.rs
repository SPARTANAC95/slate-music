//! Choices for exclusive-mode output, kept apart from Windows so they can be tested: which
//! sample rate and sample format to send a song in, and turning mixer samples back into the
//! whole numbers the device takes. A song decoded from 16- or 24-bit PCM and left untouched
//! (volume 100%, no EQ or levelling) comes out as exactly the numbers in the file.
use serde::{Deserialize, Serialize};

/// How a sample is laid out: bits it takes up, and how many of them carry sound (24 of 32).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    pub container: u16,
    pub valid: u16,
}
/// Every rate and layout tried when a device is checked.
pub const RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
pub const LAYOUTS: [Layout; 4] = [
    Layout {
        container: 32,
        valid: 24,
    },
    Layout {
        container: 24,
        valid: 24,
    },
    Layout {
        container: 32,
        valid: 32,
    },
    Layout {
        container: 16,
        valid: 16,
    },
];

/// What a device accepts in exclusive mode.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Support {
    pub device: String,
    /// The chosen device was missing, so the Windows default is used.
    pub fallback: bool,
    pub formats: Vec<(u32, Layout)>,
}
impl Support {
    fn rates(&self) -> Vec<u32> {
        let mut rates: Vec<u32> = self.formats.iter().map(|(r, _)| *r).collect();
        rates.sort_unstable();
        rates.dedup();
        rates
    }
    /// The rate to send a song at: its own when the device takes it; otherwise the nearest of
    /// the same family (44.1 or 48 kHz multiples), so conversion stays as gentle as possible.
    pub fn rate_for(&self, native: u32) -> u32 {
        let rates = self.rates();
        if rates.contains(&native) || rates.is_empty() {
            return native;
        }
        let family = |r: u32| r % 11025 == 0;
        let nearest = |list: Vec<u32>| {
            list.into_iter()
                .min_by_key(|r| (*r as i64 - native as i64).abs())
        };
        nearest(
            rates
                .iter()
                .copied()
                .filter(|r| family(*r) == family(native))
                .collect(),
        )
        .or_else(|| nearest(rates.clone()))
        .unwrap_or(native)
    }
    /// The layout for a song with `bits` bits per sample (0 for lossy files) at `rate`:
    /// the smallest that carries every bit, else the largest there is.
    pub fn layout_for(&self, rate: u32, bits: u16) -> Option<Layout> {
        let bits = if bits == 0 { 24 } else { bits };
        let mut options: Vec<Layout> = self
            .formats
            .iter()
            .filter(|(r, _)| *r == rate)
            .map(|(_, l)| *l)
            .collect();
        options.sort_by_key(|l| {
            let fits = l.valid >= bits;
            (
                !fits,
                if fits { l.valid } else { u16::MAX - l.valid },
                std::cmp::Reverse(l.container),
            )
        });
        options.first().copied()
    }
}

/// Writes one sample as a little-endian whole number in `out` (container/8 bytes), with the
/// sound in the top `valid` bits. Rounds, never dithers, so untouched samples stay exact.
pub fn to_pcm(sample: f32, layout: Layout, out: &mut [u8]) {
    let scale = (1u64 << (layout.valid - 1)) as f64;
    let value = (sample as f64 * scale).round().clamp(-scale, scale - 1.) as i64;
    let word = value << (layout.container - layout.valid);
    let bytes = (word as i32).to_le_bytes();
    let n = (layout.container / 8) as usize;
    if layout.container == 24 {
        out[..3].copy_from_slice(&(value as i32).to_le_bytes()[..3]);
    } else {
        out[..n].copy_from_slice(&bytes[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const L16: Layout = Layout {
        container: 16,
        valid: 16,
    };
    const L24: Layout = Layout {
        container: 24,
        valid: 24,
    };
    const L2432: Layout = Layout {
        container: 32,
        valid: 24,
    };
    const L32: Layout = Layout {
        container: 32,
        valid: 32,
    };
    fn support(formats: &[(u32, Layout)]) -> Support {
        Support {
            device: "DAC".into(),
            fallback: false,
            formats: formats.to_vec(),
        }
    }
    #[test]
    fn songs_keep_their_own_rate_when_the_device_takes_it() {
        let dac = support(&[(44100, L16), (44100, L2432), (48000, L2432), (96000, L2432)]);
        assert_eq!(dac.rate_for(44100), 44100);
        assert_eq!(dac.rate_for(96000), 96000);
        // 88.2 kHz isn't offered: the nearest 44.1 kHz multiple, not 96 kHz.
        assert_eq!(dac.rate_for(88200), 44100);
        let only48 = support(&[(48000, L16)]);
        assert_eq!(only48.rate_for(44100), 48000);
        assert_eq!(support(&[]).rate_for(44100), 44100);
    }
    #[test]
    fn layouts_carry_every_bit() {
        let dac = support(&[(44100, L16), (44100, L2432), (44100, L32), (48000, L24)]);
        assert_eq!(dac.layout_for(44100, 16), Some(L16));
        assert_eq!(dac.layout_for(44100, 24), Some(L2432));
        assert_eq!(
            dac.layout_for(44100, 0),
            Some(L2432),
            "lossy files get 24 bits"
        );
        assert_eq!(dac.layout_for(48000, 16), Some(L24));
        let small = support(&[(44100, L16)]);
        assert_eq!(small.layout_for(44100, 24), Some(L16), "the best there is");
        assert_eq!(small.layout_for(96000, 16), None);
    }
    #[test]
    fn whole_numbers_come_back_exactly() {
        let mut b = [0u8; 4];
        for x in [-32768i32, -1, 0, 1, 12345, 32767] {
            to_pcm(x as f32 / 32768., L16, &mut b);
            assert_eq!(i16::from_le_bytes([b[0], b[1]]) as i32, x);
            to_pcm(x as f32 / 32768., L2432, &mut b);
            assert_eq!(i32::from_le_bytes(b) >> 16, x, "16-bit in 24-in-32");
        }
        for x in [-8388608i32, -1, 0, 1, 4_000_001, 8388607] {
            to_pcm(x as f32 / 8388608., L24, &mut b);
            assert_eq!(i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8, x);
            to_pcm(x as f32 / 8388608., L2432, &mut b);
            assert_eq!(i32::from_le_bytes(b) >> 8, x);
        }
        to_pcm(2.0, L16, &mut b);
        assert_eq!(
            i16::from_le_bytes([b[0], b[1]]),
            i16::MAX,
            "clipped, never wrapped"
        );
        to_pcm(-1.0, L32, &mut b);
        assert_eq!(i32::from_le_bytes(b), i32::MIN);
    }
}
