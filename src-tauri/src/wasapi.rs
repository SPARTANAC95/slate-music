//! Exclusive-mode output through WASAPI. Slate Music takes the audio device for itself and
//! sends each song at its own sample rate as whole-number samples, so Windows neither mixes nor
//! resamples it. Other apps can't play through the device meanwhile, so it is let go a few
//! seconds after music pauses and taken back on play. A song whose rate differs from the last
//! one reopens the device at the change; songs at the same rate stay gapless.
use crate::audio::{OutputInfo, RenderState};
use crate::exclusive::{to_pcm, Layout, Support, LAYOUTS, RATES};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, S_OK, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_INVALIDATED,
    AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_E_UNSUPPORTED_FORMAT,
    AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::Media::KernelStreaming::{
    KSDATAFORMAT_SUBTYPE_PCM, SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT, WAVE_FORMAT_EXTENSIBLE,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToBSTR;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

/// COM for the current thread, released when dropped.
struct Com(bool);
impl Com {
    fn init() -> Com {
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() }
        }
    }
}
fn wave(rate: u32, l: Layout) -> WAVEFORMATEXTENSIBLE {
    let block = 2 * l.container / 8;
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: 2,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * block as u32,
            nBlockAlign: block,
            wBitsPerSample: l.container,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: l.valid,
        },
        dwChannelMask: SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT,
        SubFormat: KSDATAFORMAT_SUBTYPE_PCM,
    }
}
fn describe(e: &windows::core::Error) -> String {
    match e.code() {
        AUDCLNT_E_DEVICE_IN_USE => "another app is using the device in exclusive mode".into(),
        AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED => {
            "Windows is set not to let apps take this device (Sound settings → the device → Properties → Advanced → Allow applications to take exclusive control)".into()
        }
        AUDCLNT_E_UNSUPPORTED_FORMAT => "the device refused the song's format".into(),
        AUDCLNT_E_DEVICE_INVALIDATED => "the device was disconnected".into(),
        _ => e.message(),
    }
}
fn name_of(d: &IMMDevice) -> String {
    unsafe {
        d.OpenPropertyStore(STGM_READ)
            .and_then(|s| s.GetValue(&PKEY_Device_FriendlyName))
            .and_then(|v| PropVariantToBSTR(&v))
            .map(|b| b.to_string())
            .unwrap_or_default()
    }
}
/// The named device when it is connected, else the Windows default; and whether it fell back.
fn find(name: Option<&str>) -> windows::core::Result<(IMMDevice, String, bool)> {
    unsafe {
        let all: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        if let Some(wanted) = name {
            let devices = all.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            for i in 0..devices.GetCount()? {
                let d = devices.Item(i)?;
                if name_of(&d) == wanted {
                    return Ok((d, wanted.to_owned(), false));
                }
            }
        }
        let d = all.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let n = name_of(&d);
        Ok((d, n, name.is_some()))
    }
}
/// Asks the device which rates and layouts it takes in exclusive mode. Plays nothing.
pub fn probe(name: Option<String>) -> Result<Support, String> {
    std::thread::spawn(move || {
        let _com = Com::init();
        let (device, name, fallback) = find(name.as_deref()).map_err(|e| describe(&e))?;
        let client: IAudioClient =
            unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| describe(&e))?;
        let mut formats = vec![];
        for rate in RATES {
            for layout in LAYOUTS {
                let w = wave(rate, layout);
                let hr = unsafe {
                    client.IsFormatSupported(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &w as *const _ as *const WAVEFORMATEX,
                        None,
                    )
                };
                if hr == S_OK {
                    formats.push((rate, layout));
                } else if hr == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
                    return Err(describe(&hr.into()));
                }
            }
        }
        if formats.is_empty() {
            return Err("the device doesn't accept any format Slate Music can send".into());
        }
        Ok(Support {
            device: name,
            fallback,
            formats,
        })
    })
    .join()
    .map_err(|_| "checking the device failed".to_string())?
}

