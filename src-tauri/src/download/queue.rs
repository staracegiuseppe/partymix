//! The download manager: a queue of jobs run in the background, at most `max` at a time (default 2),
//! saved in metadata/jobs.json so a restart loses nothing.
//!
//! After a restart a job that was downloading goes back in the queue and starts again: yt-dlp continues the
//! partial file kept in the job's temporary folder (`--continue`), where the source allows it; otherwise it starts over.

use super::downloader::{CancelFlag, Dirs, Event, Runner};
use super::models::{human_speed, now_ms, ApiError, ErrorCode, Job, Request, Status};
use super::validate::{content_key, validate_url};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type Notify = Arc<dyn Fn(&Job) + Send + Sync>;
pub const DEFAULT_MAX: usize = 2;

struct State {
    jobs: Vec<Job>,
    max: usize,
    active: usize,
    cancels: HashMap<String, CancelFlag>,
}

struct Inner {
    state: Mutex<State>,
    runner: Arc<dyn Runner>,
    dirs: Dirs,
    notify: Notify,
    /// Tests run without writing jobs.json when false.
    persist: bool,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

static SEQ: AtomicU64 = AtomicU64::new(0);
fn new_id() -> String { format!("{:x}{:04x}", now_ms(), SEQ.fetch_add(1, Ordering::SeqCst) & 0xffff) }

fn key_of(req: &Request) -> String {
    let base = validate_url(&req.url).map(|u| content_key(&u)).unwrap_or_else(|_| req.url.clone());
    format!("{}|{:?}|{}", base, req.kind, req.format.clone().unwrap_or_default().to_ascii_lowercase())
}

impl Manager {
    /// Loads the saved jobs (a job interrupted by closing the app goes back in the queue) and starts the queue.
    pub fn new(dirs: Dirs, runner: Arc<dyn Runner>, notify: Notify, max: usize, persist: bool) -> Self {
        let mut jobs: Vec<Job> = if persist {
            std::fs::read_to_string(dirs.metadata().join("jobs.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
        } else { Vec::new() };
        for j in jobs.iter_mut() {
            if j.status.active() {
                j.status = Status::Queued;
                j.speed = None;
                j.eta = None;
                j.message = Some("Ripreso dopo il riavvio dell’app.".into());
            }
        }
        let m = Manager { inner: Arc::new(Inner { state: Mutex::new(State { jobs, max: max.clamp(1, 8), active: 0, cancels: HashMap::new() }), runner, dirs, notify, persist }) };
        m.save();
        pump(&m.inner);
        m
    }

    fn save(&self) { save(&self.inner); }

    /// POST /api/download: creates a job and returns at once; the download runs in the background.
    /// The same content already downloaded (file still there) is not downloaded again: the earlier job comes back with `already`.
    pub fn create(&self, req: Request) -> Result<Job, ApiError> {
        let url = validate_url(&req.url)?;
        let mut req = req;
        req.url = url.to_string();
        super::downloader::build_args(&req, &self.inner.dirs, "check", Some(std::path::Path::new("ffmpeg")))?; // format and quality are valid
        let key = key_of(&req);
        let job = {
            let mut st = self.inner.state.lock().unwrap();
            if let Some(j) = st.jobs.iter().find(|j| key_of(&j.request) == key && !matches!(j.status, Status::Failed | Status::Cancelled)) {
                let file_ok = j.meta.as_ref().map(|m| self.inner.dirs.root.join(&m.local_filename).is_file()).unwrap_or(false);
                if j.status != Status::Completed || file_ok {
                    let mut out = j.clone();
                    out.already = j.status == Status::Completed;
                    return Ok(out);
                }
            }
            let t = now_ms();
            let job = Job { id: new_id(), request: req, status: Status::Queued, progress: 0.0, speed: None, eta: None, downloaded_bytes: 0, total_bytes: None,
                filename: None, error_code: None, message: None, meta: None, created_at: t, updated_at: t, already: false };
            st.jobs.push(job.clone());
            job
        };
        self.save();
        (self.inner.notify)(&job);
        pump(&self.inner);
        Ok(self.get(&job.id).unwrap_or(job))
    }

    /// GET /api/downloads
    pub fn list(&self) -> Vec<Job> { self.inner.state.lock().unwrap().jobs.clone() }

    /// GET /api/downloads/{id}
    pub fn get(&self, id: &str) -> Result<Job, ApiError> {
        self.inner.state.lock().unwrap().jobs.iter().find(|j| j.id == id).cloned().ok_or_else(|| ApiError::new(ErrorCode::NotFound, "Download non trovato."))
    }

    /// POST /api/downloads/{id}/cancel: a waiting job is cancelled at once, a running one as soon as yt-dlp stops.
    pub fn cancel(&self, id: &str) -> Result<Job, ApiError> {
        let job = {
            let mut st = self.inner.state.lock().unwrap();
            let flag = st.cancels.get(id).cloned();
            let j = st.jobs.iter_mut().find(|j| j.id == id).ok_or_else(|| ApiError::new(ErrorCode::NotFound, "Download non trovato."))?;
            if j.status == Status::Queued {
                j.status = Status::Cancelled;
                j.error_code = Some(ErrorCode::Cancelled);
                j.message = Some("Download annullato.".into());
                j.updated_at = now_ms();
            } else if let Some(f) = flag {
                f.store(true, Ordering::SeqCst);
            }
            j.clone()
        };
        self.save();
        (self.inner.notify)(&job);
        Ok(job)
    }

    /// DELETE /api/downloads/{id}: removes the job from the list (stopping it first). The library file is not touched.
    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        {
            let mut st = self.inner.state.lock().unwrap();
            if let Some(f) = st.cancels.get(id) { f.store(true, Ordering::SeqCst); }
            let n = st.jobs.len();
            st.jobs.retain(|j| j.id != id);
            if st.jobs.len() == n { return Err(ApiError::new(ErrorCode::NotFound, "Download non trovato.")); }
        }
        let _ = std::fs::remove_dir_all(self.inner.dirs.job_temp(id));
        self.save();
        Ok(())
    }

    /// How many downloads run together (1…8).
    pub fn set_max(&self, n: usize) -> usize {
        let v = n.clamp(1, 8);
        self.inner.state.lock().unwrap().max = v;
        pump(&self.inner);
        v
    }
    pub fn max(&self) -> usize { self.inner.state.lock().unwrap().max }
    pub fn dirs(&self) -> &Dirs { &self.inner.dirs }
}

fn save(inner: &Inner) {
    if !inner.persist { return; }
    let jobs = inner.state.lock().unwrap().jobs.clone();
    let dir = inner.dirs.metadata();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    if let Ok(s) = serde_json::to_string_pretty(&jobs) {
        let tmp = dir.join("jobs.json.tmp");
        if std::fs::write(&tmp, s).is_ok() { let _ = std::fs::rename(&tmp, dir.join("jobs.json")); }
    }
}

/// Starts waiting jobs while there is room.
fn pump(inner: &Arc<Inner>) {
    loop {
        let picked = {
            let mut st = inner.state.lock().unwrap();
            if st.active >= st.max { return; }
            let Some(j) = st.jobs.iter_mut().find(|j| j.status == Status::Queued) else { return };
            j.status = Status::Downloading;
            j.updated_at = now_ms();
            j.error_code = None;
            let job = j.clone();
            let flag: CancelFlag = Arc::new(AtomicBool::new(false));
            st.cancels.insert(job.id.clone(), flag.clone());
            st.active += 1;
            (job, flag)
        };
        let (job, flag) = picked;
        save(inner);
        (inner.notify)(&job);
        let inner2 = inner.clone();
        std::thread::spawn(move || work(inner2, job, flag));
    }
}

fn update(inner: &Inner, id: &str, f: impl FnOnce(&mut Job)) -> Option<Job> {
    let mut st = inner.state.lock().unwrap();
    let j = st.jobs.iter_mut().find(|j| j.id == id)?;
    f(j);
    j.updated_at = now_ms();
    Some(j.clone())
}

fn work(inner: Arc<Inner>, job: Job, flag: CancelFlag) {
    let mut last = Instant::now() - Duration::from_secs(1);
    let res = {
        let inner = inner.clone();
        let id = job.id.clone();
        inner.runner.run(&job.id, &job.request, &inner.dirs, &flag, &mut |ev| {
            let processing = ev == Event::Processing;
            let j = update(&inner, &id, |j| match ev {
                Event::Progress { downloaded, total, speed, eta } => {
                    j.downloaded_bytes = downloaded;
                    j.total_bytes = total;
                    j.progress = total.filter(|t| *t > 0).map(|t| (downloaded as f64 / t as f64 * 100.0).min(100.0)).unwrap_or(j.progress);
                    j.speed = speed.map(human_speed);
                    j.eta = eta;
                }
                Event::Processing => { j.status = Status::Processing; j.speed = None; j.eta = Some(0); }
            });
            // progress at most 4 times a second, a change of state at once
            if let Some(j) = j { if processing || last.elapsed() >= Duration::from_millis(250) { last = Instant::now(); (inner.notify)(&j); } }
        })
    };
    let _ = std::fs::remove_dir_all(inner.dirs.job_temp(&job.id)); // no .part files left behind
    let done = {
        let j = update(&inner, &job.id, |j| {
            j.speed = None;
            j.eta = None;
            match res {
                Ok(meta) => {
                    j.status = Status::Completed;
                    j.progress = 100.0;
                    j.filename = Some(meta.local_filename.rsplit('/').next().unwrap_or("").to_string());
                    j.total_bytes = Some(meta.file_size);
                    j.downloaded_bytes = meta.file_size;
                    j.message = Some("✓ Download completato".into());
                    j.error_code = None;
                    j.meta = Some(meta);
                }
                Err(e) => {
                    j.status = if e.error_code == ErrorCode::Cancelled { Status::Cancelled } else { Status::Failed };
                    j.error_code = Some(e.error_code);
                    j.message = Some(e.message);
                }
            }
        });
        let mut st = inner.state.lock().unwrap();
        st.active -= 1;
        st.cancels.remove(&job.id);
        j
    };
    save(&inner);
    if let Some(j) = done { (inner.notify)(&j); }
    pump(&inner);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::models::{Kind, Meta};
    use std::sync::atomic::AtomicUsize;

    /// A downloader that waits for `go`, reports two progress steps and returns a file (or the error asked).
    struct Fake { running: AtomicUsize, peak: AtomicUsize, go: AtomicBool, fail: Mutex<Option<ApiError>> }
    impl Fake { fn new() -> Arc<Self> { Arc::new(Fake { running: AtomicUsize::new(0), peak: AtomicUsize::new(0), go: AtomicBool::new(false), fail: Mutex::new(None) }) } }
    impl Runner for Fake {
        fn run(&self, job_id: &str, req: &Request, dirs: &Dirs, cancel: &AtomicBool, on: &mut dyn FnMut(Event)) -> Result<Meta, ApiError> {
            let n = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(n, Ordering::SeqCst);
            let _ = std::fs::create_dir_all(dirs.job_temp(job_id));
            std::fs::write(dirs.job_temp(job_id).join("x.part"), b"part").unwrap();
            on(Event::Progress { downloaded: 50, total: Some(100), speed: Some(2_000_000.0), eta: Some(3) });
            while !self.go.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) { self.running.fetch_sub(1, Ordering::SeqCst); return Err(ApiError::new(ErrorCode::Cancelled, "Download annullato.")); }
                std::thread::sleep(Duration::from_millis(5));
            }
            on(Event::Processing);
            self.running.fetch_sub(1, Ordering::SeqCst);
            if let Some(e) = self.fail.lock().unwrap().clone() { return Err(e); }
            let rel = format!("music/{}.mp3", job_id);
            std::fs::create_dir_all(dirs.music()).unwrap();
            std::fs::write(dirs.root.join(&rel), b"ID3data").unwrap();
            Ok(Meta { title: format!("Song {}", &req.url[req.url.len() - 3..]), local_filename: rel, file_size: 7, mime_type: "audio/mpeg".into(), source_url: req.url.clone(), ..Default::default() })
        }
    }
    fn dir() -> Dirs { let d = std::env::temp_dir().join(format!("pmx-q-{}", new_id())); Dirs::new(d) }
    fn req(i: u32) -> Request { Request { url: format!("https://example.com/song{:03}", i), kind: Kind::Audio, quality: "best".into(), format: Some("mp3".into()), playlist_id: None } }
    fn wait(m: &Manager, id: &str, s: Status) -> Job {
        for _ in 0..400 { let j = m.get(id).unwrap(); if j.status == s { return j; } std::thread::sleep(Duration::from_millis(5)); }
        panic!("{} never reached {:?}: {:?}", id, s, m.get(id).unwrap().status);
    }
    fn mk(fake: &Arc<Fake>, persist: bool, d: &Dirs) -> (Manager, Arc<Mutex<Vec<Job>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        (Manager::new(d.clone(), fake.clone(), Arc::new(move |j: &Job| s2.lock().unwrap().push(j.clone())), DEFAULT_MAX, persist), seen)
    }

