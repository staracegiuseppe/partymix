//! Listens to what the computer is playing (the sound the party is made of) so the app can tell music from a spoken ad.
//! macOS 14.6+ and Windows can record the output of the sound card without extra drivers. The audio is reduced to
//! 16 kHz mono blocks of 100 ms, handed to the web view, analysed on the fly and never stored.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use cpal::{SampleFormat, Stream};

/// Android and iOS do not let an app record what the device is playing without the screen-capture consent:
/// the ad detector simply stays off there.
#[cfg(any(target_os = "android", target_os = "ios"))]
struct Stream;

#[cfg(any(target_os = "android", target_os = "ios"))]
fn open(_on_audio: Channel<InvokeResponseBody>) -> Result<Stream, String> {
    Err("su telefono e tablet l'ascolto dell'audio del dispositivo non è disponibile".into())
}
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

const OUT_RATE: u32 = 16_000;
const BLOCK: usize = 1_600; // 100 ms

#[derive(Default)]
pub struct CaptureState(Mutex<Option<Sender<()>>>);

/// Mono 16 kHz converter: each output sample is the average of the input samples it covers.
struct Reducer {
    rate: u32,
    channels: usize,
    pos: u32,
    sum: f32,
    n: u32,
    block: Vec<i16>,
}

impl Reducer {
    fn new(rate: u32, channels: usize) -> Self {
        Reducer { rate, channels: channels.max(1), pos: 0, sum: 0.0, n: 0, block: Vec::with_capacity(BLOCK * 2) }
    }

    /// Feeds interleaved samples; returns a full block (little-endian i16 bytes) each time 100 ms are ready.
    fn feed(&mut self, interleaved: &[f32], mut emit: impl FnMut(Vec<u8>)) {
        for frame in interleaved.chunks(self.channels) {
            let mono = frame.iter().sum::<f32>() / frame.len() as f32;
            self.sum += mono;
            self.n += 1;
            self.pos += OUT_RATE;
            if self.pos >= self.rate {
                self.pos -= self.rate;
                let v = (self.sum / self.n as f32).clamp(-1.0, 1.0);
                self.sum = 0.0;
                self.n = 0;
                self.block.push((v * 32767.0) as i16);
                if self.block.len() == BLOCK {
                    let bytes: Vec<u8> = self.block.iter().flat_map(|s| s.to_le_bytes()).collect();
                    self.block.clear();
                    emit(bytes);
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open(on_audio: Channel<InvokeResponseBody>) -> Result<Stream, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("nessuna uscita audio trovata")?;
    let range = device
        .supported_output_configs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("l'uscita audio non ha configurazioni")?;
    let supported = range.with_max_sample_rate();
    let format = supported.sample_format();
    let config = supported.config();
    let rate = config.sample_rate;
    let channels = config.channels as usize;
    let mut reducer = Reducer::new(rate, channels);
    let err = |e: cpal::Error| eprintln!("cattura audio: {e}");
    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                reducer.feed(data, |b| {
                    let _ = on_audio.send(InvokeResponseBody::Raw(b));
                })
            },
            err,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let f: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                reducer.feed(&f, |b| {
                    let _ = on_audio.send(InvokeResponseBody::Raw(b));
                })
            },
            err,
            None,
        ),
        other => return Err(format!("formato audio non supportato: {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

#[tauri::command]
pub fn start_audio_capture(state: State<CaptureState>, on_audio: Channel<InvokeResponseBody>) -> Result<(), String> {
    stop_audio_capture(state.clone());
    let (stop_tx, stop_rx) = channel::<()>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    // The stream is not Send on every platform: it lives and dies on its own thread.
    std::thread::spawn(move || match open(on_audio) {
        Ok(stream) => {
            let _ = ready_tx.send(Ok(()));
            let _ = stop_rx.recv(); // until stopped (or the app closes)
            drop(stream);
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    });
    ready_rx.recv().map_err(|e| e.to_string())??;
    *state.0.lock().unwrap() = Some(stop_tx);
    Ok(())
}

/// Debug aid for tuning the ad detector: when the environment variable PARTYMIX_ADLOG names a file, the lines the web
/// view sends (numbers describing the sound, never audio) are appended to it. Without the variable it does nothing.
#[tauri::command]
pub fn ad_debug_log(line: Option<String>) -> bool {
    use std::io::Write;
    let Some(path) = std::env::var_os("PARTYMIX_ADLOG") else { return false };
    if let Some(l) = line {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{l}");
        }
    }
    true
}

/// Debug aid: the playlist link named by PARTYMIX_PLAYLIST, so a test run can start without typing it.
#[tauri::command]
pub fn ad_debug_playlist() -> Option<String> {
    std::env::var("PARTYMIX_PLAYLIST").ok().filter(|v| !v.is_empty())
}

/// Debug aid: the spot mode named by PARTYMIX_SPOT (off, duck or skip), so a test run can try it without the menu.
#[tauri::command]
pub fn ad_debug_spot() -> Option<String> {
    std::env::var("PARTYMIX_SPOT").ok().filter(|v| !v.is_empty())
}

#[tauri::command]
pub fn stop_audio_capture(state: State<CaptureState>) {
    if let Some(tx) = state.0.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_48k_becomes_mono_16k_blocks_of_100ms() {
        let mut r = Reducer::new(48_000, 2);
        let mut blocks = 0;
        // one second of a constant 0.5 on both channels
        let input = vec![0.5f32; 48_000 * 2];
        r.feed(&input, |b| {
            assert_eq!(b.len(), BLOCK * 2);
            let s = i16::from_le_bytes([b[0], b[1]]);
            assert!((s as i32 - 16_383).abs() < 3);
            blocks += 1;
        });
        assert_eq!(blocks, 10);
    }

    #[test]
    fn odd_rates_keep_the_duration() {
        let mut r = Reducer::new(44_100, 1);
        let mut blocks = 0;
        r.feed(&vec![0.0f32; 44_100 * 3], |_| blocks += 1);
        assert_eq!(blocks, 30);
    }
}
