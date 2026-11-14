//! The download engine: yt-dlp run as a process by the app (never from the web page), with the options of the
//! user's scripts translated to its command line. ffmpeg is used for MP3/M4A/Opus extraction and for joining video+audio.

use super::metadata;
use super::models::{ApiError, ErrorCode, Kind, Meta, Request};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

/// The library folders: music/, video/, thumbnails/, metadata/, temporary/.
#[derive(Clone, Debug)]
pub struct Dirs {
    pub root: PathBuf,
}
impl Dirs {
    pub fn new(root: PathBuf) -> Self { Dirs { root } }
    pub fn music(&self) -> PathBuf { self.root.join("music") }
    pub fn video(&self) -> PathBuf { self.root.join("video") }
    pub fn thumbnails(&self) -> PathBuf { self.root.join("thumbnails") }
    pub fn metadata(&self) -> PathBuf { self.root.join("metadata") }
    pub fn temporary(&self) -> PathBuf { self.root.join("temporary") }
    pub fn job_temp(&self, job: &str) -> PathBuf { self.temporary().join(job) }
    pub fn create(&self) -> std::io::Result<()> {
        for d in [self.music(), self.video(), self.thumbnails(), self.metadata(), self.temporary()] { std::fs::create_dir_all(d)?; }
        Ok(())
    }
}

/// Apps opened from the Finder do not get the shell PATH: also look where Homebrew, pip and winget put programs.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{}.exe", name) } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] { dirs.push(d.into()); }
    if let Some(h) = std::env::var_os("HOME") { dirs.push(PathBuf::from(&h).join(".local/bin")); }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") { dirs.push(PathBuf::from(l).join("Microsoft/WinGet/Links")); }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

/// Is ffmpeg there? (Needed to make MP3/M4A/Opus and to join video and audio.)
pub fn check_ffmpeg() -> Option<PathBuf> { find_tool("ffmpeg") }
pub fn check_ytdlp() -> Option<PathBuf> { find_tool("yt-dlp") }

/// The command that updates yt-dlp the way it was installed (Homebrew, pip, standalone).
pub fn update_hint() -> &'static str {
    match check_ytdlp() {
        Some(p) if p.starts_with("/opt/homebrew") || p.starts_with("/usr/local/Cellar") || p.starts_with("/usr/local/bin") && std::fs::read_to_string(&p).map(|s| s.contains("Cellar")).unwrap_or(false) => "brew upgrade yt-dlp",
        Some(p) if p.to_string_lossy().contains("WinGet") => "winget upgrade yt-dlp",
        _ => "yt-dlp -U",
    }
}

