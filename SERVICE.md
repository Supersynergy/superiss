# Superiss-Dienst

`sis service` verwaltet einen lokalen Aufgaben-Daemon. Er verwendet den vorhandenen vollständigen `sis run`-Ablauf und öffnet keinen zusätzlichen Netzwerkport. Der RPC-Dienst `sis up` bleibt eine eigene Funktion.

## Konfiguration

Eine JSON-Datei mit absoluten kanonischen Pfaden enthält `id`, `db`, `goal`, `actor`, `stateDir`, `sis` und `jobRoot`. `zeroCostLock:1`, `extraSpendEur:0` und `providerMode:"local-only"` gelten automatisch. Andere Kosten- oder Providerwerte werden abgelehnt. Die DB und der Dienstzustand liegen außerhalb des Jobverzeichnisses. `sis` zeigt auf einen geprüften festen Release-Pfad. Der Dienst berücksichtigt direkte Teilaufgaben des gewählten Goals. Owner, Nullbudget, `local_zero` und ein Arbeitsordner innerhalb von `jobRoot` sind Pflicht.

Defaults: `pollMs:1000`, `maxConcurrent:4`, `timeoutSecs:10`, `deadlineSecs:60`, `maxRestarts:3`, `watchdogSecs:120`. Bis zu 16 lokale Worker können explizit konfiguriert werden. Gleiche oder ineinanderliegende Arbeitsverzeichnisse warten aufeinander. Abhängigkeiten und Gates werden vor dem Start über natives `ready` geprüft; Warten verbraucht keine Wiederholungsversuche. Der Sandbox- und Checkpoint-Vertrag steht in ZERO-RECOVERY.md. Laufende eingefrorene Releases behalten ihre Einstellungen.

```bash
sis service defaults
sis service status --config /ABS/config.json
sis service foreground --config /ABS/config.json
sis service install --config /ABS/config.json
sis service pause --config /ABS/config.json
sis service resume --config /ABS/config.json
sis service uninstall --config /ABS/config.json
```

## Betrieb und Wiederanlauf

Ein kleiner Python-Launcher hält einen echten `flock` über `exec` bis zum Ende des Daemons. Er benötigt keine zusätzlichen Pakete. Worker behalten ihre eigenen nativen Workflow-Sperren. Nach einem Daemon-Abbruch werden lebende eigene Worker abgeglichen; bestätigte Wirkungen werden über native Checkpoints wiedergefunden. Bekannte Aufgabenfehler sind terminal. Unklare Wirkungen bleiben an die Replay-Freigabe des Aufgabenvertrags gebunden.

Zustand wird atomar mit `fsync` gespeichert. Eine separate Pause-Datei bleibt über Neustarts erhalten. Begrenzte Fehlerhistorie und rotierende Dienstlogs helfen bei der Diagnose. Ein fehlerhafter oder fremder Zustand wird erhalten und verlangt eine Klärung.

Auf macOS installiert `install` zwei eigene LaunchAgents für den angemeldeten Nutzer: Hauptdienst mit KeepAlive und Startdrosselung sowie einen Watchdog im 30-Sekunden-Takt. Der Watchdog prüft Konfiguration, Installationsbeleg, Prozessinstanz und Startidentität. Er begrenzt erzwungene Neustarts auf drei pro Stunde. `uninstall` entfernt ausschließlich die nachgewiesene eigene Installation. Login-Autostart ist keine Abnahme eines Rechner-Neustarts vor der Anmeldung.

## 24-Stunden-Test

Der gebündelte Such-Workload benötigt `fd` und `ripgrep` im Suchpfad.
Auf macOS: `brew install fd ripgrep`. Der Aufgabenstore selbst benötigt
diese Werkzeuge nicht.

Die optionale `soak`-Konfiguration erzeugt stündlich 20 private Find-Everything-Aufgaben. Sie speichert Zeitproben und eine Hashkette in `soak.sqlite`, beendet absichtlich ausgewählte eigene Worker und beobachtet den Wiederanlauf. Ein zeitlich begrenztes `caffeinate` verhindert während des Tests Leerlaufschlaf; echte Beobachtungslücken bleiben sichtbar.

```bash
bun tools/service-soak.ts verify --config /ABS/config.json
```

