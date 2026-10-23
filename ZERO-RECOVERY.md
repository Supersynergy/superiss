# Lokaler Nullkosten-Ablauf

`sis run` führt genau eine ausdrücklich gewählte lokale Aufgabe vom Claim bis zum belegten Abschluss aus. Die Ausführung ist opt-in. Sie startet keinen dauerhaften Dienst und keinen externen Modellaufruf.

## Vertrag

Eine vorhandene, ausdrücklich gewählte Projekt-DB verwenden. Tracker und Lockdateien müssen außerhalb des beschreibbaren Jobverzeichnisses liegen. Beispiel für `task.json` mit absoluten Pfaden:

```json
{
  "id": "sort-local-input",
  "title": "Lokale Eingabe sortieren",
  "owner": "local-worker",
  "budget_eur": 0,
  "oracle_cmd": "cmp result.txt expected.txt",
  "allowed_paths": ["/ABS/job/input.txt", "/ABS/job/expected.txt"],
  "acceptance": "result.txt stimmt bytegenau mit expected.txt überein",
  "meta": {
    "local_zero": true,
    "budget_gate": true,
    "execution": {
      "cmd": "sort input.txt > result.txt",
      "cwd": "/ABS/job",
      "replay_safe": true,
      "oracle_replay_safe": true
    }
  }
}
```

```bash
sis create @task.json --db /ABS/tracker/.sis/project.db
sis run --db /ABS/tracker/.sis/project.db --issue sort-local-input --actor local-worker
```

`owner` und Actor müssen übereinstimmen. `local_zero` verlangt ein bekanntes Budget von exakt 0. Fehlendes Budget ist keine Nullkostenfreigabe. Vor Run und Oracle prüft der Kern außerdem die bereits gebuchten Kosten. Das Budget-Gate beim Abschluss unterscheidet ebenfalls 0 von fehlendem Budget.

Run und Oracle laufen auf macOS in einer Seatbelt-Sandbox: Netzwerkverbindungen einschließlich Unix-Sockets und Launch-IPC sind gesperrt; die Umgebung enthält keine übernommenen Zugangsdaten. Schreiben ist nur im kanonischen Jobverzeichnis erlaubt. Benutzerverzeichnisse außerhalb davon sind nicht lesbar. Systemdateien und Daten innerhalb des Jobverzeichnisses bleiben lesbar; Zugangsdaten gehören deshalb nicht in diesen Arbeitsbereich. Ohne verfügbare Sandbox schlägt der Modus sichtbar fehl.

Diese Begrenzung betrifft die vom lokalen Ablauf gestarteten Prozesse. Sie ist kein Ausgabenstopp für andere Apps, fremde Prozesse oder bereits laufende Providerjobs. Externe kostenpflichtige Ausführung wird in dieser Lieferung nicht angeboten. Ein späterer Provideradapter braucht eine eigene verbindliche Quota- und Kostenadmission.

Session- und Prozessgruppenwechsel werden im lokalen Modus gesperrt. Dazu blockiert die Sandbox `setsid`, `setpgid` und `posix_spawn`, damit eine abgetrennte Gruppe den Timeout nicht überlebt. Manche Systemlauncher verwenden intern `posix_spawn`; in diesem Modus ist dann ein direkt ausführbares Programm erforderlich. Die Syscall-Nummern wurden mit dem installierten Apple-SDK und der [offiziellen XNU-Tabelle](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/syscalls.master) abgeglichen.

## Zustände und Wiederanlauf

Der Controller speichert vor jedem wirkenden Schritt einen nativen Checkpoint. Run-PASS und Oracle-PASS sind getrennt. Erst ein gültiger Proof erlaubt Close; ein anschließender Readback bestätigt den Abschluss.

```text
prepared → run_started → run_passed → verify_started
         → proof_passed → close_started → closed
```

Ein Fehler oder Timeout führt zu einem sichtbaren Stopp. Bekannte Fehlschläge werden nicht automatisch als neuer Versuch behandelt. SIGINT/SIGTERM verhindern den nächsten Schritt; die laufende begrenzte Ausführung kann noch zu Ende laufen. Nach Unterbrechung:

```bash
sis run --db /ABS/tracker/.sis/project.db --issue sort-local-input --actor local-worker --resume
```

Der Controller prüft dabei Projektidentität, Owner, Vertragsrevision, Konfiguration und Quellenbindung des Checkpoints. Bereits atomar gespeicherte Idempotenzantworten werden gelesen. Fehlt nach einem Abbruch eine solche Antwort, darf der Run nur mit `execution.replay_safe=true` wiederholt werden; beim Oracle gilt gesondert `oracle_replay_safe=true`. Diese Kennzeichnungen sind ein Vertrag des Aufgabenautors. Die Software kann die fachliche Wiederholbarkeit eines beliebigen Kommandos nicht beweisen.

Ein exklusiver OS-Lock pro kanonischer DB und Aufgabe bleibt bis zum tatsächlichen Ausführungskind erhalten. Ein zweiter Controller startet nicht parallel. Direkte Kernaufrufe vermeiden eine unterbrochene Lockkette über einen fremden Socketdienst. Abgelaufene Claims werden erst unter diesem Lock neu geclaimt; eine neue Epoch benötigt einen neuen Proof. Ist dessen Oracle-Wiederholung nicht freigegeben, bleibt eine verantwortliche Entscheidung erforderlich.

## Grenzen

- Run-Kommandos müssen die geschützten Eingaben unverändert lassen. Ergebnisse können im Jobverzeichnis außerhalb des Eingabe-Fingerprints entstehen. Dieser erste Ablauf ist kein allgemeiner Coding-Agent für Änderungen innerhalb des geschützten Quellumfangs.
- `meta.autorun` und der vollständige Ablauf dürfen dieselbe Aufgabe nicht ausführen. Der Controller lehnt die Kombination ab.
- Standard: 30 Sekunden pro Run/Oracle und 180 Sekunden Gesamtfrist. Optionen: `--timeout 1..60`, `--deadline 5..300`. Es werden höchstens sechs Ausführungsstarts einschließlich Wiederaufnahmen zugelassen.
- Quellen-, Rechte- oder Commandänderung macht gespeicherte Belege unbrauchbar. Budget und sicherheitsrelevante Metadaten gehören zur Vertragsrevision.
- Eine erforderliche unabhängige Review wird nicht durch automatisches Close ersetzt. Der Kern verweigert den Abschluss ohne passenden Beleg.
- Es gibt keine Zusage einmaliger beliebiger externer Wirkungen und keine unbeaufsichtigte globale Selbständerung.

## Abnahme

```bash
python3 tests/budget_suite.py --impl rs
python3 tests/controller_suite.py --impl rs
python3 tests/recovery_edges.py --impl rs
bash tools/verify-all.sh
```

Die Tests verwenden private temporäre Stores und beenden ausschließlich eigene Prozesse. Sie prüfen echte SIGKILL-Fenster sowie die gesperrte Wiederholung unklarer Wirkungen. Ein bestandener lokaler Test ist kein 24-Stunden-Verfügbarkeitsnachweis.
