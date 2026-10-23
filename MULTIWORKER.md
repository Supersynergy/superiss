# Superiss 0.9: Multiworker-Kern und lokale Bereitstellung

## Implementiert

- `attest kind=run` führt Kommandos außerhalb der SQLite-Schreibtransaktion aus. Vor dem Speichern werden Claim, Lease, Abbruch, Vertragsrevision und Quellenhash erneut geprüft. Run-Attestierungen und verschachtelte Batches sind im Batch verboten.
- `outbox_export` reserviert mit explizitem `actor` eine Zustellung atomar. Sie trägt Zustell-Epoch, Ablaufzeit und einen stabilen Idempotenzschlüssel. ACK und Fehlerbestätigung verlangen dieselbe lebende Zustellung. Ein abgeschlossenes Ergebnis lässt sich nicht in das gegenteilige Ergebnis umschreiben.
- Ein Run mit `outbox_id` muss zur reservierten Aufgabe, Claim-Epoch, Kommando, konfiguriertem Arbeitsverzeichnis und zum Idempotenzschlüssel passen. Vor dem Start muss die Zustell-Lease die komplette Kommandofrist einschließlich Aufräumreserve abdecken. Derselbe Run-Key liefert den gespeicherten Beleg statt einer erneuten Ausführung.
- Nach drei abgelaufenen Zustellversuchen wird ein Job sichtbar `failed`. Transportfehler bestätigen keinen Erfolg. Ein tatsächlich fehlgeschlagenes Kommando wird ebenfalls als Fehler bestätigt.
- Claim-Auswahl streamt Kandidaten, filtert ungeeignete Zustände bereits in SQL und nutzt Indizes für Auswahl und Elternbeziehungen. Gates, Dependencies, Containerregeln und Prioritätsreihenfolge bleiben erhalten.
- `learn since=...` filtert auch Proofs und Issue-Kohorten. Proof-Zeitfenster verwenden Verifikationsereignisse; unbekannte Zeitstempel zählen nicht in ein positives Zeitfenster. Gleichstände werden nach Schlüssel sortiert. Lernmetriken schalten keine Vorgaben automatisch um.
- Das MCP-Agentenprofil begrenzt Aufrufe auf die tatsächlich angebotenen zwölf Tools, nicht nur deren Anzeige. Das ist eine Profilgrenze, kein Ersatz für Betriebssystemrechte oder Administratorauthentifizierung.
- Python-JUnit-Belege dürfen nicht über gleichnamige Nachbarverzeichnisse aus dem Arbeitsverzeichnis ausbrechen.

## Kompatibilität und Betrieb

Weiterhin 85 registrierte Operationen und Protokoll 2; Datenbankschema jetzt **8**.
Die Migration von Schema 7 erhält Aufgaben und Projektidentität und ergänzt Tabellen und Indizes. Zukünftige unbekannte Schemas werden abgewiesen.

Alle Runner eines Stores müssen für die neuen Zustell-Leases aktualisiert werden. Ohne Export-Actor bleibt die alte Preview-/Drain-Schnittstelle erhalten; sie ist nicht der neue Mehrfach-Runner-Pfad. Leased Export und `drain:true` dürfen nicht kombiniert werden.

Die native CLI zeigt mit `context` auch die Identität eines älteren Daemons, übermittelt diesem aber keine weiteren Operationen. Ein Upgrade darf nur einen eigenen, geprüften, ruhenden Daemon ersetzen. Diese Bereitstellung beendet keine fremden Daemons und migriert keine produktiven Projektstores automatisch. Für die sofortige Nutzung eine neue explizite Projektdatenbank wählen.

Ein älterer CLI-Pointer allein ist kein Datenbank-Rollback. Ein einmal migrierter Schema-8-Store braucht eine passende Laufzeit. Vor produktiver Migration die vorhandene projektspezifische Sicherungs- und Wiederanlaufprozedur verwenden.

## Lokal sofort benutzen

