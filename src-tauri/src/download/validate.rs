//! validate_url: only public web addresses go to the downloader. Never files, never this computer, never the home network:
//! the downloader must not become a way to reach internal services.

use super::models::{ApiError, ErrorCode};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use url::{Host, Url};

const BLOCKED_SUFFIXES: [&str; 8] = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".intranet", ".corp"];

fn bad(msg: &str) -> ApiError { ApiError::new(ErrorCode::InvalidUrl, msg) }

pub fn private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.is_documentation() || ip.is_multicast()
        || o[0] == 0 || (o[0] == 100 && (64..128).contains(&o[1])) // carrier-grade NAT
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        || o[0] >= 240
}

pub fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => private_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() { return private_v4(v4); }
            let s = v6.segments();
            v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || v6 == Ipv6Addr::LOCALHOST
        }
    }
}

/// Checks the address itself (no network): scheme, no credentials, a public host name or address.
pub fn validate_url(raw: &str) -> Result<Url, ApiError> {
    let raw = raw.trim();
    if raw.is_empty() { return Err(bad("Incolla un indirizzo (URL).")); }
    if raw.len() > 2048 { return Err(bad("Indirizzo troppo lungo.")); }
    let u = Url::parse(raw).map_err(|_| bad("Indirizzo non valido: deve cominciare con https://"))?;
    if u.scheme() != "https" && u.scheme() != "http" { return Err(bad("Sono accettati solo indirizzi web (https://).")); }
    if !u.username().is_empty() || u.password().is_some() { return Err(bad("Indirizzi con nome utente o password non sono accettati.")); }
    if let Some(p) = u.port() { if p != 80 && p != 443 { return Err(bad("Porta non consentita: solo indirizzi web normali.")); } }
    match u.host() {
        None => return Err(bad("Indirizzo senza sito.")),
        Some(Host::Ipv4(ip)) => if private_v4(ip) { return Err(bad("Indirizzi della rete locale o di questo computer non sono consentiti.")); },
        Some(Host::Ipv6(ip)) => if private_ip(IpAddr::V6(ip)) { return Err(bad("Indirizzi della rete locale o di questo computer non sono consentiti.")); },
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || !d.contains('.') || BLOCKED_SUFFIXES.iter().any(|s| d.ends_with(s)) {
                return Err(bad("Indirizzi della rete locale o di questo computer non sono consentiti."));
            }
        }
    }
    Ok(u)
}

/// Before downloading: the name must not point to an internal address (e.g. a public name set to 127.0.0.1).
pub fn resolves_public(u: &Url) -> Result<(), ApiError> {
    let host = u.host_str().unwrap_or("");
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = (host.trim_start_matches('[').trim_end_matches(']'), port)
        .to_socket_addrs()
        .map_err(|_| ApiError::new(ErrorCode::Network, "Il sito non si trova: controlla l’indirizzo e la connessione."))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| private_ip(a.ip())) {
        return Err(bad("Questo indirizzo porta alla rete locale: non consentito."));
    }
    Ok(())
}

/// The id of a YouTube video in a link (watch, youtu.be, shorts, music), to recognise the same song in different links.
pub fn youtube_id(u: &Url) -> Option<String> {
    let host = u.host_str()?.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    let id = match host {
        "youtube.com" => {
            let p = u.path();
            if p == "/watch" { u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned()) }
            else { p.strip_prefix("/shorts/").or_else(|| p.strip_prefix("/live/")).or_else(|| p.strip_prefix("/embed/")).map(|s| s.split('/').next().unwrap_or("").to_string()) }
        }
        "youtu.be" => u.path_segments()?.next().map(|s| s.to_string()),
        _ => None,
    }?;
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(id)
}

/// A key that is the same for the same content: «youtube:<id>», else the link without its #fragment.
pub fn content_key(u: &Url) -> String {
    if let Some(id) = youtube_id(u) { return format!("youtube:{}", id); }
    let mut c = u.clone();
    c.set_fragment(None);
    c.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_public_web_links() {
        assert!(validate_url("https://www.youtube.com/watch?v=BaW_jenozKc").is_ok());
        assert!(validate_url("  https://youtu.be/BaW_jenozKc ").is_ok());
        assert!(validate_url("https://example.com:443/a.mp3").is_ok());
    }
    #[test]
    fn refuses_files_local_and_internal_addresses() {
        for u in ["file:///etc/passwd", "/Users/x/a.mp3", "C:\\musica\\a.mp3", "ftp://example.com/a", "javascript:alert(1)", "http://localhost:9527/", "http://127.0.0.1/",
                  "http://[::1]/", "http://192.168.1.10/a.mp3", "http://10.0.0.5/", "http://172.16.3.4/", "http://169.254.169.254/latest/meta-data", "http://100.64.0.1/",
                  "http://0.0.0.0/", "http://nas.local/a.mp3", "http://router.lan/", "http://intranet/", "https://user:pw@example.com/", "https://example.com:8080/",
                  "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", ""] {
            assert_eq!(validate_url(u).map(|_| ()).unwrap_err().error_code, ErrorCode::InvalidUrl, "{}", u);
        }
    }
    #[test]
    fn same_video_same_key() {
        let k = |s: &str| content_key(&Url::parse(s).unwrap());
        assert_eq!(k("https://www.youtube.com/watch?v=BaW_jenozKc&t=10"), "youtube:BaW_jenozKc");
        assert_eq!(k("https://youtu.be/BaW_jenozKc?si=x"), "youtube:BaW_jenozKc");
        assert_eq!(k("https://music.youtube.com/watch?v=BaW_jenozKc"), "youtube:BaW_jenozKc");
        assert_eq!(k("https://www.youtube.com/shorts/BaW_jenozKc"), "youtube:BaW_jenozKc");
        assert_eq!(k("https://example.com/a.mp3#x"), "https://example.com/a.mp3");
    }
    #[test]
    fn names_that_resolve_inside_are_refused() {
        assert!(resolves_public(&Url::parse("http://127.0.0.1/").unwrap()).is_err());
    }
}
