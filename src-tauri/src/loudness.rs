//! Loudness and silence of each song, for loudness levelling and smart crossfades. Songs are
//! measured once in the background with EBU R128 (the basis of ReplayGain 2); ReplayGain
//! values already stored in a file are preferred for its gain. Files are only read.
use crate::db::{err, Database, Result, Track};
use lofty::{file::TaggedFileExt, tag::ItemKey};
use rodio::{Decoder, Source};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// ReplayGain 2 reference loudness.
pub const TARGET_LUFS: f64 = -18.;
/// Quieter than this counts as silence at a song's start or end (about −60 dBFS).
const SILENCE: f32 = 0.001;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness in LUFS.
    pub lufs: f64,
    /// Highest sample, 1.0 = full scale.
    pub peak: f64,
    /// Seconds of silence before the music starts and after it ends.
    pub start_silence: f64,
    pub end_silence: f64,
    /// ReplayGain values stored in the file, in dB, when present.
    pub tag_track_gain: Option<f64>,
    pub tag_album_gain: Option<f64>,
    pub tag_track_peak: Option<f64>,
    pub tag_album_peak: Option<f64>,
}

/// Identifies a song's audio independently of where the file is, so moved files keep it.
pub fn key(t: &Track) -> String {
    format!("{}|{}", t.size, crate::years::key(&t.artist, &t.title))
}

/// "-6.54 dB" → -6.54
fn db_value(text: &str) -> Option<f64> {
    text.trim()
        .trim_end_matches(|c: char| c.is_alphabetic() || c.is_whitespace())
        .trim()
        .parse()
        .ok()
}

/// Measures a file: decodes it once, feeding EBU R128 and tracking silence and peak.
pub fn measure(path: &str) -> Result<Loudness> {
    let decoder = Decoder::try_from(File::open(path).map_err(err)?).map_err(err)?;
    let channels = decoder.channels() as u32;
    let rate = decoder.sample_rate();
    let mut meter = ebur128::EbuR128::new(
        channels,
        rate,
        ebur128::Mode::I | ebur128::Mode::SAMPLE_PEAK,
    )
    .map_err(err)?;
    let (mut frames, mut first, mut last, mut peak) = (0u64, None, 0u64, 0f32);
    let mut chunk: Vec<f32> = Vec::with_capacity(8192 * channels as usize);
    let mut in_frame = 0u32;
    let mut loud_frame = false;
    for sample in decoder {
        chunk.push(sample);
        peak = peak.max(sample.abs());
        loud_frame |= sample.abs() > SILENCE;
        in_frame += 1;
        if in_frame == channels {
            if loud_frame {
                first.get_or_insert(frames);
                last = frames;
            }
            frames += 1;
            in_frame = 0;
            loud_frame = false;
            if chunk.len() >= 8192 * channels as usize {
                meter.add_frames_f32(&chunk).map_err(err)?;
                chunk.clear();
            }
        }
    }
    if !chunk.is_empty() {
        let whole = chunk.len() - chunk.len() % channels as usize;
        meter.add_frames_f32(&chunk[..whole]).map_err(err)?;
    }
    let seconds = |f: u64| f as f64 / rate as f64;
    let lufs = meter.loudness_global().map_err(err)?;
    let (start, end) = match first {
        Some(first) => (seconds(first), seconds(frames.saturating_sub(last + 1))),
        None => (0., 0.),
    };
    Ok(Loudness {
        lufs: if lufs.is_finite() { lufs } else { -70. },
        peak: peak as f64,
        start_silence: start,
        end_silence: end,
        ..Default::default()
    })
}

/// Measures a song and adds any ReplayGain values its tags carry.
pub fn analyze(t: &Track) -> Result<Loudness> {
    let mut l = measure(&t.path)?;
    if let Ok(tagged) = lofty::read_from_path(&t.path) {
        for tag in tagged.tags() {
            let get = |k: &ItemKey| tag.get_string(k).and_then(db_value);
            l.tag_track_gain = l.tag_track_gain.or(get(&ItemKey::ReplayGainTrackGain));
            l.tag_album_gain = l.tag_album_gain.or(get(&ItemKey::ReplayGainAlbumGain));
            l.tag_track_peak = l.tag_track_peak.or(get(&ItemKey::ReplayGainTrackPeak));
            l.tag_album_peak = l.tag_album_peak.or(get(&ItemKey::ReplayGainAlbumPeak));
        }
    }
    Ok(l)
}

/// Songs quieter than this are essentially silence (hidden tracks, gaps); they are never
/// boosted, which would only amplify hiss.
const SILENT_LUFS: f64 = -60.;
/// Largest boost and cut levelling applies, in dB.
const MAX_BOOST: f64 = 12.;
const MAX_CUT: f64 = -24.;

