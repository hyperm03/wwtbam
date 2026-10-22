# Login Discord e privacy: configurazione prima dell'attivazione

Il codice implementa misure tecniche di minimizzazione e sicurezza. Non certifica conformità al GDPR o a tutte le leggi mondiali: le regole dipendono da titolare, finalità, utenti, Paesi, fornitori, trasferimenti e modalità di diffusione degli show. Il responsabile del servizio deve verificare questi elementi prima dell'uso reale. `PRIVACY_REVIEWED=1` è una scelta operativa del gestore, non una certificazione.

## Attivazione

Al primo accesso amministratore si apre la procedura `/setup`. Inserire qui i valori descritti sotto; si potranno modificare successivamente in **Admin → Impostazioni**. Non è necessario esportarli manualmente come variabili d’ambiente. L’ambiente resta un’alternativa per installazioni automatizzate; le impostazioni dell’app hanno precedenza. I segreti salvati dall’interfaccia sono cifrati sul server e non vengono mostrati di nuovo nel browser.

1. Registrare un'applicazione nel Discord Developer Portal e configurare esattamente il callback `https://DOMINIO-REGIA/auth/discord/callback`. Usare il flusso Authorization Code, senza implicit grant. Il server aggiunge PKCE S256, stato casuale monouso legato al browser con durata di cinque minuti e controllo dell'issuer `https://discord.com`.
2. Inserire Client ID e Client Secret nei campi Discord della procedura o delle impostazioni, oppure usare il proprio secret manager. Non inviarlo in chat, non commetterlo, non inserirlo negli URL. Mantenere TLS e verifiche dei pacchetti attivi. Consentire al server l'uscita HTTPS verso `discord.com`.
3. Impostare `PUBLIC_URL` all'origine HTTPS della regia/account e `OUTPUT_PUBLIC_URL` a un'origine HTTPS con **hostname differente**, senza percorsi. Configurare DNS, certificati e reverse proxy per entrambi verso lo stesso processo, preservando Host e WebSocket. Il dominio output serve solamente output, risorse del bridge e temi; non espone pagine account o API amministrative. I temi eseguono codice: solo gli amministratori possono caricarli. Questa separazione impedisce ai temi di leggere account e sessioni della regia tramite lo stesso origin. Limitare i domini ammessi anche nel reverse proxy. Non usare cookie Domain condivisi.
4. Se l'accesso è riservato al network, specificare `DISCORD_GUILD_ID`. Si aggiunge il solo scope necessario `guilds.members.read` a `identify`, e l'appartenenza viene verificata durante l'autenticazione. Facoltativamente impostare `DISCORD_ALLOWED_ROLE_IDS`. Senza questi limiti ogni account Discord può registrarsi agli show di cui conosce il link. La conoscenza di un link non deve essere trattata come una verifica di appartenenza.
5. Gli utenti sono partecipanti senza accesso alla regia. Assegnare **esplicitamente** `DISCORD_OPERATOR_ROLE_IDS` e `DISCORD_ADMIN_ROLE_IDS` solamente se si vuole usare Discord anche per gli operatori. Questi ruoli richiedono il server configurato. Nessuna promozione basata su soprannome, email, sola appartenenza o dati inviati dal browser. I privilegi Discord durano al massimo 15 minuti; le modifiche ai ruoli esterni hanno effetto alla nuova autenticazione, non sono monitorate in tempo reale.
6. Completare `PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTACT_EMAIL`, `PRIVACY_HOSTING_REGION` e la versione dell'informativa. Il campo hosting deve identificare fornitori, localizzazioni e garanzie sui trasferimenti applicabili. Integrare l'informativa `/privacy` se l'organizzazione richiede ulteriori informazioni, DPO o rappresentanti. Impostare `PRIVACY_REVIEWED=1` solo dopo verifica delle condizioni effettive.
7. Eseguire un'autenticazione reale, verificare ruoli, export, cancellazione, log e logout su più dispositivi. Senza credenziali reali i test usano un provider simulato e non attestano che callback, DNS, certificati o permessi Discord funzionino in produzione.

Il login rimane spento se mancano impostazioni essenziali. Non abbassare questi controlli per far apparire l'ambiente pronto.

## Dati e tempi

| Dato | Trattamento e conservazione |
| --- | --- |
| ID Discord | Usato in memoria per derivare un identificativo HMAC con la chiave del servizio; non salvato in chiaro. Il riferimento pseudonimo resta dato personale. |
| Email, avatar, messaggi, amici, data di nascita | Non richiesti come scope né conservati dall'integrazione. La risposta `identify` viene ridotta al solo ID; altri campi vengono scartati. |
| OAuth access/refresh token | Solo in memoria durante il controllo; revoca richiesta anche se fallisce il controllo dei ruoli. Non salvati. Se la rete/Discord rifiuta la revoca, non si può garantire l'invalidazione prima della scadenza del provider. |
| Sessioni locali | Cookie opachi HttpOnly, SameSite=Lax, Secure in HTTPS, prefisso `__Host-`; nel registro persistono solo hash del token, finalità e scadenza. Partecipanti 12 ore, regia Discord 15 minuti, regia locale 8 ore. Pulizia ogni minuto. |
| Soprannome, iscrizioni e check-in | Correggibili/esportabili/cancellabili da `/account`. Account inattivi e iscrizioni collegate eliminati dopo 30 giorni più massimo un'ora; `PARTICIPANT_RETENTION_DAYS` ammette 1–90 giorni. |
| Voti | Un identificativo HMAC diverso per turno, senza account nei log di voto. Un voto per account e turno anche da due browser. Scelte individuali eliminate alla chiusura; rimangono i totali. I turni durano 30 secondi per default, configurabili fra 5 e 180. Un account non prova l'identità di una persona. |
| Informativa | Versione e momento della presa visione; nessun consenso marketing implicito. |
| Backup del gioco | Cifrati, con autenticazione prima dell'estrazione; escludono account, sessioni, log e registro notifiche. Snapshot dell'hosting e backup MySQL sono gestiti separatamente dal titolare. |