    #[test]
    fn one_download_goes_from_queued_to_completed_with_progress() {
        let fake = Fake::new();
        let d = dir();
        let (m, seen) = mk(&fake, false, &d);
        let j = m.create(req(1)).unwrap();
        assert_eq!(j.id.len() > 4, true);
        let j1 = wait(&m, &j.id, Status::Downloading);
        std::thread::sleep(Duration::from_millis(20));
        let p = m.get(&j1.id).unwrap();
        assert_eq!(p.progress, 50.0);
        assert_eq!(p.speed.as_deref(), Some("1.9 MB/s"));
        assert_eq!(p.eta, Some(3));
        fake.go.store(true, Ordering::SeqCst);
        let done = wait(&m, &j.id, Status::Completed);
        assert_eq!(done.progress, 100.0);
        assert_eq!(done.meta.unwrap().local_filename, format!("music/{}.mp3", j.id));
        assert!(!d.job_temp(&j.id).exists(), "temporary files must be removed");
        let states: Vec<Status> = seen.lock().unwrap().iter().filter(|x| x.id == j.id).map(|x| x.status).collect();
        assert!(states.contains(&Status::Queued) && states.contains(&Status::Downloading) && states.contains(&Status::Processing) && states.contains(&Status::Completed));
        let _ = std::fs::remove_dir_all(&d.root);
    }

