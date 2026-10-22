# Millionaire Web

On first administrator sign-in, the application opens a setup wizard at `/setup` for site, Discord and privacy settings. These can also be edited under Admin → Impostazioni; secrets are encrypted on the server. Environment variables are optional defaults for these application settings, rather than a required manual setup step.

> Updated live workflow: see [Preparation, recovery and backups](docs/OPERATIONS.md) and [Discord login and privacy](docs/DISCORD-PRIVACY.md). New shows start in rehearsal; live participation uses Discord/check-in, approved frozen questions and an isolated HTTPS output hostname. `npm test` and `npm run test:browser` verify the new workflow. The legacy reference below describes the original integrations; the two guides take precedence for authentication, theme upload permissions and live operation.

Web platform for the Project Rave HTML5 "Who Wants to Be a Millionaire?" controllers: show control from the browser,
audience keypads on phones, theme packs uploaded to the server, several shows running in parallel.

It uses the same bridge as the desktop Millionaire Controller (`public/bridge.js` = `NetBridge.js`), so every game
feature verified on the stock themes works the same way.

## Pages

| Page | URL | Who |
|---|---|---|
| Home page | `/` → `/home` | operators and administrators, after signing in |
| Control panel | `/control` | operators and administrators (user name and password) |
| Game output | `/output/<show>?t=<secret>&bg=black` | OBS browser source or a full-screen browser |
| Host screen | `/host/<show>` | the host (its own password, set per show) |
| Player screen | `/player/<show>` | the contestant (its own password, set per show) |
| Audience keypad | `/v/<show>` | the audience's phones (QR code in the panel) |

Each **show** is a separate room with its own theme, questions, contestant, output and audience votes.

## Install version 1.0

