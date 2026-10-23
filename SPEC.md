# Superiss 0.8: Vertrag und Protokoll

Diese Spezifikation beschreibt den lokalen Aufgabenstore mit atomaren Claims,
Verträgen und gespeicherten Prüfbelegen. `ops.json`, Version 0.8.0, Protokoll 2,
ist das gemeinsame Eingabeschema für native MCP-Adapter und Node-Bridge.
Administrative Zustandsimporte sind kein Beleg für eine neue Abnahme.

## Speicher und Identität

SQLite läuft in WAL mit `synchronous=FULL`; `SIS_SYNCHRONOUS=NORMAL` senkt die
Stromausfall-Dauerhaftigkeit ausdrücklich. Bestehende Aufgaben, Abhängigkeiten,
Events, Memories und Outbox bleiben erhalten. Hinzu kommen Prüfbelege,
Checkpoints und Abbruchanforderungen. `project_id` wird dauerhaft im Store
hinterlegt. `context` liefert diese ID, den kanonischen Datenbankpfad,
Capabilities und Statistiken. Der Aufrufer wählt `--db` oder `SIS_DB` selbst.

Aufgaben besitzen unter anderem `id`, `title`, `desc`, `acceptance`,
`oracle_cmd`, `allowed_paths`, `owner`, `lane`, `budget_eur`, Status und
Lease-Felder. Dependencies tragen ihren Typ. Nur `blocks` und `gate` sperren
Arbeit; ein unbekanntes Gate ist geschlossen. Elternbeziehungen sind keine
Blocker. Goals und Epics sind Container.

## Worker-Vertrag

`claim`, `claim_next` und `acquire` prüfen die Eignung innerhalb derselben
atomaren Schreiboperation. Ein Kandidat muss ein ausführbares Blatt mit
nichtleerem Oracle sein; Blocker und Gates müssen erfüllt sein. Auch Status, Verfall und ausdrückliche
Goal-/Lane-Filter müssen passen. Eine ausdrücklich angeforderte Lane schließt
fremde und unzugeordnete Lanes aus. Ohne Kandidaten liefern Auswahloperationen
`id:null`. Ein erneuter Claim erhöht die Epoch und verdrängt alte Fence-Token.

Ein Actor enthält höchstens 128 Zeichen. Er muss mindestens ein Zeichen außerhalb von Leerraum enthalten.
TTL ist endlich und liegt in 1–86400 Sekunden. Epoch ist ganzzahlig und ≥0.
`heartbeat`, `checkpoint`, `close`, `unclaim` und `cancel_ack` benötigen
passenden Actor, aktuelle Epoch und `lease_until>now`. Ein früherer Besitzer
kann keinen Ersatz-Claim freigeben. `slot_release` verlangt Actor und Epoch.

`update` darf Status-, Lease-, Claim- und Proof-Felder nicht setzen.
`expected_revision` führt bei Abweichung zu `revision_conflict`. Revision ist
SHA256 des kanonischen JSON aus `id,title,desc,acceptance,oracle_cmd,
allowed_paths,owner,lane,dependencies`. Zeitstempel und Lease gehören nicht
hinein. Dependency-Beziehungen werden stabil sortiert; deren aktueller
Blockerzustand bleibt im strukturierten Vertrag sichtbar.

Budgets und Reservierungen müssen endlich und nichtnegativ sein.
Reservierungen können das Restbudget nicht erhöhen. Plan-Dependency-Indizes
müssen existierende ganzzahlige, fremde Kinder referenzieren. Ein ungültiger
Plan oder Batch wird vollständig zurückgerollt. `verify` läuft niemals in
einer Batch-Schreibtransaktion.

## Vertrag, Brief und Tokens

