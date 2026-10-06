use crate::db::{err, Database, Result, Track};
use rand::seq::SliceRandom;
use rodio::{source::UniformSourceIterator, Decoder, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Emitter;

const RATE: u32 = 48000;
type StreamSource = Box<dyn Source<Item = f32> + Send>;
pub struct Deck {
    pub id: String,
    pub index: usize,
    pub source: StreamSource,
    pub samples: u64,
    pub duration: f64,
    /// Loudness levelling as a linear factor, and what it is for the signal path.
    pub gain: f32,
    pub gain_db: Option<f64>,
    pub gain_kind: String,
    /// Where the music ends, before any trailing silence (for smart crossfades).
    pub audible_end: f64,
    /// Seconds of silence before the music starts.
    pub start_silence: f64,
    /// Follows the previous song on the same album, so it plays gaplessly, never faded.
    pub continues_album: bool,
    /// The rate this song is mixed at: 48 kHz normally, its own rate in exclusive mode.
    pub rate: u32,
    /// The file's own sample rate.
    pub native: u32,
}
impl Deck {
    /// Opens a song, mixed at the rate `rate_for` picks for the file's own rate.
    fn load(track: &Track, index: usize, rate_for: impl Fn(u32) -> u32) -> Result<Self> {
        let decoder = Decoder::try_from(File::open(&track.path).map_err(err)?).map_err(err)?;
        let duration = decoder
            .total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(track.duration);
        let native = decoder.sample_rate();
        let rate = rate_for(native);
        Ok(Self {
            id: track.id.clone(),
            index,
            source: Box::new(UniformSourceIterator::new(decoder, 2, rate)),
            samples: 0,
            duration,
            gain: 1.,
            gain_db: None,
            gain_kind: "off".into(),
            audible_end: duration,
            start_silence: 0.,
            continues_album: false,
            rate,
            native,
        })
    }
    /// Jumps forward, keeping the position count in whole stereo frames.
    fn skip_to(&mut self, seconds: f64) -> Result<()> {
        let target = seconds.min((self.duration - 0.1).max(0.));
        self.source
            .try_seek(Duration::from_secs_f64(target))
            .map_err(err)?;
        self.samples = (target * self.rate as f64) as u64 * 2;
        Ok(())
    }
    fn position(&self) -> f64 {
        self.samples as f64 / (self.rate * 2) as f64
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Playback {
    pub queue: Vec<String>,
    pub cursor: usize,
    pub current_id: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
    /// Whether samples can advance. A playing queue may be waiting for a deck or device.
    #[serde(skip_deserializing)]
    pub clock_running: bool,
    /// Unix milliseconds at which `position` was read, so the window can allow for the time
    /// this snapshot spent on its way there.
    #[serde(skip_deserializing)]
    pub at: i64,
    /// Seconds between a sample leaving the mixer and being heard, as far as Windows reports.
    #[serde(skip_deserializing)]
    pub output_latency: f64,
    pub volume: f32,
    pub shuffle: bool,
    pub repeat: String,
    pub crossfade: f64,
    pub error: Option<String>,
    pub engine_ready: bool,
    pub system_controls: bool,
    /// Sleep timer deadline in Unix milliseconds. Never restored after a restart.
    pub sleep_at: Option<i64>,
    pub sleep_end_of_track: bool,
    /// Loudness levelling: "off", "track", "album" or "smart" (album gain while an album
    /// plays in order, song gain otherwise).
    pub levelling: String,
    /// Crossfades skip silence at song edges and never fade within an album.
    pub smart_crossfade: bool,
    pub eq: crate::dsp::EqSettings,
    /// The chosen output device's name; None follows the Windows default.
    pub output_device: Option<String>,
    /// Play through the device exclusively, at each song's own rate (bit-perfect).
    pub exclusive: bool,
    /// The device actually playing, for the signal path. Not restored.
    pub output: Option<OutputInfo>,
    /// Levelling applied to the current song, in dB, and whether by song or album.
    pub gain_db: Option<f64>,
    pub gain_kind: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OutputInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// The chosen device was missing, so the Windows default is used.
    pub fallback: bool,
    /// Exclusive mode: Slate Music has the device to itself.
    pub exclusive: bool,
    /// Bits per sample sent to the device in exclusive mode.
    pub bits: u16,
}
impl Default for Playback {
    fn default() -> Self {
        Self {
            queue: vec![],
            cursor: 0,
            current_id: None,
            position: 0.,
            duration: 0.,
            playing: false,
            clock_running: false,
            at: 0,
            output_latency: 0.,
            volume: 0.7,
            shuffle: false,
            repeat: "off".into(),
            crossfade: 0.,
            error: None,
            engine_ready: false,
            system_controls: false,
            sleep_at: None,
            sleep_end_of_track: false,
            levelling: "smart".into(),
            smart_crossfade: true,
            eq: crate::dsp::EqSettings::default(),
            output_device: None,
            exclusive: false,
            output: None,
            gain_db: None,
            gain_kind: "off".into(),
        }
    }
}
pub struct RenderState {
    pub state: Playback,
    pub current: Option<Deck>,
    pub next: Option<Deck>,
    pub epoch: u64,
    pub transition: u64,
    pub stopping: bool,
    pub next_attempt: Option<(u64, usize)>,
    /// A failed repeat of the current song, scoped to the queue/settings epoch. At EOF it
    /// must stop rather than wait forever for an attempt that has already finished.
    pub next_failed: Option<(u64, usize)>,
    /// Old → new ID of the playing song after its file moved, so it is not counted again.
    pub renamed: HashMap<String, String>,
    pub eq: crate::dsp::Equalizer,
    /// Which channel the next output sample is for (0 left, 1 right).
    pub channel: usize,
    /// The output device changed; the audio thread opens it again.
    pub reopen: bool,
    /// The rate the output runs at: 48 kHz, or the song's own in exclusive mode.
    pub rate: u32,
    /// Exclusive mode is running, and what the device takes.
    pub exclusive: Option<crate::exclusive::Support>,
    /// The next song needs the device at another rate; silence until it is reopened.
    pub rate_pending: bool,
    /// Samples handed to the output so far. A shared output whose count stops rising has
    /// silently died (a device that went away without an error) and is opened again.
    pub pulled: u64,
    /// The song ended while the next one was still being prepared (for example after a queue
    /// edit in its last moments): playback stays on, silent, until the next song is ready.
    pub waiting: bool,
    /// Seconds the open output takes to make a mixed sample audible (0 when not known).
    pub latency: f64,
}
impl RenderState {
    /// The rate a song whose file is at `native` Hz is mixed at.
    fn deck_rate(&self, native: u32) -> u32 {
        self.exclusive.as_ref().map_or(RATE, |s| s.rate_for(native))
    }
    pub fn current_rate(&self) -> u32 {
        self.current.as_ref().map_or(self.rate, |d| d.rate)
    }
    /// The output now runs at `rate`.
    pub fn use_rate(&mut self, rate: u32) {
        if self.rate != rate {
            self.rate = rate;
            self.eq = crate::dsp::Equalizer::new(&self.state.eq, rate as f64);
        }
        self.rate_pending = false;
        self.channel = 0;
    }
    /// The crossfade in use: none for the end-of-song sleep timer (the song plays to its real
    /// end) or in exclusive mode (songs are sent untouched, never mixed).
    fn effective_crossfade(&self) -> f64 {
        if self.state.sleep_end_of_track || self.exclusive.is_some() {
            0.
        } else {
            self.state.crossfade
        }
    }
    /// The loaded song was opened for another output rate (exclusive mode just ended) and must
    /// be opened again before it plays, never at the wrong speed.
    fn wrong_rate(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|d| d.rate != self.deck_rate(d.native))
    }
    /// Unloads the playing song but keeps its place, so Play opens it again.
    fn unload(&mut self) {
        let s = self.snapshot();
        self.state.cursor = s.cursor;
        self.state.current_id = s.current_id;
        self.state.position = s.position;
        self.state.duration = s.duration;
        self.state.playing = false;
        self.current = None;
        self.next = None;
        self.waiting = false;
        self.epoch += 1;
        self.next_attempt = None;
    }
    /// Ends a sleep timer whose time is up: pauses if playing, and clears it either way (a
    /// deadline that passes while paused must not stop the next play).
    fn apply_sleep(&mut self, now: i64) {
        if self.state.sleep_at.is_some_and(|at| now >= at) {
            self.state.playing = false;
            self.state.sleep_at = None;
        }
    }
    fn remove_queued(&mut self, index: usize) {
        let mut remove = vec![false; self.state.queue.len()];
        if let Some(slot) = remove.get_mut(index) {
            *slot = true;
            self.remove_rows(&remove);
        }
    }
    /// Removes every queue entry marked in `remove` in one pass, keeping the cursor on the same
    /// song (or, when that song itself is removed, on the one after it).
    fn remove_rows(&mut self, remove: &[bool]) {
        let cursor = self.current.as_ref().map_or(self.state.cursor, |d| d.index);
        let removed_before = remove.iter().take(cursor).filter(|r| **r).count();
        let cursor_removed = remove.get(cursor) == Some(&true);
        let mut i = 0;
        self.state.queue.retain(|_| {
            i += 1;
            !remove.get(i - 1).copied().unwrap_or(false)
        });
        let next_cursor = (cursor - removed_before).min(self.state.queue.len().saturating_sub(1));
        self.state.cursor = next_cursor;
        if let Some(deck) = self.current.as_mut() {
            deck.index = next_cursor;
        }
        self.state.current_id = self.state.queue.get(next_cursor).cloned();
        if cursor_removed && self.current.is_none() {
            self.state.position = 0.;
            self.state.duration = 0.;
            self.state.playing = false;
        }
        self.next = None;
        self.epoch += 1;
        self.next_attempt = None;
    }
    fn snapshot(&self) -> Playback {
        let mut s = self.state.clone();
        s.clock_running = s.playing
            && self.current.is_some()
            && !self.stopping
            && !self.waiting
            && !self.rate_pending
            && !self.wrong_rate();
        s.at = crate::db::now();
        s.output_latency = self.latency;
        if let Some(d) = &self.current {
            s.current_id = Some(d.id.clone());
            s.cursor = d.index;
            s.position = d.position();
            s.duration = d.duration;
            s.gain_db = d.gain_db;
            s.gain_kind = d.gain_kind.clone();
        }
        s
    }
    /// Makes the prepared next song current. False when there is none.
    fn advance(&mut self) -> bool {
        let Some(next) = self.next.take() else {
            return false;
        };
        self.state.cursor = next.index;
        self.state.current_id = Some(next.id.clone());
        // In exclusive mode a song at another rate waits for the device to be reopened.
        self.rate_pending = self.exclusive.is_some() && next.rate != self.rate;
        self.current = Some(next);
        self.waiting = false;
        self.transition += 1;
        self.epoch += 1;
        self.next_attempt = None;
        true
    }
    fn next_index(&self) -> Option<usize> {
        if self.state.queue.is_empty() {
            return None;
        }
        let cursor = self
            .current
            .as_ref()
            .map(|d| d.index)
            .unwrap_or(self.state.cursor);
        if self.state.repeat == "one" {
            Some(cursor)
        } else if cursor + 1 < self.state.queue.len() {
            Some(cursor + 1)
        } else if self.state.repeat == "all" {
            Some(0)
        } else {
            None
        }
    }
    fn preload_failed(&mut self, index: usize, epoch: u64, error: String) {
        if self.epoch != epoch {
            return;
        }
        self.state.error = Some(error);
        let cursor = self.current.as_ref().map_or(self.state.cursor, |d| d.index);
        if index != cursor && index < self.state.queue.len() {
            self.remove_queued(index);
        } else {
            self.next_failed = Some((epoch, index));
            if self.waiting {
                self.waiting = false;
                self.state.playing = false;
            }
        }
    }
    /// The next output sample. Output alternates left and right, starting on the left.
    pub fn sample(&mut self) -> f32 {
        self.pulled += 1;
        let sample = self.render_sample();
        self.channel ^= 1;
        sample
    }
    fn render_sample(&mut self) -> f32 {
        if !self.state.playing || self.stopping || self.rate_pending {
            return 0.;
        }
        let crossfade = self.effective_crossfade();
        let smart = self.state.smart_crossfade;
        let fades_into_next = crossfade > 0.
            && self
                .next
                .as_ref()
                .is_some_and(|n| !(smart && n.continues_album));
        // Smart crossfade: once the music itself has ended, go straight to the next song
        // (at a whole stereo frame, so the channels stay in order).
        if smart && fades_into_next {
            if let Some(current) = &self.current {
                if current.samples % 2 == 0
                    && self.channel == 0
                    && current.position() >= current.audible_end
                    && self.advance()
                {
                    return self.render_sample();
                }
            }
        }
        // Never play a song opened for another output rate: it would play at the wrong speed.
        if self.exclusive.is_none() && self.wrong_rate() {
            return 0.;
        }
        let channel = self.channel as u64;
        let Some(current) = self.current.as_mut() else {
            return 0.;
        };
        // A song loaded or sought between a left and a right sample waits for the next left
        // one, so its left channel is never played on the right.
        if current.samples % 2 != channel {
            return 0.;
        }
        if let Some(sample) = current.source.next() {
            let mut sample = sample * current.gain;
            let fade = if fades_into_next {
                crossfade
                    .min(current.duration / 2.)
                    .min(self.next.as_ref().map(|d| d.duration / 2.).unwrap_or(0.))
                    .max(0.)
            } else {
                0.
            };
            let end = if smart {
                current.audible_end
            } else {
                current.duration
            };
            let remaining = end - current.position();
            if fade > 0. && remaining <= fade {
                if let Some(next) = self.next.as_mut() {
                    // The next song joins on a left sample and then keeps step, so its
                    // channels stay in order through the fade and after it.
                    if next.samples % 2 == current.samples % 2 {
                        if let Some(n) = next.source.next() {
                            let ratio = (1. - remaining / fade).clamp(0., 1.) as f32;
                            sample = sample * (1. - ratio) + n * next.gain * ratio;
                            next.samples += 1;
                        }
                    }
                }
            }
            current.samples += 1;
            let shaped = self.eq.process(sample, self.channel) * self.state.volume;
            return shaped.clamp(-1., 1.);
        }
        if self.advance() {
            if self.state.sleep_end_of_track {
                // Sleep timer: the next song is ready but waits, paused at its start.
                self.state.sleep_end_of_track = false;
                self.state.playing = false;
                return 0.;
            }
            return self.render_sample();
        }
        if self
            .next_index()
            .is_some_and(|index| self.next_failed != Some((self.epoch, index)))
        {
            // The next song is still being prepared (the queue or a setting changed in the
            // song's last moments): stay on, silent, instead of stopping.
            self.waiting = true;
            return 0.;
        }
        self.waiting = false;
        self.state.sleep_end_of_track = false;
        self.state.playing = false;
        self.state.position = self.current.as_ref().map(|d| d.duration).unwrap_or(0.);
        0.
    }
}
/// The new order of a list of `len` items after moving `rows` (kept in their order) to sit
/// before position `to` of the original list (`to == len` moves them to the end).
pub fn move_rows(len: usize, rows: &[usize], to: usize) -> Vec<usize> {
    let rows: HashSet<usize> = rows.iter().copied().collect();
    let moving: Vec<usize> = (0..len).filter(|i| rows.contains(i)).collect();
    let mut order: Vec<usize> = (0..len).filter(|i| !rows.contains(i)).collect();
    let at = order.iter().position(|&i| i >= to).unwrap_or(order.len());
    order.splice(at..at, moving);
    order
}
/// The output device to open: the named one when it is connected, else the Windows default.
/// Returns the device (None = default), its name, and whether the named one was missing.
fn choose_device(wanted: Option<&str>) -> (Option<rodio::Device>, String, bool) {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    let named = wanted.and_then(|name| {
        host.output_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name))
    });
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_else(|| "Default output".into());
    match named {
        Some(d) => (Some(d), wanted.unwrap_or_default().into(), false),
        None => (None, default_name, wanted.is_some()),
    }
}
/// Queue positions from a command's list.
fn indices(value: &serde_json::Value) -> Result<Vec<usize>> {
    let rows: Vec<usize> = value
        .as_array()
        .ok_or("Missing queue positions")?
        .iter()
        .filter_map(|v| v.as_u64().map(|n| n as usize))
        .collect();
    if rows.is_empty() {
        return Err("Missing queue positions".into());
    }
    Ok(rows)
}
/// Output devices Windows offers, and which one is the default.
pub fn output_devices() -> (Vec<String>, Option<String>) {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let names = rodio::cpal::default_host()
        .output_devices()
        .map(|all| all.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    (names, default_device_name())
}
/// The name of Windows' current default output device.
fn default_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}
/// Whether the open output should be replaced: while following Windows' default, the default
/// is now another device (headphones plugged in or reconnected); or a chosen device that was
/// missing, so the default stood in, is connected again. `shown` is the device playing,
/// `default` and `names` what Windows offers now.
fn device_changed(
    wanted: Option<&str>,
    shown: Option<&OutputInfo>,
    default: Option<&str>,
    names: &[String],
) -> bool {
    let Some(shown) = shown else {
        return false;
    };
    match wanted {
        None => default.is_some_and(|d| d != shown.device),
        Some(name) => shown.fallback && names.iter().any(|n| n == name),
    }
}
/// Whether the device playing (`shown`) is no longer among the devices Windows offers.
fn device_gone(shown: Option<&OutputInfo>, names: &[String]) -> bool {
    shown.is_some_and(|s| !names.iter().any(|n| *n == s.device))
}
/// Where sound goes: Windows' shared mixer, or the device to ourselves (exclusive mode).
/// Holding one keeps it playing; dropping it stops it, so its parts are never read.
#[allow(dead_code)]
enum Output {
    Shared(rodio::OutputStream, Sink),
    #[cfg(windows)]
    Exclusive(crate::wasapi::Exclusive),
}
pub struct Mixer(pub Arc<Mutex<RenderState>>);
impl Iterator for Mixer {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        Some(self.0.lock().unwrap().sample())
    }
}
impl Source for Mixer {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        RATE
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}
/// The song playing, where it is, and a count that rises each time a song starts (also when
/// the same song starts again).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listening {
    pub id: Option<String>,
    pub position: f64,
    pub playing: bool,
    pub transition: u64,
}
pub struct Engine {
    pub render: Arc<Mutex<RenderState>>,
    pub db: Arc<Database>,
    command_lock: Mutex<()>,
}
impl Engine {
    pub fn new(db: Arc<Database>) -> Arc<Self> {
        let mut state: Playback = serde_json::from_value(db.get("session")).unwrap_or_default();
        state.playing = false;
        state.engine_ready = false;
        state.system_controls = false;
        state.error = None;
        state.sleep_at = None;
        state.sleep_end_of_track = false;
        state.output = None;
        state.gain_db = None;
        if !["off", "track", "album", "smart"].contains(&state.levelling.as_str()) {
            state.levelling = "smart".into();
        }
        if state.eq.validate().is_err() {
            state.eq = crate::dsp::EqSettings::default();
        }
        let eq = crate::dsp::Equalizer::new(&state.eq, RATE as f64);
        state.volume = state.volume.clamp(0., 1.);
        state.crossfade = state.crossfade.clamp(0., 12.);
        if state.queue.is_empty() {
            state.current_id = None;
            state.cursor = 0;
            state.position = 0.;
            state.duration = 0.;
        } else if state.queue.get(state.cursor) != state.current_id.as_ref() {
            state.cursor = state
                .current_id
                .as_ref()
                .and_then(|id| state.queue.iter().position(|entry| entry == id))
                .unwrap_or(state.cursor.min(state.queue.len() - 1));
            state.current_id = state.queue.get(state.cursor).cloned();
            state.position = 0.;
            state.duration = 0.;
        }
        Arc::new(Self {
            render: Arc::new(Mutex::new(RenderState {
                state,
                current: None,
                next: None,
                epoch: 0,
                transition: 0,
                stopping: false,
                next_attempt: None,
                next_failed: None,
                renamed: HashMap::new(),
                eq,
                channel: 0,
                reopen: false,
                rate: RATE,
                exclusive: None,
                rate_pending: false,
                pulled: 0,
                waiting: false,
                latency: 0.,
            })),
            db,
            command_lock: Mutex::new(()),
        })
    }
    pub fn snapshot(&self) -> Playback {
        self.render.lock().unwrap().snapshot()
    }
    /// What is playing, without copying the queue: for watchers that look every second.
    pub fn listening(&self) -> Listening {
        let r = self.render.lock().unwrap();
        let (id, position) = match &r.current {
            Some(d) => (Some(d.id.clone()), d.position()),
            None => (r.state.current_id.clone(), r.state.position),
        };
        Listening {
            id,
            position,
            playing: r.state.playing,
            transition: r.transition,
        }
    }
    pub fn save(&self) {
        let mut s = self.snapshot();
        s.playing = false;
        let _ = self.db.set("session", &serde_json::to_value(s).unwrap());
    }
    /// Applies changed sound settings to the playing song and prepares the next one again.
    fn reshape(&self) {
        let (current, levelling, queue) = {
            let r = self.render.lock().unwrap();
            (
                r.current.as_ref().map(|d| (d.id.clone(), d.index)),
                r.state.levelling.clone(),
                r.state.queue.clone(),
            )
        };
        if let Some((id, index)) = current {
            if let Ok(t) = self.db.track(&id) {
                // Shape a stand-in deck, then copy its results onto the playing one.
                let mut probe = Deck {
                    id: id.clone(),
                    index,
                    source: Box::new(rodio::source::Empty::new()),
                    samples: 0,
                    duration: t.duration,
                    gain: 1.,
                    gain_db: None,
                    gain_kind: "off".into(),
                    audible_end: t.duration,
                    start_silence: 0.,
                    continues_album: false,
                    rate: RATE,
                    native: RATE,
                };
                self.shape(&mut probe, &t, &levelling, &queue);
                let mut r = self.render.lock().unwrap();
                if let Some(d) = r.current.as_mut().filter(|d| d.id == id) {
                    d.gain = probe.gain;
                    d.gain_db = probe.gain_db;
                    d.gain_kind = probe.gain_kind;
                    d.audible_end = probe.audible_end.min(d.duration);
                }
            }
        }
        let mut r = self.render.lock().unwrap();
        r.next = None;
        r.epoch += 1;
        r.next_attempt = None;
    }
    /// Points the listening session at the new IDs of songs whose files moved.
    pub fn remap(&self, moved: &[(String, String)]) {
        if moved.is_empty() {
            return;
        }
        let map: HashMap<&str, &str> = moved
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        {
            let mut r = self.render.lock().unwrap();
            let r = &mut *r;
            for id in r.state.queue.iter_mut().chain(r.state.current_id.as_mut()) {
                if let Some(new) = map.get(id.as_str()) {
                    *id = new.to_string();
                }
            }
            for deck in r.current.iter_mut().chain(r.next.as_mut()) {
                if let Some(new) = map.get(deck.id.as_str()) {
                    r.renamed.insert(deck.id.clone(), new.to_string());
                    deck.id = new.to_string();
                }
            }
        }
        self.save();
    }
    /// Drops forgotten songs from the queue in one pass, except the one that is loaded.
    pub fn forget(&self, ids: &HashSet<String>) {
        {
            let mut r = self.render.lock().unwrap();
            let loaded = r.current.as_ref().map(|d| d.index);
            let remove: Vec<bool> = r
                .state
                .queue
                .iter()
                .enumerate()
                .map(|(i, id)| ids.contains(id) && Some(i) != loaded)
                .collect();
            if !remove.iter().any(|r| *r) {
                return;
            }
            r.remove_rows(&remove);
        }
        self.save();
    }
    /// Starts or ends exclusive mode (with what the device takes), reloading the playing song
    /// where it was, at the rate the new output needs.
    fn use_exclusive(&self, support: Option<crate::exclusive::Support>) {
        let reload = {
            let mut r = self.render.lock().unwrap();
            if r.exclusive == support {
                return;
            }
            r.exclusive = support;
            if r.exclusive.is_none() {
                r.use_rate(RATE);
            }
            r.next = None;
            r.epoch += 1;
            r.next_attempt = None;
            let s = r.snapshot();
            r.current
                .is_some()
                .then_some((s.cursor, s.position, s.playing))
        };
        if let Some((index, position, playing)) = reload {
            let _ = self.load(index, position, playing);
        }
        self.fix_rate();
    }
    /// A song still opened for the previous output rate (its reload failed or was overtaken)
    /// is opened again where it was; if that fails it is unloaded, keeping its place.
    fn fix_rate(&self) {
        let reload = {
            let r = self.render.lock().unwrap();
            if !r.wrong_rate() {
                return;
            }
            let s = r.snapshot();
            (s.cursor, s.position, s.playing)
        };
        if self.load(reload.0, reload.1, reload.2).is_err()
            || self.render.lock().unwrap().wrong_rate()
        {
            self.render.lock().unwrap().unload();
        }
    }
    fn prepare(&self, id: &str, index: usize) -> Result<Deck> {
        let queue = self.render.lock().unwrap().state.queue.clone();
        self.prepare_in(id, index, &queue)
    }
    /// Prepares a song as it will sit in `queue` (which may not be the current queue yet).
    fn prepare_in(&self, id: &str, index: usize, queue: &[String]) -> Result<Deck> {
        let t = self.db.track(id)?;
        if !std::path::Path::new(&t.path).is_file() {
            let _ = self.db.missing(id, true);
            return Err(format!(
                "File unavailable: {}. Reconnect its drive or rescan.",
                t.title
            ));
        }
        let mut deck = Deck::load(&t, index, |native| {
            self.render.lock().unwrap().deck_rate(native)
        })?;
        let levelling = self.render.lock().unwrap().state.levelling.clone();
        self.shape(&mut deck, &t, &levelling, queue);
        Ok(deck)
    }
    /// Sets a deck's loudness gain, audible end and album continuity from the library's
    /// measurements and its neighbours in the queue.
    fn shape(&self, deck: &mut Deck, t: &Track, levelling: &str, queue: &[String]) {
        let neighbour = |i: Option<usize>| {
            i.and_then(|i| queue.get(i))
                .and_then(|id| self.db.track(id).ok())
        };
        let previous = neighbour(deck.index.checked_sub(1));
        let following = neighbour(Some(deck.index + 1));
        let same_album = |o: &Track| {
            o.album == t.album && o.album_artist == t.album_artist && !t.album.is_empty()
        };
        deck.continues_album = previous.as_ref().is_some_and(|p| {
            same_album(p)
                && ((t.disc == p.disc && t.track == p.track + 1)
                    || (t.disc == p.disc + 1 && t.track == 1))
        });
        let own = self
            .db
            .loudness(&[crate::loudness::key(t)])
            .ok()
            .and_then(|mut m| m.remove(&crate::loudness::key(t)));
        if let Some(l) = &own {
            // Never trust a measurement that would cut more than half the song.
            deck.audible_end = (deck.duration - l.end_silence).max(deck.duration / 2.);
            deck.start_silence = l.start_silence.min(deck.duration / 2.);
        }
        let album_mode = levelling == "album"
            || (levelling == "smart"
                && (previous.as_ref().is_some_and(same_album)
                    || following.as_ref().is_some_and(same_album)));
        let album = if album_mode {
            self.db
                .album_tracks(&t.album, &t.album_artist)
                .ok()
                .and_then(|tracks| {
                    let songs: Vec<Track> = tracks.into_iter().filter(same_album).collect();
                    let keys: Vec<String> = songs.iter().map(crate::loudness::key).collect();
                    let measured = self.db.loudness(&keys).ok()?;
                    let list: Vec<_> = songs
                        .iter()
                        .filter_map(|o| {
                            measured
                                .get(&crate::loudness::key(o))
                                .map(|l| (l.clone(), o.duration))
                        })
                        .collect();
                    crate::loudness::album_gain(&list)
                })
        } else {
            None
        };
        let (gain, kind) = match (levelling, album, &own) {
            ("off", _, _) => (None, "off"),
            (_, Some(g), _) => (Some(g), "album"),
            (_, None, Some(l)) => (Some(crate::loudness::track_gain(l)), "track"),
            _ => (None, "unmeasured"),
        };
        deck.gain = gain.map_or(1., |(db, peak)| crate::loudness::linear(db, peak));
        // Report what is really applied, after the boost limit and clip protection.
        deck.gain_db = gain.map(|_| 20. * (deck.gain as f64).log10());
        deck.gain_kind = kind.into();
    }
    fn load(&self, index: usize, position: f64, playing: bool) -> Result<()> {
        // Opening a song takes a moment; if a song ended or the queue moved meanwhile, open it
        // again rather than silently ignoring the request.
        for _ in 0..3 {
            let (id, epoch) = {
                let r = self.render.lock().unwrap();
                (
                    r.state.queue.get(index).cloned().ok_or("Queue is empty")?,
                    r.epoch,
                )
            };
            let mut deck = self.prepare(&id, index)?;
            if position > 0. {
                deck.skip_to(position)?;
            }
            let mut r = self.render.lock().unwrap();
            if r.epoch != epoch {
                continue;
            }
            let new_play = r
                .current
                .as_ref()
                .is_none_or(|d| d.id != id || d.index != index);
            r.rate_pending = r.exclusive.is_some() && deck.rate != r.rate;
            r.current = Some(deck);
            r.next = None;
            r.waiting = false;
            r.state.cursor = index;
            r.state.current_id = Some(id);
            r.state.playing = playing;
            r.state.error = None;
            r.epoch += 1;
            if new_play {
                r.transition += 1;
            }
            r.next_attempt = None;
            return Ok(());
        }
        Err("Playback changed while the song was opening. Try again.".into())
    }
    pub fn command(&self, action: &str, value: serde_json::Value) -> Result<Playback> {
        let _guard = self.command_lock.lock().unwrap();
        let result = (|| -> Result<()> {
            match action {
                "queue" => {
                    if !self.snapshot().engine_ready {
                        return Err("No audio output is available. Connect an output device, then try again.".into());
                    }
                    let ids: Vec<String> =
                        serde_json::from_value(value["ids"].clone()).map_err(err)?;
                    if ids.len() > 100000 {
                        return Err("Queue is too large".into());
                    }
                    let requested = value["index"].as_u64().unwrap_or(0) as usize;
                    let available: HashSet<String> = self
                        .db
                        .tracks()?
                        .into_iter()
                        .filter(|t| !t.missing)
                        .map(|t| t.id)
                        .collect();
                    let mut valid = Vec::with_capacity(ids.len());
                    let mut index = 0;
                    for (original_index, id) in ids.into_iter().enumerate() {
                        if available.contains(&id) {
                            if original_index == requested {
                                index = valid.len();
                            }
                            valid.push(id);
                        }
                    }
                    if valid.is_empty() {
                        return Err("No available files in this selection".into());
                    }
                    if self.snapshot().shuffle {
                        let current = valid.remove(index);
                        valid.shuffle(&mut rand::rng());
                        valid.insert(0, current);
                        index = 0;
                    }
                    // Decode first: an unavailable replacement must not destroy the current session.
                    let deck = self.prepare_in(&valid[index], index, &valid)?;
                    {
                        let mut r = self.render.lock().unwrap();
                        r.state.queue = valid;
                        r.state.cursor = index;
                        r.state.current_id = Some(deck.id.clone());
                        r.state.position = 0.;
                        r.state.duration = deck.duration;
                        r.state.playing = true;
                        r.state.error = None;
                        r.rate_pending = r.exclusive.is_some() && deck.rate != r.rate;
                        r.current = Some(deck);
                        r.next = None;
                        r.waiting = false;
                        r.epoch += 1;
                        r.transition += 1;
                        r.next_attempt = None;
                    }
                }
                "play" | "toggle" => {
                    let s = self.snapshot();
                    if !s.engine_ready {
                        return Err("No audio output is available. Check your Windows output device and reopen Slate Music.".into());
                    }
                    if s.current_id.is_none() && s.queue.is_empty() {
                        return Err("Choose a song to start listening".into());
                    }
                    if self.render.lock().unwrap().current.is_none() {
                        self.load(s.cursor, s.position, true)?
                    } else if !s.playing
                        && s.position >= s.duration - 0.03
                        && !self.render.lock().unwrap().waiting
                    {
                        self.load(s.cursor, 0., true)?
                    } else {
                        let mut r = self.render.lock().unwrap();
                        r.state.playing = if action == "play" {
                            true
                        } else {
                            !r.state.playing
                        };
                    }
                }
                "pause" => self.render.lock().unwrap().state.playing = false,
                "next" | "previous" => {
                    let s = self.snapshot();
                    let index = if action == "previous" {
                        if s.position > 3. {
                            s.cursor
                        } else {
                            s.cursor.saturating_sub(1)
                        }
                    } else {
                        if s.cursor + 1 < s.queue.len() {
                            s.cursor + 1
                        } else if s.repeat == "all" {
                            0
                        } else {
                            self.render.lock().unwrap().state.playing = false;
                            return Ok(());
                        }
                    };
                    self.load(index, 0., true)?;
                }
                "seek" => {
                    let s = self.snapshot();
                    let p = value
                        .as_f64()
                        .filter(|p| p.is_finite())
                        .ok_or("Invalid position")?
                        .max(0.);
                    self.load(s.cursor, p, s.playing)?;
                }
                "volume" => {
                    let v = value
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .ok_or("Invalid volume")?;
                    self.render.lock().unwrap().state.volume = v.clamp(0., 1.) as f32;
                }
                "repeat" => {
                    let mode = value.as_str().unwrap_or("off");
                    if !["off", "all", "one"].contains(&mode) {
                        return Err("Invalid repeat mode".into());
                    }
                    let mut r = self.render.lock().unwrap();
                    r.state.repeat = mode.into();
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                "crossfade" => {
                    let fade = value
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .unwrap_or(0.)
                        .clamp(0., 12.);
                    let mut r = self.render.lock().unwrap();
                    let was_fading = r.effective_crossfade() > 0.;
                    r.state.crossfade = fade;
                    if was_fading != (r.effective_crossfade() > 0.) {
                        // A smart fade may already have skipped the next song's introduction.
                        // Prepare it again using the new setting, including when fading is off.
                        r.next = None;
                        r.epoch += 1;
                        r.next_attempt = None;
                    }
                }
                "shuffle" => {
                    let mut r = self.render.lock().unwrap();
                    r.state.shuffle = value.as_bool().unwrap_or(false);
                    if r.state.shuffle {
                        let start = r.snapshot().cursor + 1;
                        if start < r.state.queue.len() {
                            r.state.queue[start..].shuffle(&mut rand::rng());
                        }
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                // One song ID or a list; the whole list is checked before the queue changes.
                "append" | "insert_next" => {
                    let ids: Vec<String> = match value.as_str() {
                        Some(id) => vec![id.into()],
                        None => serde_json::from_value(value).map_err(|_| "Missing song")?,
                    };
                    let mut first_duration = 0.;
                    for (i, id) in ids.iter().enumerate() {
                        let t = self.db.track(id)?;
                        if t.missing {
                            return Err("That file is unavailable".into());
                        }
                        if i == 0 {
                            first_duration = t.duration;
                        }
                    }
                    if ids.is_empty() {
                        return Err("Missing song".into());
                    }
                    let mut r = self.render.lock().unwrap();
                    if r.state.queue.len() + ids.len() > 100000 {
                        return Err("Queue is too large".into());
                    }
                    if r.state.current_id.is_none() || r.state.queue.is_empty() {
                        r.state.queue.extend(ids);
                        r.state.cursor = 0;
                        r.state.current_id = r.state.queue.first().cloned();
                        r.state.position = 0.;
                        r.state.duration = first_duration;
                    } else if action == "insert_next" {
                        let at = (r.snapshot().cursor + 1).min(r.state.queue.len());
                        r.state.queue.splice(at..at, ids);
                    } else {
                        r.state.queue.extend(ids);
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                // Keeps the current song (and playback) and drops everything else.
                "clear_upcoming" => {
                    let mut r = self.render.lock().unwrap();
                    let s = r.snapshot();
                    match s.current_id.filter(|id| s.queue.get(s.cursor) == Some(id)) {
                        Some(id) => {
                            r.state.queue = vec![id];
                            r.state.cursor = 0;
                            if let Some(d) = r.current.as_mut() {
                                d.index = 0;
                            }
                        }
                        None => {
                            r.state.queue.clear();
                            r.current = None;
                            r.waiting = false;
                            r.state.current_id = None;
                            r.state.position = 0.;
                            r.state.duration = 0.;
                            r.state.playing = false;
                        }
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                "sleep" => {
                    let mut r = self.render.lock().unwrap();
                    let was_end_of_track = r.state.sleep_end_of_track;
                    r.state.sleep_at = None;
                    r.state.sleep_end_of_track = false;
                    if value["endOfTrack"].as_bool() == Some(true) {
                        r.state.sleep_end_of_track = true;
                    } else if let Some(minutes) = value["minutes"]
                        .as_f64()
                        .filter(|m| m.is_finite() && *m > 0. && *m <= 720.)
                    {
                        r.state.sleep_at = Some(crate::db::now() + (minutes * 60000.) as i64);
                    }
                    if r.state.sleep_end_of_track != was_end_of_track {
                        // End-of-song sleep must leave the following song at its real start,
                        // even if it was already prepared (or partially mixed) for a crossfade.
                        r.next = None;
                        r.epoch += 1;
                        r.next_attempt = None;
                    }
                }
                "dismiss_error" => {}
                "levelling" => {
                    let mode = value.as_str().unwrap_or("smart");
                    if !["off", "track", "album", "smart"].contains(&mode) {
                        return Err("Invalid levelling mode".into());
                    }
                    self.render.lock().unwrap().state.levelling = mode.into();
                    self.reshape();
                }
                "smart_crossfade" => {
                    self.render.lock().unwrap().state.smart_crossfade =
                        value.as_bool().unwrap_or(true);
                    self.reshape();
                }
                "eq" => {
                    let settings: crate::dsp::EqSettings =
                        serde_json::from_value(value).map_err(|_| "Invalid equalizer settings")?;
                    settings.validate()?;
                    let mut r = self.render.lock().unwrap();
                    r.eq = crate::dsp::Equalizer::new(&settings, r.rate as f64);
                    r.state.eq = settings;
                }
                "device" => {
                    let mut r = self.render.lock().unwrap();
                    r.state.output_device = value.as_str().map(str::to_owned);
                    r.reopen = true;
                }
                "exclusive" => {
                    let on = value.as_bool().ok_or("Missing exclusive mode setting")?;
                    let mut r = self.render.lock().unwrap();
                    r.state.exclusive = on;
                    r.reopen = true;
                }
                "remove" => {
                    let index = value.as_u64().ok_or("Missing queue index")? as usize;
                    let mut r = self.render.lock().unwrap();
                    if index >= r.state.queue.len() {
                        return Err("Queue entry not found".into());
                    }
                    if index == r.snapshot().cursor && r.current.is_some() {
                        return Err("Skip the playing song before removing it".into());
                    }
                    r.remove_queued(index);
                }
                "move" => {
                    let from = value["from"].as_u64().ok_or("Missing source")? as usize;
                    let to = value["to"].as_u64().ok_or("Missing destination")? as usize;
                    let mut r = self.render.lock().unwrap();
                    if from >= r.state.queue.len() || to >= r.state.queue.len() {
                        return Err("Queue entry not found".into());
                    }
                    let current = r.snapshot().cursor;
                    let id = r.state.queue.remove(from);
                    r.state.queue.insert(to, id);
                    let mapped = if current == from {
                        to
                    } else if from < current && to >= current {
                        current - 1
                    } else if from > current && to <= current {
                        current + 1
                    } else {
                        current
                    };
                    r.state.cursor = mapped;
                    if let Some(d) = &mut r.current {
                        d.index = mapped
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                "move_many" => {
                    let rows = indices(&value["rows"])?;
                    let to = value["to"].as_u64().ok_or("Missing destination")? as usize;
                    let mut r = self.render.lock().unwrap();
                    let len = r.state.queue.len();
                    if rows.iter().any(|&i| i >= len) || to > len {
                        return Err("Queue entry not found".into());
                    }
                    let current = r.snapshot().cursor;
                    let order = move_rows(len, &rows, to);
                    let queue: Vec<String> =
                        order.iter().map(|&i| r.state.queue[i].clone()).collect();
                    r.state.queue = queue;
                    let mapped = order.iter().position(|&i| i == current).unwrap_or(current);
                    r.state.cursor = mapped;
                    if let Some(d) = &mut r.current {
                        d.index = mapped
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                "remove_many" => {
                    let rows: HashSet<usize> = indices(&value)?.into_iter().collect();
                    let mut r = self.render.lock().unwrap();
                    let cursor = r.snapshot().cursor;
                    let playing = r.current.is_some();
                    // One pass, however many rows; the playing song stays.
                    let remove: Vec<bool> = (0..r.state.queue.len())
                        .map(|i| rows.contains(&i) && !(playing && i == cursor))
                        .collect();
                    if remove.iter().any(|r| *r) {
                        r.remove_rows(&remove);
                    }
                }
                "jump" => {
                    let i = value.as_u64().ok_or("Missing queue index")? as usize;
                    self.load(i, 0., true)?;
                }
                "clear" => {
                    let mut r = self.render.lock().unwrap();
                    r.state.queue.clear();
                    r.current = None;
                    r.next = None;
                    r.waiting = false;
                    r.state.current_id = None;
                    r.state.position = 0.;
                    r.state.duration = 0.;
                    r.state.playing = false;
                    r.epoch += 1;
                    r.next_attempt = None;
                }
                _ => return Err("Unknown playback action".into()),
            }
            Ok(())
        })();
        // A successful command means an old message no longer describes the session.
        self.render.lock().unwrap().state.error = result.as_ref().err().cloned();
        self.save();
        result?;
        Ok(self.snapshot())
    }
    pub fn start(self: &Arc<Self>, app: tauri::AppHandle, hwnd: usize) {
        let engine = self.clone();
        std::thread::spawn(move || {
            let lost = Arc::new(AtomicBool::new(false));
            let mut output: Option<Output> = None;
            // Why exclusive mode stopped, and whether to stay shared until it is asked for again.
            let problem = Arc::new(Mutex::new(None::<String>));
            let mut exclusive_blocked = false;
            let mut media = souvlaki::MediaControls::new(souvlaki::PlatformConfig {
                dbus_name: "slate_music",
                display_name: "Slate Music",
                hwnd: Some(hwnd as *mut std::ffi::c_void),
            })
            .ok();
            if let Some(m) = media.as_mut() {
                let e = engine.clone();
                let attached = m
                    .attach(move |event| {
                        use souvlaki::MediaControlEvent as E;
                        let (a, v) = match event {
                            E::Play => ("play", serde_json::Value::Null),
                            E::Pause | E::Stop => ("pause", serde_json::Value::Null),
                            E::Toggle => ("toggle", serde_json::Value::Null),
                            E::Next => ("next", serde_json::Value::Null),
                            E::Previous => ("previous", serde_json::Value::Null),
                            E::SetPosition(p) => ("seek", serde_json::json!(p.0.as_secs_f64())),
                            E::Seek(direction) => {
                                let p = e.snapshot().position;
                                (
                                    "seek",
                                    serde_json::json!(if matches!(
                                        direction,
                                        souvlaki::SeekDirection::Forward
                                    ) {
                                        p + 5.
                                    } else {
                                        (p - 5.).max(0.)
                                    }),
                                )
                            }
                            _ => return,
                        };
                        let _ = e.command(a, v);
                    })
                    .is_ok();
                engine.render.lock().unwrap().state.system_controls = attached;
            }
            let mut last_play = String::new();
            let mut tick = 0u64;
            let mut last_transition = 0;
            // A message to show once an output opens (why exclusive mode stopped).
            let mut notice: Option<String> = None;
            // Output watchdog: samples handed out at the last check, and checks without any.
            let (mut last_pulled, mut stalled) = (0u64, 0u32);
            loop {
                std::thread::sleep(Duration::from_millis(80));
                tick += 1;
                if lost.swap(false, Ordering::SeqCst) {
                    output.take();
                    let why = problem.lock().unwrap().take();
                    let mut r = engine.render.lock().unwrap();
                    r.state.playing = false;
                    r.state.engine_ready = false;
                    let message = match why {
                        Some(why) => {
                            exclusive_blocked = true;
                            let message = format!("Exclusive mode stopped: {why}. Slate Music plays through Windows instead until you turn exclusive mode on again.");
                            // Kept until the shared output opens, so it isn't wiped a moment later.
                            notice = Some(message.clone());
                            message
                        }
                        None => {
                            "Audio device disconnected. Reconnecting; playback will stay paused."
                                .into()
                        }
                    };
                    r.state.error = Some(message);
                }
                // About once a second: follow Windows' default device (headphones plugged in
                // or reconnected), return to a chosen device that is back, and replace an
                // output that stopped asking for sound without reporting an error.
                if output.is_some() && tick % 12 == 6 {
                    let (wanted, shown, pulled) = {
                        let r = engine.render.lock().unwrap();
                        (
                            r.state.output_device.clone(),
                            r.state.output.clone(),
                            r.pulled,
                        )
                    };
                    let shared = matches!(output, Some(Output::Shared(..)));
                    stalled = if shared && pulled == last_pulled {
                        stalled + 1
                    } else {
                        0
                    };
                    last_pulled = pulled;
                    // Only what the check needs: the default's name, or the device list.
                    let (names, default) = match (&wanted, &shown) {
                        (None, Some(_)) => (Vec::new(), default_device_name()),
                        (Some(_), Some(s)) if s.fallback => (output_devices().0, None),
                        _ => (Vec::new(), None),
                    };
                    if stalled >= 2
                        || device_changed(
                            wanted.as_deref(),
                            shown.as_ref(),
                            default.as_deref(),
                            &names,
                        )
                    {
                        stalled = 0;
                        // The device that was playing is gone (headphones unplugged): pause, as
                        // for a disconnect, so music never jumps out loud to the speakers. A
                        // device that only stopped being the default keeps playing on the new one.
                        let gone = device_gone(shown.as_ref(), &output_devices().0);
                        let mut r = engine.render.lock().unwrap();
                        if gone {
                            r.state.playing = false;
                        }
                        r.reopen = true;
                    }
                }
                let reopen = std::mem::take(&mut engine.render.lock().unwrap().reopen);
                if reopen {
                    output.take();
                    exclusive_blocked = false;
                    // The old output is gone; a failure it reported on its way out must not
                    // stop the new one.
                    lost.store(false, Ordering::SeqCst);
                    problem.lock().unwrap().take();
                }
                // Exclusive mode (Windows only) can ask for the shared output at once.
                #[cfg_attr(not(windows), allow(unused_mut))]
                let mut open_now = reopen;
                #[cfg(windows)]
                if output.is_none() && (reopen || tick % 12 == 1) {
                    let (wanted, exclusive) = {
                        let r = engine.render.lock().unwrap();
                        (r.state.output_device.clone(), r.state.exclusive)
                    };
                    if exclusive && !exclusive_blocked {
                        match crate::wasapi::probe(wanted.clone()) {
                            Ok(support) => {
                                engine.use_exclusive(Some(support.clone()));
                                output = Some(Output::Exclusive(crate::wasapi::Exclusive::start(
                                    support,
                                    wanted,
                                    engine.render.clone(),
                                    problem.clone(),
                                    lost.clone(),
                                )));
                                notice = None;
                            }
                            Err(why) => {
                                exclusive_blocked = true;
                                open_now = true;
                                notice = Some(format!("Exclusive mode isn't available: {why}. Slate Music plays through Windows instead."));
                            }
                        }
                    }
                }
                if output.is_none() && (open_now || tick % 12 == 1) {
                    engine.use_exclusive(None);
                    let signal = lost.clone();
                    let wanted = engine.render.lock().unwrap().state.output_device.clone();
                    let (device, name, fallback) = choose_device(wanted.as_deref());
                    let opened = match device {
                        Some(d) => OutputStreamBuilder::from_device(d),
                        None => OutputStreamBuilder::from_default_device(),
                    }
                    .and_then(|b| {
                        b.with_error_callback(move |_| {
                            signal.store(true, Ordering::SeqCst);
                        })
                        .open_stream()
                    });
                    match opened {
                        Ok(mut stream) => {
                            stream.log_on_drop(false);
                            let info = OutputInfo {
                                device: name,
                                sample_rate: stream.config().sample_rate(),
                                channels: stream.config().channel_count(),
                                fallback,
                                ..Default::default()
                            };
                            #[cfg(windows)]
                            let latency = crate::wasapi::shared_latency(Some(info.device.clone()));
                            #[cfg(not(windows))]
                            let latency = 0.;
                            // The new stream asks for a left sample first.
                            engine.render.lock().unwrap().channel = 0;
                            let sink = Sink::connect_new(stream.mixer());
                            sink.append(Mixer(engine.render.clone()));
                            output = Some(Output::Shared(stream, sink));
                            let mut r = engine.render.lock().unwrap();
                            r.state.engine_ready = true;
                            r.state.error = notice.take();
                            r.state.output = Some(info);
                            r.latency = latency;
                            last_pulled = r.pulled;
                            stalled = 0;
                        }
                        Err(e) => {
                            let mut r = engine.render.lock().unwrap();
                            r.state.playing = false;
                            r.state.engine_ready = false;
                            r.state.error=Some(format!("Audio output unavailable: {e}. Connect an output device to continue."));
                        }
                    }
                }
                // A song left at the previous output's rate is reopened, never played fast or slow.
                engine.fix_rate();
                let target = {
                    let mut r = engine.render.lock().unwrap();
                    if r.stopping {
                        break;
                    }
                    let next = r.next_index();
                    if r.current.is_some() && r.next.is_none() {
                        next.and_then(|index| {
                            if r.next_attempt == Some((r.epoch, index)) {
                                return None;
                            }
                            r.next_attempt = Some((r.epoch, index));
                            r.state
                                .queue
                                .get(index)
                                .cloned()
                                .map(|id| (id, index, r.epoch))
                        })
                    } else {
                        None
                    }
                };
                if let Some((id, index, epoch)) = target {
                    match engine.prepare(&id, index) {
                        Ok(mut deck) => {
                            let (crossfade, smart) = {
                                let r = engine.render.lock().unwrap();
                                (r.effective_crossfade(), r.state.smart_crossfade)
                            };
                            if smart
                                && crossfade > 0.
                                && !deck.continues_album
                                && deck.start_silence > 0.3
                            {
                                let _ = deck.skip_to((deck.start_silence - 0.1).min(8.));
                            }
                            let mut r = engine.render.lock().unwrap();
                            if r.epoch == epoch {
                                r.next = Some(deck);
                            }
                        }
                        Err(e) => {
                            let mut r = engine.render.lock().unwrap();
                            r.preload_failed(index, epoch, e);
                        }
                    }
                }
                // One lock, so a moved song is never mistaken for a new play.
                let (s, transition) = {
                    let mut r = engine.render.lock().unwrap();
                    r.apply_sleep(crate::db::now());
                    if let Some(new) = r.renamed.remove(&last_play) {
                        last_play = new;
                    }
                    r.renamed.clear();
                    (r.snapshot(), r.transition)
                };
                if s.playing {
                    if let Some(id) = s.current_id.as_ref() {
                        if id != &last_play || transition != last_transition {
                            let _ = engine.db.played(id);
                            last_play = id.clone();
                            last_transition = transition;
                            let _ = app.emit("history-changed", ());
                            if let (Some(m), Ok(t)) = (media.as_mut(), engine.db.track(id)) {
                                let _ = m.set_metadata(souvlaki::MediaMetadata {
                                    title: Some(&t.title),
                                    artist: Some(&t.artist),
                                    album: Some(&t.album),
                                    duration: Some(Duration::from_secs_f64(s.duration.max(0.))),
                                    ..Default::default()
                                });
                            }
                        }
                    }
                }
                if tick % 3 == 0 {
                    let _ = app.emit("playback", &s);
                    if let Some(m) = media.as_mut() {
                        let progress = Some(souvlaki::MediaPosition(Duration::from_secs_f64(
                            s.position.max(0.),
                        )));
                        let _ = m.set_playback(if s.playing {
                            souvlaki::MediaPlayback::Playing { progress }
                        } else {
                            souvlaki::MediaPlayback::Paused { progress }
                        });
                    }
                }
                if tick % 25 == 0 {
                    engine.save();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn deck(id: &str, index: usize, value: f32, frames: usize) -> Deck {
        Deck {
            id: id.into(),
            index,
            source: Box::new(rodio::buffer::SamplesBuffer::new(
                2,
                RATE,
                vec![value; frames * 2],
            )),
            samples: 0,
            duration: frames as f64 / RATE as f64,
            gain: 1.,
            gain_db: None,
            gain_kind: "off".into(),
            audible_end: frames as f64 / RATE as f64,
            start_silence: 0.,
            continues_album: false,
            rate: RATE,
            native: RATE,
        }
    }
    fn render() -> RenderState {
        RenderState {
            state: Playback {
                playing: true,
                volume: 1.,
                queue: vec!["a".into(), "b".into()],
                ..Default::default()
            },
            current: Some(deck("a", 0, 0.25, 480)),
            next: Some(deck("b", 1, 0.5, 480)),
            epoch: 0,
            transition: 0,
            stopping: false,
            next_attempt: None,
            next_failed: None,
            renamed: HashMap::new(),
            eq: crate::dsp::Equalizer::default(),
            channel: 0,
            reopen: false,
            rate: RATE,
            exclusive: None,
            rate_pending: false,
            pulled: 0,
            waiting: false,
            latency: 0.,
        }
    }
    /// Writes a WAV of pseudo-random samples and returns them as whole numbers.
    fn noise_wav(path: &std::path::Path, rate: u32, bits: u16, frames: usize) -> Vec<i32> {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: bits,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        let mut seed = 12345u64;
        let top = 1i64 << (bits - 1);
        let values: Vec<i32> = (0..frames * 2)
            .map(|i| {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                // Include the extremes, where rounding mistakes would show.
                match i {
                    0 => (-top) as i32,
                    1 => (top - 1) as i32,
                    _ => ((seed >> 33) as i64 % (2 * top) - top) as i32,
                }
            })
            .collect();
        for v in &values {
            w.write_sample(*v).unwrap();
        }
        w.finalize().unwrap();
        values
    }
    #[test]
    fn exclusive_mode_sends_the_files_own_numbers() {
        use crate::exclusive::{to_pcm, Layout, Support};
        let dir = tempfile::tempdir().unwrap();
        for (rate, bits, layout) in [
            (
                44100,
                16,
                Layout {
                    container: 16,
                    valid: 16,
                },
            ),
            (
                96000,
                24,
                Layout {
                    container: 32,
                    valid: 24,
                },
            ),
        ] {
            let path = dir.path().join(format!("{rate}-{bits}.wav"));
            let values = noise_wav(&path, rate, bits, 4000);
            let track = Track {
                id: "n".into(),
                path: path.to_string_lossy().into(),
                bit_depth: bits as u8,
                ..Default::default()
            };
            let mut r = render();
            r.exclusive = Some(Support {
                device: "DAC".into(),
                fallback: false,
                formats: vec![(rate, layout)],
            });
            let deck = Deck::load(&track, 0, |native| r.deck_rate(native)).unwrap();
            assert_eq!(deck.rate, rate);
            r.current = Some(deck);
            r.next = None;
            r.use_rate(rate);
            let mut out = [0u8; 4];
            for (i, want) in values.iter().enumerate() {
                let sample = r.sample();
                to_pcm(sample, layout, &mut out);
                let got = match layout.container {
                    16 => i16::from_le_bytes([out[0], out[1]]) as i32,
                    _ => i32::from_le_bytes(out) >> (32 - layout.valid),
                };
                assert_eq!(got, *want, "{bits}-bit sample {i}");
            }
        }
    }
    #[test]
    fn exclusive_gapless_transition_preserves_a_higher_bit_depth() {
        use crate::exclusive::{to_pcm, Layout, Support};
        let dir = tempfile::tempdir().unwrap();
        let support = Support {
            device: "DAC".into(),
            fallback: false,
            formats: vec![
                (
                    RATE,
                    Layout {
                        container: 16,
                        valid: 16,
                    },
                ),
                (
                    RATE,
                    Layout {
                        container: 32,
                        valid: 24,
                    },
                ),
            ],
        };
        let mut r = render();
        r.exclusive = Some(support.clone());
        let mut expected = Vec::new();
        for (index, bits) in [16, 24].into_iter().enumerate() {
            let path = dir.path().join(format!("{bits}.wav"));
            expected.extend(
                noise_wav(&path, RATE, bits, 32)
                    .into_iter()
                    .map(|value| value << (24 - bits)),
            );
            let track = Track {
                id: r.state.queue[index].clone(),
                path: path.to_string_lossy().into(),
                bit_depth: bits as u8,
                ..Default::default()
            };
            let deck = Deck::load(&track, index, |rate| rate).unwrap();
            if index == 0 {
                r.current = Some(deck);
            } else {
                r.next = Some(deck);
            }
        }
        // WASAPI chooses this once and keeps it for both songs at the same rate.
        let layout = support.stream_layout(RATE).unwrap();
        let mut out = [0u8; 4];
        for (index, expected) in expected.into_iter().enumerate() {
            to_pcm(r.sample(), layout, &mut out);
            assert_eq!(i32::from_le_bytes(out) >> 8, expected, "sample {index}");
        }
        assert_eq!(r.state.current_id.as_deref(), Some("b"));
        assert!(
            !r.rate_pending,
            "no stream restart between equal-rate songs"
        );
    }
    #[test]
    fn a_song_at_another_rate_waits_for_the_device_in_exclusive_mode() {
        let mut r = render();
        r.exclusive = Some(Default::default());
        r.next.as_mut().unwrap().rate = 44100;
        let first: Vec<f32> = (0..960).map(|_| r.sample()).collect();
        assert_eq!(first, vec![0.25; 960]);
        // The first song ends; the next one is at 44.1 kHz, so nothing plays until reopened.
        assert_eq!(r.sample(), 0.);
        assert!(r.rate_pending);
        assert_eq!(r.current_rate(), 44100);
        assert_eq!(r.current.as_ref().unwrap().samples, 0, "nothing consumed");
        r.use_rate(44100);
        assert!(!r.rate_pending);
        assert_eq!(r.sample(), 0.5);
        // Shared mode never waits: every song is mixed at 48 kHz.
        let mut shared = render();
        let _: Vec<f32> = (0..961).map(|_| shared.sample()).collect();
        assert!(!shared.rate_pending);
    }
    #[test]
    fn output_follows_the_default_device_and_returns_to_a_chosen_one() {
        let playing = |device: &str, fallback| OutputInfo {
            device: device.into(),
            fallback,
            ..Default::default()
        };
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let speakers = playing("Speakers", false);
        // Following the default: headphones plugged in or reconnected become the default.
        assert!(device_changed(
            None,
            Some(&speakers),
            Some("Headphones"),
            &[]
        ));
        assert!(!device_changed(
            None,
            Some(&speakers),
            Some("Speakers"),
            &[]
        ));
        assert!(
            !device_changed(None, Some(&speakers), None, &[]),
            "no device: keep trying"
        );
        assert!(!device_changed(None, None, Some("Headphones"), &[]));
        // A chosen device that was missing (the default stood in) is back.
        let stand_in = playing("Speakers", true);
        assert!(device_changed(
            Some("DAC"),
            Some(&stand_in),
            None,
            &names(&["Speakers", "DAC"])
        ));
        assert!(!device_changed(
            Some("DAC"),
            Some(&stand_in),
            None,
            &names(&["Speakers"])
        ));
        // Unplugged headphones are gone (pause); speakers that stop being the default are not.
        let headphones = playing("Headphones", false);
        assert!(device_gone(Some(&headphones), &names(&["Speakers"])));
        assert!(!device_gone(
            Some(&speakers),
            &names(&["Speakers", "Headphones"])
        ));
        assert!(!device_gone(None, &[]));
        // Playing on the chosen device: other changes don't matter.
        assert!(!device_changed(
            Some("DAC"),
            Some(&playing("DAC", false)),
            Some("Headphones"),
            &names(&["DAC", "Headphones"])
        ));
    }
    /// A deck whose left and right samples differ, to catch swapped channels.
    fn stereo(id: &str, index: usize, left: f32, right: f32, frames: usize) -> Deck {
        let mut d = deck(id, index, 0., frames);
        d.source = Box::new(rodio::buffer::SamplesBuffer::new(
            2,
            RATE,
            [left, right].repeat(frames),
        ));
        d
    }
    #[test]
    fn a_song_loaded_between_left_and_right_keeps_its_channels() {
        let mut r = render();
        r.current = Some(stereo("a", 0, 0.1, 0.9, 100));
        r.next = None;
        r.channel = 1; // the output is about to ask for a right sample
        let out: Vec<f32> = (0..5).map(|_| r.sample()).collect();
        assert_eq!(out, [0., 0.1, 0.9, 0.1, 0.9]);
    }
    #[test]
    fn channels_stay_in_order_after_a_crossfade_that_starts_on_a_right_sample() {
        let mut r = render();
        r.state.smart_crossfade = false;
        r.current = Some(stereo("a", 0, 0., 0., 1000));
        r.next = Some(stereo("b", 1, 0.2, 0.8, 1000));
        // Chosen so the fade window opens on sample 1519, a right sample.
        r.state.crossfade = 481.5 / (2. * RATE as f64);
        let out: Vec<f32> = (0..2400).map(|_| r.sample()).collect();
        assert_eq!(r.snapshot().current_id.as_deref(), Some("b"));
        for (i, v) in out.iter().enumerate().skip(2010) {
            let want = if i % 2 == 0 { 0.2 } else { 0.8 };
            assert!((v - want).abs() < 1e-6, "sample {i}: {v}, not {want}");
        }
    }
    #[test]
    fn a_song_ending_while_the_next_is_prepared_waits_instead_of_stopping() {
        let mut r = render();
        r.next = None; // the queue just changed, so the next song is being prepared again
        let first: Vec<f32> = (0..960).map(|_| r.sample()).collect();
        assert_eq!(first, vec![0.25; 960]);
        assert_eq!(r.sample(), 0.);
        assert!(r.state.playing && r.waiting, "still on, silent");
        r.next = Some(deck("b", 1, 0.5, 480));
        // It starts on the next left sample.
        let resumed: Vec<f32> = (0..3).map(|_| r.sample()).collect();
        assert_eq!(resumed, [0., 0.5, 0.5]);
        assert!(!r.waiting);
        assert_eq!(r.snapshot().current_id.as_deref(), Some("b"));
        // At the real end of the queue playback stops as before.
        let _: Vec<f32> = (0..960).map(|_| r.sample()).collect();
        assert!(!r.state.playing && !r.waiting);
    }
    #[test]
    fn failed_repeat_preload_stops_at_eof_instead_of_waiting_forever() {
        for mode in ["one", "all"] {
            let mut r = render();
            r.state.queue = vec!["a".into()];
            r.state.repeat = mode.into();
            r.next = None;
            r.next_attempt = Some((r.epoch, 0));
            r.preload_failed(0, r.epoch, "File unavailable".into());
            assert!(r.state.playing, "the loaded song can finish");
            let samples: Vec<_> = (0..960).map(|_| r.sample()).collect();
            assert_eq!(samples, vec![0.25; 960]);
            assert_eq!(r.sample(), 0.);
            assert!(!r.state.playing && !r.waiting, "failed {mode} repeat ended");
            assert_eq!(r.state.error.as_deref(), Some("File unavailable"));

            // A subsequent user action can start a fresh attempt in a new epoch.
            r.epoch += 1;
            r.state.playing = true;
            r.next = Some(deck("a", 0, 0.5, 480));
            let samples: Vec<_> = (0..3).map(|_| r.sample()).collect();
            assert_eq!(samples, [0., 0.5, 0.5]);
            assert!(r.state.playing && !r.waiting);
        }
    }
    #[test]
    fn a_song_opened_for_another_rate_never_plays_at_the_wrong_speed() {
        let mut r = render();
        r.current.as_mut().unwrap().rate = 96000;
        r.current.as_mut().unwrap().native = 96000;
        assert!(r.wrong_rate(), "shared output runs at 48 kHz");
        assert_eq!(r.sample(), 0.);
        r.unload();
        assert!(r.current.is_none() && !r.state.playing);
        assert_eq!(
            r.snapshot().current_id.as_deref(),
            Some("a"),
            "keeps its place"
        );
    }
    #[test]
    fn sample_exact_gapless_boundary() {
        let mut r = render();
        let samples: Vec<_> = (0..1920).map(|_| r.sample()).collect();
        assert_eq!(&samples[..960], vec![0.25; 960]);
        assert_eq!(&samples[960..], vec![0.5; 960]);
        assert_eq!(r.transition, 1);
        assert_eq!(r.snapshot().current_id.as_deref(), Some("b"));
    }
    #[test]
    fn crossfade_mixes_without_silence() {
        let mut r = render();
        r.state.crossfade = 0.005;
        let v: Vec<_> = (0..1200).map(|_| r.sample()).collect();
        assert!(v.iter().all(|x| *x >= 0.25 && *x <= 0.5));
        assert!(v[800] > 0.25 && v[800] < 0.5);
        assert_eq!(r.transition, 1);
        assert!(r.snapshot().position > 0.005);
    }
    #[test]
    fn pause_preserves_position_and_repeat() {
        let mut r = render();
        r.state.playing = false;
        assert_eq!(r.sample(), 0.);
        assert_eq!(r.snapshot().position, 0.);
        r.state.repeat = "one".into();
        assert_eq!(r.next_index(), Some(0));
        r.state.repeat = "off".into();
        r.current.as_mut().unwrap().index = 1;
        assert_eq!(r.next_index(), None);
        r.state.repeat = "all".into();
        assert_eq!(r.next_index(), Some(0));
    }
    #[test]
    fn lyric_clock_maps_rendered_frames_and_freezes_when_samples_cannot_advance() {
        for rate in [44100, 48000, 96000] {
            let mut r = render();
            r.current = Some(deck("a", 0, 0.25, rate as usize));
            let d = r.current.as_mut().unwrap();
            d.rate = rate;
            d.native = rate;
            r.exclusive = Some(crate::exclusive::Support::default());
            r.use_rate(rate);
            assert!(r.snapshot().clock_running);
            for _ in 0..rate / 10 * 2 {
                r.sample();
            }
            assert!((r.snapshot().position - 0.1).abs() < 1e-9);
            r.state.playing = false;
            assert!(!r.snapshot().clock_running);
            for _ in 0..500 {
                r.sample();
            }
            assert!((r.snapshot().position - 0.1).abs() < 1e-9);
            r.state.playing = true;
            r.rate_pending = true;
            assert!(!r.snapshot().clock_running);
            r.sample();
            assert!((r.snapshot().position - 0.1).abs() < 1e-9);
            r.rate_pending = false;
            r.waiting = true;
            assert!(!r.snapshot().clock_running);
        }
    }
    #[test]
    fn volume_is_the_same_gain_in_shared_and_exclusive_output() {
        for exclusive in [false, true] {
            let mut r = render();
            if exclusive {
                r.exclusive = Some(crate::exclusive::Support::default());
            }
            r.state.volume = 0.4;
            assert!((r.sample() - 0.1).abs() < 1e-7);
            r.state.volume = 0.;
            assert_eq!(r.sample(), 0.);
            r.state.volume = 1.;
            assert_eq!(r.sample(), 0.25);
        }
    }
    #[test]
    fn crossfade_handoff_keeps_the_incoming_songs_real_sample_position() {
        let mut r = render();
        r.state.crossfade = 0.005;
        while r.transition == 0 {
            r.sample();
        }
        let d = r.current.as_ref().unwrap();
        assert_eq!(d.id, "b");
        assert_eq!(r.snapshot().position, d.samples as f64 / (RATE * 2) as f64);
        assert!(r.snapshot().position >= 0.005);
        assert!(r.snapshot().clock_running);
    }
    fn test_engine() -> (tempfile::TempDir, Arc<Engine>) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("profile")).unwrap());
        for id in ["a", "b", "c"] {
            let path = dir.path().join(format!("{id}.wav"));
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels: 2,
                    sample_rate: RATE,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for _ in 0..RATE * 4 {
                writer.write_sample(100i16).unwrap();
            }
            writer.finalize().unwrap();
            db.upsert(
                &Track {
                    id: id.into(),
                    path: path.to_string_lossy().into(),
                    title: id.into(),
                    duration: 2.,
                    ..Default::default()
                },
                1,
            )
            .unwrap();
        }
        let engine = Engine::new(db);
        engine.render.lock().unwrap().state.engine_ready = true;
        (dir, engine)
    }
    #[test]
    fn explicit_load_replaces_a_pending_exclusive_rate_change() {
        for action in ["seek", "queue"] {
            let (_dir, engine) = test_engine();
            engine
                .command("queue", serde_json::json!({"ids": ["a", "b"]}))
                .unwrap();
            {
                let mut r = engine.render.lock().unwrap();
                r.exclusive = Some(Default::default());
                r.current.as_mut().unwrap().rate = 44100;
                r.rate_pending = true;
            }
            let value = if action == "seek" {
                serde_json::json!(0.)
            } else {
                serde_json::json!({"ids": ["b"]})
            };
            engine.command(action, value).unwrap();
            let mut r = engine.render.lock().unwrap();
            assert_eq!(r.current_rate(), RATE);
            assert!(
                !r.rate_pending,
                "{action} returns to the open stream's rate"
            );
            assert!(r.sample() > 0., "{action} must resume audio immediately");
        }
    }
    #[test]
    fn duplicate_queue_selection_keeps_the_requested_occurrence() {
        let (_dir, engine) = test_engine();
        let state = engine
            .command("queue", serde_json::json!({"ids":["a","b","a"],"index":2}))
            .unwrap();
        assert_eq!(state.cursor, 2);
        assert_eq!(state.current_id.as_deref(), Some("a"));
    }
    #[test]
    fn failed_queue_replacement_preserves_the_current_session() {
        let (dir, engine) = test_engine();
        engine
            .command("queue", serde_json::json!({"ids":["a","b"],"index":0}))
            .unwrap();
        std::fs::remove_file(dir.path().join("c.wav")).unwrap();
        assert!(engine
            .command("queue", serde_json::json!({"ids":["c"],"index":0}))
            .is_err());
        let state = engine.snapshot();
        assert_eq!(state.queue, vec!["a", "b"]);
        assert_eq!(state.current_id.as_deref(), Some("a"));
        assert!(state.playing);
        assert!(engine.db.track("c").unwrap().missing);
    }
    #[test]
    fn removing_restored_current_track_selects_a_valid_paused_replacement() {
        let (_dir, engine) = test_engine();
        engine.db.set("session", &serde_json::json!({"queue":["a","b"],"cursor":1,"currentId":"b","position":1.2,"duration":2.})).unwrap();
        let restored = Engine::new(engine.db.clone());
        restored.render.lock().unwrap().state.engine_ready = true;
        let state = restored.command("remove", serde_json::json!(1)).unwrap();
        assert_eq!(state.cursor, 0);
        assert_eq!(state.current_id.as_deref(), Some("a"));
        assert_eq!(state.position, 0.);
        assert!(!state.playing);
        let saved = Engine::new(engine.db.clone()).snapshot();
        assert_eq!(saved.current_id, state.current_id);
        assert_eq!(saved.cursor, state.cursor);
        assert!(
            restored
                .command("play", serde_json::Value::Null)
                .unwrap()
                .playing
        );
    }
    #[test]
    fn removing_the_only_restored_track_clears_current_state() {
        let (_dir, engine) = test_engine();
        engine
            .db
            .set(
                "session",
                &serde_json::json!({"queue":["a"],"currentId":"a","position":1.}),
            )
            .unwrap();
        let restored = Engine::new(engine.db.clone());
        let state = restored.command("remove", serde_json::json!(0)).unwrap();
        assert!(state.queue.is_empty());
        assert!(state.current_id.is_none());
        assert_eq!(state.position, 0.);
    }
    #[test]
    fn failed_repeat_wrap_preload_remaps_the_playing_position() {
        let mut r = render();
        r.state.queue = vec!["missing".into(), "b".into(), "a".into()];
        r.state.repeat = "all".into();
        r.current.as_mut().unwrap().index = 2;
        r.remove_queued(0);
        assert_eq!(r.snapshot().cursor, 1);
        assert_eq!(r.snapshot().current_id.as_deref(), Some("a"));
        assert_eq!(r.next_index(), Some(0));
        assert!(r.next.is_none());
    }
    #[test]
    fn crossfade_does_not_consume_an_entire_short_next_track() {
        let mut r = render();
        r.next = Some(deck("b", 1, 0.5, 48));
        r.state.crossfade = 0.005;
        for _ in 0..961 {
            r.sample();
        }
        assert_eq!(r.snapshot().current_id.as_deref(), Some("b"));
        assert!(r.state.playing);
        assert!(r.current.as_ref().unwrap().samples < 96);
    }
    #[test]
    fn appending_to_an_empty_queue_selects_a_paused_track() {
        let (_dir, engine) = test_engine();
        let state = engine.command("append", serde_json::json!("a")).unwrap();
        assert_eq!(state.current_id.as_deref(), Some("a"));
        assert!(!state.playing);
        assert!(
            engine
                .command("play", serde_json::Value::Null)
                .unwrap()
                .playing
        );
    }
    #[test]
    fn play_next_inserts_after_the_current_song_and_lists_are_all_or_nothing() {
        let (_dir, engine) = test_engine();
        engine
            .command("queue", serde_json::json!({"ids":["a","b"],"index":0}))
            .unwrap();
        let state = engine
            .command("insert_next", serde_json::json!(["c", "b"]))
            .unwrap();
        assert_eq!(state.queue, vec!["a", "c", "b", "b"]);
        assert_eq!(state.cursor, 0);
        assert_eq!(state.current_id.as_deref(), Some("a"));
        assert!(state.playing);
        assert!(engine
            .command("append", serde_json::json!(["a", "absent"]))
            .is_err());
        assert_eq!(engine.snapshot().queue, state.queue);
        let state = engine.command("append", serde_json::json!(["a"])).unwrap();
        assert_eq!(state.queue.last().map(String::as_str), Some("a"));
        assert!(
            state.error.is_none(),
            "a successful command clears an old error"
        );
    }
    #[test]
    fn play_next_on_an_empty_queue_selects_the_song_paused() {
        let (_dir, engine) = test_engine();
        let state = engine
            .command("insert_next", serde_json::json!("b"))
            .unwrap();
        assert_eq!(state.queue, vec!["b"]);
        assert_eq!(state.current_id.as_deref(), Some("b"));
        assert!(!state.playing);
    }
    #[test]
    fn clearing_up_next_keeps_the_current_song_playing() {
        let (_dir, engine) = test_engine();
        engine
            .command("queue", serde_json::json!({"ids":["a","b","c"],"index":1}))
            .unwrap();
        let state = engine
            .command("clear_upcoming", serde_json::Value::Null)
            .unwrap();
        assert_eq!(state.queue, vec!["b"]);
        assert_eq!(state.cursor, 0);
        assert_eq!(state.current_id.as_deref(), Some("b"));
        assert!(state.playing);
        assert_eq!(
            engine
                .render
                .lock()
                .unwrap()
                .current
                .as_ref()
                .unwrap()
                .index,
            0
        );
        let empty = Engine::new(engine.db.clone());
        empty.render.lock().unwrap().state.queue.clear();
        empty.render.lock().unwrap().state.current_id = None;
        let state = empty
            .command("clear_upcoming", serde_json::Value::Null)
            .unwrap();
        assert!(state.queue.is_empty() && state.current_id.is_none() && !state.playing);
    }
    #[test]
    fn several_queue_songs_move_and_leave_together() {
        assert_eq!(move_rows(5, &[1, 3], 0), vec![1, 3, 0, 2, 4]);
        assert_eq!(move_rows(5, &[0, 1], 4), vec![2, 3, 0, 1, 4]);
        assert_eq!(move_rows(5, &[0, 1], 5), vec![2, 3, 4, 0, 1]);
        assert_eq!(move_rows(3, &[2], 2), vec![0, 1, 2]);
        let (_dir, engine) = test_engine();
        engine
            .command(
                "queue",
                serde_json::json!({"ids":["a","b","c","a","c"],"index":1}),
            )
            .unwrap();
        // "b" plays; moving the last two in front of it keeps it playing at its new place.
        let state = engine
            .command("move_many", serde_json::json!({"rows":[3,4],"to":0}))
            .unwrap();
        assert_eq!(state.queue, vec!["a", "c", "a", "b", "c"]);
        assert_eq!((state.cursor, state.current_id.as_deref()), (3, Some("b")));
        assert!(state.playing);
        assert!(engine
            .command("move_many", serde_json::json!({"rows":[9],"to":0}))
            .is_err());
        // The playing song is never removed; the rest go at once.
        let state = engine
            .command("remove_many", serde_json::json!([0, 3, 4]))
            .unwrap();
        assert_eq!(state.queue, vec!["c", "a", "b"]);
        assert_eq!((state.cursor, state.current_id.as_deref()), (2, Some("b")));
    }
    #[test]
    fn moved_songs_keep_their_queue_places_and_removed_ones_leave_the_queue() {
        let (_dir, engine) = test_engine();
        engine
            .command(
                "queue",
                serde_json::json!({"ids":["a","b","c","b"],"index":0}),
            )
            .unwrap();
        engine.remap(&[("a".into(), "a2".into()), ("b".into(), "b2".into())]);
        let state = engine.snapshot();
        assert_eq!(state.queue, vec!["a2", "b2", "c", "b2"]);
        assert_eq!(state.current_id.as_deref(), Some("a2"));
        assert_eq!(
            engine
                .render
                .lock()
                .unwrap()
                .renamed
                .get("a")
                .map(String::as_str),
            Some("a2")
        );
        engine.forget(&["b2".to_string(), "a2".to_string()].into_iter().collect());
        let state = engine.snapshot();
        assert_eq!(state.queue, vec!["a2", "c"], "the loaded song stays");
        assert_eq!(state.cursor, 0);
    }
    #[test]
    fn disabling_fades_or_enabling_sleep_discards_a_trimmed_preload() {
        for (action, value) in [
            ("crossfade", serde_json::json!(0.)),
            ("sleep", serde_json::json!({"endOfTrack": true})),
        ] {
            let (_dir, engine) = test_engine();
            engine
                .command("queue", serde_json::json!({"ids": ["a", "b"]}))
                .unwrap();
            engine.command("crossfade", serde_json::json!(1.)).unwrap();
            let mut next = engine.prepare("b", 1).unwrap();
            next.skip_to(0.5).unwrap();
            let epoch = {
                let mut r = engine.render.lock().unwrap();
                r.next = Some(next);
                r.next_attempt = Some((r.epoch, 1));
                r.epoch
            };
            engine.command("crossfade", serde_json::json!(2.)).unwrap();
            {
                let r = engine.render.lock().unwrap();
                assert!(r.next.as_ref().unwrap().samples > 0);
                assert_eq!(
                    r.epoch, epoch,
                    "a duration change preserves the prepared song"
                );
            }
            engine.command(action, value).unwrap();
            {
                let r = engine.render.lock().unwrap();
                assert!(
                    r.next.is_none(),
                    "{action} discarded the trimmed introduction"
                );
                assert!(r.epoch > epoch, "an in-flight old preload is rejected too");
                assert!(r.next_attempt.is_none());
                assert_eq!(r.effective_crossfade(), 0.);
            }
            assert_eq!(engine.prepare("b", 1).unwrap().samples, 0);
        }
    }
    #[test]
    fn sleep_timer_is_set_cancelled_and_never_restored() {
        let (_dir, engine) = test_engine();
        let state = engine
            .command("sleep", serde_json::json!({"minutes": 30}))
            .unwrap();
        let at = state.sleep_at.unwrap();
        assert!((at - crate::db::now() - 30 * 60000).abs() < 5000);
        let state = engine
            .command("sleep", serde_json::json!({"endOfTrack": true}))
            .unwrap();
        assert!(state.sleep_at.is_none() && state.sleep_end_of_track);
        assert!(!Engine::new(engine.db.clone()).snapshot().sleep_end_of_track);
        let state = engine.command("sleep", serde_json::Value::Null).unwrap();
        assert!(state.sleep_at.is_none() && !state.sleep_end_of_track);
        assert!(engine
            .command("sleep", serde_json::json!({"minutes": -5}))
            .unwrap()
            .sleep_at
            .is_none());
    }
    #[test]
    fn loudness_gain_scales_each_song() {
        let mut r = render();
        r.current.as_mut().unwrap().gain = 0.5;
        assert_eq!(r.sample(), 0.125);
    }
    #[test]
    fn songs_that_continue_an_album_are_never_crossfaded() {
        let mut r = render();
        r.state.crossfade = 0.005;
        r.next.as_mut().unwrap().continues_album = true;
        let v: Vec<_> = (0..960).map(|_| r.sample()).collect();
        assert_eq!(
            v,
            vec![0.25; 960],
            "the first song plays unblended to its end"
        );
        assert_eq!(r.sample(), 0.5, "then the next starts, gaplessly");
    }
    #[test]
    fn smart_crossfade_skips_trailing_silence() {
        let mut r = render();
        r.state.crossfade = 0.001;
        // The music of "a" ends after 240 of its 480 frames.
        r.current.as_mut().unwrap().audible_end = 240. / RATE as f64;
        let before: Vec<_> = (0..480).map(|_| r.sample()).collect();
        assert!(before.iter().all(|x| *x >= 0.25 && *x <= 0.5));
        let _ = r.sample();
        assert_eq!(
            r.snapshot().current_id.as_deref(),
            Some("b"),
            "switched at the music's end"
        );
        r.state.smart_crossfade = false;
        let mut plain = render();
        plain.state.crossfade = 0.001;
        plain.state.smart_crossfade = false;
        plain.current.as_mut().unwrap().audible_end = 240. / RATE as f64;
        for _ in 0..481 {
            plain.sample();
        }
        assert_eq!(
            plain.snapshot().current_id.as_deref(),
            Some("a"),
            "off: plays the silence too"
        );
    }
    #[test]
    fn levelling_uses_album_gain_while_an_album_plays_in_order() {
        let (_dir, engine) = test_engine();
        for (id, n) in [("a", 1), ("b", 2), ("c", 7)] {
            let mut t = engine.db.track(id).unwrap();
            (t.album, t.album_artist, t.track, t.size) = ("LP".into(), "Band".into(), n, 1);
            t.artist = "Band".into();
            engine.db.upsert(&t, 1).unwrap();
            let lufs = if id == "a" { -10. } else { -20. };
            engine
                .db
                .set_loudness(
                    &crate::loudness::key(&t),
                    &crate::loudness::Loudness {
                        lufs,
                        peak: 0.1,
                        end_silence: 0.5,
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let state = engine
            .command("queue", serde_json::json!({"ids":["a","b"],"index":0}))
            .unwrap();
        assert_eq!(
            state.gain_kind, "album",
            "a and b are consecutive songs of one album"
        );
        let album_db = state.gain_db.unwrap();
        let state = engine
            .command("levelling", serde_json::json!("track"))
            .unwrap();
        assert_eq!(state.gain_kind, "track");
        assert!((state.gain_db.unwrap() - (-8.)).abs() < 1e-4, "−18 − (−10)");
        // Album of −10, −20 and −20 LUFS songs of equal length: 10·log10(0.04) ≈ −14 LUFS.
        assert!(
            (album_db - (-18. + 13.98)).abs() < 0.01,
            "album gain {album_db}"
        );
        // A very quiet song is boosted by at most +12 dB, and that is what is reported.
        let mut t = engine.db.track("c").unwrap();
        t.size = 2;
        engine.db.upsert(&t, 1).unwrap();
        engine
            .db
            .set_loudness(
                &crate::loudness::key(&t),
                &crate::loudness::Loudness {
                    lufs: -45.,
                    peak: 0.01,
                    ..Default::default()
                },
            )
            .unwrap();
        engine.render.lock().unwrap().state.levelling = "track".into();
        let quiet = engine.prepare("c", 2).unwrap();
        assert!(
            (quiet.gain_db.unwrap() - 12.).abs() < 1e-4,
            "{:?}",
            quiet.gain_db
        );
        let state = engine
            .command("levelling", serde_json::json!("off"))
            .unwrap();
        assert_eq!((state.gain_kind.as_str(), state.gain_db), ("off", None));
        assert!(engine
            .command("levelling", serde_json::json!("loud"))
            .is_err());
        // "c" (track 7) does not follow "b" (track 2): it may be crossfaded into.
        engine
            .command("levelling", serde_json::json!("smart"))
            .unwrap();
        let t = engine.db.track("b").unwrap();
        let mut deck = engine.prepare("b", 1).unwrap();
        assert!(deck.continues_album);
        assert!((deck.audible_end - (t.duration.max(deck.duration) - 0.5)).abs() < 0.05);
        engine.render.lock().unwrap().state.queue = vec!["b".into(), "c".into()];
        deck = engine.prepare("c", 1).unwrap();
        assert!(!deck.continues_album);
    }
    #[test]
    fn equalizer_and_output_device_settings_are_checked_and_applied() {
        let (_dir, engine) = test_engine();
        assert!(engine
            .command(
                "eq",
                serde_json::json!({"enabled": true, "preamp": 0, "bands": [20,0,0,0,0,0,0,0,0,0]})
            )
            .is_err());
        let state = engine
            .command("eq", serde_json::json!({"enabled": true, "preamp": -3, "bands": [6,3,0,0,0,0,0,0,2,4], "preset": "Bass boost"}))
            .unwrap();
        assert_eq!(state.eq.preset, "Bass boost");
        assert!(engine.render.lock().unwrap().eq.active());
        let state = engine
            .command("device", serde_json::json!("USB DAC"))
            .unwrap();
        assert_eq!(state.output_device.as_deref(), Some("USB DAC"));
        assert!(engine.render.lock().unwrap().reopen);
        let restored = Engine::new(engine.db.clone()).snapshot();
        assert_eq!(
            restored.eq.preset, "Bass boost",
            "sound settings survive a restart"
        );
        assert_eq!(restored.output_device.as_deref(), Some("USB DAC"));
        assert!(restored.output.is_none());
    }
    #[test]
    fn sleep_deadline_pauses_playback_and_clears_even_when_already_paused() {
        let mut r = render();
        r.state.sleep_at = Some(1000);
        r.apply_sleep(999);
        assert!(r.state.playing && r.state.sleep_at.is_some());
        r.apply_sleep(1000);
        assert!(!r.state.playing && r.state.sleep_at.is_none());
        r.state.sleep_at = Some(1000);
        r.apply_sleep(5000); // passed while paused: cleared, still paused
        assert!(!r.state.playing && r.state.sleep_at.is_none());
    }
    #[test]
    fn end_of_song_sleep_plays_to_the_real_end_and_waits_at_the_next_song() {
        let mut r = render();
        r.state.crossfade = 0.005; // would normally blend the last 5 ms
        r.state.sleep_end_of_track = true;
        let first: Vec<_> = (0..960).map(|_| r.sample()).collect();
        assert_eq!(
            first,
            vec![0.25; 960],
            "the whole song, with no fade into the next"
        );
        assert_eq!(r.sample(), 0.);
        assert!(!r.state.playing && !r.state.sleep_end_of_track);
        assert_eq!(r.snapshot().current_id.as_deref(), Some("b"));
        assert_eq!(
            r.current.as_ref().unwrap().samples,
            0,
            "the next song waits at its start"
        );
    }
    #[test]
    fn repairs_stale_queue_positions_from_older_saved_sessions() {
        let (_dir, engine) = test_engine();
        engine.db.set("session", &serde_json::json!({"queue":["a"],"cursor":8,"currentId":"gone","position":99.,"playing":true})).unwrap();
        let repaired = Engine::new(engine.db.clone()).snapshot();
        assert_eq!(repaired.cursor, 0);
        assert_eq!(repaired.current_id.as_deref(), Some("a"));
        assert_eq!(repaired.position, 0.);
        assert!(!repaired.playing);
    }
    #[test]
    #[ignore = "Requires locally generated codec fixtures in SLATE_AUDIO_FIXTURES"]
    fn real_codec_decode_and_seek() {
        let dir = std::path::PathBuf::from(
            std::env::var_os("SLATE_AUDIO_FIXTURES").expect("Set SLATE_AUDIO_FIXTURES"),
        );
        for name in [
            "tone.wav",
            "first.flac",
            "tone.mp3",
            "tone.m4a",
            "alac.m4a",
            "tone.ogg",
            "tone.aiff",
            "tone.aac",
        ] {
            let path = dir.join(name);
            let mut decoder = Decoder::try_from(File::open(path).unwrap())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let energy: f32 = decoder.by_ref().take(48000).map(|s| s * s).sum();
            assert!(energy > 1., "{name} decoded silence");
            if name != "tone.aac" {
                decoder
                    .try_seek(Duration::from_secs_f64(1.))
                    .unwrap_or_else(|e| panic!("{name}: seek failed: {e}"));
                assert!(decoder.next().is_some());
            }
        }
    }
    #[test]
    #[ignore = "Requires locally generated FLAC fixtures in SLATE_AUDIO_FIXTURES"]
    fn real_flac_gapless_is_sample_exact() {
        let dir = std::path::PathBuf::from(std::env::var_os("SLATE_AUDIO_FIXTURES").unwrap());
        let make = |name: &str, index| {
            Deck::load(
                &Track {
                    id: name.into(),
                    path: dir.join(name).to_string_lossy().into(),
                    duration: 2.,
                    ..Default::default()
                },
                index,
                |_| RATE,
            )
            .unwrap()
        };
        let mut r = render();
        r.current = Some(make("first.flac", 0));
        r.next = Some(make("second.flac", 1));
        let expected: Vec<f32> = Decoder::try_from(File::open(dir.join("tone.wav")).unwrap())
            .unwrap()
            .collect();
        let out: Vec<_> = (0..expected.len()).map(|_| r.sample()).collect();
        assert_eq!(out.len(), 384000);
        let maximum = out
            .iter()
            .zip(&expected)
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        assert!(
            maximum < 0.00001,
            "Decoded FLAC boundary differs: {maximum}"
        );
        assert_eq!(r.transition, 1);
    }
    #[test]
    #[ignore = "Reads a supplied library without modifying it; requires SLATE_TEST_LIBRARY"]
    fn real_library_decode_and_seek() {
        let root = std::env::var_os("SLATE_TEST_LIBRARY").expect("Set SLATE_TEST_LIBRARY");
        let mut count = 0;
        for entry in walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && crate::library::supported(e.path()))
        {
            let mut source = Decoder::try_from(File::open(entry.path()).unwrap()).unwrap();
            let duration = source.total_duration().unwrap_or(Duration::from_secs(10));
            assert!(source.by_ref().take(4800).count() > 0);
            source.try_seek(duration / 2).unwrap();
            assert!(source.next().is_some());
            count += 1;
        }
        assert!(count > 0);
        println!("Decoded and sought {count} real library files");
    }
}
