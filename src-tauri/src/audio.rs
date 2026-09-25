use crate::db::{err, Database, Result, Track};
use rand::seq::SliceRandom;
use rodio::{source::UniformSourceIterator, Decoder, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use std::{
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
}
impl Deck {
    fn load(track: &Track, index: usize) -> Result<Self> {
        let decoder = Decoder::try_from(File::open(&track.path).map_err(err)?).map_err(err)?;
        let duration = decoder
            .total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(track.duration);
        Ok(Self {
            id: track.id.clone(),
            index,
            source: Box::new(UniformSourceIterator::new(decoder, 2, RATE)),
            samples: 0,
            duration,
        })
    }
    fn position(&self) -> f64 {
        self.samples as f64 / (RATE * 2) as f64
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
    pub volume: f32,
    pub shuffle: bool,
    pub repeat: String,
    pub crossfade: f64,
    pub error: Option<String>,
    pub engine_ready: bool,
    pub system_controls: bool,
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
            volume: 0.7,
            shuffle: false,
            repeat: "off".into(),
            crossfade: 0.,
            error: None,
            engine_ready: false,
            system_controls: false,
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
}
impl RenderState {
    fn snapshot(&self) -> Playback {
        let mut s = self.state.clone();
        if let Some(d) = &self.current {
            s.current_id = Some(d.id.clone());
            s.cursor = d.index;
            s.position = d.position();
            s.duration = d.duration;
        }
        s
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
    fn sample(&mut self) -> f32 {
        if !self.state.playing || self.stopping {
            return 0.;
        }
        let Some(current) = self.current.as_mut() else {
            return 0.;
        };
        if let Some(mut sample) = current.source.next() {
            let fade = self.state.crossfade.min(current.duration / 2.).max(0.);
            let remaining = current.duration - current.position();
            if fade > 0. && remaining <= fade {
                if let Some(next) = self.next.as_mut() {
                    if let Some(n) = next.source.next() {
                        let ratio = (1. - remaining / fade).clamp(0., 1.) as f32;
                        sample = sample * (1. - ratio) + n * ratio;
                        next.samples += 1;
                    }
                }
            }
            current.samples += 1;
            return sample * self.state.volume;
        }
        if let Some(next) = self.next.take() {
            self.state.cursor = next.index;
            self.state.current_id = Some(next.id.clone());
            self.current = Some(next);
            self.transition += 1;
            self.epoch += 1;
            self.next_attempt = None;
            return self.sample();
        }
        self.state.playing = false;
        self.state.position = self.current.as_ref().map(|d| d.duration).unwrap_or(0.);
        0.
    }
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
        state.error = None;
        state.volume = state.volume.clamp(0., 1.);
        state.crossfade = state.crossfade.clamp(0., 12.);
        Arc::new(Self {
            render: Arc::new(Mutex::new(RenderState {
                state,
                current: None,
                next: None,
                epoch: 0,
                transition: 0,
                stopping: false,
                next_attempt: None,
            })),
            db,
            command_lock: Mutex::new(()),
        })
    }
    pub fn snapshot(&self) -> Playback {
        self.render.lock().unwrap().snapshot()
    }
    pub fn save(&self) {
        let mut s = self.snapshot();
        s.playing = false;
        let _ = self.db.set("session", &serde_json::to_value(s).unwrap());
    }
    fn prepare(&self, id: &str, index: usize) -> Result<Deck> {
        let t = self.db.track(id)?;
        if !std::path::Path::new(&t.path).is_file() {
            let _ = self.db.missing(id, true);
            return Err(format!(
                "File unavailable: {}. Reconnect its drive or rescan.",
                t.title
            ));
        }
        Deck::load(&t, index)
    }
    fn load(&self, index: usize, position: f64, playing: bool) -> Result<()> {
        let (id, epoch) = {
            let r = self.render.lock().unwrap();
            (
                r.state.queue.get(index).cloned().ok_or("Queue is empty")?,
                r.epoch,
            )
        };
        let mut deck = self.prepare(&id, index)?;
        if position > 0. {
            let target = position.min((deck.duration - 0.1).max(0.));
            deck.source
                .try_seek(Duration::from_secs_f64(target))
                .map_err(err)?;
            deck.samples = (target * (RATE * 2) as f64) as u64;
        }
        let mut r = self.render.lock().unwrap();
        if r.epoch != epoch {
            return Ok(());
        }
        let new_play = r
            .current
            .as_ref()
            .is_none_or(|d| d.id != id || d.index != index);
        r.current = Some(deck);
        r.next = None;
        r.state.cursor = index;
        r.state.current_id = Some(id);
        r.state.playing = playing;
        r.state.error = None;
        r.epoch += 1;
        if new_play {
            r.transition += 1;
        }
        r.next_attempt = None;
        Ok(())
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
                    let selected = ids.get(requested).cloned();
                    let tracks = self.db.tracks()?;
                    let mut valid: Vec<String> = ids
                        .into_iter()
                        .filter(|id| tracks.iter().any(|t| &t.id == id && !t.missing))
                        .collect();
                    if valid.is_empty() {
                        return Err("No available files in this selection".into());
                    }
                    let mut index = selected
                        .and_then(|id| valid.iter().position(|s| *s == id))
                        .unwrap_or(0);
                    {
                        let mut r = self.render.lock().unwrap();
                        if r.state.shuffle {
                            let current = valid.remove(index);
                            valid.shuffle(&mut rand::rng());
                            valid.insert(0, current);
                            index = 0;
                        }
                        r.state.queue = valid;
                        r.current = None;
                        r.next = None;
                        r.epoch += 1;
                    }
                    self.load(index, 0., true)?;
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
                    } else if !s.playing && s.position >= s.duration - 0.03 {
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
                    self.render.lock().unwrap().state.crossfade = fade;
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
                "append" => {
                    let id = value.as_str().ok_or("Missing song")?;
                    let t = self.db.track(id)?;
                    if t.missing {
                        return Err("That file is unavailable".into());
                    }
                    let mut r = self.render.lock().unwrap();
                    r.state.queue.push(id.into());
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
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
                    r.state.queue.remove(index);
                    if index < r.state.cursor {
                        r.state.cursor -= 1
                    }
                    if let Some(d) = &mut r.current {
                        if index < d.index {
                            d.index -= 1;
                        }
                    }
                    r.next = None;
                    r.epoch += 1;
                    r.next_attempt = None;
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
                "jump" => {
                    let i = value.as_u64().ok_or("Missing queue index")? as usize;
                    self.load(i, 0., true)?;
                }
                "clear" => {
                    let mut r = self.render.lock().unwrap();
                    r.state.queue.clear();
                    r.current = None;
                    r.next = None;
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
        if let Err(e) = &result {
            self.render.lock().unwrap().state.error = Some(e.clone());
        }
        self.save();
        result?;
        Ok(self.snapshot())
    }
    pub fn start(self: &Arc<Self>, app: tauri::AppHandle, hwnd: usize) {
        let engine = self.clone();
        std::thread::spawn(move || {
            let lost = Arc::new(AtomicBool::new(false));
            let mut output: Option<(rodio::OutputStream, Sink)> = None;
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
            loop {
                std::thread::sleep(Duration::from_millis(80));
                tick += 1;
                if lost.swap(false, Ordering::SeqCst) {
                    output.take();
                    let mut r = engine.render.lock().unwrap();
                    r.state.playing = false;
                    r.state.engine_ready = false;
                    r.state.error = Some(
                        "Audio device disconnected. Reconnecting; playback will stay paused."
                            .into(),
                    );
                }
                if output.is_none() && tick % 12 == 1 {
                    let signal = lost.clone();
                    let opened = OutputStreamBuilder::from_default_device().and_then(|b| {
                        b.with_error_callback(move |_| {
                            signal.store(true, Ordering::SeqCst);
                        })
                        .open_stream()
                    });
                    match opened {
                        Ok(mut stream) => {
                            stream.log_on_drop(false);
                            let sink = Sink::connect_new(stream.mixer());
                            sink.append(Mixer(engine.render.clone()));
                            output = Some((stream, sink));
                            let mut r = engine.render.lock().unwrap();
                            r.state.engine_ready = true;
                            r.state.error = None;
                        }
                        Err(e) => {
                            let mut r = engine.render.lock().unwrap();
                            r.state.playing = false;
                            r.state.engine_ready = false;
                            r.state.error=Some(format!("Audio output unavailable: {e}. Connect an output device to continue."));
                        }
                    }
                }
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
                        Ok(deck) => {
                            let mut r = engine.render.lock().unwrap();
                            if r.epoch == epoch {
                                r.next = Some(deck);
                            }
                        }
                        Err(e) => {
                            let mut r = engine.render.lock().unwrap();
                            if r.epoch == epoch {
                                r.state.error = Some(e);
                                if index != r.snapshot().cursor && index < r.state.queue.len() {
                                    r.state.queue.remove(index);
                                    r.next_attempt = None;
                                }
                            }
                        }
                    }
                }
                let s = engine.snapshot();
                let transition = engine.render.lock().unwrap().transition;
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
        }
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
