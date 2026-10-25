use tauri::{WebviewUrl, WebviewWindowBuilder};
fn main() {
    let port: u16 = 9527;
    tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(port).build())
        .setup(move |app| {
            let url = format!("http://localhost:{}/index.html", port).parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url)).title("PartyMix AI").inner_size(1000.0, 700.0).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run");
}