    #[test]
    fn several_downloads_respect_the_limit_of_two() {
        let fake = Fake::new();
        let d = dir();
        let (m, _) = mk(&fake, false, &d);
        let ids: Vec<String> = (0..5).map(|i| m.create(req(i)).unwrap().id).collect();
        std::thread::sleep(Duration::from_millis(60));
        let st: Vec<Status> = ids.iter().map(|i| m.get(i).unwrap().status).collect();
        assert_eq!(st.iter().filter(|s| **s == Status::Downloading).count(), 2);
        assert_eq!(st.iter().filter(|s| **s == Status::Queued).count(), 3);
        fake.go.store(true, Ordering::SeqCst);
        for i in &ids { wait(&m, i, Status::Completed); }
        assert_eq!(fake.peak.load(Ordering::SeqCst), 2);
        let _ = std::fs::remove_dir_all(&d.root);
    }

    #[test]
    fn the_limit_can_be_changed() {
        let fake = Fake::new();
        let d = dir();
        let (m, _) = mk(&fake, false, &d);
        let ids: Vec<String> = (0..4).map(|i| m.create(req(i)).unwrap().id).collect();
        assert_eq!(m.set_max(3), 3);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(ids.iter().filter(|i| m.get(i).unwrap().status == Status::Downloading).count(), 3);
        assert_eq!(m.set_max(50), 8);
        fake.go.store(true, Ordering::SeqCst);
        for i in &ids { wait(&m, i, Status::Completed); }
    }