/// Gain in dB and the peak it must respect, for one song or a whole album.
pub fn track_gain(l: &Loudness) -> (f64, f64) {
    let peak = l.tag_track_peak.unwrap_or(l.peak);
    match l.tag_track_gain {
        Some(gain) => (gain, peak),
        None if l.lufs > SILENT_LUFS => (TARGET_LUFS - l.lufs, peak),
        None => (0., peak),
    }
}
/// Album gain: the album's tag, or the loudness of all its measured songs together.
pub fn album_gain(album: &[(Loudness, f64)]) -> Option<(f64, f64)> {
    if let Some((l, _)) = album.iter().find(|(l, _)| l.tag_album_gain.is_some()) {
        return Some((l.tag_album_gain?, l.tag_album_peak.unwrap_or(l.peak)));
    }
    let album: Vec<_> = album.iter().filter(|(l, _)| l.lufs > SILENT_LUFS).collect();
    let total: f64 = album.iter().map(|(_, seconds)| seconds).sum();
    if total <= 0. {
        return None;
    }
    // Loudness adds as energy, weighted by how long each song plays.
    let energy: f64 = album
        .iter()
        .map(|(l, s)| s * 10f64.powf(l.lufs / 10.))
        .sum::<f64>()
        / total;
    let peak = album.iter().map(|(l, _)| l.peak).fold(0., f64::max);
    Some((TARGET_LUFS - 10. * energy.log10(), peak))
}
/// Linear gain for dB (limited to +12/−24 dB), lowered if needed so the peak never clips.
pub fn linear(gain_db: f64, peak: f64) -> f32 {
    let gain = 10f64.powf(gain_db.clamp(MAX_CUT, MAX_BOOST) / 20.);
    (if peak > 0. { gain.min(1. / peak) } else { gain }) as f32
}

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Measures every song not measured yet, on two background threads.
pub fn start(db: Arc<Database>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let known = db.loudness_keys().unwrap_or_default();
        let mut todo: HashMap<String, Track> = HashMap::new();
        for t in db
            .tracks()
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !t.missing)
        {
            let k = key(&t);
            if !known.contains(&k) {
                todo.entry(k).or_insert(t);
            }
        }
        let todo = std::sync::Mutex::new(todo.into_iter().collect::<Vec<_>>());
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| loop {
                    let Some((k, t)) = todo.lock().unwrap().pop() else {
                        break;
                    };
                    // Unreadable files are remembered too, so they are not retried each scan.
                    let l = analyze(&t).unwrap_or(Loudness {
                        lufs: f64::NAN,
                        ..Default::default()
                    });
                    let _ = db.set_loudness(&k, &l);
                });
            }
        });
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav(path: &std::path::Path, samples: &[f32]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples {
            let v = (s * i16::MAX as f32) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
    }
    #[test]
    fn measures_loudness_peak_and_silence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        // 0.5 s silence, 2 s of a 1 kHz tone at half scale, 1 s silence.
        let tone =
            (0..96000).map(|i| 0.5 * (i as f32 * 2. * std::f32::consts::PI * 1000. / 48000.).sin());
        let samples: Vec<f32> = std::iter::repeat_n(0., 24000)
            .chain(tone)
            .chain(std::iter::repeat_n(0., 48000))
            .collect();
        wav(&path, &samples);
        let l = measure(path.to_str().unwrap()).unwrap();
        assert!(
            (l.start_silence - 0.5).abs() < 0.01,
            "start {}",
            l.start_silence
        );
        assert!((l.end_silence - 1.0).abs() < 0.01, "end {}", l.end_silence);
        assert!((l.peak - 0.5).abs() < 0.01);
        // A half-scale sine in both channels: −3 dB mean power per channel, and R128 adds the
        // two channels (+3 dB) with its −0.691 offset, so about −6.6 LUFS.
        assert!((l.lufs + 6.6).abs() < 0.5, "lufs {}", l.lufs);
    }
    #[test]
    fn gains_prefer_tags_and_never_clip() {
        let measured = Loudness {
            lufs: -9.,
            peak: 0.5,
            ..Default::default()
        };
        assert_eq!(track_gain(&measured), (-9., 0.5));
        let tagged = Loudness {
            tag_track_gain: Some(-6.5),
            tag_track_peak: Some(0.9),
            ..measured.clone()
        };
        assert_eq!(track_gain(&tagged), (-6.5, 0.9));
        assert!((linear(-6.0206, 0.5) - 0.5).abs() < 0.001);
        assert!(
            (linear(12., 0.5) - 2.).abs() < 0.001,
            "boost limited to peak 1/0.5"
        );
        assert_eq!(db_value("-6.54 dB"), Some(-6.54));
        let silence = Loudness {
            lufs: -70.,
            peak: 0.0001,
            ..Default::default()
        };
        assert_eq!(track_gain(&silence).0, 0., "near-silence is never boosted");
        assert!(
            (linear(40., 0.) - 10f32.powf(12. / 20.)).abs() < 0.001,
            "boost capped at +12 dB"
        );
        assert_eq!(db_value("+1.2dB"), Some(1.2));
    }
    #[test]
    fn album_gain_weights_songs_by_length() {
        let a = Loudness {
            lufs: -10.,
            peak: 0.8,
            ..Default::default()
        };
        let b = Loudness {
            lufs: -20.,
            peak: 0.3,
            ..Default::default()
        };
        let (gain, peak) = album_gain(&[(a.clone(), 100.), (b, 100.)]).unwrap();
        assert!((gain - (-18. + 12.6)).abs() < 0.1, "gain {gain}");
        assert_eq!(peak, 0.8);
        let tagged = Loudness {
            tag_album_gain: Some(-4.),
            tag_album_peak: Some(0.95),
            ..a
        };
        assert_eq!(album_gain(&[(tagged, 10.)]), Some((-4., 0.95)));
        assert_eq!(album_gain(&[]), None);
    }
}
