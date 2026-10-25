declare global {
  interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void }
}

let loading: Promise<void> | undefined;

/** Loads the official IFrame Player API once. */
export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { loading = undefined; reject(new Error('API YouTube non raggiungibile')); };
    document.head.appendChild(s);
  });
  return loading;
}