`contract {id}` enthält `contract_text`, `revision` und die strukturierte
Aufgabe. `acquire {actor,id?,goal?,lane?,ttl?,run_id?,max_tokens?,encoding?,model?}`
liefert `id,claim_id,epoch,lease_until,revision,contract`. Passt ein angeforderter
Tokenrahmen nicht zum Pflichtteil, darf kein Claim entstehen. Mit explizitem
`id` wird genau diese Aufgabe geclaimt oder mit `not_claimable` abgelehnt —
niemals still eine andere; ohne `id` wird die nächste ready-Aufgabe gewählt
(`id:null` bei leerer Queue). `claim_next` folgt derselben `id`-Semantik.
`acquire.contract` enthält genau einen Brief mit `text,tokens,encoding,exact,
omitted`; der Vertrag wird nicht nochmals als Volltextkopie angehängt.
`context` enthält PID und Prozessinstanz sowie kompakte Capabilities.
`capabilities.schemas=true` liefert zusätzlich das vollständige Register.

Goals und andere Container bleiben aus `ready`, `claim_next` und `acquire`
ausgeschlossen. Ein explizites `claim` mit ID und `finalize:true` ist nach
geschlossenen Nachfahren für die abschließende Zielprüfung zulässig.
Die Prüfbeleg-, Actor-, Epoch- und Lease-Regeln gelten dabei unverändert.
Planvorlagen (`save_as`, `template`) durchlaufen dieselbe Indexprüfung wie
direkte Pläne. Beide Kerne migrieren den Volltextindex auf dieselbe durch
SQLite-Trigger gepflegte Tabelle; vorhandene Issue-Daten bleiben erhalten.

`brief {id,max_tokens?,encoding?,model?,since?}` liefert
`id,revision,text,tokens,encoding,exact,omitted` sowie gegebenenfalls
`checkpoint,cursor`. Pflicht sind ID, Titel, Oracle, Acceptance, Pfade, Owner,
Lane, Dependencies und Revision. Nur Beschreibung und Historie dürfen mit
sichtbarem Eintrag in `omitted` entfallen. `budget_exceeded` nennt den Bedarf
des Pflichtteils.

`tokens {text,encoding?,model?}` akzeptiert höchstens 1 MiB UTF-8-Text.
Encodings sind `o200k_base` und `cl100k_base`; nur ohne Modell und Encoding
gilt der erste Wert als Standard. Unbekanntes Modell ohne bekanntes explizites
Encoding ergibt `unknown_tokenizer`. Ergebnis:
`tokens,encoding,exact,algorithm,billing:false`. Python darf bei fehlendem
lokalem Tokenizer die UTF-8-Byte-Obergrenze als `exact:false` und
`algorithm=utf8-upper-bound` melden. Tokenzählung ist keine Kostenabrechnung.

`ready`, `next` und `list` unterstützen `fields`, `limit` von 1–1000 und
stabile Cursor. Ohne angeforderten Cursor bleibt das Ergebnis ein Array;
mit Cursor lautet es `items,next_cursor`. Die Ordnung verwendet
Priorität, Erstellzeit und ID. Fehlerhafte Cursor werden abgelehnt.

## Prüfung und Close

`verify {id,actor,epoch,cwd,timeout_secs?,review_receipt?}` führt den deklarierten
Oracle außerhalb einer Datenbank-Schreibtransaktion aus. `cwd` muss existieren
und zu den Projektpfaden passen. Timeout: 1–300 Sekunden, Standard 10;
Ausgabepuffer: 64 KiB; Timeout beendet die Prozessgruppe.

Vor und nach dem Oracle werden die Inhalte von `allowed_paths` gehasht.
Der Umfang ist auf 32 MiB und 10.000 Dateien begrenzt. Datei- und
Verzeichnispfade sind zulässig. Aus dem Umfang ausbrechende Symlinks werden
abgelehnt. Ignoriert werden `.git`, `.sis`, `.cache`, `target`, `.venv`,
`__pycache__`, die Datenbank sowie WAL/SHM. Leerer Umfang ergibt
`missing_scope`. Diese Pfade sind Prüfmetadaten und keine Prozess-Sandbox.

