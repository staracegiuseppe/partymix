# PartyMix su App Store – passi

## 1. Iscrizione (la fai tu, una volta)
1. Vai su https://developer.apple.com/programs/enroll/ e iscriviti come **persona fisica** con il tuo Apple ID (serve l'autenticazione a due fattori). Costo: 99 € l'anno.
2. Apple può chiedere un documento d'identità; l'attivazione arriva di solito in 24–48 ore.
3. In **Account › Membership** copia il **Team ID** (10 caratteri).
4. Apri Xcode › Impostazioni › Account, aggiungi il tuo Apple ID e seleziona il team.

## 2. Scheda dell'app (App Store Connect)
1. https://appstoreconnect.apple.com › App › «+» › Nuova app: piattaforma iOS, nome **PartyMix**, lingua Italiano, ID bundle **it.partymix.ai** (va prima registrato in developer.apple.com › Identifiers, oppure lo crea Xcode al primo invio), SKU `partymix`.
2. Incolla i testi di [SCHEDA-APP-STORE.md](SCHEDA-APP-STORE.md) e carica le immagini di [screenshots/](screenshots/) (iPhone 6,9" e iPad 13").
3. In «Privacy dell'app» rispondi «Non raccogliamo dati». URL privacy: https://staracegiuseppe.github.io/partymix/privacy.html

## 3. Build e invio
```sh
APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX store/ios/pubblica-ios.sh
```
Lo script crea il pacchetto `.ipa`. Per caricarlo usa l'app **Transporter** (gratuita sul Mac App Store), oppure crea una chiave API in App Store Connect › Utenti e accesso › Integrazioni e imposta `ASC_KEY_ID` e `ASC_ISSUER_ID`.

## 4. TestFlight e revisione
- Dopo il caricamento la build compare in **TestFlight**: puoi installarla sul tuo iPhone con l'app TestFlight e invitare amici con un link pubblico (fino a 10.000 persone; il primo invio esterno passa una breve revisione).
- Quando va bene, «Invia per la revisione» la pubblica sull'App Store.

## Cosa può chiedere Apple in revisione
- **Contenuti YouTube**: l'app usa solo il player ufficiale incorporato e non scarica nulla (spiegato nelle note per la revisione).
- **Donazioni**: nell'app iOS il QR di PayPal è nascosto, perché le regole dell'App Store non ammettono pagamenti fuori dagli acquisti in-app.
- **Schermo acceso**: iOS ferma i video di YouTube quando l'app esce dallo schermo, quindi mentre suona lo schermo resta acceso.
