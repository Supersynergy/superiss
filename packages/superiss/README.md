# Superiss v1 — TypeScript 7.1, SQLite und DuckDB 2

Version **1.5.2**, local release candidate. `bin/sis` is the current source entry point; `bin/sis-v1` is its alias. The release bundle includes forge CLI/HTTP/MCP, optional Worktrunk and explicit repository routing. See [the current forge guide](../../docs/SISF.md), [feature boundaries](../../docs/FEATURES.md) and [validation](../../docs/VALIDATION.md). The core has 90 operations; `rpc` is a transport entry point, not another task operation.

The host-specific measurements and research provenance below describe the inherited 1.0 analytics work; they are not fresh 1.5 production acceptance. SQLite ist die verbindliche Aufgabensteuerung; DuckDB erzeugt ausdrücklich datierte, lesende Analyseprojektionen. Releasepakete enthalten CLI, Analyse-Worker, Ops-Register, Tokenizer und Web-Board. Ein Installationswechsel migriert keine Projekt-DB und ersetzt keinen laufenden Daemon: Ein 1.5-Client weist ältere oder unversionierte Daemons vor dem ersten Arbeitsbefehl ab.

## Start

Vorhanden sein müssen Bun, TypeScript 7.1 für die Prüfung, Node-Typdefinitionen, die DuckDB-2.0-Bibliothek sowie `run-guard`. Prüfungen laufen direkt; Analysen verwenden ausschließlich den zeit-, RAM- und threadbegrenzten `run-guard`. Der deaktivierte automatische `mac-resource-run` wird nicht gestartet. Es werden keine Abhängigkeiten oder Erweiterungen automatisch installiert. `SIS_TYPE_ROOTS` wählt vorhandene Node-Typdefinitionen ausdrücklich; andernfalls wird das lokal auflösbare Paket `@types/node` verwendet.

```sh
# Aus dem Repository; neue, explizite Datenbank verwenden.
bun packages/superiss/cli.ts serve --db /tmp/superiss-v1/project.db --sock /tmp/superiss-v1.sock

# In einem zweiten Terminal: Steuerung über denselben Besitzerprozess.
bun packages/superiss/cli.ts capabilities --db /tmp/superiss-v1/project.db --sock /tmp/superiss-v1.sock
bun packages/superiss/cli.ts ready --db /tmp/superiss-v1/project.db --sock /tmp/superiss-v1.sock
bun packages/superiss/cli.ts analytics kind=all limit=100 --db /tmp/superiss-v1/project.db --sock /tmp/superiss-v1.sock
```

`--db`, `SIS_DB` oder das ausdrückliche `SIS_CWD_DB=1` ist erforderlich. Es gibt keine stillschweigende Suche nach einer produktiven DB. Die CLI behält das bestehende Format bei: erfolgreicher Aufruf = direktes JSON-Ergebnis; Socket/MCP = Protokoll-Envelope.

## Optionale lokale Suche

Ohne Konfiguration bleibt `search q=BEGRIFF` unverändert bei SQLite FTS5
(einschließlich der bisherigen `LIKE`-Rückfallebene). Für einen separaten,
rekonstruierbaren Vektorindex müssen Betreiber selbst eine kompatible
sqlite-vec-Bibliothek und ein lokales Ollama-Embedding-Modell bereitstellen:

```sh
export SIS_VEC_EXTENSION=/absolute/path/to/vec0.dylib
export SIS_VEC_MODEL=all-minilm
bun packages/superiss/cli.ts search_index action=build --db /absolute/project.db
bun packages/superiss/cli.ts search q='ähnliche Aufgabe' mode=hybrid --db /absolute/project.db
bun packages/superiss/cli.ts search_index action=status --db /absolute/project.db
```

`SIS_VEC_EXTENSION` lädt ausschließlich eine vorhandene lokale native
Bibliothek. `SIS_VEC_MODEL` aktiviert ausschließlich den Embedding-Aufruf an
`127.0.0.1:11434/api/embed`; `SIS_VEC_PORT` ändert nur den Loopback-Port.
Nichts wird automatisch installiert oder heruntergeladen. Vor der
Indizierung sensibler Aufgaben den tatsächlichen Ollama-Upstream prüfen:
Loopback allein beweist keinen fehlenden Weitertransport.

