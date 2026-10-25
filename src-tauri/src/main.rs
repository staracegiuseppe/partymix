use tauri::{Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 9527;

#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Vec<String> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| m.name().cloned().unwrap_or_else(|| format!("Schermo {}", i + 1)))
        .collect()
}

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

#[tauri::command]
fn close_projector(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("projector") {
        let _ = w.close();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(PORT).build())
        .invoke_handler(tauri::generate_handler![list_displays, open_projector, close_projector])
        .setup(|app| {
            let url: Url = format!("http://localhost:{}/index.html", PORT).parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PartyMix AI")
                .disable_drag_drop_handler()
                .inner_size(1280.0, 800.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("errore nell'avvio di PartyMix AI");
}
