# Preparazione, diretta e recupero

## Sviluppo

Node >=18, `npm ci`, `npm start`. Il progetto non richiede una build. Le dipendenze sono fissate nel lockfile. Nell'ambiente cloud usare `npm ci --cache /workspace/.cache/npm`; il percorso predefinito della cache non è scrivibile.

Alla prima installazione, accedere come amministratore: il programma apre automaticamente `/setup`. La procedura chiede indirizzi del sito, credenziali e ruoli Discord, dati privacy, annunci opzionali e durata del voto. Non è necessario predisporre queste variabili a mano nel sistema operativo. Si può salvare una bozza o scegliere esplicitamente “Configura in seguito — solo prove”; quest’ultima scelta disabilita login Discord e bot. In seguito gli stessi campi si trovano in **Admin → Impostazioni**, mentre MySQL, AI e question builder restano in **Admin → Connections**.

I valori eventualmente presenti nell’ambiente sono precompilati, con i segreti indicati solo come configurati. I valori salvati nell’app hanno precedenza e persistono in `data/installation.json`: Client Secret e token del bot sono cifrati AES-256-GCM con una chiave derivata dalla chiave locale del servizio. Un campo segreto vuoto mantiene il valore esistente; la rimozione richiede la casella dedicata. Non viene mai reinviato al browser un segreto salvato. Usare HTTPS per configurarli da remoto; il bootstrap HTTP è consentito solo dal loopback locale.

Le modifiche vengono applicate senza riavvio. Se cambiano gli hostname occorre accedere nuovamente all’indirizzo configurato e predisporre DNS/TLS/proxy; i flussi OAuth in corso vengono annullati. Le modifiche alle impostazioni di identità o privacy revocano le sessioni Discord, così i nuovi limiti valgono al successivo accesso. La procedura non attiva né testa credenziali reali in modo implicito.

Restano impostazioni del processo/hosting `HOST`, `PORT`, `DATA_DIR`, `SESSION_SECRET`, `ADMIN_PASSWORD` e `TRUST_PROXY`: non vengono riscritte da una richiesta web. La password amministratore di bootstrap è quella configurata dal gestore oppure il valore generato nel file protetto `data/admin-password.txt`. `.env.example` documenta anche l’alternativa per installazioni automatizzate; non viene caricato automaticamente dal server.

