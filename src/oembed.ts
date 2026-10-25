export type OEmbedResult =
  | { ok: true; title: string; author: string; thumb: string }
  | { ok: false; reason: string };

export async function fetchOEmbed(videoId: string, f: typeof fetch = fetch): Promise<OEmbedResult> {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
  try {
    const r = await f(url);
    if (r.ok) {
      const j = await r.json();
      return { ok: true, title: String(j.title ?? ''), author: String(j.author_name ?? ''), thumb: String(j.thumbnail_url ?? '') };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "Il proprietario non consente l'incorporamento del video" };
    return { ok: false, reason: 'Video non trovato, rimosso o privato' };
  } catch {
    return { ok: false, reason: 'Errore di rete: controlla la connessione' };
  }
}