Ein Beleg speichert `proof_id`, Aufgabe, Actor, Epoch, Vertragsrevision,
Quellenhash, kanonisches cwd, Oracle, Exitcode, Ergebnis, Timeout und begrenzte
Ausgabe. Rückgabe: `proof_id,passed,exit_code,timed_out,revision,source_hash`.
Ein fehlgeschlagener Oracle kann einen negativen Beleg erzeugen. Vor einem
positiven Beleg müssen Lease, Abbruchzustand, Quellen und Vertrag noch passen.

`close {id,actor,epoch,proof_id,reason?}` verlangt einen gespeicherten positiven
Beleg für denselben Actor, dieselbe Epoch sowie aktuellen Vertrag und
Quellenstand. Quellen werden beim Close erneut gehasht. Ohne Beleg folgt
`proof_required`; veraltete Quellen oder Verträge ergeben `stale_proof`.
Bei `meta.review_required=true` muss ein gespeicherter `review_receipt` mit
anderem `reviewer`, `verdict=pass`, passender `revision`, passendem
`source_hash` und `artifact` vorliegen. Er dokumentiert Host-Evidenz, ohne
einen externen Reviewer selbst zu authentifizieren. Container-Close setzt
zusätzlich `goal_done.done=true` und einen eigenen bestandenen Goal-Oracle
voraus. Wiederholter idempotenter Close erzeugt keine zweite Wirkung.

## Strukturierte Attestierungen

`attest {id,actor,epoch,cwd,kind,...}` hängt der aktiven Claim-Fence einen
maschinenlesbaren Beleg an, gebunden an dieselbe Vertragsrevision und denselben
Quellenhash wie `verify`. Kinds: `junit` (parst Tests/Failures/Errors aus einer
JUnit-XML-Datei unter cwd, `passed` nur bei tests>0 und failures=errors=0),
`coverage` (`percent` 0..100, `passed` bei `percent>=min`),
`smoke` (gemessener HTTP-`status` gegen `expect`, Default 200 — der Worker
misst selbst, sis ruft nichts auf), `artifact` (`ref`/`digest` als
Existenzbehauptung), `custom` (explizites `passed` plus `note`) und
`run` (`cmd` wird vom Store selbst unter cwd ausgeführt, `passed` bei
exit 0 ohne Timeout — der Beleg ist clientseitig nicht fälschbar;
`timeout_secs` 1..60, da attest in der Schreibtransaktion läuft).
`payload` ist auf 64 KiB begrenzt. `meta.attest_required` (Bool, String oder
Kind-Liste) erzwingt beim `close` passende bestandene Attestierungen —
`true` verlangt mindestens eine beliebige, eine Liste jede genannte Art;
Fehlfälle enden in `attest_required`. `show` liefert die letzten zehn
Attestierungen pro Aufgabe mit.

## Änderungsevidenz

`changes {id, files?}` hängt ein kompaktes Änderungsbild an die Aufgabe: pro
Datei Pfad, `+adds/-dels`, Status (`M`/`A`/`D`/`R`), Hunk-Zeilenbereiche
`[[start,end]]` sowie `binary`/`renamed_from`, dazu `base`, `head`,
`head_subject`, `branch` und `repo`. Der Aufrufer-CLI berechnet das Bild aus
dem echten Git-Worktree (`diff --numstat -M`, `diff -U0`,
`status --porcelain`); der Daemon spawnen nichts. Kein Code wird
gespeichert — nur mit `--patch` eine auf 64 KiB begrenzte
Unified-Diff-Aufnahme (`patch_truncated` kennzeichnet Abschnitt).
Identische Folgebilder deduplizieren über `fingerprint` (sha256[:16] der
Dateiliste); `force` erzwingt. `sis close` und `sis checkpoint` schreiben
dasselbe Bild best-effort vor dem Schließen beziehungsweise der Übergabe
(`--no-changes` deaktiviert). `list`, `show` und das Board emittieren
`changes` pro Aufgabe; `resume` und `brief` liefern das letzte Bild gleich
mit, damit ein Nachfolge-Agent den Edit-Stand ohne Event-Replay sieht.
Ereignisse bleiben append-only mit Actor.

