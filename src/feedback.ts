import { APP_VERSION } from './info';

/** Comments and ideas reach the author by e-mail, written and sent by the user from their own account. */
export const FEEDBACK_TO = 'staracegiuseppe@gmail.com';
export type FeedbackKind = 'idea' | 'problem' | 'comment';
export type FeedbackVia = 'mail' | 'gmail' | 'outlook';

export const KIND_LABEL: Record<FeedbackKind, string> = { idea: 'Suggerimento', problem: 'Problema', comment: 'Commento' };

type Tauri = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
type AndroidBridge = { sendFeedback?(via: string, subject: string, body: string): boolean };
const win = () => window as unknown as { PartyMixAndroid?: AndroidBridge; __TAURI_INTERNALS__?: Tauri };

/** Which system the app runs on, written in the message so a problem can be reproduced. */
export function platformName(): string {
  if (win().PartyMixAndroid) return 'Android';
  const p = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Win/i.test(p)) return 'Windows';
  if (/^Mac/i.test(p)) return 'macOS';
  return 'altro';
}

export function buildFeedback(kind: FeedbackKind, text: string, version = APP_VERSION, platform = platformName()): { subject: string; body: string } {
  const label = KIND_LABEL[kind];
  const first = text.trim().split('\n')[0].slice(0, 60);
  return {
    subject: `PartyMix – ${label}${first ? `: ${first}` : ''}`,
    body: `${text.trim() || '(scrivi qui il tuo messaggio)'}\n\n—\n${label} da PartyMix ${version} su ${platform}`.slice(0, 1800),
  };
}

/** Opens the message ready to send: Android app chooser, the computer's mail app, or Gmail/Outlook in the browser. */
export async function sendFeedback(via: FeedbackVia, kind: FeedbackKind, text: string): Promise<void> {
  const { subject, body } = buildFeedback(kind, text);
  const w = win();
  if (typeof w.PartyMixAndroid?.sendFeedback === 'function') {
    if (!w.PartyMixAndroid.sendFeedback(via, subject, body)) throw new Error('nessuna app di posta trovata');
    return;
  }
  if (w.__TAURI_INTERNALS__) { await w.__TAURI_INTERNALS__.invoke('open_feedback', { via, subject, body }); return; }
  const e = encodeURIComponent, to = e(FEEDBACK_TO);
  const url = via === 'mail' ? `mailto:${FEEDBACK_TO}?subject=${e(subject)}&body=${e(body)}`
    : via === 'gmail' ? `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${e(subject)}&body=${e(body)}`
    : `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${e(subject)}&body=${e(body)}`;
  window.open(url, '_blank', 'noopener');
}
