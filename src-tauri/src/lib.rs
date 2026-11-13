mod capture;

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
    }
    w.set_fullscreen(true).map_err(|e| e.to_string())
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
fn open_feedback(via: String, subject: String, body: String) -> Result<(), String> {
    let url = feedback_url(&via, &subject, &body).ok_or("modo di invio sconosciuto")?;
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    // the URL goes as one argument, never through a shell
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "android")]
    let r: std::io::Result<()> = Err(std::io::Error::other("su Android l'invio passa dall'app"));
    r.map(|_| ()).map_err(|e| format!("non riesco ad aprire la posta: {}", e))
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
    tauri::Builder::default()
        .manage(capture::CaptureState::default())
        .plugin(tauri_plugin_localhost::Builder::new(PORT).build())
        .invoke_handler(tauri::generate_handler![list_displays, open_projector, close_projector, http_get, capture::start_audio_capture, capture::stop_audio_capture, capture::ad_debug_log, capture::ad_debug_playlist, capture::ad_debug_spot, open_feedback])
        .setup(|app| {
            let url: Url = format!("http://localhost:{}/index.html", PORT).parse().unwrap();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
            #[cfg(desktop)]
            let builder = builder.title("PartyMix").disable_drag_drop_handler().inner_size(1280.0, 800.0);
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("errore nell'avvio di PartyMix");
}