I vecchi registri e i campi liberi del software possono contenere nomi, città e altri dati inseriti per condurre una puntata. Non sono parte della risposta OAuth; il gestore deve comunque definirne finalità, accessi, conservazione e gestione dei diritti. La cancellazione self-service riguarda account Discord locali, iscrizioni, sessioni e voto in corso. Per eliminare dati inseriti negli show, registrazioni video, pubblicazioni Discord o archivi storici il gestore deve gestire anche questi sistemi. Non promettere che la cancellazione locale cancelli contenuti già pubblicati o tutti gli archivi del servizio.

## Base giuridica e diritti

L'informativa distingue l'erogazione del gioco richiesto dall'interesse legittimo alla sicurezza. Il titolare deve confermare che la base giuridica scelta sia applicabile, documentare necessità e bilanciamento e integrare l'informativa quando serve una base diversa. La presa visione dell'informativa non è un consenso universale. Il login non autorizza la registrazione o pubblicazione di voce, immagine o nome reale.

Non sono installati analytics, tracker o cookie pubblicitari. I cookie di autenticazione e anti-CSRF sono necessari al servizio: nessun banner di consenso fittizio. Verificare comunque la disciplina locale delle comunicazioni elettroniche e ogni script/tema aggiunto in seguito.

Predisporre una procedura per accesso, rettifica, cancellazione, portabilità, limitazione e opposizione, per verificare il richiedente in modo proporzionato e rispondere nei termini applicabili (GDPR: ordinariamente un mese, salvo estensione motivata prevista dalla legge). Indicare l'autorità di controllo competente e permettere i reclami. Non discriminare chi esercita i diritti. Valutare UK GDPR, LGPD, norme statali USA e altre discipline soltanto nei territori e alle condizioni in cui si applicano; non dichiarare una conformità globale automatica.

Valutare ruoli di titolare/responsabile dei fornitori, accordi ex art. 28 quando necessari, trasferimenti extra SEE, eventuali SCC/altre garanzie e relativa valutazione; non assumere che la sola regione di hosting risolva i trasferimenti verso Discord. Documentare misure di sicurezza, autorizzazioni, cancellazione di snapshot, incident response e notifiche di violazione applicabili.

## Minorenni

La versione corrente riserva questo login agli adulti: soglia minima 18 anni o superiore configurata, dichiarata dall'utente senza raccogliere data di nascita o documenti. Questa non è una verifica forte dell'età. Non è implementato un percorso per consenso genitoriale o verifica dei requisiti locali dei minori. Per ammetterli occorre progettare e verificare separatamente tale percorso, inclusi requisiti Discord e del Paese; non basta abbassare una variabile. Il gestore deve verificare se la dichiarazione sia sufficiente per il proprio servizio.

## Bot opzionale

Il bot degli annunci è separato dal login e non usa i token OAuth dei partecipanti. Impostare `DISCORD_BOT_TOKEN`, `DISCORD_ANNOUNCEMENT_CHANNEL_ID`, `DISCORD_GUILD_ID` e `DISCORD_ANNOUNCEMENTS_ENABLED=1` solo dopo aver autorizzato l'integrazione. Usare i soli permessi necessari per inviare messaggi e, se desiderato, gestire eventi programmati; non richiedere accesso ai messaggi privati o l'intent del contenuto dei messaggi.

Ogni evento pubblico richiede inoltre opt-in nella scheda Calendar. I promemoria vengono inviati a 24 ore, un'ora e all'inizio; il risultato finale pubblica il solo premio, senza identità del concorrente. `allowed_mentions` è vuoto. Il pulsante di sincronizzazione crea/aggiorna l'evento Discord e permette di propagare una cancellazione. Dopo modifiche/cancellazioni sincronizzare nuovamente; eliminare un evento locale non elimina automaticamente quello Discord. Le consegne fallite o incerte non vengono ritentate alla cieca, per evitare messaggi duplicati. La cronologia tecnica delle consegne viene pulita dopo 30 giorni quando il bot è abilitato.

## Fonti consultate

- Documentazione ufficiale Discord OAuth2: https://docs.discord.com/developers/topics/oauth2 — letta dal repository ufficiale `discord/discord-api-docs`, commit `aaef8ae4c3398fcdabeec0d1dd5a3e69be587ad8`, percorso `developers/topics/oauth2.mdx`.
- Discord privacy: https://discord.com/privacy e Developer Policy: https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy . Verificare le condizioni applicabili alla propria app.
- GDPR, Regolamento (UE) 2016/679: https://eur-lex.europa.eu/eli/reg/2016/679/oj . Riferimento giuridico per la verifica del titolare, non una certificazione prodotta dal software.