Download **millionaire-web-1.0.zip** from the [GitHub release](https://github.com/hyperm03/wwtbam/releases/tag/v1.0). Use **Node.js 24 LTS** with npm:

```bash
unzip millionaire-web-1.0.zip
cd millionaire-web-1.0
npm ci --omit=dev
npm start
```

Open `http://127.0.0.1:13410`, sign in as `admin` using the generated password in `data/admin-password.txt`, and follow the setup wizard. Discord credentials, site URLs and privacy settings are requested in the application; no manual `.env` file is required. For initial rehearsals choose “Configura in seguito — solo prove”.

See **[INSTALLAZIONE.md — guida completa in italiano](INSTALLAZIONE.md)** for VPS/systemd, HTTPS, Discord setup, theme installation, data persistence and backup instructions. The default listener is `0.0.0.0:13410`: use `HOST=127.0.0.1 npm start` for local-only tests on Linux/macOS, and a private listener behind an HTTPS proxy on a VPS. Theme packs are supplied separately.

## Using it

1. **Themes tab.** Upload theme zips. A zip can hold one theme or a whole pack: every folder with a `default.html` becomes a theme.
   - Zips are extracted with strict checks: no paths outside the folder, no symlinks, size and file-count limits.
   - Themes contain scripts that run on the output page, so only upload packs you trust.
2. **Create a show** ("+ New show") and choose its theme.
3. **Output & audience links.**
   - Put the output link in an OBS browser source at 1920x1080.
   - In a normal browser, click the page once to enable sound.
   - The link is secret: "New secret link" replaces it.
4. **Show tab**, same layout as the desktop app:
   - lifeline tabs with the theme's own graphics;
   - big buttons, question, coloured answers and show control, including K Klaxon;
   - money tree mirror: click a level to restart from that question;
   - game keys also work on the keyboard.
5. **Ask the Audience** tab. Choose where the graph percentages come from:
   - the game's random ones;
   - manual ones;
   - **live audience votes**.

   With "Open voting automatically", the phones can vote while the game is in its "Start voting" step. The graph receives the live percentages and shows them at "Reveal the results". One vote per phone per voting round.
6. **Questions tab.**
   - Edits are saved on the server and sent to the game automatically.
   - Questions can be imported from, or saved into, the theme's XML files.

7. **Questions tab: Import from question builder...**
   - Set the builder address (on the same VPS: `http://127.0.0.1:13400`) and the path of the page that returns the questions as JSON.
   - The request is made by the server, only to that address.
   - The JSON is recognised automatically:
     - a list of questions, `{questions: [...]}`, separate main/replacement lists, or several named sets;
     - `question`/`text`, answers as an array or as `a`-`d`;
     - the correct answer as a letter, an index or the text itself;
     - `level`/`number`.
   - Choose a set and import the main and/or replacement questions.
8. **Questions tab: Generate with AI...**
   - Engines: Google Gemini (the API key is stored encrypted on the server and never sent back to the browser) or a local Ollama server (e.g. `localhost:11434`).
   - Same difficulty ladder, rules and checks as the desktop app:

     | Levels | Difficulty |
     |---|---|
     | 1-5 | easy |
     | 6-9 | harder |
     | 10-14 | hard |
     | 15 | the hardest |

   - Progress is shown batch by batch and the generation can be cancelled.
   - Tick the questions to keep and apply them: they are saved and sent to the game.
9. **Themes tab: Money tree...** on every theme. Same features as the desktop app, written directly into the theme's `Scripts/Variables.js`:
   - amounts, locale, currency and thousands separator;
   - top prize texts, e.g. "$1 MILLION", with the automatic text that follows amount, currency and language ("1 MILIONE €");
   - the game's second number format.

   A backup is kept as `Variables.js.bak`. "Save and reload shows" applies it at once.

## Klaxon and closing

K plays the theme's own klaxon: every theme plays `Sounds/game_over.mp3` through its `startGeneralSound()` at the start of its "G" closing sequence, and stops the bed and lifeline music half a second later. K does exactly that, without the rest of the closing sequence.

## The output is display only

Real keyboard, mouse, touch and wheel input on the output page never reaches the game. The lock is installed before the theme finishes loading, and again by the bridge.

The game is driven only from the control panel, through the server. The only clickable thing on the output is the "click to enable sound" notice outside OBS.

The game starts on the logo (commercial) and the rules introduction, exactly like the original controller: C, then the ◀ Rules / Money tree sequence, before the first question.

## Users and roles

Sign in with a user name and password.

- **admin** (built-in): uses `ADMIN_PASSWORD` if supplied by the host, otherwise the generated password in the protected `data/admin-password.txt` file. It works without MySQL.
- **Other accounts** are created in Admin → Users (MySQL needed), with two roles:
  - **Operator:** shows, questions, stacks, AI generator, money tree.
  - **Administrator:** also connections, users, system log, theme uploads and deletions.

## MySQL / MariaDB

Admin → Connections → MySQL:
- host `127.0.0.1`, port `3450`, user, password and database (the database must exist);
- "Test", then "Save and connect";
- the tables (`users`, `question_stacks`, `stack_questions`, `logs`) are created automatically;
- the password is stored encrypted.

Create the database and a user once, for example:

```sql
CREATE DATABASE millionaire CHARACTER SET utf8mb4;
CREATE USER 'wwtbam'@'127.0.0.1' IDENTIFIED BY 'a-strong-password';
GRANT ALL ON millionaire.* TO 'wwtbam'@'127.0.0.1';
```

Without MySQL the platform still works: only the built-in admin can sign in, stacks are unavailable and the log goes to `data/system.log`.

- **Question stacks** (Questions tab):
  - every AI generation is saved automatically;
  - you can save a show's questions, or a set imported from the question builder, as a stack;
  - a stack can be loaded into any show (main, replacement or both), renamed or deleted.
- **System log** (Admin → System log):
  - sign-ins, failed sign-ins, show actions (restart from a level, klaxon, game over, lifelines, reloads), questions, stacks, AI, themes, money tree, users and connections;
  - each entry has the user, the show and the IP;
  - filters by action, user and show.

## Host and player screens

In "Output & audience links", each show has a **Host screen** and a **Player screen** with their own password (at least 4 characters). A screen is disabled until its password is set. Changing the password signs out every screen already open.

Both are 1920x1080 and scale to the window. They use the question, answer and money tree graphics of the studio system.

- **Player screen**: what the contestant sees.
  - The question and the answers as they appear on air.
  - The locked answer in orange, the correct one in green only when the game reveals it.
  - The money tree with the lifelines, and the contestant's name.
- **Host screen**: the same (the answers appear together with the game output), plus:
  - the **correct-answer square**: empty until the final answer is locked, then **green** if it is right, or **red with the letter of the correct answer** if it is wrong;
  - **messages from the control room**: "Message to the host" in the Show tab shows a yellow strip on the host screen, between the answers and the boxes; "Clear" removes it. Every message and every clear is in the show log and the system log;
  - the **host comment**, switched on and off by hand with "Host comment: ON/OFF" in the control panel;
  - the boxes, for the question being played:

    | Box | Shows |
    |---|---|
    | blue | Away: questions left |
    | orange | amount already won (walking away) |
    | green ✓ | amount for a right answer |
    | red ✗ | safe level kept on a wrong answer |
    | cyan ▼ | what a wrong answer loses |

- **Ask the Audience results** (answer and percentage for A, B, C, D) and the **Phone a Friend clock** appear on both screens while they are on air: in the comment area on the host screen, in the same place on the player screen.
- **"TOTAL PRIZE WON"** is shown in the top lozenge only when the contestant walks away, with the amount taken home. Between questions the lozenge stays empty.
- What the player screen must not know is filtered by the server: the correct answer before it is revealed, the host comment and the boxes never reach the player's browser.

## Cancel a final answer

Picked the wrong answer by mistake? "Cancel final answer" (under the answers, active only while an answer is locked and not yet revealed) uses the game's own undo:
- the answer is unlocked;
- the question music starts again;
- the question is back in play, waiting for the final answer.

It is recorded in the show log.

## Ending a show

On the Shows page a show that is open has **End show**:
- it is recorded as ended, with who ended it and when;
- the game output, the host and player screens and the audience phones are closed, and they cannot reconnect;
- the control panel stops sending commands to it;
- the log is kept.

**Reopen** makes it usable again.

## Question bank and stack builder

The **Question bank** tab holds every question of the system (MySQL needed).

- **Unique ID:** every question has a permanent ID (`Q-000123`), shown in the editor, the stacks and the logs. Importing the same question again, even with the answers in another order, is recognised as a duplicate.
- **Status:** tracked automatically.

  | Status | Meaning |
  |---|---|
  | available | not in any stack |
  | in a stack | the builder will not reuse it |
  | used | it went on air in a show |

  A question is marked **used** the moment it appears on the game output, with show, game and time. Questions typed by hand get their ID at that moment.
  Administrators can mark questions as not used again, for example for a rerun.
- **Difficulty (1-15), hybrid:**
  - from the file (a Difficoltà/Difficulty column, 1-15 or easy/medium/hard, or a "Livello"/"Difficoltà" line);
  - set by hand in the table;
  - or rated by AI. The AI only rates what has no difficulty; file and manual values are never changed.

  Each difficulty shows where it came from.

The page has four tools:
1. **Import a file** straight into the bank. Any size: 1500 questions import in well under a second.
2. **Generate with AI:** N questions per level, already rated.
3. **Rate the difficulty** with AI, 40 questions at a time, with progress and cancel.
4. **Build stacks:**
   - stacks of 15 ("Stack 1", "Stack 2"...) with one question per difficulty level and varied subjects;
   - as many as the available questions allow, or a given number;
   - optional tolerance of ±1/±2 levels when a level runs out;
   - replacement questions filled automatically or left empty.

   Each question goes into one stack only.
5. **Random stack:** one available question at random for each difficulty level, as a main-game stack, a replacement stack or both. The new stack opens at once, so you can check or change any slot.

Below the tools, a table of all questions with search, filters (status, difficulty, unrated), editing, the difficulty per question and group actions.

In the Questions tab every stack has **Edit**: each slot, main and replacement, can be changed with a question from the bank (same difficulty first), filled automatically or emptied (the question goes back to the bank). Deleting a stack puts its questions back as available.

Every question saved into a stack, generated by the AI or imported from the question builder also enters the bank with its ID. The file importer has "Send all to the question bank".


**Generating questions for one level:** in the Question bank tab, "2 · Generate with AI" has two modes.
- **Every level:** N questions for each of the 15 levels.
- **One level:** N questions, up to 100, all for a single level, e.g. 10 questions for question 15. The model writes them five at a time, each on a different subject. It is told the questions of that level already in the bank, so it does not repeat them, and the duplicates it returns anyway are dropped. If it writes fewer than asked, the missing ones are asked again; after two requests in a row with nothing new it stops and says how many it wrote. The questions enter the bank with that level as their difficulty.

## Shows page and show log

The **Shows** tab lists every show: theme, who created it and when, games played, number of logged events, and what is live now (outputs, host and player screens, phones, question in progress). From there you can open, rename or delete a show.

"Log" opens the **detailed log of that show**, from its creation to the end of every game. It updates live while the show runs. The events have five types:

| Type | What is logged |
|---|---|
| Show | creation (by whom), rename, theme, new output link, screen passwords, money tree changes, deletion |
| Control | every command from the control panel, with the user: each key ("Pressed Next", "Pressed Final answer B"), restarts from a level, edited questions, imports, AI generations, audience settings, reloads |
| Gameplay | what actually happened on air, read from the game itself (see below) |
| Audience | voting opened and closed with the results, every single vote |
| Screens | the game output and the host and player screens connecting and disconnecting, screen sign-ins, wrong screen passwords |

The gameplay events include:
- question on screen with its text, each answer as it appears, final answer locked;
- CORRECT or WRONG with the right answer;
- winnings, question being played with its amounts;
- lifelines used and each of their steps: 50:50 with the answers removed, the audience results, the Phone a Friend clock;
- walk away, commercial breaks, money tree.

Events are grouped by **game**. A new game starts with a new contestant, or with the first question after the previous game ended (wrong answer, walk away, top prize).

In the log view you can:
- filter by game, type or text;
- export CSV (opens in Excel) or JSON;
- clear the log (administrators only).

The log is stored in MySQL (table `show_events`), or in `data/showlogs/` without a database, and it is kept when a show is deleted.

## Import questions from files

Questions tab → **Import from file...**

- **Formats:** Word (`.docx`, `.doc`), PDF, text (`.txt`, `.md`, `.rtf`), Excel (`.xlsx`), CSV/TSV, JSON (question builder formats) and the themes' `questions.xml`.
- **Layouts understood automatically:**
  - numbered questions or lines ending with "?", followed by answers "A) ... B) ..." (also on a single line);
  - the correct answer marked in any of these ways: **bold in Word**, an asterisk or ✓, "(corretta)", a line "Risposta: B" / "Answer: Mars", or an answer key such as "1-B 2-C" at the end;
  - "Livello 7" / "Level 7", a "Riserva" / "Replacement" heading, "Categoria:" and "Commento:" / "Note:" for the host.
- **Tables:** columns such as Livello, Domanda, A, B, C, D, Risposta corretta, Categoria, Commento, Tipo.
- **Read it with AI instead:** for documents with an unusual layout, the configured AI engine extracts the questions. It is told never to invent anything, and it marks with "?" a correct answer the document does not give.
- **Result table:**
  - choose where each question goes (level 1-15, main or replacement, or Skip). The suggestion comes from the level written in the file, otherwise the free levels in order;
  - fix the correct answer where it is "?";
  - apply to the show, optionally also saving the questions as a stack.

### Custom graphics and fonts of the screens

- **Custom graphics:** put your own graphics for the host and player screens in **`data/screens/`**, with the same file name as the built-in one (e.g. `Q4ALoz.jpg` for the question and answer lozenges, `QLozASel.jpg` for the locked answer). They take precedence over the built-in ones and are not overwritten by updates.
- **Automatic fit:** the screens **measure the lozenge picture** in use when they start: the connecting lines, the tips of every lozenge, their height and the slant of their tips. The question, the answer texts and the orange/green overlays then follow that picture, whatever its design. Lines and borders are recognised as bright blue-dominant pixels. If a picture cannot be measured, the built-in positions are used.
- **Fonts:** questions and answers are shown in **Conduit ITC**, taken from the `Fonts` folder of the show's theme (or installed on the computer).

## Windows apps

The platform also runs as a Windows app (the `desktop` project), with a separate **FFF Client** for the Fastest Finger consoles that finds the central console on the local network (UDP 13412). `GET /api/ff-public/shows` lists, without signing in, the id and name of the shows whose Fastest Finger consoles are on. See `desktop/README.md`.

## Roblox set

The **Roblox** tab links a show to a Roblox set, such as the TPH studio. The control room drives the game, and every moment is played by the set with its own lights, graphics, sounds and screens.

**How it works**
- The Roblox game server cannot be called from outside, so the `MillionaireLink` script asks the platform for the show's commands about every 0.35 s, well under Roblox's limit of about 500 requests a minute. It authenticates with the show's secret key.
- Every control button of the set registers on a **button bus**, the `MillionaireButtons` module. The web control room therefore **presses the very same buttons** a person would click, and their logic is not rewritten.
- Before "question on screen", the control room's question (answers, correct letter, 50:50) is loaded into the set's own `QuestionModule` and `Values`. The set then shows it as one of its own. The same goes for the Fastest Finger question and the contestant's name.
- Buttons pressed by hand in the game are written to the show log, with the name of who pressed them.

**The tab**
- **Link:** on/off, status of the connected servers (place, players), key (new key), download of the scripts (`MillionaireLink.lua` is already set for the show) and the installation steps.
- **Buttons of the set:** every button the set reported, grouped and searchable. Click one to press it in the set, e.g. applause, songs, gags, cameras, cues, cash.
- **Game events → buttons:** for each moment of the game, the buttons pressed in the set, in order. The moments: question on screen, final answers A-D, correct, wrong, question off screen, money tree, walk away, game over, commercial, every step of every lifeline, Fastest Finger, klaxon… The defaults match the TPH set (ShowQuestionAnswers, AnswerA-D, ShowCorrect, HideQuestion, ShowHideTree, PlayerExit, MeetTheContestants, ShowFFFQuestionAnswers, RevealFFFOrder, RevealWhoGotIt), and you can change them.

**Installation in the place (once)**
1. Save a copy of the place.
2. In ServerScriptService, put the ModuleScript `MillionaireButtons` and the Script `MillionaireLink`.
3. Studio → View → Output, then View → Command Bar: paste `Install.lua` and press Enter. It is a single line, because the command bar may keep only the first line of a pasted text. The Output shows `[Millionaire] … button scripts linked`. In every server script that connects a click, `X.MouseClick:Connect(` becomes `__MB.connect(X, `, and nothing else changes. On the TPH set this links 516 scripts. The originals are kept in `ServerStorage/MillionaireBackup`, and `Uninstall.lua` restores them.
   Alternatively, use the **Studio plugin** `MillionairePlugin.lua`, from the Roblox tab: paste it in a Script, right-click → *Save as Local Plugin*, then delete the Script. The Plugins tab gets three buttons:
   - **Link the set** (the installer);
   - **Restore**;
   - **Check**: a diagnosis of the modules, linked buttons, HTTP requests, `BaseUrl`, key and a live test of the control room.
4. Game Settings → Security → **Allow HTTP Requests**. The platform must be reachable over HTTPS at its public address.

**Lifelines:** each lifeline slot of the set has a type (`LifelineNumber`) and steps through it with `LifeControl`. In the mapping, `lifeline:<type>` stands for "the LifeControl of the slot holding that lifeline", and the set resolves it whatever slot you put the lifeline in. The types are: 1 50:50, 2 Phone a Friend, 3 Ask the Audience, 4 Ask the Host, 5 Double Dip, 6 Ask the Expert (clock), 7 expert in the studio, 8 Switch the Question. The defaults follow the steps of the TPH Classic 2002 set:
- 50:50: two presses;
- Phone a Friend: start, clock, end;
- Ask the Audience: start, vote, results, close;
- Switch the Question: start, reveal, switch, then the new question;
- Ask the Expert: start, clock, end.

Several presses for one moment run 0.2 s apart. A show that never changed its mapping always follows the current defaults.

**The graphics over the Roblox stream:** Roblox cannot show a web page inside the game, so the HTML5 graphics go over the game in OBS:
- the Roblox game capture goes below;
- the **OBS overlay** link of the Roblox tab goes above, as a browser source of 1920x1080.

The overlay link carries `&bg=transparent&start=tree&sound=off`:
- **transparent:** only the graphics, with nothing behind them;
- **`start=tree`:** it starts with nothing on screen and out of the commercial break (no logo, no "hello" music), ready for the opening money tree. The first left arrow starts the rules and the money tree;
- **`sound=off`:** every sound of the theme is muted, because music and sounds come from the set; the "click to enable sound" request does not appear either.

These options also work on any output link, and they survive reloads and theme changes.

**Note:** the game engine is the theme's output page, so **the game output must be open** during the show, for example as an OBS browser source, even if hidden, or in a browser tab.

## Layout editor

Admin → **Layout** tab: edit the **host screen**, the **player screen** and the **Fastest Finger console** for the whole platform. Each installation, e.g. each network, has its own layout.

- **Preview:** the chosen screen, at real size, filled with sample data. Choose the moment to show (question and answers, final answer locked, correct answer, Ask the Audience, Phone a Friend, walk away, between questions; for the console: answering, locked, result...). For the console, also choose the device (tablet, PC, phone).
- **Select:** click an element in the preview, or pick it from the list. Elements of the same kind (e.g. the four answer texts, the A B C D keys) change together.
- **Move and resize:** drag to move, the orange handle to resize, the arrow keys to nudge (Shift = 10 px). The console has a flowing layout, so its elements are not dragged, but everything else applies.
- **Properties:** position, size, font, text size, weight, style, alignment, spacing, text colour, background colour, picture (upload your own), border colour, corners, opacity, layer, and visible / hidden. "Back to the original" resets an element, "Reset all" the whole screen.
- **Undo / redo:** Ctrl+Z / Ctrl+Y.
- **Export / Import:** a JSON file, e.g. to copy a layout to another installation (pictures must be uploaded there again).
- **Live:** every change is saved and applied **live** to every open screen and console.
- **Storage:** layouts are stored in `data/layouts.json` and pictures in `data/layout-assets/`. The pages themselves are never changed, so updates of the program keep the layouts. Only known properties with safe values are stored; the CSS is built from them, never copied as text.

## Multi-community platform (multi-tenant)

One installation serves many communities (TPH and others), each on its own domain, with its own users, shows, question bank, calendar, layouts, Roblox links, settings and branding.

**How it works**
- **The gateway** (`gateway.js`) is the only process facing the network. It recognises the community from the **domain** of the request and forwards it, HTTP and WebSocket, to that community's **engine**.
- **Every community has its own engine:** the platform (`server.js`) in its own process, with its own data folder (`data/tenants/<id>`). A community cannot reach the data of another one: the separation is between processes, not just in the code.
- **Supervision:** the gateway restarts an engine that stops, waiting longer each time.
- **Visitor addresses:** they reach the engines intact (also behind Nginx Proxy Manager), so the protection against repeated sign-in attempts works per visitor.

**Super-admin panel** (`/_superadmin`, on any address that is not a community's, e.g. `admin.example.com` or the server's IP; password `SUPERADMIN_PASSWORD`):
- **Communities:** create (id, name, domains, admin password), edit the domains, suspend / resume, restart, new admin password, engine log, delete. Deleting archives the data in `data/tenants-archive` and destroys nothing.
- **Status:** state, restarts and memory of every engine (about 140 MB each).
- **Global themes:** a theme library offered to every community.
  - A community cannot replace or delete a global theme.
  - When a community changes one (money tree, questions), it gets its own copy, so the change never reaches the others.
  - A community can upload its own theme with the same name, which takes precedence for it.

**Branding:** every community has its name, logo and invitation texts (`data/tenants/<id>/branding.json`); new communities get a neutral logo. Without `branding.json` (single installation) everything stays TPH.

**Starting it:**
- **With the installer:** `--multi-tenant`, which also turns an existing installation into the multi-community platform.
- **By hand:** `node gateway.js` with `DATA_DIR`, `PORT`, `TRUST_PROXY=1` behind a proxy, `SUPERADMIN_PASSWORD` and `PUBLIC_SCHEME=https`.

**From a single installation:** at the first start the gateway turns it into the community `tph` (`MIGRATE_TENANT_ID`, `MIGRATE_TENANT_NAME`), with all its data, the domain of `PUBLIC_URL` and its admin password.

**In Nginx Proxy Manager:** every domain (the communities' and the admin one) forwards to the same platform (port 13410, WebSocket support on). The gateway does the rest.

## Info / About

Admin → Info / About.

## Home page and calendar

- **The address of the site** (`/`) opens the login page, then the **home page** (`/home`). It has tiles for:
  - the control room;
  - questions and stacks;
  - the question bank;
  - the calendar;
  - shows and logs;
  - themes;
  - administration (admins only).

  It also lists the shows on air now and the next events on the calendar. "Millionaire Control" at the top left of the control panel goes back to it. Links such as `/control#bank` open that tab directly.
- **Calendar tab** in the control panel. Each event has:
  - a title;
  - date and time, entered in local time;
  - a duration;
  - a linked show (optional; the event is marked LIVE while it is on air);
  - an optional link;
  - notes.

  Events can be edited, cancelled, restored or deleted. The calendar is stored in `data/schedule.json` and works without MySQL.
- **Creating an event:**
  - **"+ New show for this event"** (the default) creates the show in the Shows section with the same name, already linked;
  - an existing show can be linked instead, or none;
  - **Live** marks a live show;
  - **Where** / **Link of the place** default to the **TPH Discord server** (https://discord.gg/QZMmsRTKrw).
- **Invitation link:** every event gets a public page `/e/<code>`. The code is random, so only people with the link find it. The link is shown after saving and in the list, with Copy and Open. The page shows:
  - the TPH logo, the title, and LIVE / Not live;
  - date and time in the visitor's own time zone, with a countdown;
  - the place, with "Join the TPH Discord server";
  - "Add to my calendar" (an `.ics` file for Google, Apple and Outlook calendars);
  - the watch link, if any, and the description.

  While the linked show is on air it turns to ON AIR NOW, with "Vote with your phone". It also shows when the event is cancelled or ended.

  Shared on Discord, the link shows a preview card with title, date, place and logo. The page never exposes output links, tokens or show ids. Set `PUBLIC_URL` in the service so the links and the preview use the public address.
- **TPH branding:**
  - the circular TPH logo is at the top left of the control panel and the home page (a link to the home page), and on the login page;
  - the orange TPH logo is the favicon of every page.
- **Always the files of the running version:** every start of the server gets a build number, and the pages load their scripts with `?v=<build>`. After an update, browsers and proxies (including Nginx Proxy Manager with "Cache Assets" on) cannot keep using old files.

## Fastest Finger First

A complete Fastest Finger First for every theme: the 9 classic themes and Clocked. The contestants play on **consoles**: tablets, touch PCs or phones, in the room or remote.

**The consoles** (`/ff/<show>`, protected by the Fastest Finger password set in the tab):
- **At the top:** name and hometown (the player enters them; the control room can change them).
- **The strap:** shows the order being composed, and **OK** once the four letters are in.
- **In the middle:** the question and the four items with their A B C D badges.
- **At the bottom, the keys:**
  - **red ⌫** deletes the last letter;
  - **A B C D**;
  - **green ✓** confirms and locks the answer.

  On PCs the keyboard works too: A-D, Backspace, Enter.

There are two ways to connect:

| Console | Link | Behaviour |
|---|---|---|
| Physical | `/ff/<show>?seat=N` | fixed to seat N, stays awake, full screen button |
| Remote | `/ff/<show>` | takes the first free seat and keeps it when reconnecting |

Every console remembers its player's name.

**The dashboard** (Fastest Finger tab):
- **Consoles:** password, the remote link, and one link per seat for the physical consoles.
- **10 seats:** connected, name (click to change), console or remote, network delay, and "plays" (choose who plays this round: all 10, or 3, 4, 5, 6...). Quick choices: all connected / first N / none. "Free" releases a seat.
- **Round:**
  - choose the question (a random unused one, or from the list) and the time limit (default 20 s), then **Prepare the round**;
  - then **← Next** plays the theme's Fastest Finger sequence, with the name of the next step:
    1. the players are introduced;
    2. the question, then **the four items on air**: the consoles open at that very moment;
    3. the correct order, item by item;
    4. the times, the fastest, the winner on full screen.
  - Live, it shows the countdown and who has answered, then the results table.
- **Questions:** list with search, add, edit, delete, "Unused again", and import from CSV / Excel (columns Domanda, A, B, C, D, Ordine corretto; the Fastest Finger file of the UK rehearsal database imports as it is).

**Fair times:**
- each console measures its own time from the moment it shows the four items;
- the server checks it against its own clock minus that console's network delay, measured every 2 seconds, so no console can claim to be faster than it really was;
- times are to the hundredth of a second, as on air.

**Results, ties and the winner:**
- The fastest correct answer wins.
- **Tie:** two or more players correct with the same best time (e.g. 5.77 s) → **Start the tie-breaker** with another question, for the tied players only (the output skips the introductions). It repeats until there is a single winner.
- **Nobody correct** → **New question for the same players**.
- **The winner becomes the show's contestant automatically** (name strap, new game in the log) when the game shows them on full screen.
- **Answers close by themselves** when the question leaves the screen (the "hide the question" step), if they are still open. The times always reach the graphics before they are revealed.
- **Without a single winner** (tie, or nobody correct) the control room cannot play "flash the fastest" and the winner screen: a message says to start the tie-breaker or a new question.
- Each player sees their own result on the console once the times are on air.
- Questions are marked as used when they go on air.
- Everything is in the show log: the round, every answer with its time, closing, ties, winner, consoles connecting.

Rounds with fewer than 10 players show only their rows in the theme's graphics. Some themes may need a small adjustment of the layout.

## Theme files and shared fonts

- **Upper and lower case:** a file a theme asks for is found even when the case differs (`Fonts/RG2014EEM.ttf` vs `fonts/rg2014eem.TTF`). Theme packs made on Windows work on Linux without renaming anything.
- **Shared fonts:** a font the theme asks for but does not ship is taken from:
  - the fonts bundled with the platform (`public/fonts`). **Roadgeek 2014** is included (MIT licence, © Sammi De Guzman, see `public/fonts/roadgeek/LICENSE.txt`); it is the font of the Clocked money tree and categories;
  - `data/fonts`: drop any font file you own there (for example Copperplate) and it is used by every theme that asks for it.
- **Font bridges:** a few themes use font names they never declare, relying on fonts installed on the author's computer:
  - Clocked: "Arial Narrow" (gold clock, banked time) and "DIN" (audience percentages);
  - 2002_Classic: "Conduit ITC" (audience percentages).

  The output page links those names to the files already in the theme's `Fonts` folder. The installed font, when present, still comes first, so nothing changes on a computer that has it.
- **Automatic @font-face repair:** in CSS an unquoted font name cannot contain a word starting with a digit. `font-family: Roadgeek 2014 Series B` is invalid, and browsers drop the whole declaration; it only worked where the font was installed. The server finds these declarations in the theme's stylesheets and adds a corrected copy (quoted name, same files) to the output page. This affects:
  - Clocked: the 7 Roadgeek 2014 fonts, including the money tree amounts and the categories;
  - 2002_Classic and OlgaV3: Copperplate Gothic Std 31 AB.
- **The control panel money tree** uses Copperplate Gothic Bold: from the theme's `Fonts` folder (e.g. `CopperplateBold` in Clocked), or from the shared fonts, otherwise the copy installed on the computer.


### Who can upload themes

- **Administrators** can upload themes in the **Themes** tab.
- **Replace and delete:** an operator can replace and delete only the themes **they uploaded**; an administrator can do it for every theme.
- **Themes without an owner:** themes installed before this version, or copied by hand, have no owner, so only administrators manage them.
- **Without "Replace":** a theme with a name already in use is added as a copy ("Name (2)").
- **A whole pack:** replacing a pack is refused entirely, before anything is installed, if even one of its themes cannot be replaced by that user.
- **After a replacement** the theme keeps its original owner.
- **In use:** a theme used by a show cannot be deleted.
- **Records:** every theme card says who uploaded it, the owners are kept in `data/theme-owners.json`, and uploads, replacements and deletions are in the system log.

## Clocked 2009 (US)

Upload the **complete** Clocked theme pack in the Themes tab:
- `default.html` with the `Scripts` and `Styles` folders;
- the `Images`, `Sounds` and `Fonts` folders it uses (`clocked_*.mp3` sounds, Conduit/Copperplate/Interstate fonts...).

A theme with `Scripts/TimerControl.js` is recognised as Clocked and labelled "Clocked 2009". Everything else works as with the classic themes (questions, stacks, money tree, audience keypads, screens, logs).

- **Question clock:**
  - 15 s for questions 1-5, 30 s for 6-10, 45 s for 11-14;
  - question 15 runs on the gold clock made of the banked time;
  - the seconds left on a right answer are banked.

  In the Show tab, the "Question clock" card mirrors the clock and the banked time, with **↑ Show the clock** (before the question), **0 Pause / resume** and **B Banked time**. The same keys work on the keyboard.
- **The Clocked sequence:** the second "Next" reveals all four answers and starts the clock. Locking a final answer stops it.
- **When the time runs out:**
  - the show log records **TIME UP** and the correct answer (not a wrong or right answer), and the game ends;
  - "When time runs out" in the settings chooses whether the contestant keeps the previous amount or drops to the safe level.
- **Ask the Expert** (key T) is a lifeline tab of its own, with its steps. It pauses the clock.
- **Phone a Friend** in Clocked has eight steps. The call clock is mirrored from the game.
  - In the lifeline tab you can edit **the three friends** on the list.
  - The **Call 1/2/3** buttons light up when the game asks which friend to call.

  The show log records who was called.
- **Lifelines in play:** only those really in play are shown, in the panel, on the money tree and on the screens. Double Dip can replace 50:50 and Ask the Expert can replace Switch the Question, as set in the theme.
- **Host and player screens:** they show the clock (gold "m:ss" at question 15, **TIME UP** in red) with the banked time.
- **"Money tree & Clocked..."** on the theme card adds the Clocked settings of `Variables.js`:
  - starting banked time (max 6:45);
  - what happens when time runs out;
  - Double Dip instead of 50:50;
  - Ask the Expert instead of Switch the Question, and the question it unlocks from;
  - audience percentages inside the answers.
- **Restarting from a level** also stops and resets the clock.
- **Money tree in the control panel:** the gold milestones appear in yellow, and the current level in Clocked's dark brown.

## Light and dark mode

The control panel has a **System / Light / Dark** switch in the header, remembered by the browser. "System" follows the operating system. The login pages follow it too.

## Transparent output

The game output is **transparent by default**: the black page behind the graphics and the black colour behind the logo are removed, so it can be keyed or layered in OBS, vMix and the like. Every graphic of the theme stays, including its own backgrounds (the Fastest Finger background, the logo screen, the Clocked lifelines panel).

The output links shown in the control panel always carry **`&bg=black`** (classic black background). Remove it, or change it to `&bg=transparent`, in the OBS browser source for a transparent output. The option survives reloads and theme changes. The page carries `data-mc-transparent="yes"` or `"no"`.

The host and player screens keep their own design. They become transparent only in OBS or with `&bg=transparent`.

## The contestant's own name

On the **player screen** a "✎ Your name" button appears when the mouse moves or the screen is touched. The contestant enters a name or alias, an optional surname and where they come from.
- The name goes straight to the game's name strap and to the control panel.
- It starts a new game in the show log when it changes.
- It is recorded in the show log and the system log.

The button hides again after a few seconds. It never appears in OBS, or with `?noedit=1` on the player screen link.

## Cache

Every load of a show's output uses a new address (`/o/<show>/<n>/…`). Files are sent with `no-store`, and `default.html` also sends `Clear-Site-Data: "cache"`.

Changing theme or pressing "Reload output" therefore always starts from a clean cache.

The theme files, `questions.xml` included, are only served to an output that has the secret link.

## Status

Phase 1: server with parallel shows, output, control panel, audience keypads with live voting, theme uploads.

Phase 13 (this version): multi-community platform (gateway, super-admin panel, global themes, branding).

Phase 12: link with the Roblox set.

Phase 11: Layout editor (host screen, player screen, Fastest Finger console).

Phase 10: Fastest Finger First.

Phase 9:
- home page;
- Calendar tab with invitation pages and shows created from the calendar;
- TPH branding;
- versioned static files.

Phase 8: Clocked 2009 (US).

Phase 7:
- light / dark mode;
- transparent OBS output;
- contestant name from the player screen.

Phase 6:
- messages to the host;
- Ask the Audience results and Phone a Friend clock on the screens;
- "total prize won" only on walk away;
- cancel final answer;
- random stacks;
- ending shows.

Phase 5:
- question bank with unique IDs, statuses and hybrid difficulty;
- stack builder and stack slot editor;
- host screen: correct-answer square, manual comment, answers in sync with the output, aligned lozenges.

Phase 4:
- Shows page with the detailed per-show log;
- import of questions from documents.

Phase 3:
- users and roles;
- MySQL (users, question stacks, system log);
- admin panel;
- host and player screens.

Phase 2:
- question builder import;
- AI question generator;
- money tree settings in `Variables.js`;
- theme klaxon;
- display-only output.
