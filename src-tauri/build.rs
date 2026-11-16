fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["list_displays", "open_projector", "close_projector", "http_get", "start_audio_capture", "stop_audio_capture", "ad_debug_log", "ad_debug_playlist", "ad_debug_spot", "open_feedback", "keep_awake", "lib_write", "lib_read", "lib_root", "lib_delete", "file_sha256", "lib_read_range", "disk_free", "dl_create", "dl_create_many", "dl_list", "dl_get", "dl_cancel", "dl_remove", "dl_config", "system_accent"]),
        ),
    )
    .expect("errore nella build di PartyMix AI");
}
