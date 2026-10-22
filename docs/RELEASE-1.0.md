# Millionaire Web 1.0

Prima release della piattaforma web per gestire Chi vuol essere milionario: regia, output per OBS, schermi conduttore e concorrente, domande e partecipazione del pubblico.

## Download e installazione

Scaricare **millionaire-web-1.0.zip**, estrarlo ed eseguire nella cartella `millionaire-web-1.0`:

```bash
npm ci --omit=dev
npm start
```

Richiede **Node.js 24 LTS** con npm e Internet per scaricare le dipendenze. Aprire **http://127.0.0.1:13410**, accedere come **admin** con la password generata in **data/admin-password.txt** e seguire il setup. Discord, privacy e indirizzi si configurano nell'app, anche successivamente da **Admin → Impostazioni**. Per iniziare senza Discord scegliere **Configura in seguito — solo prove**.

La guida **INSTALLAZIONE.md**, inclusa nello ZIP e allegata anche separatamente, spiega installazione locale, VPS/systemd, HTTPS, configurazione Discord, prima puntata e backup. **SHA256SUMS** permette di verificare i file scaricati. Usare lo ZIP allegato `millionaire-web-1.0.zip` per seguire esattamente i nomi di cartella della guida.

## Funzioni incluse

- Setup al primo accesso, impostazioni persistenti e segreti cifrati.
- Login Discord OAuth con PKCE, ruoli espliciti, account partecipanti, iscrizioni/check-in, esportazione e cancellazione.
- Modalità prove e diretta, revisione/approvazione e congelamento delle domande.
- Conferme dei comandi, output attivo/riserva, checkpoint e ripristino in pausa.
- Voto per account e turno, chiusura automatica e gestione dell'incertezza Fastest Finger.
- Backup cifrati del gioco e integrazione facoltativa per annunci/eventi Discord.

## Prima dell'uso pubblico

I temi di gioco non sono inclusi: caricare un pacchetto compatibile completo e autorizzato. Il login Discord richiede due hostname HTTPS distinti, credenziali e informativa adattata al proprio servizio. L'accesso partecipanti corrente è riservato ai maggiorenni. Le misure del software non costituiscono una certificazione di conformità legale globale.

La release è verificata su Linux con Node.js 24, test automatici e Chromium con tema sintetico. Prima della diretta verificare OAuth reale, grafica/audio del proprio tema, OBS e le integrazioni effettivamente usate. MySQL, Roblox e gateway multi-community non sono coperti dalla verifica di questa release.

Guide incluse: [installazione](https://github.com/hyperm03/wwtbam/blob/v1.0/INSTALLAZIONE.md), [operazioni e backup](https://github.com/hyperm03/wwtbam/blob/v1.0/docs/OPERATIONS.md), [Discord e privacy](https://github.com/hyperm03/wwtbam/blob/v1.0/docs/DISCORD-PRIVACY.md).