    #[test]
    fn cancel_a_running_and_a_waiting_download() {
        let fake = Fake::new();
        let d = dir();
        let (m, _) = mk(&fake, false, &d);
        let a = m.create(req(1)).unwrap().id;
        let b = m.create(req(2)).unwrap().id;
        let c = m.create(req(3)).unwrap().id;
        wait(&m, &a, Status::Downloading);
        assert_eq!(m.cancel(&c).unwrap().status, Status::Cancelled); // was waiting
        m.cancel(&a).unwrap();
        let ca = wait(&m, &a, Status::Cancelled);
        assert_eq!(ca.error_code, Some(ErrorCode::Cancelled));
        assert!(!d.job_temp(&a).exists());
        fake.go.store(true, Ordering::SeqCst);
        wait(&m, &b, Status::Completed);
        assert_eq!(m.get(&c).unwrap().status, Status::Cancelled);
        assert_eq!(m.cancel("nope").unwrap_err().error_code, ErrorCode::NotFound);
    }

    #[test]
    fn errors_are_kept_with_code_and_message() {
        let fake = Fake::new();
        *fake.fail.lock().unwrap() = Some(ApiError::new(ErrorCode::Network, "Connessione interrotta o assente: riprova quando la rete funziona."));
        fake.go.store(true, Ordering::SeqCst);
        let d = dir();
        let (m, _) = mk(&fake, false, &d);
        let j = wait(&m, &m.create(req(1)).unwrap().id, Status::Failed);
        assert_eq!(j.error_code, Some(ErrorCode::Network));
        assert!(j.message.unwrap().contains("Connessione"));
    }