/// yt-dlp's version («2026.10.26»).
pub fn ytdlp_version() -> Option<String> {
    let p = check_ytdlp()?;
    let mut c = Command::new(p);
    c.arg("--version").env("PATH", tool_path()).stdin(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    let o = c.output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// Days since a yt-dlp version came out (versions are dates). YouTube changes often: after ~2 months downloads start to fail.
pub fn version_age_days(version: &str, now_ms: u64) -> Option<u64> {
    let mut it = version.split('.').map(|x| x.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    if !(2000..3000).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) { return None; }
    // days from civil date (Howard Hinnant's algorithm)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let today = (now_ms / 86_400_000) as i64;
    Some((today - days).max(0) as u64)
}

/// PATH for yt-dlp: an app opened from the Finder gets only /usr/bin:/bin, but yt-dlp needs its helpers
/// (deno for YouTube's checks, ffmpeg) that Homebrew, pip or winget put elsewhere.
pub fn tool_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for t in [check_ytdlp(), check_ffmpeg(), find_tool("deno")].into_iter().flatten() { if let Some(d) = t.parent() { dirs.push(d.to_path_buf()); } }
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] { dirs.push(d.into()); }
    if let Some(h) = std::env::var_os("HOME") { dirs.push(PathBuf::from(&h).join(".deno/bin")); dirs.push(PathBuf::from(&h).join(".local/bin")); }
    if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

pub const FFMPEG_MISSING: &str = "FFmpeg non installato: serve per creare MP3, M4A e Opus e per unire video e audio. Installalo con «brew install ffmpeg» (Mac), «winget install ffmpeg» (Windows) o dal gestore pacchetti (Linux).";
pub const YTDLP_MISSING: &str = "Per scaricare serve il programma gratuito yt-dlp: installalo con «brew install yt-dlp» (Mac), «winget install yt-dlp» (Windows) o dal gestore pacchetti (Linux), poi riprova.";

const QUALITIES: [&str; 5] = ["best", "1080", "720", "480", "360"];

/// The yt-dlp arguments for a request (without the URL). Errors when the request cannot be done (format, missing ffmpeg).
pub fn build_args(req: &Request, dirs: &Dirs, job_id: &str, ffmpeg: Option<&Path>) -> Result<Vec<String>, ApiError> {
    let q = req.quality.trim_end_matches('p').to_ascii_lowercase();
    if !QUALITIES.contains(&q.as_str()) { return Err(ApiError::new(ErrorCode::UnsupportedFormat, "Qualità non supportata: scegli Best, 1080p, 720p, 480p o 360p.")); }
    let mut a: Vec<String> = Vec::new();
    let home = match req.kind { Kind::Audio => dirs.music(), Kind::Video => dirs.video() };
    a.extend(["-P".into(), format!("home:{}", home.display())]);
    a.extend(["-P".into(), format!("temp:{}", dirs.job_temp(job_id).display())]);
    a.extend(["-P".into(), format!("thumbnail:{}", dirs.thumbnails().display())]);
    // the user's template, plus the id so two songs with the same title never overwrite each other
    a.extend(["-o".into(), "%(title).150B [%(id)s].%(ext)s".into()]);
    a.extend(["-o".into(), "thumbnail:%(id)s.%(ext)s".into()]);
    // partial files (.part) live in the job's own temporary folder: resumed after a restart (--continue), deleted at the end
    for x in ["--no-playlist", "--newline", "--progress", "--no-warnings", "--no-mtime", "--write-thumbnail", "--continue"] { a.push(x.into()); }
    match req.kind {
        Kind::Audio => {
            let fmt = req.format.as_deref().unwrap_or("mp3").to_ascii_lowercase();
            a.extend(["-f".into(), "bestaudio/best".into()]);
            match fmt.as_str() {
                "best" | "original" => {}
                "mp3" | "m4a" | "opus" => {
                    if ffmpeg.is_none() { return Err(ApiError::new(ErrorCode::FfmpegMissing, FFMPEG_MISSING)); }
                    // FFmpegExtractAudio, preferredcodec, preferredquality 192
                    a.extend(["-x".into(), "--audio-format".into(), fmt.clone(), "--audio-quality".into(), "192K".into()]);
                }
                _ => return Err(ApiError::new(ErrorCode::UnsupportedFormat, "Formato audio non supportato: scegli MP3, M4A, Opus o Originale.")),
            }
        }
        Kind::Video => {
            let fmt = req.format.as_deref().unwrap_or("mp4").to_ascii_lowercase();
            if fmt != "mp4" && fmt != "webm" { return Err(ApiError::new(ErrorCode::UnsupportedFormat, "Formato video non supportato: scegli MP4 o WebM.")); }
            let audio_ext = if fmt == "mp4" { "m4a" } else { "webm" };
            // prefer the chosen resolution and container, take what exists (not every source has every quality)
            let sort = if q == "best" { format!("ext:{}:{}", fmt, audio_ext) } else { format!("res:{},ext:{}:{}", q, fmt, audio_ext) };
            if ffmpeg.is_some() {
                a.extend(["-f".into(), "bv*+ba/b".into(), "-S".into(), sort, "--merge-output-format".into(), fmt]);
            } else {
                a.extend(["-f".into(), "b".into(), "-S".into(), sort]); // one file that already has video and audio
            }
        }
    }
    if let Some(f) = ffmpeg {
        if let Some(d) = f.parent() { a.push("--ffmpeg-location".into()); a.push(d.display().to_string()); }
        a.extend(["--convert-thumbnails".into(), "jpg".into()]);
    }
    a.extend([
        "--progress-template".into(), "download:PMXP %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s".into(),
        "--progress-template".into(), "postprocess:PMXPP %(progress.postprocessor)s|%(progress.status)s".into(),
        "--print".into(), format!("after_move:PMXF {}", metadata::PRINT_FIELDS),
    ]);
    Ok(a)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Progress { downloaded: u64, total: Option<u64>, speed: Option<f64>, eta: Option<u64> },
    Processing,
}

fn num(s: &str) -> Option<f64> { s.trim().parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0) }

