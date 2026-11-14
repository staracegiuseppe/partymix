mod capture;
pub mod download;

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::{Manager, PhysicalPosition};

const PORT: u16 = 9527;

#[cfg(desktop)]
#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Vec<String> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| m.name().cloned().unwrap_or_else(|| format!("Schermo {}", i + 1)))
        .collect()
}

#[cfg(desktop)]
#[tauri::command]
async fn open_projector(app: tauri::AppHandle, display: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("projector") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().ok().flatten();
    // Chosen display, else the first one that is not the primary, else whatever exists.
    let target = display
        .as_ref()
        .and_then(|n| monitors.iter().find(|m| m.name() == Some(n)))
        .or_else(|| {
            monitors
                .iter()
                .find(|m| primary.as_ref().map(|p| p.position() != m.position()).unwrap_or(false))
        })
        .or(monitors.first());
    let url: Url = format!("http://localhost:{}/projector.html", PORT)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    let w = WebviewWindowBuilder::new(&app, "projector", WebviewUrl::External(url))
        .title("PartyMix Proiettore")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(m) = target {
        let p = m.position();
        let _ = w.set_position(PhysicalPosition::new(p.x + 40, p.y + 40));
        // Linux: on Wayland the compositor ignores where a window asks to go; GTK can still put it full screen on a chosen monitor.
        #[cfg(target_os = "linux")]
        if linux_fullscreen_on(&w, p.x, p.y, m.name().cloned()) {
            return Ok(());
        }
    }
    w.set_fullscreen(true).map_err(|e| e.to_string())
}