Der Release-Build liegt in diesem `main`-Worktree unter `bin/superiss-native`; `bin/sis` verwendet ihn ohne Cargo. Der globale `sis`-Pointer bleibt unverändert. Mit einer neuen, ausdrücklich gewählten Projektdatenbank:

```bash
./bin/sis context \
  --db /absoluter/pfad/zum/neuen-projekt/.sis/superiss.db
```

Nach Quelländerungen den lokalen Release neu bauen und die Binärdatei aktualisieren:

```bash
CARGO_TARGET_DIR=.cache/cargo cargo build --release --locked -j2
cp .cache/cargo/release/superiss bin/superiss-native
```

Die Änderungen werden lokal auf dem Branch `main` gepflegt. Der ursprüngliche Checkout, globale Installation und Desktop-App werden nicht ersetzt.

## Runner benutzen

```bash
sis context --db /absoluter/pfad/zum/projekt/.sis/superiss.db
sis capabilities --db /absoluter/pfad/zum/projekt/.sis/superiss.db
./tools/sis-runner.sh --db /absoluter/pfad/zum/projekt/.sis/superiss.db --once --actor runner-a
```

Die Beispieldatenbank muss zum gewählten Projekt gehören; der Runner errät kein Projekt. Ein Run-Job entsteht beim Claim einer Aufgabe mit `meta.autorun`, beispielsweise mit einem expliziten absoluten `cwd`. Der Runner führt jeweils nur eine reservierte Zustellung aus und schließt eine Aufgabe nicht selbst ab. `verify` und das gefencte `close` bleiben gesonderte Abnahmeschritte.

Der Vordergrundbetrieb ohne `--once` wartet höchstens 60 Sekunden pro Poll und verarbeitet höchstens `--max-jobs` Jobs. SIGINT/SIGTERM verhindern neue Arbeit; eine laufende begrenzte Ausführung wird zu Ende geführt. Bei unklarem Transportausgang stoppt der Runner ohne ACK und ohne blinden Wiederholungsversuch.

Subprozessausgaben und Kommandos werden nicht in der Runner-Fehlermeldung ausgegeben. Die Storefehlerklasse bleibt sichtbar. Shell-Kommandos laufen mit den Rechten des aufrufenden Nutzers; `allowed_paths` und Quellennachweise sind keine Sandbox.

## Selbsttests und gepaarter Benchmark

```bash
bash tools/verify-all.sh
ruff check tools/sis_runner.py bench/multiworker.py
python3 -m mypy --strict tools/sis_runner.py bench/multiworker.py
```

Die Python-Referenz benötigt das bestehende `tiktoken`-Setup und dessen Cache. Bei getrenntem Interpreter `SIS_PYTHON` und `TIKTOKEN_CACHE_DIR` explizit setzen. Der native Release-Build braucht diese Python-Abhängigkeit nicht.

`bench/multiworker.py` führt pro Arm denselben Ablauf aus: Claim, quellengebundene Verifikation, Proof-gebundener Abschluss und abschließende exakte Closed-Zählung. Die Datenbank ist pro Versuch privat und temporär. Die Initialisierung und das synthetische Backlog-Seeding liegen außerhalb der gemessenen Batchdauer; beide Arme werden warm gemessen. Es ist kein Kaltstart- oder Providerbenchmark.

```bash
python3 bench/multiworker.py \
  --baseline .cache/bench/baseline-superiss \
  --candidate .cache/cargo/debug/superiss \
  --baseline-ref d2b91143c692096c0c719aaec1957d733be0cc23 \
  --backlog 10000 --workers 1,2,4,8 --repeats 3 \
  --out .cache/bench/comparison-new.json
sgg bench compare --file .cache/bench/comparison-new.json --json --require-gain
```

Die Baseline ist ein vor der Änderung gesicherter Debug-Build desselben Checkouts; der Kandidat muss ebenfalls ein aktueller Debug-Build sein. Die Messung enthält drei Paare pro Laststufe und wechselt die Arm-Reihenfolge. Quellen, Binärdateien und Prüfprogramm werden gehasht; Änderungen während der Messung brechen die Auswertung ab. Die CLI überschreibt keine vorhandene Ergebnisdatei und begrenzt Backlog, Wiederholungen und virtuelle Clients.

