//! Mastering-grade sample-rate conversion for Studio mode: a polyphase, Kaiser-windowed sinc
//! filter that is flat to 20 kHz (for 44.1 kHz songs) and rejects aliases and images by at least
//! 130 dB. rodio's own converter interpolates in a straight line between samples, which dulls
//! the top octave (about −4 dB at 16 kHz from 44.1 to 48 kHz) and adds aliases, and it drops
//! samples when it lowers the rate, which folds the ultrasonic content of hi-res files back
//! into the audible band.
//!
//! The filter is linear-phase and evaluated centred on each output instant, so it adds no delay
//! and a song keeps its exact length. At a song's end the converter stops just before it needs
//! samples past the end and holds its last few milliseconds: when the next song follows
//! gaplessly at the same rate, that song carries them on with its own first samples, exactly as
//! if both were one recording, so a seamless album stays seamless. Otherwise they are finished
//! against silence.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

/// Stopband attenuation in dB: aliases and images end up at least this far below the music.
const ATTENUATION: f64 = 130.;
/// Passband edge as a share of the lower Nyquist frequency: 20 kHz for a 44.1 kHz song.
const PASSBAND: f64 = 0.907;
/// Rate pairs needing more filter phases than this (no real format does) are not tabulated.
const MAX_PHASES: u32 = 2048;
/// Frames of history kept beyond what the filter needs before the buffer is compacted.
const SPARE: usize = 8192;

/// One filter, tabulated for every phase of a rate pair.
pub struct Table {
    /// Output samples per `down` input samples (the number of phases).
    up: u32,
    down: u32,
    /// Coefficients for each tap, phase by phase.
    taps: usize,
    coefficients: Vec<f64>,
}
fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}
/// Zeroth-order modified Bessel function of the first kind, for the Kaiser window.
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, mut k) = (1., 1., 1.);
    while term > sum * 1e-17 {
        term *= (x / (2. * k)).powi(2);
        sum += term;
        k += 1.;
    }
    sum
}
impl Table {
    fn design(from: u32, to: u32) -> Option<Self> {
        if from == 0 || to == 0 {
            return None;
        }
        let g = gcd(from, to);
        let (up, down) = (to / g, from / g);
        if up > MAX_PHASES {
            return None;
        }
        let nyquist = from.min(to) as f64 / 2.;
        // In cycles per input sample.
        let cutoff = (PASSBAND + 1.) / 2. * nyquist / from as f64;
        let transition = (1. - PASSBAND) * nyquist / from as f64;
        // Kaiser's estimates for the window's shape and the filter's length.
        let beta = 0.1102 * (ATTENUATION - 8.7);
        let length = (ATTENUATION - 7.95) / (2.285 * 2. * std::f64::consts::PI * transition);
        let taps = ((length / 2.).ceil() as usize).max(4) * 2;
        let half = (taps / 2) as f64;
        let norm = bessel_i0(beta);
        let mut coefficients = Vec::with_capacity(up as usize * taps);
        for phase in 0..up {
            let start = coefficients.len();
            for tap in 0..taps {
                // Distance, in input samples, from the output instant to this tap's sample.
                let t = phase as f64 / up as f64 + (half - 1.) - tap as f64;
                let x = t / half;
                let window = if x.abs() <= 1. {
                    bessel_i0(beta * (1. - x * x).sqrt()) / norm
                } else {
                    0.
                };
                let arg = 2. * cutoff * t;
                let sinc = if arg.abs() < 1e-12 {
                    1.
                } else {
                    (std::f64::consts::PI * arg).sin() / (std::f64::consts::PI * arg)
                };
                coefficients.push(2. * cutoff * sinc * window);
            }
            // Every phase passes a constant level exactly.
            let sum: f64 = coefficients[start..].iter().sum();
            for c in &mut coefficients[start..] {
                *c /= sum;
            }
        }
        Some(Self {
            up,
            down,
            taps,
            coefficients,
        })
    }
    /// The filter for a rate pair, designed once and shared by every song that needs it.
    fn get(from: u32, to: u32) -> Option<Arc<Self>> {
        type Tables = Mutex<HashMap<(u32, u32), Option<Arc<Table>>>>;
        static TABLES: OnceLock<Tables> = OnceLock::new();
        TABLES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entry((from, to))
            .or_insert_with(|| Self::design(from, to).map(Arc::new))
            .clone()
    }
}