/// Full screen on the GDK monitor at that physical position (or with that name). False if none matches: the caller
/// then falls back to the plain full screen. GTK may only be touched on the main thread.
#[cfg(target_os = "linux")]
fn linux_fullscreen_on(w: &tauri::WebviewWindow, x: i32, y: i32, name: Option<String>) -> bool {
    use gtk::prelude::{GtkWindowExt, MonitorExt};
    let found = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let win = w.clone();
    let flag = found.clone();
    let queued = w.run_on_main_thread(move || {
        if let (Ok(gw), Some(display)) = (win.gtk_window(), gtk::gdk::Display::default()) {
            let index = (0..display.n_monitors()).find(|&i| {
                display.monitor(i).map_or(false, |m| {
                    let g = m.geometry();
                    let sf = m.scale_factor();
                    (g.x() * sf == x && g.y() * sf == y) || (name.is_some() && m.model().map(|s| s.to_string()) == name)
                })
            });
            if let Some(i) = index {
                gw.fullscreen_on_monitor(&GtkWindowExt::screen(&gw).unwrap_or_else(|| gtk::gdk::Screen::default().unwrap()), i);
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _ = done_tx.send(());
    });
    queued.is_ok() && done_rx.recv_timeout(std::time::Duration::from_secs(2)).is_ok() && found.load(std::sync::atomic::Ordering::SeqCst)
}

/// Pages the app may read for the Spotify import. Nothing else: this is not a general web proxy.
const READABLE_HOSTS: [&str; 3] = ["open.spotify.com", "www.youtube.com", "genius.com"];
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let u: Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    if u.scheme() != "https" || !u.host_str().map(|h| READABLE_HOSTS.contains(&h)).unwrap_or(false) {
        return Err("indirizzo non consentito".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(u)
        .header("Accept-Language", "it-IT,it;q=0.9,en;q=0.5")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("risposta {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

// --- Music library: the user's audio files in Music/PartyMix Library/<Artista>/<Titolo>.mp3 ---

fn library_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app.path().audio_dir().or_else(|_| app.path().app_data_dir()).map_err(|e| e.to_string())?;
    Ok(base.join("PartyMix Library"))
}

/// Only plain names inside the library folder: no "..", no absolute paths, no drive letters.
fn library_path(app: &tauri::AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    let p = std::path::Path::new(rel);
    if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("percorso non valido".into());
    }
    Ok(library_root(app)?.join(p))
}

/// Saves a file of the library. The body is the file; the header x-path the wanted place (URL-encoded).
/// Never overwrites: a second song with the same name becomes «Titolo (2).mp3». Returns the path actually used.
#[tauri::command]
fn lib_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("dati mancanti".into()) };
    let wanted = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("percorso mancante")?;
    let rel: String = url::form_urlencoded::parse(format!("p={}", wanted).as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default();
    let mut path = library_path(&app, &rel)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Brano").to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("mp3").to_string();
    let mut n = 2;
    while path.exists() {
        path.set_file_name(format!("{} ({}).{}", stem, n, ext));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let root = library_root(&app)?;
    Ok(path.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn lib_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = library_path(&app, &path)?;
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn lib_delete(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = library_path(&app, &path)?;
    match std::fs::remove_file(&p) {
        Ok(()) => {
            // an artist folder left empty goes too (only that one, only if empty)
            if let Some(dir) = p.parent() { let _ = std::fs::remove_dir(dir); }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn close_projector(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("projector") {
        let _ = w.close();
    }
}

// Phones and TVs have one screen and no second window: the projector stays inside the main view.
#[cfg(mobile)]
#[tauri::command]
fn list_displays() -> Vec<String> {
    Vec::new()
}

#[cfg(mobile)]
#[tauri::command]
async fn open_projector(_display: Option<String>) -> Result<(), String> {
    Err("il proiettore su un secondo schermo non c'è su Android".into())
}

#[cfg(mobile)]
#[tauri::command]
fn close_projector() {}

/** Where comments and suggestions arrive. The page cannot change it: it only chooses how the user sends. */
const FEEDBACK_TO: &str = "staracegiuseppe@gmail.com";

/** Percent-encodes everything except unreserved characters (spaces as %20, which mail apps show as spaces). */
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/** The message as a link: the user's own mail app, or Gmail / Outlook on the web. Always to FEEDBACK_TO. */
fn feedback_url(via: &str, subject: &str, body: &str) -> Option<String> {
    let subject: String = subject.chars().take(150).collect();
    let body: String = body.chars().take(1800).collect();
    let (s, b, to) = (enc(&subject), enc(&body), enc(FEEDBACK_TO));
    match via {
        "mail" => Some(format!("mailto:{}?subject={}&body={}", FEEDBACK_TO, s, b)),
        "gmail" => Some(format!("https://mail.google.com/mail/?view=cm&fs=1&to={}&su={}&body={}", to, s, b)),
        "outlook" => Some(format!("https://outlook.live.com/mail/0/deeplink/compose?to={}&subject={}&body={}", to, s, b)),
        _ => None,
    }
}

/** Opens a message to the author, written and sent by the user from their own mail account. */
#[tauri::command]
fn open_feedback(_app: tauri::AppHandle, via: String, subject: String, body: String) -> Result<(), String> {
    let url = feedback_url(&via, &subject, &body).ok_or("modo di invio sconosciuto")?;
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    // the URL goes as one argument, never through a shell
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "android")]
    let r: std::io::Result<()> = Err(std::io::Error::other("su Android l'invio passa dall'app"));
    // iPhone and iPad: Mail, or Safari for Gmail and Outlook, through UIApplication openURL
    #[cfg(target_os = "ios")]
    let r: std::io::Result<()> = {
        use tauri_plugin_opener::OpenerExt;
        _app.opener().open_url(&url, None::<&str>).map_err(std::io::Error::other)
    };
    r.map(|_| ()).map_err(|e| format!("non riesco ad aprire la posta: {}", e))
}

/** iPhone and iPad: iOS pauses web videos when the app leaves the screen, so while the music plays the screen stays on. */
#[tauri::command]
fn keep_awake(app: tauri::AppHandle, on: bool) {
    #[cfg(target_os = "ios")]
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2::{class, msg_send, runtime::{AnyObject, Bool}};
        let ui: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        let _: () = msg_send![ui, setIdleTimerDisabled: Bool::new(on)];
    });
    #[cfg(not(target_os = "ios"))]
    let _ = (app, on);
}

#[cfg(test)]
mod feedback_tests {
    use super::*;
    #[test]
    fn builds_links_only_to_the_author() {
        let m = feedback_url("mail", "Ciao è", "a b&c").unwrap();
        assert_eq!(m, "mailto:staracegiuseppe@gmail.com?subject=Ciao%20%C3%A8&body=a%20b%26c");
        assert!(feedback_url("gmail", "x", "y").unwrap().starts_with("https://mail.google.com/"));
        assert!(feedback_url("outlook", "x", "y").unwrap().contains("to=staracegiuseppe%40gmail.com"));
        assert!(feedback_url("javascript", "x", "y").is_none());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .manage(capture::CaptureState::default())
        .plugin(tauri_plugin_localhost::Builder::new(PORT).build())
        .invoke_handler(tauri::generate_handler![list_displays, open_projector, close_projector, http_get, capture::start_audio_capture, capture::stop_audio_capture, capture::ad_debug_log, capture::ad_debug_playlist, capture::ad_debug_spot, open_feedback, keep_awake, lib_write, lib_read, lib_delete, download::dl_create, download::dl_list, download::dl_get, download::dl_cancel, download::dl_remove, download::dl_config])
        .setup(|app| {
            // download manager: jobs in Music/PartyMix Library/metadata, started at once (interrupted downloads resume)
            match library_root(app.handle()) {
                Ok(root) => download::init(app.handle(), root),
                Err(e) => eprintln!("libreria non disponibile: {}", e),
            }
            let url: Url = format!("http://localhost:{}/index.html", PORT).parse().unwrap();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
            #[cfg(desktop)]
            let builder = builder.title("PartyMix").disable_drag_drop_handler().inner_size(1280.0, 800.0);
            let _window = builder.build()?;
            // iPhone and iPad: the page lays itself out edge to edge (viewport-fit=cover) and reads the safe areas
            // with env(); UIKit's automatic insets would push it down and leave env() at zero.
            #[cfg(target_os = "ios")]
            _window.with_webview(|w| unsafe {
                use objc2::{msg_send, runtime::AnyObject};
                let wk = w.inner() as *mut AnyObject;
                let scroll: *mut AnyObject = msg_send![wk, scrollView];
                let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize]; // .never
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("errore nell'avvio di PartyMix");
}
