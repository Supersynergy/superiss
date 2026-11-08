# Superiss 1.1

**Agenten koordinieren und Ergebnisse vor dem Abschluss prüfen — mit integriertem Git-/Forge-Ablauf.**

Version **1.1.0**: Bun/TypeScript, SQLite als verbindliche Aufgaben-Datenbank, 88 Kernoperationen und zehn Forge-Tools. DuckDB 2 dient optionalen, getrennten Snapshot-Analysen.

| Bereich | Aktueller Stand |
| --- | --- |
| Aufgaben und Gedächtnis | Ziele, Abhängigkeiten, Ready-Queue, Notizen, Remember/Recall |
| Zuständigkeit | Atomare Claims, Actor, Epoch, Ablaufzeit und Heartbeats |
| Abnahme | Prüfbefehl ausführen; Abschluss an Vertrag, Quellen und Proof binden |
| Git/Forge | Worktree, Änderungen, Artefakte, echter Git-Commit, Push, PR, CI, Rebase, lokaler Merge |
| Worktrunk | Optionaler Backend; kein stiller Rückfall auf Git |
| Anbieter | GitHub über `gh`; Gitea/Forgejo über REST |
| Mehrere Repositories | Konfigurierte `repos` und ausdrückliches `meta.repo_key` |
| Schnittstellen | CLI, Socket, MCP, lokales HTTP und Boards |

```sh
mkdir -p /absolute/project/.sis
export SIS_DB=/absolute/project/.sis/project.db
bin/sis up
bin/sis forge serve --repo /absolute/project --port 8766
```

Bun ab 1.4.4 ist erforderlich, für Forge Git. Worktrunk und `gh` werden nur für die entsprechenden Funktionen benötigt. Analysen brauchen zusätzlich DuckDB 2 und `run-guard`. Es wird nichts automatisch installiert.

`bin/sis` startet jetzt die aktuelle 1.1-Laufzeit. `bin/sis-v1` und `bin/sisf` bleiben passende Aliase. Bestehende Datenbanken und laufende Daemons werden nicht automatisch umgestellt. Ein 1.1-Client weist ältere Daemons vor Schreiboperationen zurück; vorher die alte Installation behalten und eine Datenbankkopie prüfen.

Die Rust-/Python-0.9-Referenz bleibt über `sis reference …` bzw. `SIS_IMPL=rs|py` erreichbar. macOS-Sandbox und launchd-Dienst gehören weiterhin zu dieser Referenz. Historische Prüfbelege sind entsprechend gekennzeichnet.

[Start und Upgrade](docs/GETTING-STARTED.md) · [Forge-Befehle](docs/SISF.md) · [Features und Versionsgrenzen](docs/FEATURES.md) · [Vergleich mit Worktrunk und Beads](docs/COMPARISON.md) · [Prüfstand](docs/VALIDATION.md) · [English](README.md)
