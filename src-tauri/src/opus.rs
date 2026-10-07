//! Opus songs (.opus, and .ogg files that hold Opus). The decoder the rest of the player uses
//! has none for Opus, so these are read here: the Ogg container with the `ogg` crate, the sound
//! with libopus itself, translated to Rust (`unsafe-libopus`), which decodes exactly as the
//! reference does. Opus is always played at 48 kHz, and the file says how many samples at its
//! start and end are not part of the song, so albums play gaplessly.
use crate::db::{err, Result};
use rodio::source::SeekError;
use rodio::Source;
use std::fs::File;
use std::io::{BufReader, SeekFrom};
use std::time::Duration;

/// Opus always decodes to this rate, whatever was recorded.
const RATE: u32 = 48_000;
/// The longest Opus packet is 120 ms.
const LONGEST: usize = 5760;
/// How much is decoded and thrown away before the place asked for, so the decoder has settled
/// (the format asks for 80 ms) and at least one whole page has passed.
const RUN_UP: u64 = 2 * RATE as u64;

/// libopus's decoder for one stream of one or two channels.
struct Decoder {
    state: *mut unsafe_libopus::OpusDecoder,
    channels: usize,
}
// The decoder is only ever used by the thread that owns it.
unsafe impl Send for Decoder {}
impl Decoder {
    fn new(channels: usize) -> Result<Self> {
        let mut error = 0;
        // Safety: the arguments are a rate and a channel count libopus accepts, and the
        // pointer it returns is checked before use and freed once, in Drop.
        let state = unsafe {
            unsafe_libopus::opus_decoder_create(RATE as i32, channels as i32, &mut error)
        };
        if state.is_null() || error != 0 {
            return Err(format!("The Opus decoder could not start (error {error})"));
        }
        Ok(Self { state, channels })
    }
    /// Decodes one packet into `out` and returns how many frames it held.
    fn decode(&mut self, packet: &[u8], out: &mut [f32]) -> Result<usize> {
        debug_assert!(out.len() >= LONGEST * self.channels);
        // Safety: `out` has room for the longest packet, which is the frame count passed.
        let frames = unsafe {
            unsafe_libopus::opus_decode_float(
                self.state,
                packet.as_ptr(),
                packet.len() as i32,
                out.as_mut_ptr(),
                LONGEST as i32,
                0,
            )
        };
        if frames < 0 {
            return Err(format!("Damaged Opus data (error {frames})"));
        }
        Ok(frames as usize)
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        // Safety: created by opus_decoder_create and not freed before.
        unsafe { unsafe_libopus::opus_decoder_destroy(self.state) }
    }
}

/// What an Opus file says about itself in its first packet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Head {
    pub channels: usize,
    /// Frames at the start that are the encoder's run-in, not the song.
    pub pre_skip: u64,
    /// A volume change the file asks every player to apply, as a linear factor.
    pub gain: f32,
}
/// Reads the "OpusHead" packet; None when this is not Opus.
pub fn head(packet: &[u8]) -> Option<Result<Head>> {
    if packet.len() < 19 || &packet[..8] != b"OpusHead" {
        return None;
    }
    let (channels, family) = (packet[9] as usize, packet[18]);
    if family != 0 || !(1..=2).contains(&channels) {
        return Some(Err(
            "Opus files with more than two channels can't be played yet.".into(),
        ));
    }
    let gain_db = i16::from_le_bytes([packet[16], packet[17]]) as f32 / 256.;
    Some(Ok(Head {
        channels,
        pre_skip: u16::from_le_bytes([packet[10], packet[11]]) as u64,
        gain: 10f32.powf(gain_db / 20.),
    }))
}