`search_index action=build` liest einen SQLite-Snapshot, berechnet lokal
Embeddings in Batches und baut die separate Datei
`<project.db>.search-vec-<Projekt-Modell-Hash>.sqlite` transaktional. Nach
einem Restore mit anderer Projektidentität oder einem Modellwechsel (Runtime
neu starten) entsteht ein eigener Indexpfad; alte abgeleitete Dateien werden
nicht automatisch gelöscht. Das Limit sind 100.000
Aufgaben; ein großes Projekt braucht einen separat evaluierten Indexdienst.
Fremde, modellfremde oder projektfremde Indexdateien werden nicht übernommen.
Nach einer Inhaltsänderung oder geänderter Aufgabenzahl ist der Index veraltet:
`search mode=hybrid` fällt
bis zum expliziten Rebuild auf FTS5 zurück. `search_index` zeigt
`ready`, `reason` und den Snapshot-Cursor. Standardmäßig werden keine
Embeddings erzeugt. Eine Suchprojektion vergibt niemals Claims, Proofs oder
Budgets; sie darf bei Verlust aus SQLite neu aufgebaut werden. Fremde
Schreibzugriffe ohne Superiss-Events liegen außerhalb der garantierten
Drift-Erkennung. Das indexierte Aufgabenmaterial bleibt lokal sensibel.

## Viele Worker und Agenten

### Wiederverwendbare Sessions

`sis rpc --db /absolute/project.db` liest pro Zeile ein Objekt wie
`{"id":"read-1","cmd":"ready","args":{}}` und schreibt ein Envelope mit derselben
`id`, `ok` und `data` beziehungsweise `error`. Der Controller hält stdin/stdout
offen; ein neuer Prozess pro Zeile würde den Startaufwand erneut bezahlen.
Direkt bleibt ein Engine offen. Mit explizitem Socket oder vorhandenem
Projekt-Socket nutzt die Session einen identitäts- und versionsgeprüften Client.

Frames bleiben auf 1 MiB Eingabe und 8 MiB Ausgabe begrenzt. Aufträge werden
seriell angenommen, Ausgabe hat eine endliche Drain-Deadline. Ungültiges JSON
wird sichtbar abgewiesen; eine unvollständige letzte Zeile wird nicht ausgeführt.
EOF und SIGTERM schließen nur die eigenen Ressourcen; bereits angenommene
Arbeit wird abgewickelt. Actor, `idem` und `run_id` gehören zum jeweiligen
Auftrag. Eine Antwort mit `ok:false` ist kein Erfolg.

`SuperissSocketClient` aus `ts/socket-client.ts` (im Bundle:
`dist/socket-client.js`) hält eine Verbindung mit
einmaligem Handshake und korrelierten `request_id`-Antworten. Standardgrenzen:
64 offene Aufträge, 15 Sekunden pro Aufruf, höchstens 310 Sekunden bei expliziter
Konfiguration. Eine verlorene Bestätigung, Deadline oder ein Abort löst keinen
automatischen Retry aus. Ein Abort schließt diesen Clientkanal, nicht den Server
oder die dort bereits gestartete Arbeit; andere laufende Aufrufe desselben
Kanals können dadurch ebenfalls unklar werden. Folgeaufrufe verbinden neu und
prüfen dieselbe gebundene Projekt-ID. Ein bewusst gewechseltes Projekt braucht
einen neuen Client. `watch` bleibt auf einer dedizierten Verbindung.

MCP verwendet direkt bereits einen langlebigen Engine. Im Socket-Modus wird
jetzt ebenfalls eine Verbindung wiederverwendet; EOF schließt den Client.
Claims, Leases, Budgets und Proofs werden weiterhin frisch gelesen. Es gibt
keinen neuen Ergebniscache und keinen zweiten Aufgabenstore.

