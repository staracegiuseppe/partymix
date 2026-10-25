fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["list_displays", "open_projector", "close_projector"]),
        ),
    )
    .expect("errore nella build di PartyMix AI");
}