/// A Windows event handle, closed when dropped (also when opening a stream fails half-way).
struct Event(HANDLE);
impl Drop for Event {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
/// What one buffer held: whether the song still needs this rate, and whether music played.
struct Filled {
    same_rate: bool,
    playing: bool,
}
/// An open exclusive stream at one rate and layout.
struct Stream {
    client: IAudioClient,
    output: IAudioRenderClient,
    event: Event,
    frames: u32,
    layout: Layout,
}
impl Stream {
    fn open(device: &IMMDevice, rate: u32, layout: Layout) -> windows::core::Result<Stream> {
        let w = wave(rate, layout);
        let format = &w as *const _ as *const WAVEFORMATEX;
        unsafe {
            let mut client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let mut default_period = 0i64;
            client.GetDevicePeriod(Some(&mut default_period), None)?;
            // 40 ms per buffer: plenty of room, and nobody hears latency in music playback.
            let mut period = default_period.max(400_000);
            let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
            let mut opened = client.Initialize(
                AUDCLNT_SHAREMODE_EXCLUSIVE,
                flags,
                period,
                period,
                format,
                None,
            );
            if let Err(e) = &opened {
                if e.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                    // Some drivers need the buffer in whole hardware blocks: ask, then retry.
                    let frames = client.GetBufferSize()?;
                    period = (10_000_000. * frames as f64 / rate as f64).round() as i64;
                    client = device.Activate(CLSCTX_ALL, None)?;
                    opened = client.Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        flags,
                        period,
                        period,
                        format,
                        None,
                    );
                }
            }
            opened?;
            let event = Event(CreateEventW(None, false, false, None)?);
            client.SetEventHandle(event.0)?;
            let frames = client.GetBufferSize()?;
            let output: IAudioRenderClient = client.GetService()?;
            Ok(Stream {
                client,
                output,
                event,
                frames,
                layout,
            })
        }
    }
    /// Fills one buffer from the mixer.
    fn fill(&self, render: &Mutex<RenderState>, rate: u32) -> windows::core::Result<Filled> {
        let bytes = (self.layout.container / 8) as usize;
        unsafe {
            let data = self.output.GetBuffer(self.frames)?;
            let out = std::slice::from_raw_parts_mut(data, self.frames as usize * 2 * bytes);
            let mut r = render.lock().unwrap();
            let same_rate = r.current_rate() == rate;
            let playing = r.state.playing;
            for chunk in out.chunks_exact_mut(bytes) {
                let sample = if same_rate && !r.rate_pending {
                    r.sample()
                } else {
                    0.
                };
                to_pcm(sample, self.layout, chunk);
            }
            drop(r);
            self.output.ReleaseBuffer(self.frames, 0)?;
            Ok(Filled { same_rate, playing })
        }
    }
    /// Plays until stopped, the next song needs a different rate, or music has been paused
    /// for a few seconds (then the device is let go, so other apps can use it).
    fn play(
        &self,
        render: &Mutex<RenderState>,
        stop: &AtomicBool,
        rate: u32,
    ) -> Result<(), String> {
        let fail = |e: windows::core::Error| describe(&e);
        let mut filled = self.fill(render, rate).map_err(fail)?;
        unsafe { self.client.Start() }.map_err(fail)?;
        let mut quiet_since: Option<Instant> = None;
        while filled.same_rate && !stop.load(Ordering::SeqCst) {
            if filled.playing {
                quiet_since = None;
            } else if quiet_since.get_or_insert_with(Instant::now).elapsed()
                > Duration::from_secs(3)
            {
                break;
            }
            if unsafe { WaitForSingleObject(self.event.0, 2000) } != WAIT_OBJECT_0 {
                return Err("the device stopped responding".into());
            }
            filled = self.fill(render, rate).map_err(fail)?;
        }
        if !filled.same_rate {
            // The next song needs another rate. The buffer before this one still holds the end
            // of the last song: let it play out before the device is stopped and reopened.
            unsafe { WaitForSingleObject(self.event.0, 2000) };
        }
        Ok(())
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        // The event closes after this, with the other fields.
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// The exclusive output, running on its own thread until dropped.
pub struct Exclusive {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Exclusive {
    /// Starts playing. On failure `problem` is set and `lost` raised, so the engine falls back.
    pub fn start(
        support: Support,
        wanted: Option<String>,
        render: Arc<Mutex<RenderState>>,
        problem: Arc<Mutex<Option<String>>>,
        lost: Arc<AtomicBool>,
    ) -> Exclusive {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let _com = Com::init();
            if let Err(e) = run(&support, wanted.as_deref(), &render, &stopping) {
                *problem.lock().unwrap() = Some(e);
                lost.store(true, Ordering::SeqCst);
            }
        });
        Exclusive {
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Exclusive {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
fn run(
    support: &Support,
    wanted: Option<&str>,
    render: &Mutex<RenderState>,
    stop: &AtomicBool,
) -> Result<(), String> {
    while !stop.load(Ordering::SeqCst) {
        let (rate, playing, loaded) = {
            let r = render.lock().unwrap();
            (r.current_rate(), r.state.playing, r.current.is_some())
        };
        let layout = support.stream_layout(rate);
        {
            // With nothing loaded the rate may be one the device doesn't take; show the format
            // a song at that rate would get instead of failing.
            let shown = layout.map(|l| (rate, l)).or_else(|| {
                let near = support.rate_for(rate);
                support.stream_layout(near).map(|l| (near, l))
            });
            let mut r = render.lock().unwrap();
            if let Some((sample_rate, l)) = shown {
                let info = OutputInfo {
                    device: support.device.clone(),
                    sample_rate,
                    channels: 2,
                    fallback: support.fallback,
                    exclusive: true,
                    bits: l.valid,
                };
                if r.state.output.as_ref() != Some(&info) {
                    r.state.output = Some(info);
                }
            }
            r.state.engine_ready = true;
        }
        // Paused: the device stays free for other apps until music plays again.
        if !playing || !loaded {
            std::thread::sleep(Duration::from_millis(40));
            continue;
        }
        let layout = layout.ok_or("the device takes no format at this song's sample rate")?;
        // Look the device up again each time music starts: headphones may have been plugged
        // in or reconnected since. Another device is checked afresh by the engine.
        let (device, name, fallback) = find(wanted).map_err(|e| describe(&e))?;
        if name != support.device || fallback != support.fallback {
            render.lock().unwrap().reopen = true;
            return Ok(());
        }
        let stream = Stream::open(&device, rate, layout).map_err(|e| describe(&e))?;
        render.lock().unwrap().use_rate(rate);
        stream.play(render, stop, rate)?;
    }
    Ok(())
}
