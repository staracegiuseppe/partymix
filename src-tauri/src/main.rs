// On Windows release builds, run as a GUI app: no console window next to the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    partymix_ai_lib::run()
}
