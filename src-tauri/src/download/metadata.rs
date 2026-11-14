//! Metadata of a finished download, from the JSON line yt-dlp prints after moving the file into the library.

use super::models::Meta;
use std::path::Path;

/// The fields asked to yt-dlp (`--print after_move:…`): one JSON object on one line.
pub const PRINT_FIELDS: &str = "%(.{id,title,track,artist,creator,uploader,channel,album,duration,thumbnail,webpage_url,original_url,extractor_key,filepath,ext})j";

pub fn mime_of(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "opus" | "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn s(v: &serde_json::Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty() && x != "NA")
}

/// Builds the metadata. `root` is the library folder: paths are stored relative to it.
pub fn parse(line: &str, root: &Path, source_url: &str, created_at: u64) -> Option<Meta> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let filepath = s(&v, "filepath")?;
    let full = Path::new(&filepath);
    let rel = full.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let size = std::fs::metadata(full).map(|m| m.len()).unwrap_or(0);
    let id = s(&v, "id");
    let thumbs = root.join("thumbnails");
    let thumbnail_file = id.as_ref().and_then(|id| {
        ["jpg", "webp", "png", "jpeg"].iter().map(|e| thumbs.join(format!("{}.{}", id, e))).find(|p| p.is_file())
    }).and_then(|p| p.strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/")));
    // music services fill track/artist; plain videos only the channel
    let title = s(&v, "track").or_else(|| s(&v, "title")).unwrap_or_else(|| full.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default());
    let artist = s(&v, "artist").or_else(|| s(&v, "creator")).or_else(|| s(&v, "uploader")).or_else(|| s(&v, "channel")).map(|a| a.trim_end_matches(" - Topic").to_string());
    Some(Meta {
        title,
        artist,
        album: s(&v, "album"),
        duration: v.get("duration").and_then(|d| d.as_f64()),
        thumbnail: s(&v, "thumbnail"),
        thumbnail_file,
        source_url: s(&v, "webpage_url").or_else(|| s(&v, "original_url")).unwrap_or_else(|| source_url.to_string()),
        content_id: id,
        extractor: s(&v, "extractor_key"),
        original_filename: s(&v, "title").map(|t| format!("{}.{}", t, s(&v, "ext").unwrap_or_default())),
        mime_type: mime_of(&rel).to_string(),
        local_filename: rel,
        file_size: size,
        created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_the_printed_json() {
        let dir = std::env::temp_dir().join(format!("pmx-meta-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("music")).unwrap();
        std::fs::create_dir_all(dir.join("thumbnails")).unwrap();
        std::fs::write(dir.join("music/Song [abc123def45].mp3"), b"ID3xxxx").unwrap();
        std::fs::write(dir.join("thumbnails/abc123def45.jpg"), b"jpg").unwrap();
        let line = serde_json::json!({
            "id": "abc123def45", "title": "Artist - Song (Official)", "track": "Song", "artist": "Artist", "uploader": "ArtistVEVO",
            "album": "Album", "duration": 215.0, "thumbnail": "https://i.ytimg.com/x.jpg", "webpage_url": "https://www.youtube.com/watch?v=abc123def45",
            "extractor_key": "Youtube", "filepath": dir.join("music/Song [abc123def45].mp3").to_string_lossy(), "ext": "mp3"
        }).to_string();
        let m = parse(&line, &dir, "https://youtu.be/abc123def45", 7).unwrap();
        assert_eq!(m.title, "Song");
        assert_eq!(m.artist.as_deref(), Some("Artist"));
        assert_eq!(m.album.as_deref(), Some("Album"));
        assert_eq!(m.duration, Some(215.0));
        assert_eq!(m.local_filename, "music/Song [abc123def45].mp3");
        assert_eq!(m.thumbnail_file.as_deref(), Some("thumbnails/abc123def45.jpg"));
        assert_eq!(m.mime_type, "audio/mpeg");
        assert_eq!(m.file_size, 7);
        assert_eq!(m.original_filename.as_deref(), Some("Artist - Song (Official).mp3"));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn channel_names_lose_topic() {
        let dir = std::env::temp_dir();
        let line = serde_json::json!({ "title": "X", "channel": "Band - Topic", "filepath": dir.join("music/x.m4a").to_string_lossy() }).to_string();
        assert_eq!(parse(&line, &dir, "u", 0).unwrap().artist.as_deref(), Some("Band"));
        assert!(parse("not json", &dir, "u", 0).is_none());
    }
}