- **Ein zentraler Besitzerprozess pro Projekt-DB**, viele Clients. SQLite-Transaktionen für Claims, Epochs und Leases bleiben kurz. Die Claim-Auswahl filtert unpassende Status, Container und blockierte Aufgaben bereits in SQL; die vollständige Eligibility-Prüfung bleibt erhalten.
- Keine doppelte Zuteilung: konkurrierende Requests werden durch den vorhandenen Transaktions-/Fencing-Pfad geführt. Bei leerer Queue ist die Antwort `{ "id": null }`, kein Fehler und kein neuer Claim.
- Standardmäßig maximal **zwei gleichzeitig laufende Orakel** pro Engine; `SIS_VERIFY_CONCURRENCY=1..8` ist ein ausdrücklicher Betreiberwert. Gleiche laufende Verify-Requests werden zusammengeführt. Andere Requests erhalten bei voller Kapazität `verify_busy`, statt eine unbegrenzte Prozesswarteschlange aufzubauen.
- Ein Analyseprozess pro Engine. Gleiche laufende Reports teilen sich das Ergebnis desselben Snapshots; andere Reportarten erhalten `analytics_busy`. Es gibt keinen stillen Cache, der einen alten Snapshot als aktuell ausgibt.
- Heartbeats, Cancellation und Checkpoints laufen weiter, während ein Orakel oder Report auf externe Arbeit wartet. Ein langer Verify-/Report-Aufruf hält keine SQLite-Schreibtransaktion offen.
- NDJSON kann mit **`request_id`** mehrere unabhängige Requests auf einer Verbindung verarbeiten. Jede Antwort trägt dieselbe ID; doppelte laufende IDs werden abgewiesen. Ohne ID bleibt die bisherige Antwortreihenfolge erhalten. `watch` benötigt eine eigene Verbindung.
- Standard: 64 Clients; `SIS_MAX_CLIENTS` lässt sich bis 1024 setzen. Pro Verbindung bleiben Frames auf 1 MiB und die Zahl offener Requests auf 128 begrenzt. SQLite-Busy-Wartezeit standardmäßig 250 ms statt langem synchronem Blockieren; `SIS_SQLITE_BUSY_MS=25..5000` ist ein ausdrücklicher Betreiberwert.
- `SIGTERM` stoppt die Annahme neuer Arbeit, wartet auf bereits akzeptierte Requests und spült deren Antworten, bevor Socket und Besitzer-Lock freigegeben werden. Ein akzeptiertes Orakel wird nicht einfach mit der Datenbank geschlossen.

Worker-Loop: `context/resume → contract → acquire → heartbeat/checkpoint → verify → close(proof_id) → readback`. Keine fremden, noch gültigen Claims stehlen; Fehler oder unbekannter Commit-Ausgang werden nicht durch blindes Wiederholen von Schreibbefehlen kaschiert. Nach Verbindungsabbruch erst mit gleicher Projektidentität und demselben Idempotenzschlüssel den Stand prüfen. Streaming-Änderungen oder vorhandene Receipts sind vollständigen Wiederholungsscans vorzuziehen.

**Ressourcenmodell:** Reports laufen unter endlicher Zeit-/RAM-/Thread-Grenze mit `run-guard`; es gibt keinen automatischen Host-Admission-Wrapper. Externe Orakel behalten den übernommenen Prozessgruppen-Timeout. Ressourcenintensive Orakel müssen ihren Host-Guard im Vertrag enthalten; die Oracle-Kapazitätsgrenze ersetzt weder ein Betriebssystem-Sandboxing noch ein maschinenweites Ressourcenbudget.

## SQLite-Brücke ohne Live-Konvertierung

```sh
bun packages/superiss/cli.ts migrate_copy source=/absolute/old-project.db --db /absolute/new-project.db
```

Die Quelle wird nur lesend geöffnet. SQLite `VACUUM INTO` erzeugt eine konsistente Kopie einschließlich WAL-Inhalt. Integritätsprüfung und Projektidentität werden geprüft, danach wird die Zieldatei atomar ohne Überschreiben angelegt. Existiert das Ziel, schlägt der Befehl fehl; auch Symlink-/Hardlink-Kollisionen dürfen nicht zu einem Überschreiben führen. Es ist keine SQLite-zu-DuckDB-Konvertierung und keine laufende Synchronisierung.

Unterstützt sind die übernommenen Superiss-Schemas 7 und 8; neue Datenbanken verwenden den kompatiblen Schema-7-Kern. Neuere unbekannte Schemas werden abgewiesen. Die Formatnummer ist nicht mit der Produktversion 1.5.2 oder der SQLite-Laufzeitversion zu verwechseln. Für eine Produktivübernahme zuerst eine Kopie prüfen; nicht versuchsweise die echte Projekt-DB migrieren.

## DuckDB-Analyse

`analytics` unterstützt `kind=all|summary|actors|daily` und `limit=1..1000`. Die separate Datei liegt standardmäßig neben der SQLite-Datei als `*.analytics.duckdb`. Sie ist **niemals** Quelle für Claims, Budgets, Gates oder Proof-Entscheidungen.