`show` emittiert zusätzlich `run_state`: aus dem Ereignisstrom abgeleitete
Laufphase `queued → claimed → evidence → verified → closed` (verify-Ereignis
mit `passed:true` schaltet auf `verified`; `changes`/`checkpoint` auf
`evidence`; aktiver Claim auf `claimed`). Externe Übergänge wie Dispatch und
Merge bleiben Ereignisse, kein gespeicherter Zustand. `list`/`query`
projizieren `run_state` gebatcht pro Seite (zwei gruppierte Queries, in
500er-Chunks unter der SQLite-Variablenkappe), sodass der Reconciler die
Phase aller sichtbaren Aufgaben in einem Aufruf liest.

## Fortschritt und Abbruch

`checkpoint {id,actor,epoch,text,next_step,artifacts?,expected_revision?}`
speichert einen an Quellen und Vertrag gebundenen Fortschrittsdatensatz bis
16 KiB. `resume {id,since?}` liefert aktuellen Vertrag, letzten Checkpoint
mit Stale-Markierung, Abbruchzustand, Versuchsinformation und begrenzte Events
mit Cursor. Es führt keine Arbeit aus und übernimmt keine Ownership.

`handoff {id,actor,epoch,text,next_step,to?}` ist Checkpoint plus
Lease-Freigabe in einem Schritt: der Datensatz wird geschrieben, der Claim
gelöst (`open`, `lease_epoch+1`) und ein `handoff`-Ereignis mit optionalem
Nachfolger `to` angehängt. Der nächste Agent kann sofort claimen statt die
Lease-TTL abzuwarten; `resume` liefert ihm Checkpoint und Changes-Bild.

`who {repo?}` ordnet jeden dirty/untracked-Pfad eines Worktrees dem jüngsten
`changes`-Ereignis zu, das ihn aufzeichnete — inklusive `status`, `seq`,
`actor`, `claim_actor` und `head_subject` des Ereignisses. Pfade ohne
Treffer erscheinen explizit in `summary.orphaned`; `summary.by_issue`
aggregiert pro Aufgabe. So wird ein uncommitted Fremdstand zurechenbar
(verwaist vs. fremd-aktiv) statt geraten.

`cancel` verlangt den aktiven Worker oder den ausdrücklich in Metadaten
konfigurierten Controller. Es setzt eine Absicht. `heartbeat` meldet
`cancel_requested,revision,lease_until`. `cancel_ack` setzt `cancelled`,
entfernt die Lease und fencet alte Arbeit. `reopen` benötigt gültigen Owner,
Controller oder Admin-Autorisierung, erhöht die Epoch und entfernt den Abbruch.
Es gibt keine automatische endlose Wiederholung oder Wiedergabe von Effekten.

## Administration, Ereignisse und Idempotenz

`admin_update` und `import` verlangen einen serverseitig konfigurierten,
konstantzeitlich geprüften `admin_token`. Ohne `SIS_ADMIN_TOKEN` sind sie
gesperrt. Ein Actor-Name allein erteilt keine Admin-Autorität. Der Token darf
weder in Ereignissen noch in gespeicherten Requests oder Logs auftauchen.
`admin_update` benötigt außerdem einen Grund; es ist keine Worker-Abnahme.

Idempotenz bindet Schlüssel, kanonischen Payloadhash, Befehl und Actor.
Gleicher Schlüssel mit gleichem Payload liefert das Originalergebnis;
Abweichung ergibt `idem_conflict`. Parent-Schlüssel dürfen nicht in
Batch-Kinder gelangen. Mutationen, zugehörige Events und Outbox-Einträge
werden in derselben Transaktion festgeschrieben. Abonnenten werden nach dem
Commit geweckt; Ereigniscursor bleiben über Neustarts nutzbar.

## Transporte

