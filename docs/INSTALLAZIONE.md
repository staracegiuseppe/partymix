# Installazione e aggiornamento

Gli installer **non sono firmati** (la firma richiede un account sviluppatore a pagamento): al primo avvio il sistema mostra un avviso. È normale; ecco come procedere.

## macOS
1. Apri il file `PartyMix AI_x.y.z_*.dmg` e trascina **PartyMix AI** in *Applicazioni*.
2. Primo avvio: **clic destro sull'app → Apri → Apri**. Se macOS dice che l'app è "danneggiata", apri il Terminale ed esegui:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/PartyMix AI.app"
   ```
3. Alla prima apertura del proiettore macOS chiede il permesso per il **microfono**: consentilo (serve solo a far muovere le forme).

## Windows 10/11
1. Esegui `PartyMix AI_x.y.z_x64-setup.exe`.
2. Se compare **SmartScreen** ("Windows ha protetto il PC"): **Ulteriori informazioni → Esegui comunque**.
3. Windows può chiedere il permesso per il microfono: consentilo.
4. Serve *Microsoft Edge WebView2* (già presente su Windows 11 e sui Windows 10 aggiornati; l'installer lo scarica se manca).

> Lo stato di verifica su Windows è nel [registro delle verifiche](VERIFICHE.md).

## Aggiornamento
Scarica il nuovo installer e installalo sopra quello vecchio: impostazioni e playlist restano. Non c'è aggiornamento automatico.

## Se qualcosa non va
- *"Non riesco ad avviare i player YouTube"*: controlla la connessione e riavvia l'app.
- *Un brano è sbarrato nella coda*: YouTube non ne consente la riproduzione incorporata; usa l'avviso a destra per sostituirlo.
- *Il proiettore dice "Microfono non disponibile"*: concedi il permesso nelle impostazioni di privacy del sistema o scegli un altro ingresso dalla console (**Cerca ingressi**).