/// One line of yt-dlp's output → an event of the manager.
pub fn parse_line(line: &str) -> Option<Event> {
    if let Some(r) = line.strip_prefix("PMXP ") {
        let f: Vec<&str> = r.split('|').collect();
        if f.len() < 6 { return None; }
        let total = num(f[2]).or_else(|| num(f[3])).map(|t| t as u64);
        return Some(Event::Progress { downloaded: num(f[1]).unwrap_or(0.0) as u64, total, speed: num(f[4]), eta: num(f[5]).map(|e| e as u64) });
    }
    if line.starts_with("PMXPP ") { return Some(Event::Processing); }
    None
}

/// yt-dlp's error text → a code and a sentence for the user.
pub fn classify(stderr: &str) -> ApiError {
    let s = stderr.to_lowercase();
    let e = |c, m: &str| ApiError::new(c, m);
    if s.contains("no space left") || s.contains("os error 28") || s.contains("disk full") || s.contains("errno 28") {
        e(ErrorCode::DiskFull, "Spazio insufficiente nella libreria locale.")
    } else if s.contains("ffmpeg") && (s.contains("not found") || s.contains("not installed")) || s.contains("ffprobe and ffmpeg not found") {
        e(ErrorCode::FfmpegMissing, FFMPEG_MISSING)
    } else if s.contains("postprocessing") || s.contains("conversion failed") || s.contains("error converting") {
        e(ErrorCode::ConversionError, "Errore nella conversione del file: prova il formato «Originale».")
    } else if s.contains("drm") {
        e(ErrorCode::Unavailable, "Contenuto protetto (DRM): non si può scaricare.")
    } else if s.contains("unsupported url") {
        e(ErrorCode::InvalidUrl, "Questo sito o indirizzo non è supportato.")
    } else if s.contains("requested format is not available") || s.contains("no video formats") {
        e(ErrorCode::UnsupportedFormat, "Il formato o la qualità scelti non sono disponibili per questo contenuto.")
    } else if s.contains("private video") || s.contains("video unavailable") || s.contains("is unavailable") || s.contains("no longer available") || s.contains("has been removed") || s.contains("is not available") || s.contains("sign in to confirm") || s.contains("members-only") || s.contains("http error 404") {
        e(ErrorCode::Unavailable, "Contenuto non disponibile (privato, rimosso, riservato o con limite di età).")
    } else if s.contains("unable to download webpage") || s.contains("getaddrinfo") || s.contains("network is unreachable") || s.contains("timed out") || s.contains("connection reset") || s.contains("connection refused") || s.contains("temporary failure in name resolution") || s.contains("incompleteread") {
        e(ErrorCode::Network, "Connessione interrotta o assente: riprova quando la rete funziona.")
    } else if let Some(i) = s.find("http error ") {
        let code: String = s[i + 11..].chars().take(3).collect();
        if code == "403" {
            e(ErrorCode::HttpError, &format!("Il sito ha rifiutato il download (HTTP 403): quasi sempre vuol dire che yt-dlp è vecchio. Aggiornalo con «{}», poi premi ↻ Riprova.", update_hint()))
        } else {
            e(ErrorCode::HttpError, &format!("Il sito ha risposto con un errore (HTTP {}): riprova più tardi; se succede spesso aggiorna yt-dlp con «{}».", code, update_hint()))
        }
    } else {
        let last = stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("").replace("ERROR:", "");
        let last = last.trim();
        e(ErrorCode::Unknown, &if last.is_empty() { "Download non riuscito.".to_string() } else { format!("Download non riuscito: {}", last.chars().take(160).collect::<String>()) })
    }
}

/// Runs one job. Implemented by yt-dlp; the tests use a fake.
pub trait Runner: Send + Sync {
    fn run(&self, job_id: &str, req: &Request, dirs: &Dirs, cancel: &AtomicBool, on: &mut dyn FnMut(Event)) -> Result<Meta, ApiError>;
}

pub struct YtDlp;