CLI: `sis <op> [JSON|@datei|k=v|positionell ...] --db PATH`.
Erfolge liefern rohe Daten; Fehler einen Fehlerumschlag und Exitcode ungleich
null. Exitcodes: 0 Erfolg, 1 Nutzerfehler, 2 intern, 3 Server bereits gebunden.
`serve` startet den Server im Vordergrund; `mcp` startet NDJSON-JSON-RPC über
stdio. Socket und MCP liefern `ok/data` oder `ok:false,error:{code,msg}`.

Unix-Socket: 0600, Standard `/tmp/sis-<hash>.sock`; Hash sind die ersten
20 SHA256-Hexzeichen des kanonischen DB-Pfads. `SIS_SOCK` oder `--sock`
überschreiben den Pfad. Anfrageframe: höchstens 1 MiB. Clients, Ausgabe und
Idle-Wartezeiten sind begrenzt. Neustart prüft einen alten Socket vor dem
Entfernen. `SIGTERM`/`SIGINT` wecken wartende Abonnenten.

DB-Auflösung ohne `--db`/`SIS_DB`: die nächste `.sis/*.db` aufwärts vom
cwd (die `mk sis`-Konvention), sonst ein **existierendes** `sis.db` im
cwd. Ohne Fund endet jeder Aufruf mit `no_project_db` (Exit 2) — es
wird nie implizit ein neuer Store angelegt. Ad-hoc-Stores im cwd
erfordern `SIS_CWD_DB=1`; Reads und unbekannte Ops auf fehlende Stores
enden mit `db_missing` statt einem leeren Backlog. Meta-Ops (`context`,
`capabilities`, `tokens`, `prime`, `types`, `statuses`) dürfen einen
expliziten Store lazy anlegen.

CLI-Args: neben `k=v` und Positionals gelten `--key value`,
`--key=value` und `--key` (=true); `--` beendet das Flag-Parsing.

`--http PORT` oder `SIS_HTTP` ergänzt Loopback-HTTP auf `127.0.0.1` mit
`GET /health`, `/board`, `/events?after=N&wait=S`, `/` sowie JSON-`POST /`.
Native MCP und Node-Bridge verwenden dasselbe Register. Das Profil
`SIS_MCP_PROFILE=agent` bewirbt zwölf Ops; es ist keine Sicherheitsgrenze.

## Versionierung und Sync

Nach jedem committeten Schreib-Tx schreibt sis `<db>.issues.jsonl` neu:
eine `upsert`-Zeile pro Issue (Deps eingebettet, sortiert nach ID,
deterministisch — identischer Stand erzeugt identische Bytes, kein
Rewrite). Das ist der git-diffbare Spiegel des Task-Stands; die SQLite-DB
bleibt die Wahrheit und wird nie committet. `snapshot` schreibt den
Spiegel explizit, `SIS_SNAPSHOT=0` deaktiviert den Auto-Schrieb.

`import` akzeptiert dieselbe Zeilenform (`{"op":"upsert","issue":…,
"data":{…}}`) und merged vollständig — damit ist `git log`/`git diff`
auf `.issues.jsonl` das praktische Äquivalent zu `bd`'s Dolt-History.

`tools/sis-sync.sh` koppelt den Spiegel an Git: `pull` (git pull --rebase
+ Import), `push` (snapshot + commit + push), `sync`, `status`. Es gibt
kein DB-Merging; Konflikte löst Git auf Zeilenebene, der Import gewinnt
je Issue mit letztem Stand.

## Runner-Bridge, Kostenspeicher, Sync und Emission

`outbox_export {format,limit?,drain?,task_queue?}` rendert pending
Outbox-Zeilen als Job-Hüllen für externe Durable-Runner: `raw` (generisch),
`pgboss-sql` (INSERT-Literale für `pgboss.job`), `hatchet` (Workflow-Inputs)
und `temporal` (`SisEvent`-Workflows mit `sis-outbox-<id>`-Ids).
`drain:true` markiert exportierte Zeilen in derselben Transaktion als
`done`. sis bleibt Vertrags- und Beweisebene; der Runner liefert
Crash-Recovery für lange Ausführung.

