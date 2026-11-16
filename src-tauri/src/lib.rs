mod capture;
pub mod download;

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::Manager;

const PORT: u16 = 9527;

/// A screen as the user sees it: `key` is the system's id (kept in the settings), `label` a readable name
/// («Mi TV · 1360×768», «Schermo del computer (principale) · 1440×900»).
#[derive(serde::Serialize, Clone)]
struct DisplayInfo {
    key: String,
    label: String,
}

/// The names macOS gives the screens (NSScreen.localizedName) with their position and size in points, to put a
/// real name on the monitors (the window library only knows «Monitor #257»). Other systems: none, names come from there.
#[cfg(desktop)]
fn system_screen_names() -> Vec<(f64, f64, f64, String)> {
    #[cfg(target_os = "macos")]
    {
        let js = "ObjC.import('AppKit'); var a = $.NSScreen.screens, o = []; for (var i = 0; i < a.count; i++) { var s = a.objectAtIndex(i), f = s.frame; o.push([f.origin.x, f.size.width, f.size.height, ObjC.unwrap(s.localizedName) || ''].join('\\t')); } o.join('\\n')";
        if let Ok(out) = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", js]).output() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|l| {
                    let f: Vec<&str> = l.split('\t').collect();
                    if f.len() < 4 { return None; }
                    Some((f[0].parse().ok()?, f[1].parse().ok()?, f[2].parse().ok()?, f[3].trim().to_string()))
                })
                .collect();
        }
    }
    Vec::new()
}

#[cfg(desktop)]
fn display_list(app: &tauri::AppHandle) -> Vec<(DisplayInfo, tauri::Monitor)> {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten().map(|p| *p.position());
    let names = system_screen_names();
    monitors
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let sf = m.scale_factor();
            let lp = m.position().to_logical::<f64>(sf);
            let ls = m.size().to_logical::<f64>(sf);
            let raw = m.name().cloned().unwrap_or_default();
            let sys = names
                .iter()
                .find(|n| (n.0 - lp.x).abs() < 2.0 && (n.1 - ls.width).abs() < 2.0 && (n.2 - ls.height).abs() < 2.0)
                .map(|n| n.3.clone())
                .filter(|n| !n.is_empty());
            let generic = raw.is_empty() || raw.starts_with("Monitor #") || raw.starts_with("\\\\.\\");
            let mut base = sys.unwrap_or_else(|| if generic { format!("Schermo {}", i + 1) } else { raw.clone() });
            if base.starts_with("Built-in") || base.to_lowercase().contains("integrat") || base.contains("Color LCD") {
                base = "Schermo del computer".into();
            }
            let is_primary = primary.map(|p| p == *m.position()).unwrap_or(i == 0);
            let label = format!("{}{} · {}×{}", base, if is_primary { " (principale)" } else { "" }, ls.width.round() as i64, ls.height.round() as i64);
            let key = if raw.is_empty() { format!("#{}", i + 1) } else { raw };
            (DisplayInfo { key, label }, m)
        })
        .collect()
}

#[cfg(desktop)]
#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Vec<DisplayInfo> {
    display_list(&app).into_iter().map(|(d, _)| d).collect()
}

