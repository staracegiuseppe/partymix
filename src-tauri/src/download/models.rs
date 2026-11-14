//! Data of the download manager: requests, jobs, states and error codes (sent to the page as JSON).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Queued,
    Downloading,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    pub fn finished(self) -> bool { matches!(self, Status::Completed | Status::Failed | Status::Cancelled) }
    pub fn active(self) -> bool { matches!(self, Status::Downloading | Status::Processing) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Audio,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidUrl,
    Unavailable,
    UnsupportedFormat,
    FfmpegMissing,
    YtdlpMissing,
    DiskFull,
    Network,
    HttpError,
    ConversionError,
    Cancelled,
    CorruptFile,
    Duplicate,
    NotFound,
    Unknown,
}

/// An error as the page receives it: a code for the program, a sentence for the user.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error_code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self { ApiError { error_code: code, message: message.into() } }
}

fn default_kind() -> Kind { Kind::Audio }
fn default_quality() -> String { "best".into() }

/// What the page asks for: `{ "url": …, "type": "audio"|"video", "quality": "best"|"1080"…, "format": "mp3"…, "playlist_id": … }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub url: String,
    #[serde(rename = "type", default = "default_kind")]
    pub kind: Kind,
    #[serde(default = "default_quality")]
    pub quality: String,
    /// audio: mp3 | m4a | opus | best (as it comes, no conversion) · video: mp4 | webm
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub playlist_id: Option<String>,
}

/// What is known about the downloaded file (filled at the end).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    /// The picture's link on the source site.
    pub thumbnail: Option<String>,
    /// The picture saved in the library (path inside it).
    pub thumbnail_file: Option<String>,
    pub source_url: String,
    /// The id of the content on its site (e.g. the YouTube video id) and the site.
    pub content_id: Option<String>,
    pub extractor: Option<String>,
    pub original_filename: Option<String>,
    /// Path inside the library («music/Titolo [id].mp3»).
    pub local_filename: String,
    pub mime_type: String,
    pub file_size: u64,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub request: Request,
    pub status: Status,
    /// 0 … 100
    pub progress: f64,
    /// «4.2 MB/s»
    pub speed: Option<String>,
    /// seconds
    pub eta: Option<u64>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// File name shown while downloading (the title once known).
    pub filename: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub message: Option<String>,
    pub meta: Option<Meta>,
    pub created_at: u64,
    pub updated_at: u64,
    /// The same content was already downloaded: this is the earlier job, nothing was downloaded again.
    #[serde(default)]
    pub already: bool,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// «4.2 MB/s» from bytes per second.
pub fn human_speed(bps: f64) -> String {
    if bps >= 1_048_576.0 { format!("{:.1} MB/s", bps / 1_048_576.0) } else if bps >= 1024.0 { format!("{:.0} kB/s", bps / 1024.0) } else { format!("{:.0} B/s", bps) }
}