`npm test` esegue test di sessioni, account, privacy, OAuth simulato, editoria, protocollo di regia, checkpoint, voto, timing e backup. `npm run test:browser` richiede Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`) e prova Chromium tramite Playwright con un tema sintetico di test. La fixture serve solo a verificare il bridge e non sostituisce una partita con un tema reale. Non è un tema distribuito al pubblico.

## Puntata

Gli show nuovi e quelli importati senza modalità esplicita sono in **REHEARSAL**. Le prove non consumano domande della banca e non accettano iscrizioni pubbliche. Da “Preparation & recovery” è possibile creare una copia separata, controllare i prerequisiti e rivedere ogni slot principale e sostitutivo. Verificare fonte HTTPS, correttezza, distrattori, ambiguità e resa grafica. Le domande AI partono come bozze, come qualsiasi domanda senza revisione. La verifica precede l'approvazione, riservata a un amministratore.

Il controllo di lunghezza è conservativo; provare comunque i testi nel tema installato. Autore, revisore, scadenza e fonte appartengono alla versione esatta del contenuto: modificarlo invalida l'approvazione. “Freeze approved questions” congela la scaletta. “Go live” richiede temi e tutti i 30 slot approvati e un login Discord configurato. Il passaggio alla diretta ricarica l'output e chiude i client concorrente/pubblico; riaprirli con Discord e check-in. Per modificare la scaletta o ricaricare manualmente tornare alle prove, confermando il reset. Questo è intenzionale e non costituisce ripristino della partita in corso.

I partecipanti aprono `/account?room=ID-SHOW`, scelgono un soprannome, si iscrivono ed effettuano check-in. I link voto, concorrente e Fastest Finger consentono di tornare all'account. Gli schermi concorrente e Fastest Finger mantengono anche la password dello show. Il conduttore usa la propria password. Non chiedere nomi reali o città se non sono necessari e non pubblicare dati senza averne verificato i presupposti.

Solo il primo output è attivo; gli altri mostrano un avviso di standby. È possibile trasferire il controllo dalla regia scegliendo la connessione. Il trasferimento richiede conferma e recupero del checkpoint; non esiste elezione automatica di un motore sconosciuto. I comandi hanno identificativo, scadenza e conferma del bridge. Se manca una conferma, verificare l'output prima di ripetere l'azione. Comandi offline e autoripetizione della tastiera sono bloccati.

I turni di voto mostrano domanda completa e conto alla rovescia, chiudono automaticamente e non mostrano le domande future. Un cambio domanda chiude il turno, senza riutilizzare voti o identità. Per Fastest Finger le misure provengono da ping monouso del server, con compensazione limitata a 100 ms; differenze entro l'incertezza richiedono spareggio. I centesimi visualizzati non equivalgono a precisione assoluta su reti diverse.

## Checkpoint

Il server salva atomicamente i cambi di fase e aggiorna il resto al massimo ogni secondo. Domande, modalità e tema devono corrispondere al checkpoint. Dopo una ricarica/riavvio, l'output non sovrascrive il recupero con lo stato iniziale: attendere che il bridge sia pronto e usare “Restore paused”. La conferma arriva dal bridge dopo l'applicazione.

Il ripristino ricostruisce variabili di gioco, testi e visibilità del DOM, con timer fermo e audio arrestato. Verificare visivamente la scena e riprendere esplicitamente. Non viene promessa ripresa di un'animazione o di un file audio allo stesso istante. Checkpoint durante aiuti a tempo o Fastest Finger vengono rifiutati: tornare a una domanda sicura nelle prove o rifare il turno. Provarlo con ogni tema reale prima di una diretta. Non usare questa funzione come sostituto di backup esterni.

## Backup cifrati

Fermare il processo per avere un insieme coerente; il processo salva show e checkpoint al SIGTERM. Conservare una passphrase di almeno 16 caratteri in un file protetto, fuori dal repository. Non passarla come argomento né pubblicarla nei log.

```bash
node scripts/backup.mjs create /percorso/data /percorso/backup.enc /percorso/passphrase-file
node scripts/backup.mjs restore /percorso/backup.enc /percorso/data-ripristinati /percorso/passphrase-file
```

Il backup include temi, configurazione del gioco e chiave locale che permette di decifrare le impostazioni; per questo è cifrato AES-256-GCM, con chiave derivata tramite scrypt. Non ripristinare su dati esistenti: la destinazione deve essere vuota. Password errata, dati alterati e percorsi/symlink pericolosi fanno fallire il ripristino. Account/sessioni dei partecipanti, log e registro notifiche sono esclusi anche nelle sottocartelle.

Se MySQL è attivo, eseguire separatamente un backup coerente del database secondo gli strumenti del proprio host: il backup dei file non contiene utenti, banca domande e tabelle MySQL. Anche quel backup deve rispettare i tempi di cancellazione. Il test automatico verifica autenticazione, esclusione delle identità e ripristino; pianificare periodicamente una prova del proprio archivio reale.

## Limiti verificati di questa consegna

Codice derivato dallo ZIP originale e importato nel checkout locale inizialmente vuoto. Nessun push o pubblicazione eseguiti. OAuth e bot necessitano di configurazione, credenziali e verifica reale; nessun messaggio è stato inviato a Discord durante lo sviluppo. Nessun pacchetto temi originale era disponibile: grafica/audio dei temi, OBS, MySQL, Roblox e gateway multi-community non sono coperti dai test di questa consegna. Per il gateway occorrono configurazioni e domini distinti per ogni community, con verifica dell'isolamento e dei callback prima di abilitare Discord per i tenant.