`cost_add`/`cost_list`/`cost_rollup` führen einen append-only
Kostenspeicher (`tokens_in`, `tokens_out`, `cents`, `eur`, `wave`,
`actor`, `run_id`) je Aufgabe. `cost_rollup {id}` aggregiert über den
Container-Baum (`meta.parent`-Kette plus id-Präfix) und gruppiert nach
Issue, Actor und Wave; Budgetbezug bleibt `budget_eur`.

`sync_export` emittiert ein deterministisches `sis-sync`-Bundle
(Schemaversion, `project_id`, Issues mit eingebetteten Deps, Memories,
Proof- und Attest-Receipts; `events:true` legt zusätzlich das volle
Ereignislog bei — Events werden exportiert, aber nicht reimportiert). `sync_import` (admin-gated) merged es: Issues/Deps
werden ersetzt, Memories gewinnen last-write-wins über `updated_at`,
Receipts mischen per Primärschlüssel (`INSERT OR IGNORE`) und werden
nie überschrieben — so schließt ein auf Maschine A verifizierter Beleg
die Arbeit auf Maschine B ab. Ein Issue mit laufender Lease wird nie
überschrieben und landet im `conflicts`-Report (`active_claim`).
Gates, Slots und der Outbox-Status bleiben instanzlokal.

`export {format:"bd"}` und `import {format:"bd"}` lesen/schreiben die
bd-kompatible `issues.jsonl`-Form (`issue_type`, `description`, `labels`,
eingebettete `dependencies`) — Import erkennt unverpackte Issue-Zeilen
auch automatisch. bd-Import ist konfliktfähig: ein Issue mit laufender
Lease landet als `active_claim` im `conflicts`-Report, ein geschlossenes
Issue wird ohne `force:true` nicht still wieder geöffnet (`would_reopen`).

`meta.autorun` (Cmd-String oder `{cmd,cwd}`) lässt `claim` zusätzlich
einen `outbox`-Job der Art `autorun` anlegen — `tools/sis-runner.sh`
exportiert ihn, führt das Kommando über `attest kind:"run"` store-seitig
aus und markiert `outbox_done`/`outbox_fail`. Der Job liegt damit
dauerhaft vor der Ausführung vor; ein abgebrochener Runner hinterlässt
ihn `pending` für den nächsten Lauf.

`meta.budget_gate` (Bool) lässt `close` mit `budget_exceeded`
fehlschlagen, sobald der Kosten-Rollup des Container-Baums das
`budget_eur` des Issue übersteigt (Vergleich in Cent).

`learn {group_by, since}` aggregiert den Speicher ehrlich: je Gruppe
(`actor`, `wave`, `kind`, `issue`) Attest- und Proof-Rate, Cents/Tokens
und `accept_secs` (Zeit von Erstellung bis `closed`). Es gibt keinen
erfundenen Score — fehlgeschlagene Läufe bleiben als Evidenz sichtbar.
Issue-Metriken attribuieren auf die erste passende Mitgliedschaft; der
Actor-Schlüssel fällt auf den letzten Prover zurück, weil `close` den
`claim_actor` leert. Das Bundle liefert genau den Posterior, den
Bandit-/Routing-Entscheide über Akteure, Waves und Prüfarten brauchen.

`SIS_EMIT=<pfad>` (oder `1` für `<db>.otel.jsonl`) hängt pro Request
eine OTel-förmige Span-Zeile an (`name`=Op, `trace_id` aus run_id/issue,
Status `ok`/`error`, `sis.cmd`/`sis.issue`/`sis.actor`-Attribute).
Best-effort und append-only; `spans {limit}` liest die letzten Zeilen
zurück.

## Register der Operationen

Die Tabelle wird aus dem gemeinsamen Register abgeleitet. Optionale Felder
und Typen stehen vollständig in `ops.json`.

