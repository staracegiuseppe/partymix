declare const __APP_VERSION__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
export const AUTHOR = 'Giuseppe Starace';
/** The author's personal PayPal QR code (payload https://www.paypal.com/qrcodes/p2pqrc/8AXGQ7233LRNL). Opened in a desktop browser that link only shows PayPal's
 * app page, so it is shown as a code to scan with the PayPal app instead of a button. */
export const PAYPAL_QR = new URL('./assets/paypal-qr.png', import.meta.url).href;
