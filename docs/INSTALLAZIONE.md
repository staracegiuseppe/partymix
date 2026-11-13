# Installazione e aggiornamento

Gli installer **non sono firmati** (la firma richiede un account sviluppatore a pagamento): al primo avvio il sistema mostra un avviso. È normale; ecco come procedere.

## macOS
1. Apri il file `PartyMix_x.y.z_*.dmg` e trascina **PartyMix** in *Applicazioni*.
2. Primo avvio: **clic destro sull'app → Apri → Apri**. Se macOS dice che l'app è "danneggiata", apri il Terminale ed esegui:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/PartyMix.app"
   ```
3. Alla prima apertura del proiettore macOS chiede il permesso per il **microfono**: consentilo (serve solo a far muovere le forme).

## Windows 10/11
1. Estrai lo zip `PartyMix_x.y.z_windows-x64.zip` dove vuoi (ad esempio sul Desktop) e fai doppio clic su `PartyMix.exe`: è una versione portabile, non serve installare nulla.
2. Se compare **SmartScreen** ("Windows ha protetto il PC"): **Ulteriori informazioni → Esegui comunque**.
3. Windows può chiedere il permesso per il microfono: consentilo.
4. Serve *Microsoft Edge WebView2* (già presente su Windows 11 e sui Windows 10 aggiornati; l'installer lo scarica se manca).

> Lo stato di verifica su Windows è nel [registro delle verifiche](VERIFICHE.md).

## Android
1. Scarica `PartyMix_x.y.z_android.apk` sul telefono (Android 7 o successivo) e aprilo.
2. Se Android lo chiede, consenti a quell'app (browser o file) di **installare app sconosciute**, poi **Installa**.
3. Play Protect può dire che l'app non è conosciuta: **Installa comunque**.
4. Per il proiettore: **Apri proiettore** apre le impostazioni *Trasmetti / Schermo wireless* del telefono; scegli la TV o il proiettore e il proiettore di PartyMix compare lì. Serve un televisore o proiettore che riceva lo *schermo wireless* (Miracast; su molti Android TV con app come AirScreen). Un Chromecast che copia soltanto lo schermo del telefono mostra la console, non il proiettore.

## Aggiornamento
Scarica il nuovo installer e installalo sopra quello vecchio: impostazioni e playlist restano. Non c'è aggiornamento automatico.

## Se qualcosa non va
- *"Non riesco ad avviare i player YouTube"*: controlla la connessione e riavvia l'app.
- *Un brano è sbarrato nella coda*: YouTube non ne consente la riproduzione incorporata; usa l'avviso a destra per sostituirlo.
- *Il proiettore dice "Microfono non disponibile"*: concedi il permesso nelle impostazioni di privacy del sistema o scegli un altro ingresso dalla console (**Cerca ingressi**).