1. Ein nur lesender SQLite-Client hält einen konsistenten Snapshot.
2. Projekt-ID, Schema und Ereignis-Wasserzeichen werden in diesem Snapshot ermittelt.
3. Ein eigener Prozess lädt Issues, Events, Costs, Proofs und Agent-State in gebundenen Seiten; DuckDB-Appender vermeiden Einzel-INSERT-Transaktionen.
4. Tabellen und Wasserzeichen werden in einer DuckDB-Transaktion ersetzt. Ein anderer Projektbesitzer oder ein unbekanntes Dateiformat wird nicht überschrieben.
5. Die Antwort enthält `authority`, `consistency`, `snapshot_sequence`, `project_id`, tatsächliche DB-Versionen, Zeilenzahlen sowie Import-/Gesamtdauer.

Die Auswertungen zeigen Status/Lanes, Actor-Aktivität, Tageszahlen, Proof-Ergebnisse und Kosten nach Währung. EUR-Actor-Kosten sind ausdrücklich so bezeichnet; unterschiedliche Währungen werden nicht vermischt. Prüfungs-Latenzquantile werden nicht erfunden: Der übernommene SQLite-Kern speichert dafür noch keine ausreichenden Zeitmessungen.

Diese v1 verwendet bewusst eine **vollständige On-demand-Projektion**, kein unvollständiges Event-CDC. Auch direkte kompatible Änderungen ohne vollständigen Event-Payload werden dadurch nicht übersehen. Für sehr große Historien sind Snapshot-Dauer, WAL-Wachstum, Import-RAM und Last getrennt zu messen. Ein inkrementeller Import braucht vollständige Änderungsdaten, Tombstones, Schema-Versionen und einen atomaren Cursor; bloß `MAX(seq)` als Cache-Schlüssel genügt nicht.

Automatisches Erweiterungsladen und externer Dateizugriff bleiben in DuckDB aus. Die SQLite-Erweiterung wird nicht automatisch installiert oder für Schreibzugriffe freigeschaltet. Die vorhandene stabile C-API wird verwendet; Statement-LRU und atomarer Appender sind getestet. Die Resultat-Decodierung nutzt für SELECTs ein JSON-Zeilenformat, um NUL/Unicode und sichere Integer ohne ungetestete, by-value C-Strukturen zu erhalten. Ein späterer nativer Data-Chunk-/Neo-Treiber braucht einen eigenen ABI-/Bun-Kompatibilitätsnachweis und eine Dependency-Freigabe.

## Versionen und Datenschutz

Auf diesem Host bestätigt: Bun 1.4.4, TypeScript **7.1.0-dev.20261027.1**, SQLite **3.54.1**, DuckDB **v2.0.0**. TypeScript 7.1 ist hier eine Entwicklungsfassung, keine behauptete stabile Veröffentlichung. Bun hatte ohne ausdrückliche Bibliothekswahl SQLite 3.43.2 geladen; v1 verwendet unter macOS die bereits installierte Homebrew-Bibliothek, bevor die erste Verbindung entsteht. `SIS_SQLITE_LIBRARY` erlaubt einen ausdrücklichen Pfad oder `system`; die gemeldete tatsächliche Version bleibt sichtbar. Für DuckDB gilt der vorhandene `SIS_DUCKDB_LIBRARY`-Override. Die Abnahme ist für dieses macOS/arm64-System, nicht für ungeprüfte Plattformen.

Primär- und Analysedateien werden mit Modus 0600 geschrieben; Socket ebenfalls 0600. Analyseausgaben sind begrenzt und geben keine vollständigen Task-/Proof-Payloads aus. Actor-Namen sind keine Authentifizierung: Standard ist ein vertrauenswürdiges lokales Unix-Benutzerkonto. Mehrere Systeme benötigen einen separat autorisierten TLS-/Identitäts-/Berechtigungszugang. Quack oder ein offener SQL-Port ersetzt den Superiss-Befehlsserver und seine Proof-Regeln nicht. Keine fremden Dienste, Browser oder Locks werden für v1 neu gestartet oder aufgeräumt.

## Prüfen und bauen

```sh
npm --prefix packages/superiss run types
npm --prefix packages/superiss run check
# Gleichwertige direkte Bun-Aufrufe:
bun packages/superiss/check.ts --types
bun packages/superiss/check.ts
# Nach erfolgreicher Abnahme:
bun packages/superiss/dist/cli.js capabilities --db /absolute/test-project.db
```