Die Abnahme verlangt tatsächlich verstrichene 86400 Sekunden, vollständige Zeitabdeckung innerhalb der Lückengrenze, alle 20 Aufgaben pro Zyklus mit nativen Run-/Close-Belegen, mindestens drei gebundene Kill-/Recovery-Paare und keine nichtnulligen Kostenbuchungen. Ein kurzer privater Testlauf wird ausdrücklich zurückgewiesen. Ein nicht bestandener Langzeittest darf nicht als abgeschlossenes Goal geschlossen werden.

## Kosten und Grenzen

Für echte Modellagenten verwendet der Host-Controller vorhandene autorisierte Codex-Anmeldungen und den enthaltenen Host-Transport. Standard sind bis zu drei Luna-Agenten, 2 Prozent Kontingentreserve und automatische Ausführung bereits freigegebener Aufgaben. Keine Tokens werden kopiert; lokale Worker erhalten weiterhin keine Zugangsdaten. `sis service agent-ready --config /ABS/controller.json --quota /ABS/receipt.json` liefert konfliktfreie native Aufgaben, ohne sie zu claimen oder selbst einen Modellaufruf auszuführen.

Ein Kontingentbeleg enthält `source:"mcp__codex_app__get_usage_limits"`, aktuelle `observedAt`-Millisekunden, die unveränderte `usage`-Antwort des Host-Tools sowie `capacity:{ownActive,freeSlots,ownScopes,foreignScopes}` aus der aktuellen Kapazitäts- und Scope-Prüfung. Eigene Bereiche umfassen auch reservierte Arbeit. Er darf höchstens fünf Minuten alt sein. Unbekannte Kontingente oder eigene Bereiche, kostenpflichtige Credits, aufgebrauchte Reserve oder fehlende freie Slots sperren die Auswahl. Die Datei ist ein Auditbeleg, kein signierter Providerbeleg. Jede Antwort trägt `dispatchAuthorized:false` und `requiresLiveHostCheck:true`. Nur der Host startet nach dem tatsächlichen frischen Toolaufruf, globalem Dispatch-Slot und fenced Claim. Ein gespeicherter Beleg oder eine Anmeldung allein genügt nicht.

Automatisch ausgewählte Aufgaben benötigen passenden Owner und Parent, Budget 0, einen echten Oracle und `meta.execution:{kind:"host-agent",auto_dispatch:true,transport:"codex-host-included",cwd:"/ABS/Arbeitsordner"}`. Diese Ausführungsdaten sind Bestandteil der nativen Vertragsrevision. Der Arbeitsordner liegt im konfigurierten Bereich. Vorhandene Aufgaben werden nicht ummarkiert. Der Host claimt atomar, liest den geclaimten Vertrag erneut, prüft Revision und Bereiche, verwendet die Capsule-Prüfung und übergibt ausschließlich die freigegebenen Dateibereiche. Verifikation und Abschluss behalten Actor/Epoch und Quellbindung. Die laufende 24-Stunden-Abnahme wird von diesem neuen Controller nicht verändert.

`sis service enqueue-agent --task /ABS/task.json` verwendet die eingerichtete Controller-Konfiguration automatisch. Die Datei benötigt `title`, `cwd`, `allowed_paths` und `oracle_cmd`; optional sind `id`, `desc` und `priority`. Owner, Parent, Nullbudget und der enthaltene Transport werden gesetzt. Der Arbeitsbereich bleibt auf den konfigurierten Jobroot begrenzt. Eigene `--config`-Dateien sind möglich. Die Chat-Automation prüft die freigegebene Queue alle 15 Minuten; der Codex-Host muss dafür verfügbar sein.

Der Daemon startet ausschließlich lokale Kommandos im strikten Nullkostenmodus. Er besitzt keinen Provideradapter, keinen API-Fallback und keine Berechtigung für neue Ausgaben. Eine Laufzeitsperre und eine Kontingentbeobachtung sind keine Rechnungsmessung und kontrollieren keine fremden Apps.

Abnahme: `bun test tests/service*.test.ts` sowie `bash tools/verify-all.sh`. Die Tests verwenden eigene private Datenbanken und signalisieren ausschließlich eigene Fixture-Prozesse. Live-Installation und tatsächlich verstrichene 24 Stunden werden getrennt nachgewiesen.
