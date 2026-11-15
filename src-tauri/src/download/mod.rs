//! PartyMix download manager (computer). The REST routes of the specification are Tauri commands here
//! (the app has no HTTP server: the page talks to the Rust side through IPC):
//!
//! | REST                               | command        |
//! |------------------------------------|----------------|
//! | POST   /api/download               | `dl_create`    |
//! | POST   /api/download (a list)      | `dl_create_many` |
//! | GET    /api/downloads              | `dl_list`      |
//! | GET    /api/downloads/{id}         | `dl_get`       |
//! | POST   /api/downloads/{id}/cancel  | `dl_cancel`    |
//! | DELETE /api/downloads/{id}         | `dl_remove`    |
//! | (settings, tools)                  | `dl_config`    |
//!
//! Every change of a job is pushed to the page as the event `download-update` (the Job as JSON).
//! The library itself (GET/DELETE /api/library) stays where it is, in the page (IndexedDB).

pub mod downloader;
pub mod metadata;
pub mod models;
pub mod queue;
pub mod validate;

use models::{ApiError, Job, Request};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager as _, State};

pub struct DlState(pub queue::Manager);

/// Starts the manager in the library folder (Music/PartyMix Library) and keeps it in the app state.
pub fn init(app: &tauri::AppHandle, root: std::path::PathBuf) {
    let handle = app.clone();
    let notify: queue::Notify = Arc::new(move |j: &Job| { let _ = handle.emit("download-update", j); });
    let m = queue::Manager::new(downloader::Dirs::new(root), Arc::new(downloader::YtDlp), notify, queue::DEFAULT_MAX, true);
    app.manage(DlState(m));
}

#[tauri::command]
pub fn dl_create(state: State<'_, DlState>, request: Request) -> Result<Job, ApiError> { state.0.create(request) }
/// One result per request: the job, or the error for that link.
#[derive(Serialize)]
pub struct Many { pub jobs: Vec<Option<Job>>, pub errors: Vec<Option<ApiError>> }

/// POST /api/download with a list («Scarica tutta la playlist»).
#[tauri::command]
pub fn dl_create_many(state: State<'_, DlState>, requests: Vec<Request>) -> Many {
    let mut m = Many { jobs: Vec::new(), errors: Vec::new() };
    for r in state.0.create_many(requests) {
        match r { Ok(j) => { m.jobs.push(Some(j)); m.errors.push(None); } Err(e) => { m.jobs.push(None); m.errors.push(Some(e)); } }
    }
    m
}
#[tauri::command]
pub fn dl_list(state: State<'_, DlState>) -> Vec<Job> { state.0.list() }
#[tauri::command]
pub fn dl_get(state: State<'_, DlState>, id: String) -> Result<Job, ApiError> { state.0.get(&id) }
#[tauri::command]
pub fn dl_cancel(state: State<'_, DlState>, id: String) -> Result<Job, ApiError> { state.0.cancel(&id) }
#[tauri::command]
pub fn dl_remove(state: State<'_, DlState>, id: String) -> Result<(), ApiError> { state.0.remove(&id) }

#[derive(Serialize)]
pub struct Config {
    pub max: usize,
    pub ytdlp: bool,
    pub ffmpeg: bool,
    pub root: String,
    /// «2026.10.26»
    pub ytdlp_version: Option<String>,
    /// Days since that version: over ~60, YouTube downloads usually start failing.
    pub ytdlp_age_days: Option<u64>,
    /// The command that updates it («brew upgrade yt-dlp»).
    pub update_hint: String,
}

/// Reads (and with `max` changes) how many downloads run together; says whether yt-dlp and FFmpeg are installed.
#[tauri::command]
pub fn dl_config(state: State<'_, DlState>, max: Option<usize>) -> Config {
    let m = match max { Some(n) => state.0.set_max(n), None => state.0.max() };
    let version = downloader::ytdlp_version();
    let age = version.as_deref().and_then(|v| downloader::version_age_days(v, models::now_ms()));
    Config { max: m, ytdlp: downloader::check_ytdlp().is_some(), ffmpeg: downloader::check_ffmpeg().is_some(), root: state.0.dirs().root.display().to_string(),
        ytdlp_version: version, ytdlp_age_days: age, update_hint: downloader::update_hint().into() }
}