impl Runner for YtDlp {
    fn run(&self, job_id: &str, req: &Request, dirs: &Dirs, cancel: &AtomicBool, on: &mut dyn FnMut(Event)) -> Result<Meta, ApiError> {
        let ytdlp = check_ytdlp().ok_or_else(|| ApiError::new(ErrorCode::YtdlpMissing, YTDLP_MISSING))?;
        let ffmpeg = check_ffmpeg();
        let url = super::validate::validate_url(&req.url)?;
        super::validate::resolves_public(&url)?;
        dirs.create().map_err(|e| ApiError::new(ErrorCode::DiskFull, format!("Non riesco a creare la cartella della libreria: {}", e)))?;
        let mut cmd = Command::new(ytdlp);
        cmd.env("PATH", tool_path());
        cmd.args(build_args(req, dirs, job_id, ffmpeg.as_deref())?).arg("--").arg(url.as_str())
            .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        let mut child = cmd.spawn().map_err(|e| ApiError::new(ErrorCode::YtdlpMissing, format!("Non riesco ad avviare yt-dlp: {}", e)))?;
        let stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || { for l in BufReader::new(stdout).lines().map_while(Result::ok) { if tx.send(l).is_err() { break; } } });
        let err_reader = std::thread::spawn(move || { let mut s = String::new(); let _ = stderr.read_to_string(&mut s); s });
        let mut meta_line: Option<String> = None;
        let mut killed = false;
        loop {
            if cancel.load(Ordering::SeqCst) && !killed { let _ = child.kill(); killed = true; }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(l) => {
                    if let Some(m) = l.strip_prefix("PMXF ") { meta_line = Some(m.to_string()); } else if let Some(ev) = parse_line(&l) { on(ev); }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let status = child.wait();
        let err = err_reader.join().unwrap_or_default();
        if killed || cancel.load(Ordering::SeqCst) { return Err(ApiError::new(ErrorCode::Cancelled, "Download annullato.")); }
        let ok = status.map(|s| s.success()).unwrap_or(false);
        let meta = match (ok, meta_line) {
            (true, Some(line)) => metadata::parse(&line, &dirs.root, &req.url, super::models::now_ms()),
            _ => None,
        };
        let meta = meta.ok_or_else(|| classify(&err))?;
        verify_file(&dirs.root.join(&meta.local_filename))?;
        Ok(meta)
    }
}

/// A file that is empty, or that ffprobe cannot read, is corrupt: it is deleted and the job fails.
pub fn verify_file(path: &Path) -> Result<(), ApiError> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let corrupt = || { let _ = std::fs::remove_file(path); ApiError::new(ErrorCode::CorruptFile, "Il file scaricato è danneggiato: riprova.") };
    if size == 0 { return Err(corrupt()); }
    if let Some(probe) = find_tool("ffprobe") {
        let out = Command::new(probe).args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(path).stdin(Stdio::null()).output();
        if let Ok(o) = out { if !o.status.success() { return Err(corrupt()); } }
    }
    Ok(())
}

/// Shared stop flag of a job.
pub type CancelFlag = Arc<AtomicBool>;

#[cfg(test)]
mod tests {
    use super::*;
    fn req(kind: Kind, quality: &str, format: Option<&str>) -> Request { Request { url: "https://www.youtube.com/watch?v=BaW_jenozKc".into(), kind, quality: quality.into(), format: format.map(|s| s.into()), playlist_id: None } }
    fn dirs() -> Dirs { Dirs::new(PathBuf::from("/lib")) }
    fn has(a: &[String], seq: &[&str]) -> bool { a.windows(seq.len()).any(|w| w.iter().zip(seq).all(|(x, y)| x == y)) }

