/**
 * The page's side of the download manager. The manager runs in the app (Rust + yt-dlp, never in the page):
 * the REST routes of the specification are the IPC commands below, and every change arrives as `download-update`.
 *
 *   POST   /api/download              → create()
 *   GET    /api/downloads             → list()
 *   GET    /api/downloads/{id}        → get()
 *   POST   /api/downloads/{id}/cancel → cancel()
 *   DELETE /api/downloads/{id}        → remove()
 */
export type DlStatus = 'QUEUED' | 'DOWNLOADING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type DlErrorCode = 'INVALID_URL' | 'UNAVAILABLE' | 'UNSUPPORTED_FORMAT' | 'FFMPEG_MISSING' | 'YTDLP_MISSING' | 'DISK_FULL' | 'NETWORK' | 'HTTP_ERROR' | 'CONVERSION_ERROR' | 'CANCELLED' | 'CORRUPT_FILE' | 'DUPLICATE' | 'NOT_FOUND' | 'UNKNOWN';

export type DlRequest = {
  url: string;
  type: 'audio' | 'video';
  /** best | 1080 | 720 | 480 | 360 (video) */
  quality: string;
  /** audio: mp3 | m4a | opus | best · video: mp4 | webm */
  format?: string;
  playlist_id?: string;
};

export type DlMeta = {
  title: string; artist?: string | null; album?: string | null; duration?: number | null;
  thumbnail?: string | null; thumbnail_file?: string | null; source_url: string;
  content_id?: string | null; extractor?: string | null; original_filename?: string | null;
  local_filename: string; mime_type: string; file_size: number; created_at: number;
};

export type DlJob = {
  id: string; request: DlRequest; status: DlStatus; progress: number; speed?: string | null; eta?: number | null;
  downloaded_bytes: number; total_bytes?: number | null; filename?: string | null;
  error_code?: DlErrorCode | null; message?: string | null; meta?: DlMeta | null;
  created_at: number; updated_at: number; already?: boolean;
};

export type DlConfig = { max: number; ytdlp: boolean; ffmpeg: boolean; root: string; ytdlp_version?: string | null; ytdlp_age_days?: number | null; update_hint?: string };
export class DlError extends Error { constructor(readonly code: DlErrorCode, message: string) { super(message); } }

export interface DownloadClient {
  create(req: DlRequest): Promise<DlJob>;
  list(): Promise<DlJob[]>;
  get(id: string): Promise<DlJob>;
  cancel(id: string): Promise<DlJob>;
  remove(id: string): Promise<void>;
  config(max?: number): Promise<DlConfig>;
  onUpdate(fn: (j: DlJob) => void): void;
}

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;
type Listen = (event: string, fn: (e: { payload: unknown }) => void) => Promise<unknown>;

/** Errors come back as {error_code, message}: turned into a DlError with words for the user. */
const wrap = <T>(p: Promise<unknown>): Promise<T> => p.then((x) => x as T, (e) => {
  const o = e as { error_code?: DlErrorCode; message?: string } | string;
  throw typeof o === 'object' && o?.error_code ? new DlError(o.error_code, o.message ?? 'Errore') : new DlError('UNKNOWN', 'Il download non è disponibile: riavvia l’app.');
});

export function tauriDownloadClient(invoke: Invoke, listen: Listen): DownloadClient {
  return {
    create: (request) => wrap(invoke('dl_create', { request })),
    list: () => wrap(invoke('dl_list')),
    get: (id) => wrap(invoke('dl_get', { id })),
    cancel: (id) => wrap(invoke('dl_cancel', { id })),
    remove: (id) => wrap(invoke('dl_remove', { id })),
    config: (max) => wrap(invoke('dl_config', { max: max ?? null })),
    onUpdate: (fn) => { void listen('download-update', (e) => fn(e.payload as DlJob)); },
  };
}

export const youtubeUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
export const fmtBytes = (b?: number | null) => (!b ? '0 MB' : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`);
export const STATUS_LABEL: Record<DlStatus, string> = { QUEUED: 'In attesa', DOWNLOADING: 'Download', PROCESSING: 'Elaborazione', COMPLETED: '✓ Completato', FAILED: 'Errore', CANCELLED: 'Annullato' };