/// The few milliseconds at the end of a song the converter has not finished, handed to the
/// next song so it can carry them on.
pub struct Tail {
    table: Arc<Table>,
    buffer: Vec<[f32; 2]>,
    base: i64,
    position: i64,
    phase: u32,
}

/// Converts a stereo stream (interleaved left, right) from one rate to another.
pub struct Resampler {
    table: Arc<Table>,
    /// Input frames from index `base` on; negative indices are the silence before the song.
    buffer: Vec<[f32; 2]>,
    base: i64,
    /// The input frame at or before the next output instant, and how far past it that instant
    /// is, in steps of 1/up of a frame.
    position: i64,
    phase: u32,
    /// The input has ended, one frame past the last at index `end`.
    ended: bool,
    end: i64,
    /// Finish the song against silence instead of waiting for the next song to carry it on.
    released: bool,
    /// No input read yet, so a previous song's tail can be carried on.
    fresh: bool,
    /// The right sample of the frame whose left one was just returned.
    pending: Option<f32>,
}
impl Resampler {
    /// None when the rates are the same or no filter exists for them.
    pub fn new(from: u32, to: u32) -> Option<Self> {
        if from == to {
            return None;
        }
        let table = Table::get(from, to)?;
        let mut r = Self {
            table,
            buffer: Vec::new(),
            base: 0,
            position: 0,
            phase: 0,
            ended: false,
            end: 0,
            released: false,
            fresh: true,
            pending: None,
        };
        r.reset();
        Some(r)
    }
    fn half(&self) -> i64 {
        (self.table.taps / 2) as i64
    }
    /// Starts again from silence: after a seek, the input continues from its new place.
    pub fn reset(&mut self) {
        let half = self.half();
        self.base = -(half - 1);
        self.buffer = vec![[0.; 2]; (half - 1) as usize];
        self.position = 0;
        self.phase = 0;
        self.ended = false;
        self.end = 0;
        self.released = false;
        self.fresh = true;
        self.pending = None;
    }
    /// The song has ended and its last moments wait for `release` or for the next song.
    pub fn holding(&self) -> bool {
        self.ended && !self.released && self.position < self.end && self.pending.is_none()
    }
    /// Finishes the song against silence.
    pub fn release(&mut self) {
        self.released = true;
    }
    /// Whether this converter can carry on `tail`: it has read nothing yet and converts
    /// between the same rates.
    pub fn can_adopt(&self, tail_of: &Resampler) -> bool {
        self.fresh
            && self.pending.is_none()
            && Arc::ptr_eq(&self.table, &tail_of.table)
            && tail_of.holding()
    }
    /// Hands over the unfinished end of the song, with indices counted from the song's end.
    pub fn take_tail(&mut self) -> Tail {
        let tail = Tail {
            table: self.table.clone(),
            buffer: std::mem::take(&mut self.buffer),
            base: self.base - self.end,
            position: self.position - self.end,
            phase: self.phase,
        };
        // Nothing is left to play here.
        self.base = self.end;
        self.position = self.end;
        self.released = true;
        tail
    }
    /// Carries on the previous song's tail: the next outputs finish it using this song's
    /// first samples, then continue into this song on the same time grid.
    pub fn adopt(&mut self, tail: Tail) {
        if !self.fresh || !Arc::ptr_eq(&self.table, &tail.table) {
            return;
        }
        self.buffer = tail.buffer;
        self.base = tail.base;
        self.position = tail.position;
        self.phase = tail.phase;
        self.fresh = false;
    }
    /// The next output sample, alternating left and right; None at the end of the song or
    /// while its last moments are held (see `holding`).
    pub fn next(&mut self, input: &mut impl Iterator<Item = f32>) -> Option<f32> {
        if let Some(right) = self.pending.take() {
            return Some(right);
        }
        let [left, right] = self.frame(input)?;
        self.pending = Some(right);
        Some(left)
    }
    fn frame(&mut self, input: &mut impl Iterator<Item = f32>) -> Option<[f32; 2]> {
        let half = self.half();
        loop {
            if self.ended && self.position >= self.end {
                return None;
            }
            if self.base + self.buffer.len() as i64 > self.position + half {
                break;
            }
            if !self.ended {
                match input.next() {
                    Some(left) => {
                        let right = input.next().unwrap_or(0.);
                        self.buffer.push([left, right]);
                        self.fresh = false;
                    }
                    None => {
                        self.ended = true;
                        self.end = self.base + self.buffer.len() as i64;
                    }
                }
            } else if self.released {
                self.buffer.push([0.; 2]);
            } else {
                return None;
            }
        }
        let table = &self.table;
        let taps = table.taps;
        let start = (self.position - (half - 1) - self.base) as usize;
        let row = &table.coefficients[self.phase as usize * taps..][..taps];
        let frames = &self.buffer[start..start + taps];
        let (mut left, mut right) = (0f64, 0f64);
        for (c, f) in row.iter().zip(frames) {
            left += f[0] as f64 * c;
            right += f[1] as f64 * c;
        }
        // Step to the next output instant.
        let step = self.phase + table.down;
        self.position += (step / table.up) as i64;
        self.phase = step % table.up;
        // Drop history the filter no longer reaches, now and then rather than every frame.
        let unused = (self.position - (half - 1) - self.base).max(0) as usize;
        if unused > SPARE {
            self.buffer.drain(..unused);
            self.base += unused as i64;
        }
        Some([left as f32, right as f32])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(freq: f64, rate: u32, frames: usize, amp: f64) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let v = (amp * (2. * PI * freq * i as f64 / rate as f64).sin()) as f32;
                [v, -v]
            })
            .collect()
    }
    fn convert(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        let mut r = Resampler::new(from, to).unwrap();
        r.release();
        let mut it = input.iter().copied();
        std::iter::from_fn(|| r.next(&mut it)).collect()
    }
    /// RMS of the difference from an ideal sine at the output rate, in dB below the sine,
    /// away from the edges of the signal.
    fn error_db(out: &[f32], freq: f64, to: u32, amp: f64) -> f64 {
        let frames = out.len() / 2;
        let skip = to as usize / 10;
        let (mut err, mut n) = (0f64, 0);
        for i in skip..frames - skip {
            let ideal = amp * (2. * PI * freq * i as f64 / to as f64).sin();
            err += (out[2 * i] as f64 - ideal).powi(2) + (out[2 * i + 1] as f64 + ideal).powi(2);
            n += 2;
        }
        let rms = (err / n as f64).sqrt();
        20. * (rms / (amp / 2f64.sqrt())).log10()
    }
    fn rms_db(out: &[f32], to: u32) -> f64 {
        let skip = to as usize / 10 * 2;
        let part = &out[skip..out.len() - skip];
        let p = part.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / part.len() as f64;
        10. * p.log10()
    }

    #[test]
    fn the_audible_band_passes_untouched_from_44_1_to_48_khz() {
        for freq in [50., 1000., 10000., 16000., 19500.] {
            let out = convert(&sine(freq, 44100, 44100, 0.5), 44100, 48000);
            let e = error_db(&out, freq, 48000, 0.5);
            assert!(e < -110., "{freq} Hz is reproduced within {e:.1} dB");
        }
    }
    #[test]
    fn hi_res_ultrasonics_never_fold_into_the_audible_band() {
        // rodio drops every other sample here, so 30 kHz would come back at 18 kHz.
        for (from, freq) in [(96000, 30000.), (192000, 70000.), (88200, 27000.)] {
            let out = convert(&sine(freq, from, from as usize, 0.9), from, 48000);
            let level = rms_db(&out, 48000);
            assert!(level < -125., "{freq} Hz at {from} Hz leaves {level:.1} dB");
        }
        let out = convert(&sine(15000., 96000, 96000, 0.5), 96000, 48000);
        assert!(error_db(&out, 15000., 48000, 0.5) < -110.);
    }
    /// What is left of the left channel, in dB below `amp`, once the best-fitting sine at
    /// `freq` (any level and phase) is taken out: images, aliases and noise.
    fn residual_db(out: &[f32], freq: f64, to: u32, amp: f64) -> f64 {
        let frames = out.len() / 2;
        let skip = to as usize / 10;
        let range = skip..frames - skip;
        let (mut ss, mut sc, mut cc, mut ys, mut yc) = (0f64, 0f64, 0f64, 0f64, 0f64);
        for i in range.clone() {
            let w = 2. * PI * freq * i as f64 / to as f64;
            let (s, c, y) = (w.sin(), w.cos(), out[2 * i] as f64);
            ss += s * s;
            sc += s * c;
            cc += c * c;
            ys += y * s;
            yc += y * c;
        }
        let det = ss * cc - sc * sc;
        let a = (ys * cc - yc * sc) / det;
        let b = (yc * ss - ys * sc) / det;
        let mut err = 0f64;
        for i in range.clone() {
            let w = 2. * PI * freq * i as f64 / to as f64;
            err += (out[2 * i] as f64 - a * w.sin() - b * w.cos()).powi(2);
        }
        let rms = (err / range.len() as f64).sqrt();
        20. * (rms / (amp / 2f64.sqrt())).log10()
    }
    #[test]
    fn images_above_the_source_band_are_rejected_when_raising_the_rate() {
        // A 20.5 kHz tone in a 44.1 kHz file must not leave an image at 23.6 kHz, which the
        // linear converter keeps at about −50 dB.
        let out = convert(&sine(20500., 44100, 44100, 0.5), 44100, 48000);
        let residual = residual_db(&out, 20500., 48000, 0.5);
        assert!(
            residual < -115.,
            "everything but the tone: {residual:.1} dB"
        );
    }
    #[test]
    fn a_song_keeps_its_exact_length() {
        for (from, to, frames) in [
            (44100, 48000, 44101),
            (96000, 48000, 9999),
            (48000, 44100, 777),
        ] {
            let out = convert(&vec![0.1; frames * 2], from, to);
            let expected = (frames as u64 * to as u64).div_ceil(from as u64) as usize;
            assert_eq!(out.len(), expected * 2, "{from} → {to}");
        }
    }
    #[test]
    fn same_rates_need_no_converter() {
        assert!(Resampler::new(48000, 48000).is_none());
        assert!(Resampler::new(0, 48000).is_none());
    }
    #[test]
    fn a_gapless_album_converts_as_one_recording() {
        let whole = sine(5000., 44100, 30000, 0.7);
        let (a, b) = whole.split_at(2 * 13001);
        let one_piece = convert(&whole, 44100, 48000);
        let mut first = Resampler::new(44100, 48000).unwrap();
        let mut second = Resampler::new(44100, 48000).unwrap();
        let (mut ia, mut ib) = (a.iter().copied(), b.iter().copied());
        let mut out: Vec<f32> = std::iter::from_fn(|| first.next(&mut ia)).collect();
        assert!(first.holding(), "the end waits for what follows");
        assert!(second.can_adopt(&first));
        second.adopt(first.take_tail());
        second.release();
        out.extend(std::iter::from_fn(|| second.next(&mut ib)));
        assert_eq!(out.len(), one_piece.len());
        let worst = out
            .iter()
            .zip(&one_piece)
            .map(|(x, y)| (x - y).abs())
            .fold(0f32, f32::max);
        assert!(worst < 1e-6, "seam differs by {worst}");
    }
    #[test]
    fn a_released_end_finishes_against_silence() {
        let mut r = Resampler::new(44100, 48000).unwrap();
        let input = vec![0.5f32; 2000];
        let mut it = input.iter().copied();
        let held: Vec<f32> = std::iter::from_fn(|| r.next(&mut it)).collect();
        assert!(r.holding());
        r.release();
        let rest: Vec<f32> = std::iter::from_fn(|| r.next(&mut it)).collect();
        assert!(!rest.is_empty());
        assert_eq!(held.len() + rest.len(), convert(&input, 44100, 48000).len());
        assert!(r.next(&mut it).is_none());
    }
    #[test]
    fn a_seek_starts_cleanly_from_the_new_place() {
        let input = sine(1000., 44100, 20000, 0.5);
        let mut r = Resampler::new(44100, 48000).unwrap();
        let mut it = input.iter().copied();
        for _ in 0..5001 {
            r.next(&mut it);
        }
        r.reset();
        r.release();
        let mut again = input.iter().copied();
        let out: Vec<f32> = std::iter::from_fn(|| r.next(&mut again)).collect();
        assert_eq!(out, convert(&input, 44100, 48000));
    }
    /// Level of the best-fitting sine at `freq` in the left channel, in dB relative to `amp`.
    fn level_db(out: &[f32], freq: f64, to: u32, amp: f64) -> f64 {
        let frames = out.len() / 2;
        let skip = to as usize / 10;
        let (mut ss, mut sc, mut cc, mut ys, mut yc) = (0f64, 0f64, 0f64, 0f64, 0f64);
        for i in skip..frames - skip {
            let w = 2. * PI * freq * i as f64 / to as f64;
            let (s, c, y) = (w.sin(), w.cos(), out[2 * i] as f64);
            (ss, sc, cc, ys, yc) = (ss + s * s, sc + s * c, cc + c * c, ys + y * s, yc + y * c);
        }
        let det = ss * cc - sc * sc;
        let (a, b) = ((ys * cc - yc * sc) / det, (yc * ss - ys * sc) / det);
        20. * ((a * a + b * b).sqrt() / amp).log10()
    }
    #[test]
    #[ignore = "prints a comparison with rodio's converter"]
    fn compare_with_rodio() {
        use rodio::{buffer::SamplesBuffer, source::UniformSourceIterator};
        let rodio = |input: &[f32], from: u32, to: u32| -> Vec<f32> {
            UniformSourceIterator::new(SamplesBuffer::new(2, from, input.to_vec()), 2, to).collect()
        };
        println!(
            "44.1 → 48 kHz        level (rodio / Studio)     everything else (rodio / Studio)"
        );
        for freq in [1000., 5000., 10000., 16000., 19500.] {
            let input = sine(freq, 44100, 44100, 0.5);
            let (old, new) = (rodio(&input, 44100, 48000), convert(&input, 44100, 48000));
            println!(
                "{:>6} Hz   {:>8.2} / {:>6.3} dB      {:>8.1} / {:>6.1} dB",
                freq,
                level_db(&old, freq, 48000, 0.5),
                level_db(&new, freq, 48000, 0.5),
                residual_db(&old, freq, 48000, 0.5),
                residual_db(&new, freq, 48000, 0.5),
            );
        }
        println!("Hi-res to 48 kHz: what an inaudible ultrasonic tone leaves in the audible band");
        for (from, freq) in [(96000, 30000.), (192000, 70000.), (88200, 27000.)] {
            let input = sine(freq, from, from as usize, 0.5);
            println!(
                "{:>6} Hz at {} kHz   rodio {:>7.1} dBFS   Studio {:>7.1} dBFS",
                freq,
                from / 1000,
                rms_db(&rodio(&input, from, 48000), 48000),
                rms_db(&convert(&input, from, 48000), 48000),
            );
        }
    }
    #[test]
    fn broken_input_never_breaks_the_rest_of_the_song() {
        let mut input = sine(1000., 44100, 44100, 0.5);
        input[20000] = f32::NAN;
        let out = convert(&input, 44100, 48000);
        // The filter forgets a bad sample once it has passed: the song after it is clean.
        assert!(out[30000..].iter().all(|s| s.is_finite()));
    }
}
