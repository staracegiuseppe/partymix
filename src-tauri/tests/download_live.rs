//! Real downloads with the installed yt-dlp and ffmpeg (network needed): `cargo test --test download_live -- --ignored`.
//! Uses a short public test video.

use partymix_ai_lib::download::downloader::{Dirs, YtDlp};
use partymix_ai_lib::download::models::{ErrorCode, Job, Kind, Request, Status};
use partymix_ai_lib::download::queue::Manager;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn manager(tag: &str) -> (Manager, Dirs, Arc<Mutex<Vec<Job>>>) {
    let root = std::env::temp_dir().join(format!("pmx-live-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dirs = Dirs::new(root);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    (Manager::new(dirs.clone(), Arc::new(YtDlp), Arc::new(move |j: &Job| s2.lock().unwrap().push(j.clone())), 2, true), dirs, seen)
}
fn finish(m: &Manager, id: &str) -> Job {
    for _ in 0..1200 { let j = m.get(id).unwrap(); if j.status.finished() { return j; } std::thread::sleep(Duration::from_millis(100)); }
    panic!("timeout");
}
const URL: &str = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

#[test]
#[ignore]
fn audio_mp3_into_the_library() {
    let (m, dirs, seen) = manager("mp3");
    let j = m.create(Request { url: URL.into(), kind: Kind::Audio, quality: "best".into(), format: Some("mp3".into()), playlist_id: None }).unwrap();
    let done = finish(&m, &j.id);
    assert_eq!(done.status, Status::Completed, "{:?}", done.message);
    let meta = done.meta.unwrap();
    println!("{:#?}", meta);
    assert!(meta.local_filename.starts_with("music/") && meta.local_filename.ends_with(".mp3"));
    assert_eq!(meta.mime_type, "audio/mpeg");
    assert!(meta.file_size > 10_000);
    assert!(meta.duration.unwrap() > 5.0);
    assert_eq!(meta.content_id.as_deref(), Some("jNQXAC9IVRw"));
    assert!(dirs.root.join(&meta.local_filename).is_file());
    assert!(meta.thumbnail_file.map(|t| dirs.root.join(t).is_file()).unwrap_or(false), "thumbnail saved");
    assert!(std::fs::read_dir(dirs.temporary()).unwrap().next().is_none(), "no temporary files left");
    assert!(seen.lock().unwrap().iter().any(|x| x.status == Status::Downloading));
    // second request: already there
    let again = m.create(Request { url: "https://youtu.be/jNQXAC9IVRw".into(), kind: Kind::Audio, quality: "best".into(), format: Some("mp3".into()), playlist_id: None }).unwrap();
    assert!(again.already);
}

#[test]
#[ignore]
fn video_mp4_360p() {
    let (m, dirs, _) = manager("mp4");
    let j = m.create(Request { url: URL.into(), kind: Kind::Video, quality: "360p".into(), format: Some("mp4".into()), playlist_id: None }).unwrap();
    let done = finish(&m, &j.id);
    assert_eq!(done.status, Status::Completed, "{:?}", done.message);
    let meta = done.meta.unwrap();
    println!("{:#?}", meta);
    assert!(meta.local_filename.starts_with("video/") && meta.local_filename.ends_with(".mp4"));
    assert!(dirs.root.join(&meta.local_filename).is_file());
}

#[test]
#[ignore]
fn unavailable_video_is_a_readable_failure() {
    let (m, _, _) = manager("bad");
    let j = m.create(Request { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa".into(), kind: Kind::Audio, quality: "best".into(), format: Some("best".into()), playlist_id: None }).unwrap();
    let done = finish(&m, &j.id);
    println!("{:?} {:?}", done.error_code, done.message);
    assert_eq!(done.status, Status::Failed);
    assert_ne!(done.error_code, Some(ErrorCode::Unknown));
}