Messdaten, SGG-Auswertung und Kennzahlen liegen für diese Lieferung unter [`bench/results/`](bench/results/README.md). Der installierte SGG-CLI-Vergleich besteht mit `--file`; eine CLI-Codeänderung war nicht erforderlich. Anzugeben sind akzeptierte Aufgaben pro Sekunde und Latenzen je Laststufe, nicht allein die Anzahl gestarteter Worker. Ein Quellenvergleich gilt nur für das geprüfte Arbeitsprofil. Modellaufrufe, Tokenverbrauch und Providerkosten werden hier nicht gemessen. Acht virtuelle Socket-Clients beweisen keine optimale Zahl von Coding-Agenten.

## Simflow: geprüfte Übergänge und Grenzen

| Perspektive | Übergang und Beleg |
|---|---|
| Lifecycle | Schema-7-Migration erhält Identität und Aufgabe; bestehende Crash-/Restart-Tests bleiben Teil der Abnahme. Release-Launcher funktioniert ohne Cargo im PATH. |
| Dependencies | Kommando-Fehler und Timeout bleiben FAIL; Transportunsicherheit lässt Zustellung unbestätigt. Ältere Daemons werden vor Mutation abgewiesen. Provider-/Quotenausfälle sind nicht Bestandteil dieses modellfreien Benchmarks. |
| Konkurrenz | Gleichzeitige Runner erhalten nicht denselben aktiven Job. Heartbeat und Abbruch bleiben während eines blockierenden Run-Kommandos verfügbar. Idempotenz verhindert erneute Ausführung desselben Zustell-Keys. |
| Ressourcen/Zeit | Ausführung maximal 60 Sekunden; Zustell-Lease 5..3600 Sekunden, maximal drei Versuche, einzelne Zustellung pro Runner. Bench-Clients, Datensätze und Socketwartezeiten sind begrenzt. |
| Vertrauen | Quellenänderung, Abbruch, falscher Runner, alte Epoch, fremdes Kommando und falscher Run-Key liefern keinen PASS. Versteckte MCP-Aufrufe und JUnit-Nachbarpfade werden abgewiesen. |

Ablauf: `Claim -> pending Outbox -> atomar running/Delivery-Epoch -> gefencter Run ohne Writer-Lock -> erneute Quellen-/Claim-Prüfung -> Run-Beleg -> gefencter ACK`. Bei Crash bleibt die Zustellung bis zum Lease-Ablauf reserviert. Eine neue Zustellung bekommt eine neue Epoch; alte ACKs werden abgewiesen.

Bei externen Seiteneffekten bleibt das Fenster zwischen Ausführung und ACK grundsätzlich unsicher. Exactly-once für beliebige Shell-Kommandos wird nicht zugesagt. Externe Ziele brauchen eigene Idempotenz; bei unsicherer Wirkung ist vor einer weiteren Zustellung eine verantwortliche Wiederanlaufentscheidung erforderlich.

## Bewusst keine unbeaufsichtigte Selbständerung

Diese Version verbessert den Kern und das messbare Entwicklungsverfahren. Ein global optimaler kritischer-Pfad-Scheduler, automatische Worktree-Erstellung, semantische Dateibereichsreservierungen und autonomes Modellrouting sind nicht implementiert. Die bestehenden Claims, Slots, Goals und Controller bleiben zuständig. Worktrunk bleibt optional und wurde nicht zur Laufzeitabhängigkeit gemacht.

Eine Verbesserung wird anhand gleicher akzeptierter Arbeit mit unveränderten Abnahmebedingungen beurteilt. Die Benchmark-Auswertung darf einen Kandidaten empfehlen, ändert aber keine Providerbudgets, Sicherheitsgrenzen oder Agentenzahl. Große Repositories brauchen weiterhin vollständig deklarierte modulare Quellenbereiche samt gemeinsamen Eingaben; die bisherigen Fingerprint-Grenzen wurden nicht abgeschwächt.