#[cfg(desktop)]
#[tauri::command]
async fn open_projector(app: tauri::AppHandle, display: Option<String>, label: Option<String>) -> Result<(), String> {
    let list = display_list(&app);
    let primary = app.primary_monitor().ok().flatten();
    // The screen chosen (by its id; if the id changed — cable unplugged and back — by its name), else the first
    // one that is not the primary, else whatever exists.
    let name_of = |l: &str| l.split(" · ").next().unwrap_or("").replace(" (principale)", "");
    let target = display
        .as_ref()
        .and_then(|k| list.iter().find(|(d, _)| &d.key == k))
        .or_else(|| label.as_ref().and_then(|l| list.iter().find(|(d, _)| d.label == *l || name_of(&d.label) == name_of(l))))
        .or_else(|| list.iter().find(|(_, m)| primary.as_ref().map(|p| p.position() != m.position()).unwrap_or(false)))
        .or(list.first())
        .map(|(_, m)| m.clone());
    // Where to put the window, in LOGICAL points of the target screen. Screens can have different densities
    // (a Retina laptop at 2x and a TV at 1x): a physical position read on one screen and applied with another
    // screen's scale lands in the wrong place — the projector stayed on the main screen.
    let spot = target.as_ref().map(|m| {
        let p = m.position().to_logical::<f64>(m.scale_factor());
        (p.x + 40.0, p.y + 40.0)
    });
    if let Some(w) = app.get_webview_window("projector") {
        // already open: move it to the screen chosen now (out of full screen first, or macOS keeps it where it is)
        if let Some((x, y)) = spot {
            let _ = w.set_fullscreen(false);
            std::thread::sleep(std::time::Duration::from_millis(350));
            let _ = w.set_position(tauri::LogicalPosition::new(x, y));
            fullscreen_soon(w.clone(), target.clone());
        }
        return w.set_focus().map_err(|e| e.to_string());
    }
    let url: Url = format!("http://localhost:{}/projector.html", PORT)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    let mut b = WebviewWindowBuilder::new(&app, "projector", WebviewUrl::External(url))
        .title("PartyMix Proiettore")
        .inner_size(1280.0, 720.0);
    if let Some((x, y)) = spot {
        b = b.position(x, y); // born on the chosen screen
    }
    let w = b.build().map_err(|e| e.to_string())?;
    if let Some((x, y)) = spot {
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
    fullscreen_soon(w, target);
    Ok(())
}

/// Full screen once the window really is on its screen (macOS goes full screen on the screen the window is on
/// at that moment, and a move is applied asynchronously).
fn fullscreen_soon(w: tauri::WebviewWindow, target: Option<tauri::Monitor>) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        // Linux: on Wayland the compositor ignores where a window asks to go; GTK can still put it full screen on a chosen monitor.
        #[cfg(target_os = "linux")]
        if let Some(m) = &target {
            let p = m.position();
            if linux_fullscreen_on(&w, p.x, p.y, m.name().cloned()) {
                return;
            }
        }
        let _ = &target;
        // no windows to resize on a phone: full screen is a desktop call
        #[cfg(desktop)]
        let _ = w.set_fullscreen(true);
        #[cfg(mobile)]
        let _ = &w;
    });
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

/// Where the library folder is (absolute), so the page can stream its files (asset protocol) instead of reading them whole.
#[tauri::command]
fn lib_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(library_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn lib_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = library_path(&app, &path)?;
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The computer's accent colour («#007AFF»), so the app takes the same colours as the system. None = not known.
#[tauri::command]
fn system_accent() -> Option<String> {
    let run = |cmd: &str, args: &[&str]| -> Option<String> {
        let o = std::process::Command::new(cmd).args(args).stdin(std::process::Stdio::null()).output().ok()?;
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    #[cfg(target_os = "macos")]
    {
        // missing key = the default (multicolour → blue); -1 graphite, 0 red … 6 pink
        let v = run("defaults", &["read", "-g", "AppleAccentColor"]).and_then(|x| x.parse::<i32>().ok()).unwrap_or(4);
        let hex = match v { -1 => "#8C8C8C", 0 => "#FF5257", 1 => "#F7821B", 2 => "#FFC600", 3 => "#62BA46", 5 => "#A550A7", 6 => "#F74F9E", _ => "#007AFF" };
        return Some(hex.into());
    }
    #[cfg(target_os = "windows")]
    {
        let out = run("reg", &["query", r"HKCU\Software\Microsoft\Windows\DWM", "/v", "AccentColor"])?;
        let word = out.split_whitespace().find(|w| w.starts_with("0x"))?;
        let v = u32::from_str_radix(word.trim_start_matches("0x"), 16).ok()?; // 0xAABBGGRR
        return Some(format!("#{:02X}{:02X}{:02X}", v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff));
    }
    #[cfg(target_os = "linux")]
    {
        let name = run("gsettings", &["get", "org.gnome.desktop.interface", "accent-color"])?.trim_matches('\'').to_string();
        let hex = match name.as_str() { "teal" => "#2190A4", "green" => "#3A944A", "yellow" => "#C88800", "orange" => "#ED5B00", "red" => "#E62D42", "pink" => "#D56199", "purple" => "#9141AC", "slate" => "#6F8396", "blue" => "#3584E4", _ => return None };
        return Some(hex.into());
    }
    #[allow(unreachable_code)]
    { let _ = run; None }
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
fn list_displays() -> Vec<DisplayInfo> {
    Vec::new()
}

#[cfg(mobile)]
#[tauri::command]
async fn open_projector(_display: Option<String>, _label: Option<String>) -> Result<(), String> {
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
        .invoke_handler(tauri::generate_handler![list_displays, open_projector, close_projector, http_get, capture::start_audio_capture, capture::stop_audio_capture, capture::ad_debug_log, capture::ad_debug_playlist, capture::ad_debug_spot, open_feedback, keep_awake, lib_write, lib_read, lib_root, lib_delete, download::dl_create, download::dl_create_many, download::dl_list, download::dl_get, download::dl_cancel, download::dl_remove, download::dl_config, system_accent])
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