| Operation | Pflichtfelder laut Register |
|---|---|
| `create` | `title` |
| `update` | `id` |
| `admin_update` | `id`, `admin_token`, `reason` |
| `dep` | keine |
| `dep_list` | keine |
| `dep_remove` | `issue`, `depends_on` |
| `ready` | keine |
| `list` | keine |
| `query` | keine |
| `count` | keine |
| `next` | keine |
| `acquire` | `actor` |
| `claim` | `id`, `actor` |
| `claim_next` | `actor` |
| `heartbeat` | `id`, `actor`, `epoch` |
| `unclaim` | `id`, `actor`, `epoch` |
| `reclaim` | keine |
| `verify` | `id`, `actor`, `epoch`, `cwd` |
| `close` | `id`, `actor`, `epoch`, `proof_id` |
| `reopen` | `id`, `actor` |
| `delete` | `id` |
| `defer` | `id` |
| `undefer` | `id` |
| `show` | `id` |
| `search` | `q` |
| `children` | `id` |
| `label` | `id` |
| `rename` | `from`, `to` |
| `note` | `id`, `text` |
| `comments` | `id` |
| `changes` | `id` |
| `history` | `id` |
| `checkpoint` | `id`, `actor`, `epoch`, `text`, `next_step` |
| `handoff` | `id`, `actor`, `epoch`, `text`, `next_step` |
| `resume` | `id` |
| `cancel` | `id`, `actor` |
| `cancel_ack` | `id`, `actor`, `epoch` |
| `contract` | `id` |
| `brief` | `id` |
| `tokens` | `text` |
| `context` | keine |
| `capabilities` | keine |
| `watch` | keine |
| `lint` | keine |
| `types` | keine |
| `statuses` | keine |
| `prime` | keine |
| `orphans` | keine |
| `stats` | keine |
| `review` | keine |
| `stale` | keine |
| `remember` | `key`, `value` |
| `recall` | keine |
| `export` | keine |
| `import` | `admin_token` |
| `batch` | `ops` |
| `budget_claim` | `issue`, `eur` |
| `outbox_list` | keine |
| `outbox_done` | `id` |
| `outbox_fail` | `id`, `err` |
| `outbox_export` | `format` (`raw`/`pgboss-sql`/`hatchet`/`temporal`), `drain` |
| `attest` | `id`, `actor`, `epoch`, `kind` |
| `cost_add` | `issue`, `tokens_in`/`tokens_out`/`cents`/`eur`, `wave` |
| `cost_list` | keine (`issue`/`actor`/`run_id`/`wave`/`limit` filterbar) |
| `cost_rollup` | `id` |
| `sync_export` | keine |
| `sync_import` | `admin_token`, `path` oder `json` |
| `spans` | `limit` |
| `compact` | keine |
| `gate` | `name` |
| `gate_list` | keine |
| `slot_acquire` | `name`, `actor` |
| `slot_release` | `name`, `actor`, `epoch` |
| `slot_list` | keine |
| `epic` | `id` |
| `dup_scan` | keine |
| `q` | `title` |
| `goal` | `name` |
| `sub` | `parent`, `title` |
| `plan` | `name` |
| `goal_tree` | keine |
| `goal_done` | `id` |

## Abnahme

`tests/agent_suite.py` prüft Worker- und Proof-Invarianten;
`tests/integration_suite.py` prüft CLI, Socket, MCP, HTTP und Wiederanlauf;
`tests/contract_suite.py` prüft bestehende Operationsverträge mit echten
Verify-/Close-Fixtures. Beide Implementierungen müssen am integrierten
Quellenstand bestehen. Zusätzliche Grenzen benötigen passende Timeout-,
Crash-, Nebenläufigkeits- und Wiederanlauftests. Benchmarks vergleichen
identische lokale Arbeitslasten. Ohne Provider-Messbelege bleiben Modellkosten
und Einsparungen unbekannt.
