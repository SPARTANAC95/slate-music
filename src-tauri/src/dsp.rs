//! A 10-band graphic equalizer for the stereo mixer: one peaking filter per band (RBJ audio
//! cookbook biquads), plus a preamp to leave headroom for boosts.
use serde::{Deserialize, Serialize};

/// Band centre frequencies in Hz.
pub const BANDS: [f64; 10] = [
    31., 62., 125., 250., 500., 1000., 2000., 4000., 8000., 16000.,
];
/// Boost or cut limit per band, in dB.
pub const LIMIT: f32 = 12.;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EqSettings {
    pub enabled: bool,
    /// dB, never positive, to keep boosts from clipping.
    pub preamp: f32,
    /// dB per band, in the order of BANDS.
    pub bands: Vec<f32>,
    /// The preset name shown in Settings, or "Custom".
    pub preset: String,
}
impl EqSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.bands.is_empty() && self.bands.len() != BANDS.len() {
            return Err("The equalizer needs 10 bands".into());
        }
        if self.bands.iter().any(|b| !b.is_finite() || b.abs() > LIMIT) {
            return Err("Equalizer bands must be between −12 and +12 dB".into());
        }
        if !self.preamp.is_finite() || !(-LIMIT..=0.).contains(&self.preamp) {
            return Err("The preamp must be between −12 and 0 dB".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    /// Filter memory per channel (transposed direct form II).
    z1: [f32; 2],
    z2: [f32; 2],
}
impl Biquad {
    fn peaking(freq: f64, gain_db: f64, rate: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.);
        let w0 = 2. * std::f64::consts::PI * freq / rate;
        let alpha = w0.sin() / (2. * std::f64::consts::SQRT_2);
        let a0 = 1. + alpha / a;
        Self {
            b0: ((1. + alpha * a) / a0) as f32,
            b1: ((-2. * w0.cos()) / a0) as f32,
            b2: ((1. - alpha * a) / a0) as f32,
            a1: ((-2. * w0.cos()) / a0) as f32,
            a2: ((1. - alpha / a) / a0) as f32,
            z1: [0.; 2],
            z2: [0.; 2],
        }
    }
    fn process(&mut self, x: f32, ch: usize) -> f32 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Clone)]
pub struct Equalizer {
    filters: Vec<Biquad>,
    /// Linear preamp; 1.0 when the equalizer is off.
    preamp: f32,
}
impl Default for Equalizer {
    fn default() -> Self {
        Self {
            filters: Vec::new(),
            preamp: 1.,
        }
    }
}
impl Equalizer {
    pub fn new(settings: &EqSettings, rate: f64) -> Self {
        if !settings.enabled {
            return Self::default();
        }
        Self {
            filters: settings
                .bands
                .iter()
                .zip(BANDS)
                // Only bands that change something cost processing time.
                .filter(|(gain, freq)| gain.abs() > 0.01 && *freq < rate / 2.)
                .map(|(gain, freq)| Biquad::peaking(freq, *gain as f64, rate))
                .collect(),
            preamp: 10f32.powf(settings.preamp / 20.),
        }
    }
    #[cfg(test)]
    pub fn active(&self) -> bool {
        !self.filters.is_empty() || self.preamp != 1.
    }
    /// One sample of channel `ch` (0 = left, 1 = right).
    pub fn process(&mut self, x: f32, ch: usize) -> f32 {
        if self.filters.is_empty() {
            return x * self.preamp;
        }
        self.filters
            .iter_mut()
            .fold(x * self.preamp, |s, f| f.process(s, ch & 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Peak level of a sine at `freq` after the equalizer, once it has settled.
    fn response(eq: &mut Equalizer, freq: f64) -> f32 {
        let mut peak = 0f32;
        for i in 0..96000 {
            let x = (2. * std::f64::consts::PI * freq * i as f64 / 48000.).sin() as f32 * 0.25;
            let y = eq.process(x, 0);
            eq.process(x, 1);
            if i > 48000 {
                peak = peak.max(y.abs());
            }
        }
        peak / 0.25
    }
    fn settings(bands: [f32; 10], preamp: f32) -> EqSettings {
        EqSettings {
            enabled: true,
            preamp,
            bands: bands.to_vec(),
            preset: "Custom".into(),
        }
    }
    #[test]
    fn flat_or_off_changes_nothing() {
        let mut off = Equalizer::new(&EqSettings::default(), 48000.);
        assert_eq!(off.process(0.3, 0), 0.3);
        assert!(!off.active());
        let mut flat = Equalizer::new(&settings([0.; 10], 0.), 48000.);
        assert!((response(&mut flat, 440.) - 1.).abs() < 0.01);
    }
    #[test]
    fn a_boost_lifts_its_band_and_leaves_distant_ones() {
        let mut bands = [0.; 10];
        bands[5] = 6.; // +6 dB at 1 kHz
        let mut eq = Equalizer::new(&settings(bands, 0.), 48000.);
        let at_1k = response(&mut eq, 1000.);
        assert!((at_1k - 2.).abs() < 0.1, "about +6 dB: {at_1k}");
        let mut eq = Equalizer::new(&settings(bands, 0.), 48000.);
        assert!((response(&mut eq, 60.) - 1.).abs() < 0.05);
        let mut quieter = Equalizer::new(&settings(bands, -6.), 48000.);
        assert!(
            (response(&mut quieter, 1000.) - 1.).abs() < 0.1,
            "preamp makes room"
        );
    }
    #[test]
    fn rejects_out_of_range_settings() {
        assert!(settings([0.; 10], 0.).validate().is_ok());
        assert!(settings([13.; 10], 0.).validate().is_err());
        assert!(settings([0.; 10], 3.).validate().is_err());
        let short = EqSettings {
            bands: vec![0.; 3],
            ..Default::default()
        };
        assert!(short.validate().is_err());
    }
}