    #[test]
    fn audio_mp3_is_bestaudio_extracted_at_192() {
        let a = build_args(&req(Kind::Audio, "best", Some("mp3")), &dirs(), "j1", Some(Path::new("/opt/homebrew/bin/ffmpeg"))).unwrap();
        assert!(has(&a, &["-f", "bestaudio/best"]));
        assert!(has(&a, &["-x", "--audio-format", "mp3", "--audio-quality", "192K"]));
        assert!(has(&a, &["-P", "home:/lib/music"]));
        assert!(has(&a, &["-P", "temp:/lib/temporary/j1"]));
        assert!(a.contains(&"--no-playlist".to_string()));
    }
    #[test]
    fn audio_conversion_without_ffmpeg_is_a_clear_error() {
        let e = build_args(&req(Kind::Audio, "best", Some("mp3")), &dirs(), "j", None).unwrap_err();
        assert_eq!(e.error_code, ErrorCode::FfmpegMissing);
        assert!(e.message.starts_with("FFmpeg non installato"));
        assert!(build_args(&req(Kind::Audio, "best", Some("best")), &dirs(), "j", None).is_ok()); // original format: no ffmpeg needed
    }
    #[test]
    fn video_quality_and_container() {
        let a = build_args(&req(Kind::Video, "720p", Some("mp4")), &dirs(), "j", Some(Path::new("/x/ffmpeg"))).unwrap();
        assert!(has(&a, &["-f", "bv*+ba/b", "-S", "res:720,ext:mp4:m4a", "--merge-output-format", "mp4"]));
        assert!(has(&a, &["-P", "home:/lib/video"]));
        let w = build_args(&req(Kind::Video, "best", Some("webm")), &dirs(), "j", None).unwrap();
        assert!(has(&w, &["-f", "b", "-S", "ext:webm:webm"]));
    }
    #[test]
    fn unsupported_requests() {
        assert_eq!(build_args(&req(Kind::Video, "4320", None), &dirs(), "j", None).unwrap_err().error_code, ErrorCode::UnsupportedFormat);
        assert_eq!(build_args(&req(Kind::Audio, "best", Some("wma")), &dirs(), "j", None).unwrap_err().error_code, ErrorCode::UnsupportedFormat);
        assert_eq!(build_args(&req(Kind::Video, "best", Some("avi")), &dirs(), "j", None).unwrap_err().error_code, ErrorCode::UnsupportedFormat);
    }
    #[test]
    fn progress_lines() {
        assert_eq!(parse_line("PMXP downloading|524288|1048576|NA|262144.5|2"), Some(Event::Progress { downloaded: 524288, total: Some(1048576), speed: Some(262144.5), eta: Some(2) }));
        assert_eq!(parse_line("PMXP downloading|100|NA|2000|NA|NA"), Some(Event::Progress { downloaded: 100, total: Some(2000), speed: None, eta: None }));
        assert_eq!(parse_line("PMXPP FFmpegExtractAudio|started"), Some(Event::Processing));
        assert_eq!(parse_line("[youtube] something"), None);
    }
    #[test]
    fn errors_have_codes_and_readable_words() {
        assert_eq!(classify("ERROR: [youtube] x: Video unavailable").error_code, ErrorCode::Unavailable);
        assert_eq!(classify("ERROR: [youtube] BaW_jenozKc: This video is unavailable").error_code, ErrorCode::Unavailable);
        assert_eq!(classify("ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>").error_code, ErrorCode::Network);
        assert_eq!(classify("OSError: [Errno 28] No space left on device").error_code, ErrorCode::DiskFull);
        assert_eq!(classify("ERROR: Postprocessing: Conversion failed!").error_code, ErrorCode::ConversionError);
        assert_eq!(classify("ERROR: Requested format is not available").error_code, ErrorCode::UnsupportedFormat);
        assert_eq!(classify("ERROR: unable to download video data: HTTP Error 403: Forbidden").error_code, ErrorCode::HttpError);
        assert_eq!(classify("ERROR: Unsupported URL: https://example.com").error_code, ErrorCode::InvalidUrl);
        assert_eq!(classify("ERROR: This video is DRM protected").error_code, ErrorCode::Unavailable);
        assert_eq!(classify("").error_code, ErrorCode::Unknown);
    }
    #[test]
    fn old_versions_are_spotted() {
        // 2026-11-15 00:00 UTC
        let now = 1_794_700_800_000;
        assert_eq!(version_age_days("2026.11.15", now), Some(0));
        assert_eq!(version_age_days("2026.10.26", now), Some(20));
        assert_eq!(version_age_days("2026.03.17", now), Some(243));
        assert_eq!(version_age_days("nightly", now), None);
    }
    #[test]
    fn forbidden_says_to_update() {
        let e = classify("ERROR: unable to download video data: HTTP Error 403: Forbidden");
        assert!(e.message.contains("yt-dlp è vecchio") && e.message.contains("Riprova"), "{}", e.message);
    }
    #[test]
    fn empty_file_is_corrupt() {
        let p = std::env::temp_dir().join(format!("pmx-empty-{}.mp3", std::process::id()));
        std::fs::write(&p, b"").unwrap();
        assert_eq!(verify_file(&p).unwrap_err().error_code, ErrorCode::CorruptFile);
        assert!(!p.exists());
    }
}