    #[test]
    fn the_same_content_is_not_downloaded_twice() {
        let fake = Fake::new();
        fake.go.store(true, Ordering::SeqCst);
        let d = dir();
        let (m, _) = mk(&fake, false, &d);
        let yt = |u: &str| Request { url: u.into(), kind: Kind::Audio, quality: "best".into(), format: Some("mp3".into()), playlist_id: None };
        let a = m.create(yt("https://www.youtube.com/watch?v=BaW_jenozKc")).unwrap();
        wait(&m, &a.id, Status::Completed);
        let b = m.create(yt("https://youtu.be/BaW_jenozKc?si=abc")).unwrap();
        assert_eq!(b.id, a.id);
        assert!(b.already);
        assert_eq!(m.list().len(), 1);
        // a different format is a different file
        let c = m.create(Request { format: Some("m4a".into()), ..yt("https://youtu.be/BaW_jenozKc") }).unwrap();
        assert_ne!(c.id, a.id);
        // file deleted from the library: downloaded again
        let rel = m.get(&a.id).unwrap().meta.unwrap().local_filename;
        std::fs::remove_file(d.root.join(rel)).unwrap();
        let e = m.create(yt("https://www.youtube.com/watch?v=BaW_jenozKc")).unwrap();
        assert_ne!(e.id, a.id);
        assert!(!e.already);
        let _ = std::fs::remove_dir_all(&d.root);
    }

    #[test]
    fn invalid_requests_are_refused_before_the_queue() {
        let fake = Fake::new();
        let (m, _) = mk(&fake, false, &dir());
        assert_eq!(m.create(Request { url: "file:///etc/passwd".into(), ..req(1) }).unwrap_err().error_code, ErrorCode::InvalidUrl);
        assert_eq!(m.create(Request { url: "http://192.168.1.1/x".into(), ..req(1) }).unwrap_err().error_code, ErrorCode::InvalidUrl);
        assert_eq!(m.create(Request { quality: "8k".into(), ..req(1) }).unwrap_err().error_code, ErrorCode::UnsupportedFormat);
        assert!(m.list().is_empty());
    }

    #[test]
    fn delete_removes_the_job() {
        let fake = Fake::new();
        fake.go.store(true, Ordering::SeqCst);
        let (m, _) = mk(&fake, false, &dir());
        let a = m.create(req(1)).unwrap().id;
        wait(&m, &a, Status::Completed);
        m.remove(&a).unwrap();
        assert!(m.list().is_empty());
        assert_eq!(m.remove(&a).unwrap_err().error_code, ErrorCode::NotFound);
    }

    #[test]
    fn a_restart_keeps_finished_jobs_and_resumes_interrupted_ones() {
        let fake = Fake::new();
        let d = dir();
        {
            let (m, _) = mk(&fake, true, &d);
            let a = m.create(req(1)).unwrap().id;
            fake.go.store(true, Ordering::SeqCst);
            wait(&m, &a, Status::Completed);
            fake.go.store(false, Ordering::SeqCst);
            let b = m.create(req(2)).unwrap().id;
            wait(&m, &b, Status::Downloading);
            // the app closes here: jobs.json says «downloading»
        }
        let saved: Vec<Job> = serde_json::from_str(&std::fs::read_to_string(d.metadata().join("jobs.json")).unwrap()).unwrap();
        assert_eq!(saved.len(), 2);
        let fake2 = Fake::new();
        fake2.go.store(true, Ordering::SeqCst);
        let (m2, _) = mk(&fake2, true, &d);
        let jobs = m2.list();
        assert_eq!(jobs[0].status, Status::Completed);
        let b = &jobs[1];
        assert_eq!(wait(&m2, &b.id, Status::Completed).status, Status::Completed);
        let _ = std::fs::remove_dir_all(&d.root);
    }
}