Die npm-Prüfskripte `check` und `types` sowie die direkten Bun-Aufrufe verwenden dieselbe Compilerauflösung: Unter den ausführbaren `tsc`-Dateien im jeweiligen `PATH` wird die neueste **installierte 7.1-Version** gewählt. Ältere Compiler in den von npm vorangestellten `node_modules/.bin`-Verzeichnissen verdrängen sie nicht. Numerische Nightly-/Prerelease-Versionen werden nach Versionsreihenfolge verglichen; Build-Metadaten ändern die Priorität nicht. Es gibt keine Registry-Abfrage, Installation oder globale PATH-Änderung. `SIS_TSC=/absoluter/pfad/tsc` pinnt ausdrücklich einen Compiler; ein leerer, fehlender oder inkompatibler Override scheitert ohne Fallback. `npm run types` meldet den tatsächlich gewählten Compilerpfad. `SIS_TYPE_ROOTS` bleibt der Override für bereits installierte Node-Typdefinitionen.

Der feste Checker verlangt TypeScript 7.1, prüft strikt, führt die übernommene Unit-Suite, Hybrid-/Konkurrenz-/Timeout-/Drain-Tests und den vollständigen vorhandenen Protokollvertrag aus. Er misst drei gepaarte Cache-Runden, baut CLI und Analyse-Worker und prüft beide gebauten Artefakte. Die Manifestdatei `dist/version.json` enthält reale Versionen und Artefakt-Hashes; ein zusätzlicher lokaler JSON-Receipt trägt Ergebnisse, Stufenzeiten und Messwerte. Ein Compile allein ist keine Interaktionsabnahme.

Der Cache-Vergleich misst nur den CPU-/Allokationspfad wiederholter `prepare()`-Aufrufe. Er ist kein allgemeiner Projekt-Speedup. Haltbarkeit bleibt standardmäßig WAL + `synchronous=FULL`; kein schnelleres Ergebnis durch abgeschwächte Assertions oder ausgeschaltete Persistenz.

`ORIGIN.json` dokumentiert den eingefrorenen, bereits abgeschlossenen TypeScript-Port und die FFI-Herkunft. Originale außerhalb `v1/` bleiben unangetastet. Im öffentlichen Repository liegt dieses eigenständige Paket unter `packages/superiss/`; dort sind Befehle relativ zu diesem Paket auszuführen. Release, Installation und Daemon-Cutover benötigen zusätzlich zur Quellabnahme einen Paket-/Plattformnachweis und Rückbaupfad. Keine vollständige Stromausfall-/Desasterabnahme oder unabhängige Sicherheitszertifizierung wird behauptet.

## Quellen und Grenzen der Recherche

Stand **1. November 2026**; spätere November-Erfahrungen sind nicht bekannt. Es wurden Superweb Mega, offizielle Dokumentation, ghmax und Metacode verwendet. Metacode lieferte keinen geeigneten DuckDB-Donor; Freshdocs lieferte teilweise nur README-Kontext. Das ist kein API-Nachweis. Bibliotheksdetails wurden deshalb zusätzlich mit offiziellen C-API-Seiten, vorhandenen Typen und isolierten Laufzeitproben geprüft. Keine neuen Repositories wurden automatisch indexiert.

- [DuckDB 2.0 vom 21. Oktober 2026](https://duckdb.org/2026/10/21/announcing-duckdb-200): Quack und neue Funktionen, kein pauschaler OLTP-Speedup.
- [DuckDB Concurrency](https://duckdb.org/docs/2.0/connect/concurrency) und [Transaktionen](https://duckdb.org/docs/2.0/sql/statements/transactions): MVCC/Snapshot Isolation ist kein Beweis serialisierbarer Gate-/Budget-Regeln.
- [SQLite-Erweiterung](https://duckdb.org/docs/2.0/core_extensions/sqlite): kann auch schreiben; v1 wählt stattdessen die ausdrückliche lesende Brücke.
- [Appender](https://duckdb.org/docs/2.0/clients/c/appender): Bulk-Import statt Einzeltransaktionen.
- [SQLite Changelog](https://sqlite.org/changes.html): 3.54.1 vom 16. Oktober 2026; reale lokale Bibliothekswahl wurde geprüft.
- Die vorherige lokale Analyse erfasste 19 Quellen und getrennte Messungen. Trends und fremde Benchmarks ersetzen keine lokale Abnahme.

Die Loop-Prinzipien aus `zeroloop`, `superloop` und `mksisloop` sind hier konkret: eine maßgebliche Aufgaben-DB, begrenzte parallele Arbeit, persistente Verbindungen, set-basierte Auswahl, kurze Schreibabschnitte, source-bound Receipts, Prüfungen vor Abschluss und keine Wiederholung unveränderter grüner Flächen ohne Grund. Das ist kein Anspruch, sämtliche denkbaren Speed-Skills oder optimale Einstellungen für jede Last nachgewiesen zu haben.
