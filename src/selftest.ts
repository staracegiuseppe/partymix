// Temporary, build-time opt-in (VITE_BEACON=1): drives the real UI like a user and reports to a local log server.
export const beacon = (m: string) => { void fetch('http://127.0.0.1:9600/log?m=' + encodeURIComponent(m), { mode: 'no-cors' }).catch(() => {}); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = <T extends Element>(s: string) => document.querySelector(s) as T;
const snap = () => beacon('snap ' + [...document.querySelectorAll('.role,.times,.problems li')].map((e) => e.textContent).join(' | ') + ' || ' + document.querySelectorAll('.status')[1]?.textContent);

export async function run() {
  beacon('selftest start; tauri=' + !!(window as any).__TAURI_INTERNALS__ + ' origin=' + location.origin);
  await wait(6000);
  (q<HTMLInputElement>('input[type=text]')).value = 'https://www.youtube.com/playlist?list=PLfBfxMb0qlFw';
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Carica playlist')!.click();
  await wait(15000); snap();
  q<HTMLButtonElement>('.big').click();
  await wait(8000); snap();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Transizione immediata')!.click();
  await wait(5000); snap();
  await wait(8000); snap();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Apri proiettore')!.click();
  await wait(4000);
  beacon('projector msg: ' + (q('.panel .status:last-child')?.textContent ?? ''));
  const sel = document.querySelector('select[aria-label="Schermo del proiettore"]');
  beacon('displays: ' + (sel ? [...sel.querySelectorAll('option')].map((o) => o.textContent).join(',') : 'none'));
}
