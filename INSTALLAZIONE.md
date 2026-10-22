# Millionaire Web 1.0 — installazione

Scaricare **millionaire-web-1.0.zip** dagli allegati della [release 1.0](https://github.com/hyperm03/wwtbam/releases/tag/v1.0). Lo ZIP contiene il programma e queste istruzioni. Non richiede una compilazione; le dipendenze vengono scaricate durante l'installazione. Non include temi di gioco: occorre un pacchetto compatibile, completo di immagini, suoni e font, che si abbia diritto di usare.

## Requisiti

- Node.js **24 LTS** con npm (versione usata per la verifica della release).
- Connessione Internet per `npm ci` e, se abilitato, per Discord.
- Browser aggiornato; OBS è facoltativo per la trasmissione.
- Per una VPS: Linux, un utente dedicato senza privilegi amministrativi per il processo, due hostname e HTTPS. MySQL/MariaDB è facoltativo per utenti locali aggiuntivi e banca domande.
- Per i backup cifrati descritti nella guida operativa: GNU tar.

## 1. Estrarre e avviare

Estrarre lo ZIP in una cartella scrivibile. Su Linux/macOS:

```bash
unzip millionaire-web-1.0.zip
cd millionaire-web-1.0
npm ci --omit=dev
npm start
```

Su Windows si può estrarre lo ZIP da Esplora file ed eseguire gli ultimi due comandi nel terminale aperto nella cartella estratta. La verifica della release è stata eseguita su Linux.

Aprire **http://127.0.0.1:13410**. Tenere aperto il terminale: chiudendolo si arresta il server. Per fermarlo usare Ctrl+C.

Il server ascolta sulla porta 13410, su tutte le interfacce per impostazione predefinita. Per prove solo locali, su Linux/macOS avviarlo con `HOST=127.0.0.1 npm start`. Su una VPS non esporre questa porta a Internet: usare il servizio e il proxy HTTPS descritti sotto.

Non occorre creare un file `.env`: sito, Discord e privacy vengono richiesti nell'app. `.env.example` è soltanto una documentazione per installazioni automatizzate e non viene caricato automaticamente.

## 2. Primo accesso e configurazione guidata

1. Accedere con nome utente **admin**. La password viene generata al primo avvio nel file **data/admin-password.txt** della cartella del programma; leggerla sul computer/server che lo ospita. Non viene stampata nel log. Se il gestore ha impostato `ADMIN_PASSWORD`, usare invece quella password.
2. Il primo accesso apre automaticamente **/setup**. Compilare indirizzi del sito, login e ruoli Discord, dati dell'informativa, conservazione e impostazioni del gioco.
3. Per provare subito senza Discord scegliere **Configura in seguito — solo prove**: login Discord e annunci vengono disabilitati. Gli show nuovi sono in modalità prove.
4. In qualsiasi momento tornare in **Admin → Impostazioni**. Le impostazioni vengono salvate sul server e applicate senza riavvio. MySQL, AI e question builder si configurano in **Admin → Connections**.

Il Client Secret Discord e il token bot sono cifrati. Un campo segreto vuoto conserva il valore precedente; per rimuoverlo usare l'opzione dedicata. Conservare **data/session-secret.txt**: perderlo rende illeggibili i segreti salvati. Se si usa `SESSION_SECRET` esterno, conservarne il valore nel secret manager.

## 3. VPS: servizio persistente e HTTPS

Esempio Linux con systemd. Installare prima Node.js 24 LTS e Caddy secondo le istruzioni dei rispettivi progetti. Fare puntare due hostname al server, ad esempio **quiz.example.com** e **output.quiz.example.com**. Sostituire i domini negli esempi con i propri.

Creare l'utente di servizio ed estrarre il pacchetto (eseguire dalla cartella dove si è scaricato lo ZIP):

```bash
sudo useradd --system --user-group --home-dir /opt/millionaire-web --shell /usr/sbin/nologin millionaire
sudo mkdir -p /opt/millionaire-web
sudo unzip millionaire-web-1.0.zip -d /opt
sudo cp -a /opt/millionaire-web-1.0/. /opt/millionaire-web/
sudo chown -R millionaire:millionaire /opt/millionaire-web
cd /opt/millionaire-web
sudo -u millionaire npm ci --omit=dev --cache /opt/millionaire-web/.npm-cache
```

Creare `/etc/systemd/system/millionaire-web.service`:

```ini
[Unit]
Description=Millionaire Web
After=network.target

[Service]
Type=simple
User=millionaire
Group=millionaire
WorkingDirectory=/opt/millionaire-web
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=13410
Environment=TRUST_PROXY=1
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Verificare con `command -v node` che il percorso sia `/usr/bin/node`, altrimenti correggere `ExecStart`. `HOST`, porta e fiducia nel proxy sono impostazioni del processo: le credenziali Discord e gli altri dati del sito si inseriscono invece nell'app.

Configurare `/etc/caddy/Caddyfile` con i soli hostname ammessi:

```caddyfile
quiz.example.com, output.quiz.example.com {
    request_body {
        max_size 1GB
    }
    reverse_proxy 127.0.0.1:13410
}
```

Caddy gestisce certificati e WebSocket. Nel firewall consentire il traffico web sulle porte 80/443, mantenendo la 13410 privata. Il processo applicativo deve essere raggiungibile soltanto dal proxy locale quando `TRUST_PROXY=1`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now millionaire-web
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status millionaire-web
sudo cat /opt/millionaire-web/data/admin-password.txt
```

Aprire **https://quiz.example.com** e completare il primo accesso. L'hostname output non è una seconda pagina di login: serve le risorse dello show tramite il link generato dalla regia. Per la diagnosi del servizio usare `sudo journalctl -u millionaire-web -n 100 --no-pager`.

## 4. Attivare Discord dall'app

1. Creare un'applicazione nel [Discord Developer Portal](https://discord.com/developers/applications). In **OAuth2 → Redirects** registrare esattamente `https://quiz.example.com/auth/discord/callback` usando il proprio dominio.
2. Nel setup o in **Admin → Impostazioni**, inserire l'indirizzo HTTPS della regia e quello dell'output: devono avere **hostname differenti**. Inserire Client ID e Client Secret. Da remoto, inviare segreti soltanto con HTTPS.
3. Per riservare l'accesso al network inserire l'ID del server Discord e, se necessario, gli ID dei ruoli ammessi. I ruoli operatore/amministratore vanno assegnati esplicitamente: non sono concessi a tutti i membri.
4. Compilare titolare, contatto privacy, hosting/Paesi/trasferimenti e conservazione. Leggere l'informativa `/privacy` e confermarne la verifica solo dopo averla adeguata al servizio effettivo. Il login corrente è riservato a partecipanti maggiorenni, con autodichiarazione dell'età minima.
5. Abilitare il login e completare il setup. Se si cambiano gli indirizzi il browser può chiedere nuovamente l'accesso all'URL configurato. Consentire al server l'uscita HTTPS verso `discord.com`.
6. Verificare con account reali accesso consentito/rifiutato, privilegi, logout, esportazione e cancellazione prima della prima diretta. Il bot degli annunci è facoltativo, separato dal login e disabilitato inizialmente.

La piattaforma applica misure tecniche di privacy; la conformità del servizio dipende anche dalla gestione e dalle norme applicabili. La [guida Discord e privacy](docs/DISCORD-PRIVACY.md) descrive dati, tempi, diritti e verifiche richieste al gestore.

## 5. Preparare la prima puntata

1. Come amministratore, caricare un tema ZIP attendibile nella scheda **Themes**. Lo ZIP deve contenere `default.html` e tutte le risorse necessarie. I temi eseguono codice: provarli prima della diretta.
2. Creare uno show e selezionare il tema. Aprire il link output dalla regia, anche come sorgente browser OBS; dimensione consigliata 1920×1080. Nel browser abilitare l'audio con un clic se richiesto.
3. Importare/preparare le domande. Per la diretta verificare e approvare tutti i 30 slot principali e sostitutivi, quindi congelare la scaletta. Il login Discord deve essere configurato.
4. Provare comandi, audio, voto, schermi conduttore/concorrente e ripristino con il proprio tema; solo dopo passare alla diretta. I partecipanti usano `/account?room=ID-SHOW` per iscrizione e check-in.

Vedere la [guida operativa](docs/OPERATIONS.md) per preparazione, output di riserva, checkpoint, spareggi e backup.

## Dati, backup e aggiornamenti

La cartella **data/** contiene configurazione, chiave, password, show e temi: deve rimanere privata e persistente. Non pubblicarla e non cancellarla quando si aggiorna il codice. Arrestare il servizio prima di copiarla o effettuare backup coerenti.

Per i backup cifrati del gioco e il ripristino usare le istruzioni in [OPERATIONS.md](docs/OPERATIONS.md#backup-cifrati). Questi archivi escludono account/sessioni/log dei partecipanti e non sono una copia completa dell'installazione. MySQL e gli eventuali backup completi dell'hosting richiedono procedure separate con accessi e conservazione definiti.

Per aggiornare: fermare il servizio, fare i backup necessari, estrarre la nuova versione in una cartella separata, conservare la precedente, trasferire in sicurezza i dati persistenti e la stessa chiave, eseguire `npm ci --omit=dev` nella nuova cartella e riavviare. Non sovrascrivere o condividere una directory dati mentre due istanze sono attive.

## Verifica dello ZIP e risoluzione dei problemi

La release include **SHA256SUMS**. Salvandolo nella stessa cartella dello ZIP e di queste istruzioni, su Linux si può verificare con `sha256sum -c SHA256SUMS`; su macOS con `shasum -a 256 -c SHA256SUMS`.

| Problema | Verifica |
| --- | --- |
| La porta è già occupata | Fermare l'altra istanza oppure configurare `PORT` e aggiornare il proxy. |
| Il login Discord è disabilitato | Controllare i campi mancanti nel setup, due hostname HTTPS distinti e la verifica dell'informativa. |
| Discord segnala redirect non valido | Il callback nel portale deve coincidere esattamente con dominio, HTTPS e `/auth/discord/callback`. |
| Salvataggio segreto rifiutato | Usare HTTPS; dietro proxy verificare `TRUST_PROXY=1` e inoltro di Host/protocollo. |
| Nessun tema o output vuoto | Caricare un tema completo e assegnarlo allo show; il pacchetto non include un tema. |
| Il server non riparte | Verificare Node 24, permessi della cartella dati, chiave persistente e log del servizio. |

Per contribuire o eseguire i test: `npm ci`, `npm test`; per il test browser serve Chromium, poi `npm run test:browser` (`CHROMIUM_PATH` se non è in `/usr/bin/chromium`). OAuth reale, temi originali/audio, OBS, MySQL, Roblox e gateway multi-community richiedono verifiche nel proprio ambiente.
