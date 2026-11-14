fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["list_displays", "open_projector", "close_projector", "http_get", "start_audio_capture", "stop_audio_capture", "ad_debug_log", "ad_debug_playlist", "ad_debug_spot", "open_feedback", "keep_awake"]),
        ),
    )
    .expect("errore nella build di PartyMix AI");
}