/// An Opus song as a stream of samples.
pub struct OpusSource {
    reader: ogg::PacketReader<BufReader<File>>,
    decoder: Decoder,
    head: Head,
    serial: u32,
    /// Frames in the song, once its start and end are trimmed (0 when the file doesn't say).
    frames: u64,
    /// Decoded samples waiting to be played, and how far into them playback is.
    ready: Vec<f32>,
    at: usize,
    scratch: Vec<f32>,
    /// Frames decoded so far, counted as the file counts them (the run-in included). After a
    /// seek this is unknown until the end of a page is reached.
    decoded: Option<u64>,
    /// The frame, counted the same way, from which samples are played.
    from: u64,
    ended: bool,
}
impl OpusSource {
    /// Opens the file if it holds Opus: Ok(None) for anything else (an Ogg Vorbis file, say).
    pub fn open(path: &str) -> Result<Option<Self>> {
        let mut reader = ogg::PacketReader::new(BufReader::new(File::open(path).map_err(err)?));
        let Ok(Some(first)) = reader.read_packet() else {
            return Ok(None);
        };
        let Some(head) = head(&first.data) else {
            return Ok(None);
        };
        let head = head?;
        let serial = first.stream_serial();
        // The last page says where the song ends.
        let size = reader.seek_bytes(SeekFrom::End(0)).map_err(err)?;
        reader
            .seek_bytes(SeekFrom::Start(size.saturating_sub(200_000)))
            .map_err(err)?;
        let mut last = 0;
        while let Ok(Some(packet)) = reader.read_packet() {
            if packet.stream_serial() == serial && packet.absgp_page() != u64::MAX {
                last = last.max(packet.absgp_page());
            }
        }
        let mut source = Self {
            reader,
            decoder: Decoder::new(head.channels)?,
            head,
            serial,
            frames: last.saturating_sub(head.pre_skip),
            ready: Vec::new(),
            at: 0,
            scratch: vec![0.; LONGEST * head.channels],
            decoded: Some(0),
            from: head.pre_skip,
            ended: false,
        };
        source.rewind()?;
        Ok(Some(source))
    }
    /// Back to the first sound packet, with a fresh decoder.
    fn rewind(&mut self) -> Result<()> {
        self.reader.seek_bytes(SeekFrom::Start(0)).map_err(err)?;
        // The head and the tags (which may span several pages) come before the sound.
        let mut headers = 0;
        while headers < 2 {
            match self.reader.read_packet().map_err(err)? {
                Some(packet) if packet.stream_serial() == self.serial => headers += 1,
                Some(_) => {}
                None => break,
            }
        }
        self.restart(Some(0), self.head.pre_skip)
    }
    fn restart(&mut self, decoded: Option<u64>, from: u64) -> Result<()> {
        self.decoder = Decoder::new(self.head.channels)?;
        self.ready.clear();
        self.at = 0;
        self.decoded = decoded;
        self.from = from;
        self.ended = false;
        Ok(())
    }
    /// Decodes packets until some samples are ready. False at the end of the song.
    fn refill(&mut self) -> bool {
        self.ready.clear();
        self.at = 0;
        let channels = self.head.channels;
        while self.ready.is_empty() && !self.ended {
            let packet = match self.reader.read_packet() {
                Ok(Some(packet)) => packet,
                // The end, or a damaged file: the song ends here.
                Ok(None) | Err(_) => break,
            };
            if packet.stream_serial() != self.serial {
                continue;
            }
            let Ok(frames) = self.decoder.decode(&packet.data, &mut self.scratch) else {
                continue;
            };
            let page_end = Some(packet.absgp_page())
                .filter(|granule| packet.last_in_page() && *granule != u64::MAX);
            let Some(before) = self.decoded else {
                // Just after a seek: where this is in the song is known at the end of a page.
                self.decoded = page_end;
                continue;
            };
            let mut after = before + frames as u64;
            let mut keep = frames;
            if let Some(end) = page_end {
                if packet.last_in_stream() && end < after {
                    // The last packet is longer than the song: the rest is padding.
                    keep = keep.saturating_sub((after - end) as usize);
                    self.ended = true;
                }
                // Pages say exactly where they end; trust them over the running count.
                after = end.max(before);
            }
            self.decoded = Some(after);
            let skip = (self.from.saturating_sub(before) as usize).min(keep);
            self.ready.extend(
                self.scratch[skip * channels..keep * channels]
                    .iter()
                    .map(|sample| sample * self.head.gain),
            );
        }
        !self.ready.is_empty()
    }
    /// Moves to `frame` of the song.
    fn seek(&mut self, frame: u64) -> Result<()> {
        let within = if self.frames > 0 {
            frame.min(self.frames - 1)
        } else {
            frame
        };
        let target = within + self.head.pre_skip;
        // Start a little earlier: the decoder needs a run-up, and the position is only known
        // at the end of a page. Near the start it is simpler to begin at the beginning.
        for run_up in [RUN_UP, 5 * RUN_UP] {
            if target <= run_up {
                break;
            }
            if !self
                .reader
                .seek_absgp(Some(self.serial), target - run_up)
                .map_err(err)?
            {
                break;
            }
            self.restart(None, target)?;
            // Find the end of the first page; if that is already past the place asked for
            // (unusually long pages), try from further back.
            while self.decoded.is_none() {
                match self.reader.read_packet() {
                    Ok(Some(packet)) if packet.stream_serial() == self.serial => {
                        let _ = self.decoder.decode(&packet.data, &mut self.scratch);
                        if packet.last_in_page() && packet.absgp_page() != u64::MAX {
                            self.decoded = Some(packet.absgp_page());
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
            }
            if self.decoded.is_some_and(|at| at <= target) {
                return Ok(());
            }
        }
        self.rewind()?;
        self.from = target;
        Ok(())
    }
}
impl Iterator for OpusSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.at >= self.ready.len() && !self.refill() {
            return None;
        }
        self.at += 1;
        Some(self.ready[self.at - 1])
    }
}
impl Source for OpusSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.head.channels as u16
    }
    fn sample_rate(&self) -> u32 {
        RATE
    }
    fn total_duration(&self) -> Option<Duration> {
        (self.frames > 0).then(|| Duration::from_secs_f64(self.frames as f64 / RATE as f64))
    }
    fn try_seek(&mut self, position: Duration) -> std::result::Result<(), SeekError> {
        // Whole frames, so the channels never swap.
        self.seek((position.as_secs_f64() * RATE as f64) as u64)
            .map_err(|e| SeekError::Other(Box::new(std::io::Error::other(e))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Writes an Opus file of a tone that differs between the two channels, in pages of about a
    /// second, the way encoders do. Returns the number of frames in the song.
    fn tone_file(path: &std::path::Path, seconds: usize) -> usize {
        const PRE_SKIP: usize = 312;
        let frames = seconds * RATE as usize;
        let serial = 0x51A7E;
        let mut writer = ogg::PacketWriter::new(File::create(path).unwrap());
        let mut head = b"OpusHead".to_vec();
        head.extend([1, 2]);
        head.extend((PRE_SKIP as u16).to_le_bytes());
        head.extend(RATE.to_le_bytes());
        head.extend([0, 0, 0]);
        let end_page = ogg::PacketWriteEndInfo::EndPage;
        writer.write_packet(head, serial, end_page, 0).unwrap();
        let mut tags = b"OpusTags".to_vec();
        tags.extend(5u32.to_le_bytes());
        tags.extend(b"slate");
        tags.extend(0u32.to_le_bytes());
        writer.write_packet(tags, serial, end_page, 0).unwrap();
        let mut error = 0;
        // Safety: a rate, channel count and application (2049, "audio") libopus accepts.
        let encoder =
            unsafe { unsafe_libopus::opus_encoder_create(RATE as i32, 2, 2049, &mut error) };
        assert_eq!(error, 0);
        let sample = |frame: usize, hz: f32| {
            let t = frame as f32 / RATE as f32;
            // Silent past the end of the song: that part is the padding.
            if frame < frames {
                0.4 * (2. * std::f32::consts::PI * hz * t).sin()
            } else {
                0.
            }
        };
        // The decoder gives back the song PRE_SKIP frames late, so that much more is encoded.
        let packets = (frames + PRE_SKIP).div_ceil(960);
        let mut out = vec![0u8; 4000];
        for n in 0..packets {
            let pcm: Vec<f32> = (n * 960..(n + 1) * 960)
                .flat_map(|frame| [sample(frame, 440.), sample(frame, 1320.)])
                .collect();
            // Safety: `pcm` holds 960 stereo frames and `out` is as long as stated.
            let size = unsafe {
                unsafe_libopus::opus_encode_float(
                    encoder,
                    pcm.as_ptr(),
                    960,
                    out.as_mut_ptr(),
                    4000,
                )
            };
            assert!(size > 0);
            let last = n + 1 == packets;
            let granule = if last {
                frames + PRE_SKIP
            } else {
                (n + 1) * 960
            };
            let end = if last {
                ogg::PacketWriteEndInfo::EndStream
            } else if n % 50 == 49 {
                ogg::PacketWriteEndInfo::EndPage
            } else {
                ogg::PacketWriteEndInfo::NormalPacket
            };
            writer
                .write_packet(out[..size as usize].to_vec(), serial, end, granule as u64)
                .unwrap();
        }
        // Safety: created above and not freed before.
        unsafe { unsafe_libopus::opus_encoder_destroy(encoder) };
        frames
    }
    /// How often a channel's signal crosses zero going up, per second: its pitch.
    fn pitch(samples: &[f32], channel: usize) -> f32 {
        let one: Vec<f32> = samples.iter().skip(channel).step_by(2).copied().collect();
        let crossings = one.windows(2).filter(|w| w[0] < 0. && w[1] >= 0.).count();
        crossings as f32 * RATE as f32 / one.len() as f32
    }
    #[test]
    fn plays_an_opus_song_whole_and_seeks_to_the_right_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.opus");
        let frames = tone_file(&path, 9);
        let path = path.to_string_lossy().to_string();
        let mut song = OpusSource::open(&path).unwrap().unwrap();
        assert_eq!((song.channels(), song.sample_rate()), (2, 48_000));
        assert_eq!(song.total_duration(), Some(Duration::from_secs(9)));
        let whole: Vec<f32> = song.by_ref().collect();
        // Exactly the song: the encoder's run-in and the padding at the end are left out.
        assert_eq!(whole.len(), frames * 2);
        assert!((pitch(&whole[96_000..], 0) - 440.).abs() < 3.);
        assert!((pitch(&whole[96_000..], 1) - 1320.).abs() < 3.);
        // Seeking lands on the very same samples as playing through to that point: far in
        // (found through the page index), near the start (played from the beginning), and
        // backwards.
        for seconds in [6.5, 0.75, 3.0, 8.99] {
            song.try_seek(Duration::from_secs_f64(seconds)).unwrap();
            let rest: Vec<f32> = song.by_ref().collect();
            let from = (seconds * RATE as f64) as usize * 2;
            assert_eq!(rest.len(), whole.len() - from, "seek to {seconds}");
            let worst = rest
                .iter()
                .zip(&whole[from..])
                .take(9600)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            assert!(worst < 0.002, "seek to {seconds} is off by {worst}");
        }
        // The player and the loudness scan open it as any other song.
        let opened = crate::audio::open(&path).unwrap();
        assert_eq!(opened.total_duration(), Some(Duration::from_secs(9)));
        assert_eq!(opened.count(), frames * 2);
        // An .ogg that is not Opus is left to the other decoder.
        std::fs::write(dir.path().join("other.ogg"), b"OggS not really").unwrap();
        let other = dir.path().join("other.ogg").to_string_lossy().to_string();
        assert!(OpusSource::open(&other).unwrap().is_none());
    }
    #[test]
    #[ignore = "needs SLATE_OPUS_FIXTURES: .opus files with ffmpeg's decode beside them as .ref.f32"]
    fn matches_the_reference_decoder_on_real_files() {
        let dir = std::path::PathBuf::from(std::env::var_os("SLATE_OPUS_FIXTURES").unwrap());
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("opus") {
                continue;
            }
            let reference: Vec<f32> = std::fs::read(path.with_extension("ref.f32"))
                .unwrap()
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            let song = OpusSource::open(&path.to_string_lossy()).unwrap().unwrap();
            let mine: Vec<f32> = song.collect();
            assert_eq!(mine.len(), reference.len(), "{path:?}: the same length");
            let worst = mine
                .iter()
                .zip(&reference)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            println!(
                "{:?}: {} samples, worst difference {worst}",
                path.file_name().unwrap(),
                mine.len()
            );
            assert!(worst < 0.0005, "{path:?} differs by {worst}");
            checked += 1;
        }
        assert!(checked > 0);
    }
    #[test]
    fn reads_what_an_opus_file_says_about_itself() {
        let mut packet = b"OpusHead".to_vec();
        // Version 1, two channels, 312 frames of run-in, recorded at 44.1 kHz, no gain, stereo.
        packet.extend([1, 2, 0x38, 0x01, 0x44, 0xAC, 0, 0, 0, 0, 0]);
        assert_eq!(
            head(&packet).unwrap().unwrap(),
            Head {
                channels: 2,
                pre_skip: 312,
                gain: 1.
            }
        );
        // A gain of -6 dB (in 1/256 dB) roughly halves the level.
        packet[16..18].copy_from_slice(&(-6i16 * 256).to_le_bytes());
        assert!((head(&packet).unwrap().unwrap().gain - 0.501).abs() < 0.001);
        // Surround files use another layout.
        packet[9] = 6;
        packet[18] = 1;
        assert!(head(&packet).unwrap().is_err());
        assert!(head(b"\x01vorbis and the rest of it").is_none());
        assert!(head(b"OpusHead").is_none(), "too short to be a head");
    }
}
