//! Superiss — durable agent contracts and source-bound acceptance receipts.
//! Build with `cargo build --locked`; run through `bin/sis`.
//! Ops: create dep ready claim claim_next heartbeat close reopen show search
//! stale orphans stats remember recall export import batch budget_claim
//! contract outbox_list/done/fail compact serve mcp.

use rusqlite::{params, params_from_iter, types, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
mod agent;
mod transport;

const LEASE_S: f64 = 1800.0;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS issues(
  id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'open',
  priority INT DEFAULT 2, type TEXT DEFAULT 'task',
  owner TEXT, oracle_cmd TEXT, allowed_paths TEXT, lane TEXT,
  budget_eur REAL, acceptance TEXT, "desc" TEXT,
  lease_until REAL, lease_epoch INT DEFAULT 0, claim_actor TEXT,
  created_at REAL, closed_at REAL, meta_json TEXT,
  defer_until REAL, expires_at REAL);
CREATE TABLE IF NOT EXISTS deps(issue TEXT, depends_on TEXT,
  type TEXT DEFAULT 'blocks', PRIMARY KEY(issue, depends_on));
CREATE TABLE IF NOT EXISTS claims(actor TEXT, issue TEXT, claim_id TEXT,
  epoch INT, hb_at REAL, run_id TEXT, PRIMARY KEY(actor, issue));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, op TEXT, issue TEXT, actor TEXT, run_id TEXT, idem TEXT, data_json TEXT);
CREATE TABLE IF NOT EXISTS memories(key TEXT PRIMARY KEY, value TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, payload TEXT, state TEXT DEFAULT 'pending',
  attempts INT DEFAULT 0, run_id TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS gates(name TEXT PRIMARY KEY, state TEXT DEFAULT 'closed',
  payload TEXT, updated_at REAL);
CREATE TABLE IF NOT EXISTS slots(name TEXT PRIMARY KEY, holder TEXT,
  epoch INT DEFAULT 0, lease_until REAL, claim_id TEXT, updated_at REAL);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_deps_issue ON deps(issue);
CREATE INDEX IF NOT EXISTS idx_deps_on ON deps(depends_on);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, priority);
"#;

const COLS: &str = "id,title,status,priority,type,owner,oracle_cmd,allowed_paths,\
lane,budget_eur,acceptance,\"desc\",lease_until,lease_epoch,claim_actor,created_at,closed_at,defer_until,expires_at,meta_json";
const KEYS: [&str; 19] = [
    "id",
    "title",
    "status",
    "priority",
    "type",
    "owner",
    "oracle_cmd",
    "allowed_paths",
    "lane",
    "budget_eur",
    "acceptance",
    "desc",
    "lease_until",
    "lease_epoch",
    "claim_actor",
    "created_at",
    "closed_at",
    "defer_until",
    "expires_at",
];
// Only `blocks` deps gate readiness (v2: deps.type); defer_until>now also
// hides open issues, and a deferred issue whose defer_until passed is ready.
const BLOCKED: &str = "NOT EXISTS (SELECT 1 FROM deps d LEFT JOIN issues b \
ON d.depends_on=b.id WHERE d.issue=i.id AND (d.type IS NULL OR d.type='blocks') \
AND COALESCE(b.status,'open')!='closed') AND NOT EXISTS (SELECT 1 FROM deps dg LEFT JOIN gates g \
ON dg.depends_on=g.name WHERE dg.issue=i.id AND dg.type='gate' \
AND COALESCE(g.state,'closed')!='open')";
const READY_PRED: &str = "(i.status='open' OR (i.status='deferred' AND \
i.defer_until IS NOT NULL AND i.defer_until<=?)) AND \
(i.defer_until IS NULL OR i.defer_until<=?) AND \
(i.expires_at IS NULL OR i.expires_at>?) AND \
i.type NOT IN ('goal','epic') AND i.oracle_cmd IS NOT NULL AND trim(i.oracle_cmd)!='' AND NOT EXISTS (SELECT 1 FROM cancellations x WHERE x.issue=i.id AND x.requested!=0) AND NOT EXISTS (SELECT 1 FROM issues child WHERE json_extract(child.meta_json,'$.parent')=i.id OR (child.id LIKE i.id||'.%' AND instr(substr(child.id,length(i.id)+2),'.')=0))";
const WRITES: &[&str] = &[
    "create",
    "dep",
    "dep_remove",
    "dep-remove",
    "claim",
    "claim_next",
    "claim-next",
    "heartbeat",
    "close",
    "reopen",
    "remember",
    "import",
    "budget_claim",
    "budget-claim",
    "outbox_done",
    "outbox-done",
    "outbox_fail",
    "outbox-fail",
    "compact",
    "batch",
    "update",
    "changes",
    "note",
    "unclaim",
    "defer",
    "undefer",
    "label",
    "rename",
    "delete",
    "reclaim",
    "gate",
    "slot_acquire",
    "merge_slot",
    "slot_release",
    "q",
    "goal",
    "goal_create",
    "goal-create",
    "sub",
    "subgoal",
    "plan",
    "goal_done",
    "goal-done",
    "attest",
    "cost_add",
    "cost-add",
    "outbox_export",
    "outbox-export",
    "sync_import",
    "sync-import",
];

// Pure reads: on a missing DB they would print an empty backlog, which the
// store-selection policy forbids ("keine leere DB als aktuellen Stand").
const READS: &[&str] = &[
    "ready", "list", "query", "count", "dep_list", "dep-list", "children",
    "show", "search", "history", "comments", "stale", "orphans", "stats",
    "review", "lint", "export", "contract", "brief", "goal_tree", "goal-tree",
    "tree", "next", "epic", "dup_scan", "dup-scan", "find_duplicates",
    "find-duplicates", "recall", "outbox_list", "outbox-list", "gate_list",
    "gate-list", "slot_list", "slot-list", "goal_done", "goal-done", "watch",
    "snapshot", "who", "cost_list", "cost-list", "cost_rollup", "cost-rollup",
    "sync_export", "sync-export", "learn", "spans",
];
// Write-ish cmds outside WRITES (fenced/multi-step or process-level).
const EXTRA_WRITES: &[&str] = &[
    "acquire", "checkpoint", "handoff", "cancel", "cancel_ack", "cancel-ack",
    "admin_update", "admin-update", "verify", "serve", "mcp",
    // Meta ops: not backlog reads — they may lazily create an explicit store.
    "context", "capabilities", "tokens", "prime", "types", "statuses",
];
fn known_cmd(cmd: &str) -> bool {
    WRITES.contains(&cmd) || READS.contains(&cmd) || EXTRA_WRITES.contains(&cmd)
}

// Ops that must not trigger an .issues.jsonl snapshot rewrite: lease/beat
// churn and non-issue tables. Snapshot content is deterministic, so an
// unchanged issue set yields an unchanged file either way.
const SNAP_SKIP: &[&str] = &[
    "heartbeat", "remember", "outbox_done", "outbox-done", "outbox_fail",
    "outbox-fail", "gate", "slot_acquire", "slot-acquire", "merge_slot",
    "merge-slot", "slot_release", "slot-release", "cancel", "cancel_ack",
    "cancel-ack", "checkpoint", "changes", "attest", "cost_add", "cost-add",
    "outbox_export", "outbox-export", "sync_import", "sync-import",
];

type R<T> = Result<T, (String, String)>;
fn ie(e: impl std::fmt::Display) -> (String, String) {
    ("internal".into(), e.to_string())
}
fn bad(m: impl Into<String>) -> (String, String) {
    ("bad_args".into(), m.into())
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
static CTR: AtomicU64 = AtomicU64::new(0);
fn gen_id(p: &str) -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    format!(
        "{}{:x}{:x}",
        p,
        n & 0xffffffffffff,
        CTR.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------- arg helpers ----------
fn gs(a: &Value, k: &str) -> Option<String> {
    match a.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(v) => Some(v.to_string()),
    }
}
fn gf(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(|v| v.as_f64())
}
fn gi(a: &Value, k: &str) -> Option<i64> {
    a.get(k).and_then(|v| v.as_i64())
}
fn req(a: &Value, k: &str) -> R<String> {
    gs(a, k).ok_or_else(|| bad(format!("{k} required")))
}
fn req_i(a: &Value, k: &str) -> R<i64> {
    gi(a, k).ok_or_else(|| bad(format!("{k} required")))
}
fn actor(a: &Value) -> Option<String> {
    gs(a, "actor").or_else(|| Some("socket".into()))
}
fn run_id(a: &Value) -> Option<String> {
    gs(a, "run_id")
}

// ---------- db ----------
fn connect(p: &str) -> Result<Connection, rusqlite::Error> {
    let c = Connection::open(p)?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;\
                     PRAGMA synchronous=FULL;",
    )?;
    if env::var("SIS_SYNCHRONOUS").ok().as_deref() == Some("NORMAL") {
        c.execute_batch("PRAGMA synchronous=NORMAL;")?;
    }
    let ver: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ver > SCHEMA_VER {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unsupported schema {ver}; maximum {SCHEMA_VER}"
        )));
    }
    if ver == SCHEMA_VER && agent::fts_current(&c)? {
        return Ok(c);
    }
    c.execute_batch("BEGIN IMMEDIATE")?;
    let upgraded = (|| -> rusqlite::Result<()> {
        let ver: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if ver == SCHEMA_VER {
            return agent::fts_schema(&c);
        }
        if ver == 0 {
            c.execute_batch(SCHEMA)?;
        } else {
            if ver < 2 {
                // v2: deps.type ('blocks' gates; other relations edges only),
                // issues.defer_until (bd --defer/--due semantics).
                c.execute_batch(
                    "ALTER TABLE deps ADD COLUMN type TEXT DEFAULT 'blocks';\
                             ALTER TABLE issues ADD COLUMN defer_until REAL",
                )?;
            }
            if ver < 3 {
                // v3: gates (named wait-primitives), issues.expires_at (wisp TTL).
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS gates(name TEXT PRIMARY KEY,\
                state TEXT DEFAULT 'closed', payload TEXT, updated_at REAL);\
                ALTER TABLE issues ADD COLUMN expires_at REAL",
                )?;
            }
            if ver < 4 {
                // v4: slots — serialized merge tokens (bd merge-slot analogue).
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS slots(name TEXT PRIMARY KEY,\
                holder TEXT, epoch INT DEFAULT 0, lease_until REAL,\
                claim_id TEXT, updated_at REAL)",
                )?;
            }
        }
        agent::fts_schema(&c)?;
        agent::schema(&c)?;
        c.execute_batch(&format!("PRAGMA user_version={SCHEMA_VER}"))?;
        Ok(())
    })();
    if let Err(error) = upgraded {
        let _ = c.execute_batch("ROLLBACK");
        return Err(error);
    }
    c.execute_batch("COMMIT")?;
    Ok(c)
}
const SCHEMA_VER: i64 = 8;

fn jval(v: types::Value) -> Value {
    match v {
        types::Value::Null => Value::Null,
        types::Value::Integer(i) => i.into(),
        types::Value::Real(f) => f.into(),
        types::Value::Text(s) => s.into(),
        types::Value::Blob(b) => String::from_utf8_lossy(&b).into_owned().into(),
    }
}
fn row_issue(r: &rusqlite::Row) -> Result<Value, rusqlite::Error> {
    let mut m = Map::new();
    for (i, k) in KEYS.iter().enumerate() {
        let v: Option<types::Value> = r.get(i)?;
        m.insert((*k).into(), v.map(jval).unwrap_or(Value::Null));
    }
    let mj: Option<String> = r.get(19)?;
    m.insert(
        "meta".into(),
        mj.and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null),
    );
    Ok(Value::Object(m))
}
fn q_issues(c: &Connection, sql: &str, ps: Vec<types::Value>) -> R<Vec<Value>> {
    let mut st = c.prepare(sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), |r| row_issue(r))
        .map_err(ie)?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(ie)?);
    }
    Ok(out)
}
fn ev(c: &Connection, op: &str, issue: Option<&str>, a: &Value, data: &Value) -> R<()> {
    let mut data = data.clone();
    agent::redact(&mut data);
    c.prepare_cached(
        "INSERT INTO events(ts,op,issue,actor,run_id,idem,data_json) \
               VALUES(?,?,?,?,?,?,?)",
    )
    .map_err(ie)?
    .execute(params![
        now(),
        op,
        issue,
        actor(a),
        run_id(a),
        gs(a, "idem"),
        data.to_string()
    ])
    .map_err(ie)?;
    Ok(())
}
fn issue_row(c: &Connection, id: &str) -> R<Option<(String, i64, Option<String>)>> {
    c.query_row(
        "SELECT status,lease_epoch,claim_actor FROM issues WHERE id=?",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(ie)
}

// ---------- ops ----------
fn op_create(c: &Connection, a: &Value) -> R<Value> {
    agent::budget(a.get("budget_eur"))?;
    let title = req(a, "title")?;
    let mut id = gs(a, "id").unwrap_or_else(|| gen_id("sis-"));
    for _ in 0..8 {
        if issue_row(c, &id)?.is_none() {
            break;
        }
        if a.get("id").is_some() {
            return Err(("exists".into(), format!("issue {id} exists")));
        }
        id = gen_id("sis-");
    }
    if issue_row(c, &id)?.is_some() {
        return Err(("exists".into(), format!("issue {id} exists")));
    }
    let meta = match (a.get("meta"), gs(a, "parent")) {
        (m, parent) => {
            let mut mo = m.cloned().unwrap_or_else(|| json!({}));
            if let (Some(o), Some(p)) = (mo.as_object_mut(), parent) {
                o.insert("parent".into(), json!(p));
            }
            Some(mo.to_string())
        }
    };
    let status = gs(a, "status")
        .filter(|s| s == "deferred")
        .unwrap_or_else(|| "open".into());
    let paths = a.get("allowed_paths").map(|v| match v {
        Value::String(s) => s.clone(),
        o => o.to_string(),
    });
    // wisp/ephemeral: expires_at = now+ttl_secs (or explicit epoch) — issues
    // that auto-age out of ready and get reaped by `compact`.
    let expires = gf(a, "expires_at").or_else(|| {
        gf(a, "ttl_secs")
            .or_else(|| gf(a, "ttl"))
            .map(|s| now() + s)
    });
    c.execute("INSERT INTO issues(id,title,\"desc\",type,priority,status,owner,\
               oracle_cmd,allowed_paths,lane,budget_eur,acceptance,created_at,meta_json,defer_until,expires_at) \
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![id, title, gs(a,"desc"), gs(a,"type").unwrap_or_else(||"task".into()),
            gi(a,"priority").unwrap_or(2), status, gs(a,"owner"), gs(a,"oracle_cmd"), paths,
            gs(a,"lane"), gf(a,"budget_eur"), gs(a,"acceptance"), now(), meta,
            gf(a,"defer_until"), expires])
        .map_err(ie)?;
    ev(c, "create", Some(&id), a, &json!({"title": title}))?;
    Ok(json!({"id": id}))
}

fn dep_pairs(a: &Value) -> R<Vec<(String, String)>> {
    let one = |v: &Value| -> R<(String, String)> { Ok((req(v, "issue")?, req(v, "depends_on")?)) };
    if let Some(arr) = a.as_array() {
        return arr.iter().map(one).collect();
    }
    if let Some(arr) = a.get("deps").and_then(|v| v.as_array()) {
        return arr.iter().map(one).collect();
    }
    Ok(vec![one(a)?])
}
fn dep_cycle(c: &Connection, issue: &str, dep: &str) -> R<bool> {
    Ok(c.query_row(
        "WITH RECURSIVE r(x) AS (SELECT ? UNION \
         SELECT d.depends_on FROM deps d JOIN r ON d.issue=r.x \
         WHERE d.type IS NULL OR d.type='blocks') \
         SELECT 1 FROM r WHERE x=? LIMIT 1",
        params![dep, issue],
        |_| Ok(()),
    )
    .optional()
    .map_err(ie)?
    .is_some())
}
fn op_dep(c: &Connection, a: &Value) -> R<Value> {
    let ty = gs(a, "type").unwrap_or_else(|| "blocks".into());
    for (i, d) in dep_pairs(a)? {
        // Only blocking edges must stay acyclic; relates-to/duplicate/…
        // relations are free-form edges (bd semantics).
        if ty == "blocks" && dep_cycle(c, &i, &d)? {
            return Err(("dep_cycle".into(), format!("{i}->{d} would create a cycle")));
        }
        c.execute(
            "INSERT OR REPLACE INTO deps(issue,depends_on,type) VALUES(?,?,?)",
            params![i, d, ty],
        )
        .map_err(ie)?;
        ev(c, "dep", Some(&i), a, &json!({"depends_on": d, "type": ty}))?;
    }
    Ok(json!({"ok": true}))
}

fn op_dep_remove(c: &Connection, a: &Value) -> R<Value> {
    let (i, d) = (req(a, "issue")?, req(a, "depends_on")?);
    let n = c
        .execute(
            "DELETE FROM deps WHERE issue=? AND depends_on=?",
            params![i, d],
        )
        .map_err(ie)?;
    if n == 0 {
        return Err(("not_found".into(), format!("dep {i}->{d}")));
    }
    ev(c, "dep_remove", Some(&i), a, &json!({"depends_on": d}))?;
    Ok(json!({"ok": true}))
}

fn op_dep_list(c: &Connection, a: &Value) -> R<Value> {
    let (mut sql, mut ps) = ("SELECT issue,depends_on,type FROM deps".to_string(), vec![]);
    if let Some(i) = gs(a, "id").or_else(|| gs(a, "issue")) {
        sql.push_str(" WHERE (issue=? OR depends_on=?)");
        ps.push(types::Value::Text(i.clone()));
        ps.push(types::Value::Text(i));
    }
    sql.push_str(" ORDER BY issue,depends_on");
    let mut st = c.prepare(&sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), |r| {
            Ok(
                json!({"issue": r.get::<_,String>(0)?, "depends_on": r.get::<_,String>(1)?,
                  "type": r.get::<_,Option<String>>(2)?.unwrap_or_else(||"blocks".into())}),
            )
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

/// bd `update`: whitelisted field mutation + FTS refresh + update event.
/// `set` object or flat args both accepted; `meta` deep-merges keys.
fn op_update(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let set = a
        .get("set")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(|| a.as_object().cloned().unwrap_or_default());
    const FIELDS: [&str; 13] = [
        "title",
        "desc",
        "status",
        "priority",
        "type",
        "owner",
        "oracle_cmd",
        "allowed_paths",
        "lane",
        "budget_eur",
        "acceptance",
        "defer_until",
        "meta",
    ];
    let (mut sql2, mut ps2) = (String::from("UPDATE issues SET "), vec![]);
    let mut first2 = true;
    for f in FIELDS {
        let Some(v) = set.get(f) else { continue };
        if !first2 {
            sql2.push(',');
        }
        first2 = false;
        match f {
            "meta" => {
                let old: String = c
                    .query_row(
                        "SELECT COALESCE(meta_json,'{}') FROM issues WHERE id=?",
                        params![id],
                        |r| r.get(0),
                    )
                    .map_err(ie)?;
                let mut mo = serde_json::from_str::<Value>(&old).unwrap_or_else(|_| json!({}));
                if let (Some(o), Some(n)) = (mo.as_object_mut(), v.as_object()) {
                    for (k, nv) in n {
                        if nv.is_null() {
                            o.remove(k);
                        } else {
                            o.insert(k.clone(), nv.clone());
                        }
                    }
                }
                sql2.push_str("meta_json=?");
                ps2.push(types::Value::Text(mo.to_string()));
            }
            "allowed_paths" => {
                sql2.push_str("allowed_paths=?");
                ps2.push(types::Value::Text(match v {
                    Value::String(s) => s.clone(),
                    o => o.to_string(),
                }));
            }
            "desc" => {
                sql2.push_str("\"desc\"=?");
                ps2.push(match v {
                    Value::Null => types::Value::Null,
                    Value::String(s) => types::Value::Text(s.clone()),
                    o => types::Value::Text(o.to_string()),
                });
            }
            "priority" => {
                sql2.push_str("priority=?");
                ps2.push(types::Value::Integer(
                    v.as_i64().or(v.as_f64().map(|x| x as i64)).unwrap_or(2),
                ));
            }
            "budget_eur" | "defer_until" => {
                sql2.push_str(&format!("{f}=?"));
                match v {
                    Value::Null => ps2.push(types::Value::Null),
                    _ => ps2.push(types::Value::Real(v.as_f64().unwrap_or(0.0))),
                }
            }
            _ => {
                sql2.push_str(&format!("{f}=?"));
                match v {
                    Value::Null => ps2.push(types::Value::Null),
                    Value::String(s) => ps2.push(types::Value::Text(s.clone())),
                    o => ps2.push(types::Value::Text(o.to_string())),
                }
            }
        }
    }
    if first2 {
        return Err(bad("nothing to update"));
    }
    sql2.push_str(" WHERE id=?");
    ps2.push(types::Value::Text(id.clone()));
    let mut st = c.prepare(&sql2).map_err(ie)?;
    st.execute(params_from_iter(ps2.iter())).map_err(ie)?;
    ev(c, "update", Some(&id), a, &set_to_json(&set))?;
    Ok(json!({"ok": true}))
}
fn set_to_json(set: &Map<String, Value>) -> Value {
    let keys: Vec<Value> = set.keys().cloned().map(Value::String).collect();
    json!({"set": keys})
}

/// bd `note`/`comment`: append-only note as an event row; `comments` reads.
fn op_note(c: &Connection, a: &Value) -> R<Value> {
    let (id, text) = (req(a, "id")?, req(a, "text")?);
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    ev(c, "note", Some(&id), a, &json!({"text": text}))?;
    Ok(json!({"ok": true}))
}
/// `sis changes <id>`: append a compact file-edit summary — path, +adds/-dels,
/// hunk ranges — as an append-only `changes` event. The payload is computed
/// caller-side against the real git worktree (see `changes_from_git`), so the
/// board/history shows what an agent actually touched without trusting claims
/// or embedding the code itself.
fn op_changes(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let raw = match a.get("files") {
        Some(Value::Array(f)) => f.clone(),
        None => vec![],
        _ => return Err(("bad_args".into(), "files must be an array".into())),
    };
    // Defensive caps keep event rows small even for tree-wide edits.
    let files: Vec<Value> = raw
        .iter()
        .take(80)
        .map(|f| {
            json!({
                "path": f.get("path").and_then(|v| v.as_str())
                    .map(|s| s.chars().take(300).collect::<String>()),
                "adds": f.get("adds").and_then(|v| v.as_i64()),
                "dels": f.get("dels").and_then(|v| v.as_i64()),
                "status": f.get("status").and_then(|v| v.as_str()).unwrap_or("M"),
                "hunks": f.get("hunks").and_then(|v| v.as_array())
                    .map(|h| h.iter().take(12).cloned().collect::<Vec<_>>()),
                "binary": f.get("binary").and_then(|v| v.as_bool()).unwrap_or(false),
                "renamed_from": f.get("renamed_from").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let (adds, dels) = files.iter().fold((0i64, 0i64), |(a, d), f| {
        (
            a + f["adds"].as_i64().unwrap_or(0),
            d + f["dels"].as_i64().unwrap_or(0),
        )
    });
    // Fingerprint dedup: a repeated identical diff must not spam the trail —
    // `sis changes` after every save would otherwise bury real history.
    let fingerprint: String = {
        let d = format!(
            "{:x}",
            sha2::Sha256::digest(
                serde_json::to_string(&files).unwrap_or_default().as_bytes()
            )
        );
        d[..16].to_string()
    };
    if a.get("force").is_none() && a.get("patch").is_none() {
        let last: Option<String> = c
            .query_row(
                "SELECT data_json FROM events WHERE issue=? AND op='changes' \
                 ORDER BY seq DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(ie)?;
        if let Some(d) = last.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            if d.get("fingerprint").and_then(|v| v.as_str()) == Some(fingerprint.as_str()) {
                return Ok(json!({"id": id, "files": files, "adds": adds,
                    "dels": dels, "unchanged": true}));
            }
        }
    }
    ev(
        c,
        "changes",
        Some(&id),
        a,
        &json!({
            "files": files,
            "base": a.get("base"),
            "head": a.get("head"),
            "head_subject": a.get("head_subject"),
            "branch": a.get("branch"),
            "repo": a.get("repo"),
            "patch": a.get("patch"),
            "patch_truncated": a.get("patch_truncated"),
            "fingerprint": fingerprint,
            "summary": {"files": files.len(), "adds": adds, "dels": dels},
        }),
    )?;
    Ok(json!({"id": id, "files": files, "adds": adds, "dels": dels}))
}

fn op_comments(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let mut st = c
        .prepare(
            "SELECT ts,actor,data_json FROM events \
        WHERE issue=? AND op='note' ORDER BY seq",
        )
        .map_err(ie)?;
    let rows = st
        .query_map(params![id], |r| {
            let dj: String = r.get(2)?;
            Ok(
                json!({"ts": r.get::<_,f64>(0)?, "actor": r.get::<_,Option<String>>(1)?,
            "text": serde_json::from_str::<Value>(&dj).ok()
                .and_then(|v| v.get("text").cloned()).unwrap_or(Value::Null)}),
            )
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

/// bd `history`: every event for an issue, oldest first.
fn op_history(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,actor,data_json FROM events \
        WHERE issue=? ORDER BY seq",
        )
        .map_err(ie)?;
    let rows = st
        .query_map(params![id], |r| {
            let dj: String = r.get(4)?;
            Ok(json!({"seq": r.get::<_,i64>(0)?, "ts": r.get::<_,f64>(1)?,
            "op": r.get::<_,String>(2)?, "actor": r.get::<_,Option<String>>(3)?,
            "data": serde_json::from_str::<Value>(&dj).unwrap_or(Value::Null)}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

fn op_unclaim(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let (s, _, act) =
        issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    if s != "in_progress" {
        return Err(("not_claimed".into(), format!("issue {id} not in_progress")));
    }
    c.execute(
        "UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL \
               WHERE id=?",
        params![id],
    )
    .map_err(ie)?;
    if let Some(ac) = act {
        c.execute(
            "DELETE FROM claims WHERE issue=? AND actor=?",
            params![id, ac],
        )
        .map_err(ie)?;
    }
    ev(c, "unclaim", Some(&id), a, &json!({}))?;
    Ok(json!({"ok": true}))
}

/// bd `reclaim`: sweep every stale-leased in_progress issue back to open,
/// epoch-bumped so the dead worker's fence stays broken (SPEC invariant 3).
fn op_reclaim(c: &Connection, a: &Value) -> R<Value> {
    let t = now();
    let mut st = c
        .prepare(
            "UPDATE issues SET status='open',claim_actor=NULL,\
        lease_until=NULL,lease_epoch=lease_epoch+1 WHERE status='in_progress' \
        AND lease_until<? RETURNING id",
        )
        .map_err(ie)?;
    let ids: Vec<String> = st
        .query_map(params![t], |r| r.get(0))
        .map_err(ie)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(ie)?;
    drop(st);
    for id in &ids {
        c.execute("DELETE FROM claims WHERE issue=?", params![id])
            .map_err(ie)?;
        ev(
            c,
            "reclaim",
            Some(id),
            a,
            &json!({"reason": "lease expired"}),
        )?;
    }
    Ok(json!({"reclaimed": ids}))
}

/// SPEC `watch`: events with seq > after (snapshot form of live tail).
fn op_watch(c: &Connection, a: &Value) -> R<Value> {
    let after = gi(a, "after").unwrap_or(0);
    let lim = gi(a, "limit").unwrap_or(1000);
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,issue,actor,data_json FROM events \
        WHERE seq>? ORDER BY seq LIMIT ?",
        )
        .map_err(ie)?;
    let rows = st
        .query_map(params![after, lim], |r| {
            let dj: Option<String> = r.get(5)?;
            Ok(json!({"seq": r.get::<_,i64>(0)?, "ts": r.get::<_,f64>(1)?,
            "op": r.get::<_,String>(2)?, "issue": r.get::<_,Option<String>>(3)?,
            "actor": r.get::<_,Option<String>>(4)?,
            "data": dj.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null)}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(json!({"events": rows}))
}

fn op_defer(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let until = gf(a, "until").or_else(|| gf(a, "defer_until"));
    c.execute(
        "UPDATE issues SET status='deferred',defer_until=? WHERE id=?",
        params![until, id],
    )
    .map_err(ie)?;
    ev(c, "defer", Some(&id), a, &json!({"until": until}))?;
    Ok(json!({"ok": true}))
}
fn op_undefer(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    c.execute(
        "UPDATE issues SET status='open',defer_until=NULL WHERE id=?",
        params![id],
    )
    .map_err(ie)?;
    ev(c, "undefer", Some(&id), a, &json!({}))?;
    Ok(json!({"ok": true}))
}

/// bd `children`: issues whose meta.parent points at id (parent-child edges
/// are metadata, not readiness gates).
fn op_children(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    q_issues(
        c,
        &format!(
            "SELECT {COLS} FROM issues i \
        WHERE json_extract(i.meta_json,'$.parent')=? ORDER BY i.priority,i.created_at"
        ),
        vec![types::Value::Text(id)],
    )
    .map(Value::Array)
}

/// bd `label`: add/remove on meta.labels (JSON array).
fn op_label(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let old: String = c
        .query_row(
            "SELECT COALESCE(meta_json,'{}') FROM issues WHERE id=?",
            params![id],
            |r| r.get(0),
        )
        .map_err(ie)?;
    let mut mo = serde_json::from_str::<Value>(&old).unwrap_or_else(|_| json!({}));
    let mut labels: Vec<String> = mo
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let arg_list = |v: Option<&Value>| -> Vec<String> {
        match v {
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            Some(Value::String(s)) if s.starts_with('[') => {
                serde_json::from_str::<Vec<String>>(s).unwrap_or_else(|_| vec![s.clone()])
            }
            Some(Value::String(s)) => vec![s.clone()],
            _ => vec![],
        }
    };
    for l in arg_list(a.get("add")) {
        if !labels.contains(&l) {
            labels.push(l);
        }
    }
    let rm = arg_list(a.get("remove"));
    labels.retain(|l| !rm.contains(l));
    mo["labels"] = json!(labels);
    c.execute(
        "UPDATE issues SET meta_json=? WHERE id=?",
        params![mo.to_string(), id],
    )
    .map_err(ie)?;
    ev(c, "label", Some(&id), a, &json!({"labels": mo["labels"]}))?;
    Ok(json!({"labels": mo["labels"]}))
}

/// bd `rename`: id migration across issues/deps/claims/meta.parent.
/// Events stay under the old id — immutable provenance is a feature.
fn op_rename(c: &Connection, a: &Value) -> R<Value> {
    let (from, to) = (req(a, "from")?, req(a, "to")?);
    issue_row(c, &from)?.ok_or_else(|| ("not_found".into(), format!("issue {from}")))?;
    if issue_row(c, &to)?.is_some() {
        return Err(("exists".into(), format!("issue {to} exists")));
    }
    c.execute("UPDATE issues SET id=? WHERE id=?", params![to, from])
        .map_err(ie)?;
    c.execute("UPDATE issues SET meta_json=replace(meta_json,'\"parent\":\"'||?||'\"','\"parent\":\"'||?||'\"') \
               WHERE meta_json LIKE '%\"parent\":\"'||?||'\"%'",
        params![from, to, from]).map_err(ie)?;
    c.execute("UPDATE deps SET issue=? WHERE issue=?", params![to, from])
        .map_err(ie)?;
    c.execute(
        "UPDATE deps SET depends_on=? WHERE depends_on=?",
        params![to, from],
    )
    .map_err(ie)?;
    c.execute("UPDATE claims SET issue=? WHERE issue=?", params![to, from])
        .map_err(ie)?;
    ev(c, "rename", Some(&to), a, &json!({"from": from}))?;
    Ok(json!({"id": to}))
}

fn op_delete(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    c.execute(
        "DELETE FROM deps WHERE issue=? OR depends_on=?",
        params![id, id],
    )
    .map_err(ie)?;
    c.execute("DELETE FROM claims WHERE issue=?", params![id])
        .map_err(ie)?;
    c.execute("DELETE FROM issues WHERE id=?", params![id])
        .map_err(ie)?;
    ev(c, "delete", Some(&id), a, &json!({}))?;
    Ok(json!({"ok": true}))
}

/// bd `list`/`query`/`count`: filtered listing.
fn list_where(a: &Value) -> (String, Vec<types::Value>) {
    let mut w = String::from(" WHERE 1=1");
    let mut ps = vec![];
    for (k, col) in [
        ("status", "i.status"),
        ("type", "i.type"),
        ("lane", "i.lane"),
        ("owner", "i.owner"),
    ] {
        if let Some(v) = gs(a, k) {
            w.push_str(&format!(" AND {col}=?"));
            ps.push(types::Value::Text(v));
        }
    }
    if let Some(p) = gi(a, "priority") {
        w.push_str(" AND i.priority=?");
        ps.push(types::Value::Integer(p));
    }
    if let Some(l) = gs(a, "label") {
        w.push_str(
            " AND EXISTS (SELECT 1 FROM json_each(i.meta_json,'$.labels') je WHERE je.value=?)",
        );
        ps.push(types::Value::Text(l));
    }
    if let Some(q) = gs(a, "q") {
        w.push_str(" AND (i.title LIKE ? OR i.\"desc\" LIKE ?)");
        let like = format!("%{q}%");
        ps.push(types::Value::Text(like.clone()));
        ps.push(types::Value::Text(like));
    }
    (w, ps)
}
fn op_list(c: &Connection, a: &Value) -> R<Value> {
    let (w, mut ps) = list_where(a);
    let mut sql = format!("SELECT {COLS} FROM issues i{w}");
    agent::cursor_filter(a, &mut sql, &mut ps)?;
    sql.push_str(" ORDER BY i.priority,i.created_at,i.id");
    if let Some(n) = gi(a, "limit") {
        sql.push_str(" LIMIT ?");
        ps.push(types::Value::Integer(n));
    }
    let mut rows = q_issues(c, &sql, ps)?;
    attach_changes(c, &mut rows)?;
    attach_run_state(c, &mut rows)?;
    Ok(Value::Array(rows))
}

/// Derived run stage from the append-only event trail (goal-os L-1 FSM):
/// queued -> claimed -> evidence -> verified -> closed. `dispatched`/`merged`
/// happen outside sis and stay observable via events, not stored state.
fn run_stage(
    issue: &Value,
    verified: Option<bool>,
    evidenced: bool,
) -> &'static str {
    if issue.get("status").and_then(|v| v.as_str()) == Some("closed") {
        return "closed";
    }
    if let Some(passed) = verified {
        // a failed verify still means the run produced evidence
        return if passed { "verified" } else { "evidence" };
    }
    if evidenced {
        return "evidence";
    }
    let claimed = issue.get("claim_actor").and_then(|v| v.as_str()).is_some()
        || issue
            .get("lease_until")
            .and_then(|v| v.as_f64())
            .is_some_and(|u| u > now());
    if claimed {
        "claimed"
    } else {
        "queued"
    }
}
fn run_state(c: &Connection, id: &str, issue: &Value) -> R<&'static str> {
    let v: Option<String> = c
        .query_row(
            "SELECT data_json FROM events WHERE issue=? AND op='verify' \
             ORDER BY seq DESC LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    let verified = v
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|d| d.get("passed").and_then(|p| p.as_bool()));
    let evd: Option<i64> = c
        .query_row(
            "SELECT 1 FROM events WHERE issue=? \
             AND op IN ('changes','checkpoint') LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    Ok(run_stage(issue, verified, evd.is_some()))
}
/// Attach derived `run_state` to each listed row — two grouped queries for
/// the whole page (chunked under the SQLite variable cap), never N+1 scans.
fn attach_run_state(c: &Connection, rows: &mut [Value]) -> R<()> {
    for chunk in rows.chunks_mut(500) {
        let ids: Vec<String> = chunk
            .iter()
            .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        if ids.is_empty() {
            continue;
        }
        let marks = vec!["?"; ids.len()].join(",");
        // ordered by seq, so folding the map keeps each issue's latest verify
        let mut verified: HashMap<String, bool> = HashMap::new();
        let mut st = c
            .prepare(&format!(
                "SELECT issue,data_json FROM events \
                 WHERE op='verify' AND issue IN ({marks}) ORDER BY seq"
            ))
            .map_err(ie)?;
        let it = st
            .query_map(params_from_iter(ids.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(ie)?;
        for r in it {
            let (i, d) = r.map_err(ie)?;
            verified.insert(
                i,
                serde_json::from_str::<Value>(&d)
                    .ok()
                    .and_then(|v| v.get("passed").and_then(|p| p.as_bool()))
                    .unwrap_or(false),
            );
        }
        drop(st);
        let mut evidenced: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut st = c
            .prepare(&format!(
                "SELECT DISTINCT issue FROM events \
                 WHERE op IN ('changes','checkpoint') AND issue IN ({marks})"
            ))
            .map_err(ie)?;
        let it = st
            .query_map(params_from_iter(ids.iter()), |r| r.get::<_, String>(0))
            .map_err(ie)?;
        for r in it {
            evidenced.insert(r.map_err(ie)?);
        }
        drop(st);
        for r in chunk.iter_mut() {
            let Some(id) = r.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let stage = run_stage(r, verified.get(id).copied(), evidenced.contains(id));
            if let Some(m) = r.as_object_mut() {
                m.insert("run_state".into(), json!(stage));
            }
        }
    }
    Ok(())
}
/// Latest `changes` event payload for one issue (indexed lookup).
fn latest_changes(c: &Connection, id: &str) -> R<Option<Value>> {
    let dj: Option<String> = c
        .query_row(
            "SELECT data_json FROM events WHERE issue=? AND op='changes' \
             ORDER BY seq DESC LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    Ok(dj.and_then(|s| serde_json::from_str::<Value>(&s).ok()))
}
/// Attach each listed issue's latest `changes` event files — one indexed
/// lookup per listed row (idx_events_issue), no N+1 history scans.
fn attach_changes(c: &Connection, rows: &mut [Value]) -> R<()> {
    let mut st = c
        .prepare_cached(
            "SELECT data_json FROM events WHERE issue=? AND op='changes' \
             ORDER BY seq DESC LIMIT 1",
        )
        .map_err(ie)?;
    for r in rows.iter_mut() {
        let Some(id) = r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
        else {
            continue;
        };
        let dj: Option<String> = st
            .query_row(params![id], |r| r.get(0))
            .optional()
            .map_err(ie)?;
        if let Some(d) = dj.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            if let Some(m) = r.as_object_mut() {
                m.insert(
                    "changes".into(),
                    d.get("files").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }
    Ok(())
}
fn op_count(c: &Connection, a: &Value) -> R<Value> {
    let (w, ps) = list_where(a);
    let n: i64 = c
        .query_row(
            &format!("SELECT COUNT(*) FROM issues i{w}"),
            params_from_iter(ps.iter()),
            |r| r.get(0),
        )
        .map_err(ie)?;
    Ok(json!({"count": n}))
}

/// bd `lint`: non-closed issues missing executable acceptance evidence.
fn op_lint(c: &Connection, a: &Value) -> R<Value> {
    let _ = a;
    let mut st = c
        .prepare(
            "SELECT id,title,oracle_cmd,acceptance FROM issues \
        WHERE status!='closed' AND (oracle_cmd IS NULL OR oracle_cmd='') \
        AND (acceptance IS NULL OR acceptance='') ORDER BY priority",
        )
        .map_err(ie)?;
    let rows = st
        .query_map([], |r| {
            Ok(
                json!({"id": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                  "missing": ["oracle_cmd","acceptance"]}),
            )
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(json!({"needs_oracle": rows}))
}
fn op_types(_c: &Connection, _a: &Value) -> R<Value> {
    Ok(json!([
        "task", "bug", "feature", "epic", "chore", "question", "doc", "decision", "event"
    ]))
}
fn op_statuses(_c: &Connection, _a: &Value) -> R<Value> {
    Ok(json!([
        "open",
        "in_progress",
        "blocked",
        "deferred",
        "closed"
    ]))
}

/// bd `gate`: named wait-primitive. dep {type:'gate',depends_on:name} blocks
/// an issue until the gate's state is 'open' — lanes wait without polling.
fn op_gate(c: &Connection, a: &Value) -> R<Value> {
    let name = req(a, "name")?;
    let exists: Option<String> = c
        .query_row("SELECT state FROM gates WHERE name=?", params![name], |r| {
            r.get(0)
        })
        .optional()
        .map_err(ie)?;
    match gs(a, "state") {
        Some(state) => {
            c.execute(
                "INSERT INTO gates(name,state,payload,updated_at) VALUES(?,?,?,?) \
                       ON CONFLICT(name) DO UPDATE SET state=?,payload=?,updated_at=?",
                params![
                    name,
                    state,
                    gs(a, "payload"),
                    now(),
                    state,
                    gs(a, "payload"),
                    now()
                ],
            )
            .map_err(ie)?;
            ev(c, "gate", None, a, &json!({"name": name, "state": state}))?;
            Ok(json!({"name": name, "state": state}))
        }
        None => match exists {
            Some(state) => Ok(json!({"name": name, "state": state})),
            None => Ok(json!({"name": name, "state": "closed"})),
        },
    }
}
fn op_gate_list(c: &Connection, _a: &Value) -> R<Value> {
    let mut st = c
        .prepare("SELECT name,state,payload,updated_at FROM gates ORDER BY name")
        .map_err(ie)?;
    let rows = st
        .query_map([], |r| {
            Ok(
                json!({"name": r.get::<_,String>(0)?, "state": r.get::<_,String>(1)?,
                  "payload": r.get::<_,Option<String>>(2)?,
                  "updated_at": r.get::<_,Option<f64>>(3)?}),
            )
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

/// bd `merge-slot`: serialized merge token with fencing — only the holder
/// may merge; TTL + epoch mirror the claim invariants.
fn op_slot_acquire(c: &Connection, a: &Value) -> R<Value> {
    let name = req(a, "name")?;
    let actor = req(a, "actor")?;
    let ttl = gf(a, "ttl").unwrap_or(LEASE_S);
    let t = now();
    let cid = gen_id("sl");
    // one atomic: take a free or expired slot
    let n = c
        .execute(
            "UPDATE slots SET holder=?,epoch=epoch+1,lease_until=?,\
        claim_id=?,updated_at=? WHERE name=? AND (holder IS NULL OR lease_until<?)",
            params![actor, t + ttl, cid, t, name, t],
        )
        .map_err(ie)?;
    if n == 0 {
        let inserted = c
            .execute(
                "INSERT OR IGNORE INTO slots(name,holder,epoch,lease_until,claim_id,updated_at)\
                   VALUES(?,?,1,?,?,?)",
                params![name, actor, t + ttl, cid, t],
            )
            .map_err(ie)?;
        // re-check: was it inserted or already held?
        let held: Option<(String, f64)> = c
            .query_row(
                "SELECT holder,lease_until FROM slots WHERE name=?",
                params![name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(ie)?;
        match held {
            Some((_h, _lu)) if inserted == 1 => {}
            Some((h, lu)) => {
                return Err((
                    "slot_held".into(),
                    format!("slot {name} held by {h} until {lu:.0}"),
                ))
            }
            None => return Err(("internal".into(), "slot insert vanished".into())),
        }
    }
    let (epoch, lu): (i64, f64) = c
        .query_row(
            "SELECT epoch,lease_until FROM slots WHERE name=? AND holder=?",
            params![name, actor],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(ie)?;
    ev(
        c,
        "slot_acquire",
        None,
        a,
        &json!({"name": name, "actor": actor, "epoch": epoch}),
    )?;
    Ok(json!({"name": name, "holder": actor, "epoch": epoch,
              "claim_id": cid, "lease_until": lu}))
}
fn op_slot_release(c: &Connection, a: &Value) -> R<Value> {
    let name = req(a, "name")?;
    let actor = req(a, "actor")?;
    let epoch = gi(a, "epoch");
    let cur: Option<(String, i64)> = c
        .query_row(
            "SELECT holder,epoch FROM slots WHERE name=?",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(ie)?;
    match cur {
        None => Err(("not_found".into(), format!("slot {name}"))),
        Some((h, _e)) if h != actor => {
            Err(("slot_held".into(), format!("slot {name} held by {h}")))
        }
        Some((_, e)) if epoch.is_some() && epoch != Some(e) => {
            Err(("stale_fence".into(), format!("epoch {e}")))
        }
        Some(_) => {
            c.execute(
                "UPDATE slots SET holder=NULL,lease_until=NULL,\
                claim_id=NULL,updated_at=? WHERE name=?",
                params![now(), name],
            )
            .map_err(ie)?;
            ev(
                c,
                "slot_release",
                None,
                a,
                &json!({"name": name, "actor": actor}),
            )?;
            Ok(json!({"name": name, "released": true}))
        }
    }
}
fn op_slot_list(c: &Connection, _a: &Value) -> R<Value> {
    let mut st = c
        .prepare(
            "SELECT name,holder,epoch,lease_until,claim_id,\
        updated_at FROM slots ORDER BY name",
        )
        .map_err(ie)?;
    let rows = st
        .query_map([], |r| {
            Ok(json!({"name": r.get::<_,String>(0)?,
                  "holder": r.get::<_,Option<String>>(1)?,
                  "epoch": r.get::<_,i64>(2)?,
                  "lease_until": r.get::<_,Option<f64>>(3)?,
                  "claim_id": r.get::<_,Option<String>>(4)?,
                  "updated_at": r.get::<_,Option<f64>>(5)?}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

/// bd `epic` view: parent + children + progress rollup in one op.
fn op_epic(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let issue = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues WHERE id=?"),
        vec![types::Value::Text(id.clone())],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let children = q_issues(
        c,
        &format!(
            "SELECT {COLS} FROM issues i \
        WHERE json_extract(i.meta_json,'$.parent')=? \
        ORDER BY i.status='closed',i.priority,i.created_at"
        ),
        vec![types::Value::Text(id)],
    )?;
    let mut counts = json!({"total": children.len()});
    for ch in &children {
        let s = ch.get("status").and_then(|v| v.as_str()).unwrap_or("open");
        let k = format!("{s}");
        counts[k] = json!(counts.get(&k).and_then(|v| v.as_i64()).unwrap_or(0) + 1);
    }
    let closed = counts.get("closed").and_then(|v| v.as_i64()).unwrap_or(0);
    counts["pct_done"] = if children.is_empty() {
        json!(0)
    } else {
        json!((closed * 100) / children.len() as i64)
    };
    Ok(json!({"issue": issue, "children": children, "counts": counts}))
}

/// bd `find-duplicates` (FTS variant): title-token overlap scoring.
fn op_dup_scan(c: &Connection, a: &Value) -> R<Value> {
    let min = gi(a, "min").unwrap_or(2).max(1) as usize;
    let titles: Vec<(String, String)> = match gs(a, "id") {
        Some(id) => {
            let t: String = c
                .query_row("SELECT title FROM issues WHERE id=?", params![id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(ie)?
                .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
            vec![(id, t)]
        }
        None => {
            let mut st = c
                .prepare("SELECT id,title FROM issues WHERE status!='closed'")
                .map_err(ie)?;
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(ie)?
                .collect::<Result<Vec<(String, String)>, _>>()
                .map_err(ie)?;
            v
        }
    };
    let mut out = vec![];
    for (id, title) in &titles {
        let toks: HashSet<String> = title
            .to_lowercase()
            .split(|ch: char| !ch.is_alphanumeric())
            .filter(|w| w.len() >= 4)
            .map(String::from)
            .collect();
        if toks.len() < min {
            continue;
        }
        let q = toks
            .iter()
            .map(|w| format!("\"{w}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut st = c
            .prepare(
                "SELECT i.id,i.title FROM issues_fts f \
            JOIN issues i ON f.rowid=i.rowid WHERE issues_fts MATCH ? AND i.id!=? \
            AND i.status!='closed'",
            )
            .map_err(ie)?;
        let cands: Vec<(String, String)> = st
            .query_map(params![q, id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(ie)?
            .collect::<Result<Vec<(String, String)>, _>>()
            .map_err(ie)?;
        for (cid, ctitle) in cands {
            let ct: HashSet<String> = ctitle
                .to_lowercase()
                .split(|ch: char| !ch.is_alphanumeric())
                .filter(|w| w.len() >= 4)
                .map(String::from)
                .collect();
            let shared = toks.intersection(&ct).count();
            // .7 semantic-lite: word-Jaccard + char-3gram Jaccard (typos/
            // word-forms). Union-guarded; `threshold` overrides `min`.
            let union = toks.union(&ct).count().max(1);
            let jacc = shared as f64 / union as f64;
            let tri = |s: &str| -> HashSet<String> {
                let cs: Vec<char> = s.chars().collect();
                cs.windows(3).map(|w| w.iter().collect()).collect()
            };
            let (a3, b3) = (tri(&title.to_lowercase()), tri(&ctitle.to_lowercase()));
            let t3 = a3.intersection(&b3).count() as f64 / a3.union(&b3).count().max(1) as f64;
            let score = (jacc * 0.6 + t3 * 0.4).min(1.0);
            let thr = a.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if shared >= min && score >= thr {
                out.push(json!({"id": id, "dup": cid, "shared": shared,
                    "score": (score * 1000.0).round() / 1000.0,
                    "title": title, "dup_title": ctitle}));
            }
        }
    }
    out.sort_by(|x, y| y["shared"].as_i64().cmp(&x["shared"].as_i64()));
    Ok(Value::Array(out))
}
// ---------- goal layer: named goals, subgoals, atomic plans, dashboards ----------
/// slug id for goals/subgoals: `sis-<name-slug>` — readable handles.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in s.chars().flat_map(|c| c.to_lowercase()) {
        for t in match ch {
            'ä' => "ae",
            'ö' => "oe",
            'ü' => "ue",
            'ß' => "ss",
            _ => "",
        }
        .chars()
        .chain(if "äöüß".contains(ch) {
            None
        } else {
            Some(ch)
        }) {
            if t.is_ascii_alphanumeric() {
                if dash && !out.is_empty() {
                    out.push('-');
                }
                dash = false;
                out.push(t);
            } else {
                dash = true;
            }
        }
    }
    out.truncate(40);
    out.trim_end_matches('-').to_string()
}

fn next_sub_id(c: &Connection, parent: &str) -> R<String> {
    // bd convention: <parent>.<n> — max numeric suffix + 1.
    let like = format!("{parent}.%");
    let mut st = c
        .prepare("SELECT id FROM issues WHERE id LIKE ?")
        .map_err(ie)?;
    let rows: Vec<String> = st
        .query_map(params![like], |r| r.get(0))
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let mut maxn = 0i64;
    for id in rows {
        if let Some(tail) = id.strip_prefix(&format!("{parent}.")) {
            if let Ok(n) = tail.parse::<i64>() {
                maxn = maxn.max(n);
            }
        }
    }
    Ok(format!("{parent}.{}", maxn + 1))
}

/// `goal`: type='goal' issue with readable slug id; objective/target in meta.
fn op_goal(c: &Connection, a: &Value) -> R<Value> {
    let name = req(a, "name")?;
    let id = gs(a, "id").unwrap_or_else(|| {
        let base = format!("sis-{}", slugify(&name));
        let mut cand = base.clone();
        let mut i = 2;
        while issue_row(c, &cand).ok().flatten().is_some() {
            cand = format!("{base}-{i}");
            i += 1;
            if i > 99 {
                cand = gen_id("sis-");
                break;
            }
        }
        cand
    });
    let mut args = a.clone();
    let m = args.as_object_mut().unwrap();
    m.insert("id".into(), json!(id));
    m.insert("title".into(), json!(name));
    m.insert("type".into(), json!("goal"));
    let mut meta = a.get("meta").cloned().unwrap_or_else(|| json!({}));
    if let Some(mm) = meta.as_object_mut() {
        if let Some(o) = gs(a, "objective") {
            mm.insert("objective".into(), json!(o));
        }
        if let Some(t) = gs(a, "target") {
            mm.insert("target".into(), json!(t));
        }
    }
    m.insert("meta".into(), meta);
    op_create(c, &args)
}

/// `sub`: child issue under a goal — id `<parent>.<n>`, meta.parent set.
fn op_sub(c: &Connection, a: &Value) -> R<Value> {
    let parent = req(a, "parent")?;
    issue_row(c, &parent)?.ok_or_else(|| ("not_found".into(), format!("goal {parent}")))?;
    let id = next_sub_id(c, &parent)?;
    let mut args = a.clone();
    let m = args.as_object_mut().unwrap();
    m.insert("id".into(), json!(id));
    m.insert("parent".into(), json!(parent));
    op_create(c, &args)
}

/// `plan`: atomic goal tree — goal + subs in one tx. subs[i].deps=[j] wires
/// intra-plan block edges. Effects are all-or-nothing.
fn op_plan(c: &Connection, a: &Value) -> R<Value> {
    let name = req(a, "name")?;
    let mut args = a.clone();
    if let Some(template) = gs(a, "template") {
        let raw: String = c
            .query_row(
                "SELECT value FROM memories WHERE key=?",
                params![format!("template:{template}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(ie)?
            .ok_or_else(|| ("not_found".into(), "plan template not found".into()))?;
        let spec: Value = serde_json::from_str(&raw).map_err(ie)?;
        args["subs"] = spec["subs"].clone();
    }
    let a = &args;
    agent::validate_plan(a)?;
    let g = op_goal(c, a)?;
    let gid = g
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let empty = vec![];
    let subs = a.get("subs").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut ids = vec![];
    for s in subs {
        let mut sa = s.clone();
        if let Some(m) = sa.as_object_mut() {
            m.insert("parent".into(), json!(gid));
        }
        ids.push(
            op_sub(c, &sa)?
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        );
    }
    for (i, s) in subs.iter().enumerate() {
        if let Some(ds) = s.get("deps").and_then(|v| v.as_array()) {
            for d in ds {
                if let Some(j) = d.as_u64().map(|n| n as usize) {
                    if j < ids.len() {
                        op_dep(c, &json!({"issue": ids[i], "depends_on": ids[j]}))?;
                    }
                }
            }
        }
    }
    if let Some(key) = gs(a, "save_as") {
        op_remember(
            c,
            &json!({"key":format!("template:{key}"),"value":{"name":name,"subs":subs}}),
        )?;
    }
    Ok(json!({"goal": gid, "name": name, "children": ids}))
}

/// child predicate: meta.parent=p OR bd-dotted id p.<n> (single level —
/// synced bd corpora carry hierarchy in the id itself).

fn goal_kids(c: &Connection, id: &str, depth: i64) -> R<Vec<Value>> {
    if depth > 8 {
        return Ok(vec![]);
    }
    let rows = q_issues(
        c,
        &format!(
            "SELECT {COLS} FROM issues i \
        WHERE (json_extract(i.meta_json,'$.parent')=? \
        OR (i.id LIKE ?||'.%' AND instr(substr(i.id,length(?)+2),'.')=0)) \
        ORDER BY i.priority,i.created_at"
        ),
        vec![
            types::Value::Text(id.to_string()),
            types::Value::Text(id.to_string()),
            types::Value::Text(id.to_string()),
        ],
    )?;
    let mut out = vec![];
    for mut r in rows {
        let cid = r
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let ch = goal_kids(c, &cid, depth + 1)?;
        r.as_object_mut()
            .unwrap()
            .insert("children".into(), Value::Array(ch));
        out.push(r);
    }
    Ok(out)
}

/// `goal_tree`/`tree`: id → nested descendants; none → all open goals + pct.
fn op_goal_tree(c: &Connection, a: &Value) -> R<Value> {
    match gs(a, "id") {
        Some(id) => {
            let mut root = q_issues(
                c,
                &format!("SELECT {COLS} FROM issues WHERE id=?"),
                vec![types::Value::Text(id.clone())],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
            let ch = goal_kids(c, &id, 0)?;
            root.as_object_mut()
                .unwrap()
                .insert("children".into(), Value::Array(ch));
            Ok(root)
        }
        None => {
            let goals = q_issues(
                c,
                &format!(
                    "SELECT {COLS} FROM issues i \
                WHERE i.type='goal' AND i.status!='closed' \
                ORDER BY i.priority,i.created_at"
                ),
                vec![],
            )?;
            let mut out = vec![];
            for mut g in goals {
                let gid = g
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let ch = goal_kids(c, &gid, 0)?;
                let closed = ch
                    .iter()
                    .filter(|x| x.get("status") == Some(&json!("closed")))
                    .count();
                let om = g.as_object_mut().unwrap();
                om.insert(
                    "pct_done".into(),
                    json!(if ch.is_empty() {
                        0
                    } else {
                        closed * 100 / ch.len()
                    }),
                );
                om.insert("children".into(), Value::Array(ch));
                out.push(g);
            }
            Ok(Value::Array(out))
        }
    }
}

/// `next`: ready issues inside a goal subtree (global when no goal) — the
/// agent-facing "what do I work on for goal X".
fn op_next(c: &Connection, a: &Value) -> R<Value> {
    let t = now();
    let mut ps = vec![
        types::Value::Real(t),
        types::Value::Real(t),
        types::Value::Real(t),
    ];
    let mut sql = format!("SELECT {COLS} FROM issues i WHERE {READY_PRED} AND {BLOCKED}");
    if let Some(g) = gs(a, "goal") {
        sql.push_str(
            " AND i.id IN (WITH RECURSIVE sub(x) AS (\
            SELECT id FROM issues WHERE json_extract(meta_json,'$.parent')=? \
            OR (id LIKE ?||'.%' AND instr(substr(id,length(?)+2),'.')=0) \
            UNION SELECT i2.id FROM issues i2 JOIN sub s \
            ON json_extract(i2.meta_json,'$.parent')=s.x \
            OR (i2.id LIKE s.x||'.%' \
            AND instr(substr(i2.id,length(s.x)+2),'.')=0)) \
            SELECT x FROM sub)",
        );
        ps.push(types::Value::Text(g.clone()));
        ps.push(types::Value::Text(g.clone()));
        ps.push(types::Value::Text(g));
    }
    if let Some(l) = gs(a, "lane") {
        sql.push_str(" AND i.lane=?");
        ps.push(types::Value::Text(l));
    }
    agent::cursor_filter(a, &mut sql, &mut ps)?;
    sql.push_str(" ORDER BY i.priority, i.created_at, i.id");
    if let Some(n) = gi(a, "limit") {
        sql.push_str(" LIMIT ?");
        ps.push(types::Value::Integer(n));
    }
    Ok(Value::Array(q_issues(c, &sql, ps)?))
}

/// `review`: supervisor dashboard in one op — stats, oracle gaps, stale
/// claims, gates, slots, orphans, pending lessons (governor input).
fn op_review(c: &Connection, a: &Value) -> R<Value> {
    let stats = op_stats(c, a)?;
    let lint = op_lint(c, a)?;
    let stale = op_stale(c, a)?;
    let gates = op_gate_list(c, a)?;
    let slots = op_slot_list(c, a)?;
    let orphans = op_orphans(c, a)?;
    let pending: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(json!({"stats": stats,
        "needs_oracle": lint.get("needs_oracle").cloned().unwrap_or(json!([])),
        "stale": stale, "gates": gates, "slots": slots,
        "orphans": orphans, "pending_outbox": pending}))
}

/// `goal_done`: subtree-complete check — all descendants closed. Returns the
/// goal's oracle_cmd; caller runs it as final proof before close.
fn op_goal_done(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let issue = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues WHERE id=?"),
        vec![types::Value::Text(id.clone())],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let open: Vec<String> = {
        let mut st = c
            .prepare(
                "WITH RECURSIVE sub(x) AS (\
            SELECT id FROM issues WHERE json_extract(meta_json,'$.parent')=? \
            OR (id LIKE ?||'.%' AND instr(substr(id,length(?)+2),'.')=0) \
            UNION SELECT i.id FROM issues i JOIN sub s \
            ON json_extract(i.meta_json,'$.parent')=s.x \
            OR (i.id LIKE s.x||'.%' \
            AND instr(substr(i.id,length(s.x)+2),'.')=0)) \
            SELECT id FROM issues WHERE id IN (SELECT x FROM sub) \
            AND status!='closed'",
            )
            .map_err(ie)?;
        let rows = st
            .query_map(params![id, id, id], |r| r.get(0))
            .map_err(ie)?
            .collect::<Result<_, _>>()
            .map_err(ie)?;
        rows
    };
    let done = open.is_empty();
    Ok(json!({"id": id, "done": done, "open": open,
        "oracle_cmd": issue.get("oracle_cmd").cloned().unwrap_or(Value::Null),
        "hint": if done { "subtree closed — run oracle_cmd as final proof" }
                else { "children still open" }}))
}

fn op_prime(_c: &Connection, _a: &Value) -> R<Value> {
    Ok(json!({
        "protocol": "NDJSON over unix socket /tmp/sis-<db-stem>.sock or `sis <op>` CLI",
        "loop": "claim_next(actor) → show/contract(id) → work inside allowed_paths → run oracle_cmd → close(id, epoch, proof) → outbox lesson",
        "rules": ["claim only with oracle", "heartbeats < lease TTL",
                  "close needs fencing epoch + proof", "weak oracle → never dispatch",
                  "only blocks deps gate readiness", "deferred auto-readies at defer_until"],
        "ops": ["create","update","dep","dep_list","dep_remove","ready","list","count",
                "claim","claim_next","unclaim","reclaim","heartbeat","handoff","close","reopen","delete",
                "defer","undefer","show","search","children","label","rename","note",
                "comments","history","watch","lint","types","statuses","prime","gate",
                "gate_list","slot_acquire","slot_release","slot_list","epic","dup_scan",
                "stale","orphans","stats","remember","recall",
                "export","import","batch","budget_claim","contract",
                "outbox_list","outbox_done","outbox_fail","compact","snapshot",
                "goal","sub","plan","goal_tree","tree","next","review","goal_done"]
    }))
}

fn op_ready(c: &Connection, a: &Value) -> R<Value> {
    let t = now();
    let mut sql = format!("SELECT {COLS} FROM issues i WHERE {READY_PRED} AND {BLOCKED}");
    let mut ps = vec![
        types::Value::Real(t),
        types::Value::Real(t),
        types::Value::Real(t),
    ];
    if let Some(l) = gs(a, "lane") {
        sql.push_str(" AND i.lane=?");
        ps.push(types::Value::Text(l));
    }
    agent::cursor_filter(a, &mut sql, &mut ps)?;
    sql.push_str(" ORDER BY i.priority, i.created_at, i.id");
    if let Some(n) = gi(a, "limit") {
        sql.push_str(" LIMIT ?");
        ps.push(types::Value::Integer(n));
    }
    let mut st = c.prepare_cached(&sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), |r| row_issue(r))
        .map_err(ie)?
        .collect::<Result<Vec<Value>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}

fn claim_row(c: &Connection, issue: &str, actor: &str, epoch: i64, a: &Value) -> R<Value> {
    let cid = gen_id("c-");
    c.prepare_cached(
        "INSERT OR REPLACE INTO claims(actor,issue,claim_id,epoch,hb_at,run_id) \
               VALUES(?,?,?,?,?,?)",
    )
    .map_err(ie)?
    .execute(params![actor, issue, cid, epoch, now(), run_id(a)])
    .map_err(ie)?;
    ev(
        c,
        "claim",
        Some(issue),
        a,
        &json!({"actor": actor, "epoch": epoch, "claim_id": cid}),
    )?;
    Ok(json!({"id": issue, "claim_id": cid, "epoch": epoch}))
}
fn op_claim(c: &Connection, a: &Value) -> R<Value> {
    let (id, act) = (req(a, "id")?, actor(a).unwrap());
    let t = now();
    let ttl = gf(a, "ttl").unwrap_or(LEASE_S);
    let got: Option<i64> = c
        .query_row(
            "UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,\
         lease_epoch=lease_epoch+1 WHERE id=? AND (status='open' OR \
         (status='in_progress' AND lease_until<?)) RETURNING lease_epoch",
            params![act, t + ttl, id, t],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    match got {
        Some(ep) => claim_row(c, &id, &act, ep, a),
        None => match issue_row(c, &id)? {
            None => Err(("not_found".into(), format!("issue {id}"))),
            Some((s, _, _)) if s == "in_progress" => {
                Err(("already_claimed".into(), format!("issue {id} claimed")))
            }
            Some(_) => Err(("not_claimable".into(), format!("issue {id} not claimable"))),
        },
    }
}
fn op_claim_next(c: &Connection, a: &Value) -> R<Value> {
    let act = actor(a).unwrap();
    let t = now();
    let ttl = gf(a, "ttl").unwrap_or(LEASE_S);
    let lane = gs(a, "lane");
    let got: Option<(String, i64)> = c
        .prepare_cached(&format!(
            "UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,\
         lease_epoch=lease_epoch+1 WHERE id=(SELECT i.id FROM issues i WHERE \
         ({READY_PRED} OR (i.status='in_progress' AND i.lease_until<?)) \
         AND (i.lease_until IS NULL OR i.lease_until<?) \
         AND (? IS NULL OR i.lane=? OR i.lane IS NULL OR i.lane='') \
         AND {BLOCKED} ORDER BY i.priority, i.created_at, i.id LIMIT 1) \
         RETURNING id, lease_epoch"
        ))
        .map_err(ie)?
        .query_row(params![act, t + ttl, t, t, t, t, t, lane, lane], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(ie)?;
    match got {
        Some((id, ep)) => claim_row(c, &id, &act, ep, a),
        None => Ok(json!({"id": null})),
    }
}

fn fence_err(c: &Connection, id: &str, epoch: i64) -> (String, String) {
    match issue_row(c, id).unwrap_or(None) {
        None => ("not_found".into(), format!("issue {id}")),
        Some((_, ep, _)) if ep != epoch => ("stale_fence".into(), format!("epoch {epoch} != {ep}")),
        Some(_) => (
            "not_claimed".into(),
            format!("issue {id} not claimed by actor"),
        ),
    }
}
fn op_heartbeat(c: &Connection, a: &Value) -> R<Value> {
    let (id, act, ep) = (req(a, "id")?, actor(a).unwrap(), req_i(a, "epoch")?);
    let ttl = gf(a, "ttl").unwrap_or(LEASE_S);
    let n = c
        .prepare_cached(
            "UPDATE issues SET lease_until=? WHERE id=? AND claim_actor=? \
                       AND lease_epoch=? AND status='in_progress'",
        )
        .map_err(ie)?
        .execute(params![now() + ttl, id, act, ep])
        .map_err(ie)?;
    if n == 0 {
        return Err(fence_err(c, &id, ep));
    }
    let _ = c.execute(
        "UPDATE claims SET hb_at=? WHERE issue=? AND actor=?",
        params![now(), id, act],
    );
    ev(c, "heartbeat", Some(&id), a, &json!({"epoch": ep}))?;
    Ok(json!({"ok": true}))
}
fn op_close(c: &Connection, a: &Value) -> R<Value> {
    let (id, ep) = (req(a, "id")?, req_i(a, "epoch")?);
    let (st, lep, _) =
        issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    if lep != ep {
        return Err(("stale_fence".into(), format!("epoch {ep} != {lep}")));
    }
    if st != "closed" {
        c.execute(
            "UPDATE issues SET status='closed',closed_at=?,lease_until=NULL \
                   WHERE id=?",
            params![now(), id],
        )
        .map_err(ie)?;
        let reason = gs(a, "reason").unwrap_or_else(|| "done".into());
        ev(
            c,
            "close",
            Some(&id),
            a,
            &json!({"reason": reason, "epoch": ep}),
        )?;
        let title: String = c
            .query_row("SELECT title FROM issues WHERE id=?", params![id], |r| {
                r.get(0)
            })
            .unwrap_or_default();
        let payload = json!({"issue": id, "title": title, "reason": reason,
            "actor": actor(a), "ts": now()})
        .to_string();
        c.execute(
            "INSERT INTO outbox(kind,payload,run_id) VALUES('lesson',?,?)",
            params![payload, run_id(a)],
        )
        .map_err(ie)?;
    }
    Ok(json!({"ok": true}))
}
fn op_reopen(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let (st, lep, _) =
        issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    if let Some(ep) = gi(a, "epoch") {
        if ep != lep {
            return Err(("stale_fence".into(), format!("epoch {ep} != {lep}")));
        }
    }
    if st != "open" {
        c.execute(
            "UPDATE issues SET status='open',closed_at=NULL,lease_until=NULL,\
                   claim_actor=NULL WHERE id=?",
            params![id],
        )
        .map_err(ie)?;
    }
    ev(
        c,
        "reopen",
        Some(&id),
        a,
        &json!({"reason": gs(a, "reason")}),
    )?;
    Ok(json!({"ok": true}))
}

fn op_show(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let mut issue = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues WHERE id=?"),
        vec![types::Value::Text(id.clone())],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let deps: Vec<Value> = c
        .prepare("SELECT depends_on,type FROM deps WHERE issue=?")
        .map_err(ie)?
        .query_map(params![id], |r| {
            Ok(json!({"depends_on": r.get::<_,String>(0)?,
                      "type": r.get::<_,Option<String>>(1)?}))
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    // blocked_by: open blocks-deps OR closed/absent gates — same predicate
    // as the ready gate.
    let blocked_by: Vec<String> = c
        .prepare(
            "SELECT d.depends_on FROM deps d \
         LEFT JOIN issues b ON b.id=d.depends_on \
         LEFT JOIN gates g ON g.name=d.depends_on \
         WHERE d.issue=? AND (\
           ((d.type IS NULL OR d.type='blocks') AND b.status IS NOT NULL AND b.status!='closed') \
           OR (d.type='gate' AND COALESCE(g.state,'closed')!='open'))",
        )
        .map_err(ie)?
        .query_map(params![id], |r| r.get(0))
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,actor,run_id,idem,data_json FROM events \
        WHERE issue=? ORDER BY seq DESC LIMIT 10",
        )
        .map_err(ie)?;
    let mut tail: Vec<Value> = st
        .query_map(params![id], |r| {
            let dj: Option<String> = r.get(6)?;
            Ok(json!({"seq": r.get::<_,i64>(0)?, "ts": r.get::<_,f64>(1)?,
            "op": r.get::<_,String>(2)?, "actor": r.get::<_,Option<String>>(3)?,
            "run_id": r.get::<_,Option<String>>(4)?, "idem": r.get::<_,Option<String>>(5)?,
            "data": dj.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)}))
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    tail.reverse();
    let stage = run_state(c, &id, &issue)?;
    if let Some(m) = issue.as_object_mut() {
        m.insert("run_state".into(), json!(stage));
        let last: Option<String> = c
            .query_row(
                "SELECT data_json FROM events WHERE issue=? AND op='changes' \
                 ORDER BY seq DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(ie)?;
        if let Some(d) = last.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            m.insert(
                "changes".into(),
                d.get("files").cloned().unwrap_or(Value::Null),
            );
        }
    }
    let mut st = c
        .prepare(
            "SELECT attest_id,kind,passed,revision,ts FROM attests \
             WHERE issue=? ORDER BY ts DESC LIMIT 10",
        )
        .map_err(ie)?;
    let attests = st
        .query_map(params![id], |r| {
            Ok(json!({"attest_id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,
                "passed":r.get::<_,bool>(2)?,"revision":r.get::<_,Option<String>>(3)?,
                "ts":r.get::<_,f64>(4)?}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    Ok(
        json!({"issue": issue, "deps": deps, "blocked_by": blocked_by,
              "events_tail": tail, "attests": attests}),
    )
}

fn op_search(c: &Connection, a: &Value) -> R<Value> {
    let q = req(a, "q")?;
    let lim = gi(a, "limit").unwrap_or(50);
    let sql = "SELECT i.* FROM issues i JOIN issues_fts f ON f.rowid=i.rowid \
               WHERE issues_fts MATCH ? ORDER BY rank LIMIT ?"
        .to_string();
    let try_q = |qq: &str| {
        q_issues(
            c,
            &sql,
            vec![types::Value::Text(qq.into()), types::Value::Integer(lim)],
        )
    };
    match try_q(&q) {
        Ok(v) => Ok(Value::Array(v)),
        Err(e) => try_q(&format!("\"{}\"", q.replace('"', "")))
            .map(Value::Array)
            .or_else(|_| Err(e)),
    }
}
fn op_stale(c: &Connection, a: &Value) -> R<Value> {
    let t = gf(a, "now").unwrap_or_else(now);
    Ok(Value::Array(q_issues(
        c,
        &format!(
            "SELECT {COLS} FROM issues WHERE status='in_progress' \
                  AND lease_until IS NOT NULL AND lease_until<? ORDER BY lease_until"
        ),
        vec![types::Value::Real(t)],
    )?))
}
fn op_orphans(c: &Connection, a: &Value) -> R<Value> {
    let mut info: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut st = c.prepare("SELECT id,status,type FROM issues").map_err(ie)?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .map_err(ie)?;
        for r in rows {
            let (i, s, t) = r.map_err(ie)?;
            info.insert(i, (s, t));
        }
    }
    let mut g: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut st = c.prepare("SELECT issue,depends_on FROM deps").map_err(ie)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(ie)?;
        for r in rows {
            let (i, d) = r.map_err(ie)?;
            g.entry(i).or_default().push(d);
        }
    }
    let is_root = |id: &str| -> bool {
        match info.get(id) {
            Some((s, t)) if s == "open" || s == "in_progress" => {
                t == "epic" || g.get(id).map(|v| v.is_empty()).unwrap_or(true)
            }
            _ => false,
        }
    };
    let lane = gs(a, "lane");
    let mut out = vec![];
    for (id, (st, _)) in &info {
        if st != "open" {
            continue;
        }
        if let Some(l) = &lane {
            // lane filter when provided
            let il: Option<String> = c
                .query_row("SELECT lane FROM issues WHERE id=?", params![id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(ie)?
                .flatten();
            if il.as_deref() != Some(l.as_str()) {
                continue;
            }
        }
        // DFS from id: orphan iff no reachable alive root/epic node
        let mut stack = vec![id.clone()];
        let mut seen = HashSet::new();
        let mut ok = false;
        while let Some(x) = stack.pop() {
            if !seen.insert(x.clone()) {
                continue;
            }
            if is_root(&x) {
                ok = true;
                break;
            }
            if let Some(ch) = g.get(&x) {
                stack.extend(ch.iter().cloned());
            }
        }
        if !ok {
            out.push(
                q_issues(
                    c,
                    &format!("SELECT {COLS} FROM issues WHERE id=?"),
                    vec![types::Value::Text(id.clone())],
                )?
                .remove(0),
            );
        }
    }
    Ok(Value::Array(out))
}
fn op_stats(c: &Connection, _a: &Value) -> R<Value> {
    let mut st = c
        .prepare("SELECT status,COUNT(*) FROM issues GROUP BY status")
        .map_err(ie)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(ie)?;
    let (mut open, mut prog, mut closed, mut defer, mut total) = (0i64, 0i64, 0i64, 0i64, 0i64);
    for r in rows {
        let (s, n) = r.map_err(ie)?;
        total += n;
        match s.as_str() {
            "open" => open = n,
            "in_progress" => prog = n,
            "closed" => closed = n,
            "deferred" => defer = n,
            _ => {}
        }
    }
    let blocked: i64 = c
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM issues i WHERE i.status='open' \
                  AND NOT ({BLOCKED})"
            ),
            [],
            |r| r.get(0),
        )
        .map_err(ie)?;
    let pend: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // ready = vollständige READY_PRED (defer_until + expires_at) ∧ ¬BLOCKED —
    // deckt sich 1:1 mit dem `ready`-Op statt open-minus-blocked Näherung.
    let t = now();
    let ready_n: i64 = c
        .query_row(
            &format!("SELECT COUNT(*) FROM issues i WHERE {READY_PRED} AND {BLOCKED}"),
            params![t, t, t],
            |r| r.get(0),
        )
        .map_err(ie)?;
    Ok(
        json!({"total": total, "open": open, "in_progress": prog, "closed": closed,
        "deferred": defer, "blocked": blocked, "ready": ready_n,
        "pending_outbox": pend}),
    )
}
fn op_remember(c: &Connection, a: &Value) -> R<Value> {
    let (k, v) = (
        req(a, "key")?,
        a.get("value").cloned().unwrap_or(Value::Null),
    );
    let vs = match &v {
        Value::String(s) => s.clone(),
        o => o.to_string(),
    };
    c.execute(
        "INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) \
               ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![k, vs, now()],
    )
    .map_err(ie)?;
    ev(c, "remember", None, a, &json!({"key": k}))?;
    Ok(json!({"ok": true}))
}
fn op_recall(c: &Connection, a: &Value) -> R<Value> {
    let (mut sql, mut ps) = (
        "SELECT key,value,updated_at FROM memories".to_string(),
        vec![],
    );
    if let Some(k) = gs(a, "key") {
        sql.push_str(" WHERE key=?");
        ps.push(types::Value::Text(k));
    }
    sql.push_str(" ORDER BY key");
    let mut st = c.prepare(&sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), |r| {
            Ok(json!({
        "key": r.get::<_, String>(0)?, "value": r.get::<_, String>(1)?,
        "updated_at": r.get::<_, f64>(2)? }))
        })
        .map_err(ie)?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(ie)?);
    }
    Ok(Value::Array(out))
}
/// bd-compatible issue row: .beads/issues.jsonl shape (issue_type,
/// description, labels, embedded dependencies).
fn bd_issue(c: &Connection, i: &Value) -> R<Value> {
    let id = i["id"].as_str().unwrap_or("");
    let deps: Vec<Value> = c
        .prepare("SELECT depends_on,COALESCE(type,'blocks') FROM deps WHERE issue=? ORDER BY depends_on")
        .map_err(ie)?
        .query_map(params![id], |r| {
            Ok(json!({"issue_id": id, "depends_on_id": r.get::<_,String>(0)?,
                      "type": r.get::<_,String>(1)?}))
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let labels = i
        .pointer("/meta/labels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(json!({
        "id": id, "title": i["title"], "description": i["desc"],
        "status": i["status"], "issue_type": i["type"],
        "priority": i["priority"], "labels": labels,
        "created_at": i["created_at"], "closed_at": i["closed_at"],
        "acceptance": i["acceptance"], "oracle_cmd": i["oracle_cmd"],
        "owner": i["owner"], "lane": i["lane"],
        "dependencies": deps}))
}
fn op_export(c: &Connection, a: &Value) -> R<Value> {
    let issues = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues ORDER BY created_at,id"),
        vec![],
    )?;
    if gs(a, "format").as_deref() == Some("bd") {
        let mut out = vec![];
        for i in &issues {
            out.push(bd_issue(c, i)?);
        }
        return Ok(json!({"format": "bd", "issues": out, "n": out.len()}));
    }
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,issue,actor,run_id,idem,data_json \
                            FROM events ORDER BY seq",
        )
        .map_err(ie)?;
    let evs: Vec<Value> = st
        .query_map([], |r| {
            let dj: Option<String> = r.get(7)?;
            Ok(json!({"seq": r.get::<_,i64>(0)?, "ts": r.get::<_,f64>(1)?,
            "op": r.get::<_,Option<String>>(2)?, "issue": r.get::<_,Option<String>>(3)?,
            "actor": r.get::<_,Option<String>>(4)?, "run_id": r.get::<_,Option<String>>(5)?,
            "idem": r.get::<_,Option<String>>(6)?,
            "data": dj.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)}))
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    Ok(json!({"issues": issues, "events": evs, "events_count": evs.len()}))
}

// ---------- git-versioned snapshot (.issues.jsonl) ----------
// bd-Parity: Dolt gave bd git-like history/sync; sis gets the same via a
// deterministic NDJSON mirror next to the DB. One upsert line per issue
// (deps embedded), sorted by id, no volatile fields — identical state
// produces an identical file, so `git diff` shows real task changes only.
fn snapshot_path(dbp: &str) -> PathBuf {
    Path::new(dbp).with_extension("issues.jsonl")
}
fn snapshot_store(c: &Connection, dbp: &str) -> R<Value> {
    let issues = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues ORDER BY id"),
        vec![],
    )?;
    let mut dst = c
        .prepare("SELECT issue,depends_on,type FROM deps ORDER BY issue,depends_on")
        .map_err(ie)?;
    let dep_rows = dst
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(ie)?;
    let mut deps: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for d in dep_rows {
        let (i, on, t) = d.map_err(ie)?;
        deps.entry(i).or_default().push(
            json!({"on": on, "type": t.unwrap_or_else(|| "blocks".into())}),
        );
    }
    let n = issues.len();
    let mut out = String::from("{\"k\":\"sis-snapshot\",\"v\":1}\n");
    for mut i in issues {
        if let Some(obj) = i.as_object_mut() {
            let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(d) = deps.remove(id) {
                obj.insert("deps".into(), Value::Array(d));
            }
        }
        let line = json!({"op":"upsert","issue":i.get("id").cloned().unwrap_or(Value::Null),"data":i});
        out.push_str(&line.to_string());
        out.push('\n');
    }
    let path = snapshot_path(dbp);
    // Deterministic content: an unchanged mirror skips write+rename, so
    // writes that don't touch issue rows (notes, comments, events) cost
    // the scan only, not a 4+ MB file churn.
    if fs::read(&path).map(|old| old == out.as_bytes()).unwrap_or(false) {
        return Ok(json!({"path": path.to_string_lossy(), "issues": n, "unchanged": true}));
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, out).map_err(ie)?;
    fs::rename(&tmp, &path).map_err(ie)?;
    Ok(json!({"path": path.to_string_lossy(), "issues": n}))
}

fn op_import(c: &Connection, a: &Value) -> R<Value> {
    let text = if let Some(p) = gs(a, "path") {
        fs::read_to_string(&p).map_err(ie)?
    } else if let Some(j) = gs(a, "jsonl") {
        j
    } else {
        return Err(bad("path or jsonl required"));
    };
    let mut n = 0i64;
    let mut conflicts: Vec<Value> = vec![];
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(l) else {
            continue;
        };
        let op = gs(&v, "op").or_else(|| gs(&v, "kind")).unwrap_or_default();
        let issue = gs(&v, "issue").or_else(|| gs(&v, "issue_id"));
        // bd line: bare issue object (no op wrapper) — auto-detected via
        // issue_type/description, or forced with format:"bd".
        if gs(a, "format").as_deref() == Some("bd")
            || (v.get("op").is_none()
                && v.get("issue_id").is_none()
                && (v.get("issue_type").is_some() || v.get("description").is_some()))
        {
            let Some(iid) = v.get("id").and_then(Value::as_str) else { continue };
            let status = v["status"]
                .as_str()
                .filter(|s| matches!(*s, "open" | "in_progress" | "closed" | "deferred"))
                .unwrap_or("open");
            // federation rules: a bd export must not steal a live claim or
            // implicitly reopen finished work (force:true overrides the
            // latter — the caller owns the merge decision then).
            if let Some((ex_status, ex_actor, ex_lease)) = c
                .query_row(
                    "SELECT status,claim_actor,lease_until FROM issues WHERE id=?",
                    params![iid],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, Option<f64>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(ie)?
            {
                if ex_status != "closed" && ex_lease.is_some_and(|u| u > now()) {
                    conflicts.push(json!({"id": iid, "reason": "active_claim",
                                          "actor": ex_actor}));
                    continue;
                }
                if ex_status == "closed" && status != "closed" && a["force"] != true {
                    conflicts.push(json!({"id": iid, "reason": "would_reopen"}));
                    continue;
                }
            }
            let labels = v.get("labels").cloned().unwrap_or_else(|| json!([]));
            let meta = json!({"labels": labels});
            let _ = c.execute(
                "INSERT OR REPLACE INTO issues(id,title,\"desc\",status,priority,type,\
                acceptance,closed_at,created_at,meta_json) VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM issues WHERE id=?),?),?)",
                params![
                    iid,
                    v["title"].as_str().unwrap_or("imported"),
                    v["description"].as_str().or_else(|| v["desc"].as_str()).unwrap_or(""),
                    status,
                    gf(&v, "priority").unwrap_or(2.0),
                    v["issue_type"].as_str().or_else(|| v["type"].as_str()).unwrap_or("task"),
                    v["acceptance"].as_str().unwrap_or(""),
                    gf(&v, "closed_at"),
                    iid,
                    gf(&v, "created_at").unwrap_or_else(now),
                    meta.to_string(),
                ],
            );
            if let Some(dl) = v.get("dependencies").and_then(|x| x.as_array()) {
                for d in dl {
                    if let Some(on) = d
                        .get("depends_on_id")
                        .or_else(|| d.get("depends_on"))
                        .and_then(|x| x.as_str())
                    {
                        let t = d.get("type").and_then(|x| x.as_str()).unwrap_or("blocks");
                        let _ = c.execute(
                            "INSERT OR IGNORE INTO deps(issue,depends_on,type) VALUES(?,?,?)",
                            params![iid, on, t],
                        );
                    }
                }
            }
            n += 1;
            continue;
        }
        let data = v
            .get("data")
            .cloned()
            .or_else(|| v.get("data_json").cloned())
            .unwrap_or(Value::Null);
        c.execute(
            "INSERT INTO events(ts,op,issue,actor,run_id,idem,data_json) \
                   VALUES(?,?,?,?,?,?,?)",
            params![
                gf(&v, "ts").unwrap_or_else(now),
                op,
                issue,
                gs(&v, "actor"),
                gs(&v, "run_id"),
                gs(&v, "idem"),
                data.to_string()
            ],
        )
        .map_err(ie)?;
        match op.as_str() {
            "create" => {
                let vt = gs(&v, "title");
                let title = data
                    .get("title")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .or(vt)
                    .unwrap_or_else(|| "imported".into());
                let iid = issue.clone().unwrap_or_else(|| gen_id("sis-"));
                let status = data
                    .get("status")
                    .and_then(|x| x.as_str())
                    .filter(|s| matches!(*s, "open" | "in_progress" | "closed" | "deferred"))
                    .unwrap_or("open");
                let prio = gf(&data, "priority").unwrap_or(2.0);
                let desc = data
                    .get("desc")
                    .or_else(|| data.get("description"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let acc = data
                    .get("acceptance")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let closed_at = if status == "closed" {
                    Some(now())
                } else {
                    None
                };
                c.execute("INSERT OR IGNORE INTO issues(id,title,\"desc\",status,priority,acceptance,created_at,closed_at) \
                           VALUES(?,?,?,?,?,?,?,?)",
                    params![iid, title, desc, status, prio, acc, now(), closed_at]).map_err(ie)?;
            }
            "dep" | "dep_add" => {
                if let (Some(i), Some(d)) = (
                    issue.clone(),
                    data.get("depends_on")
                        .and_then(|x| x.as_str())
                        .map(String::from)
                        .or_else(|| data.as_str().map(String::from)),
                ) {
                    let _ = c.execute(
                        "INSERT OR IGNORE INTO deps(issue,depends_on) \
                                       VALUES(?,?)",
                        params![i, d],
                    );
                }
            }
            "close" => {
                if let Some(i) = &issue {
                    let _ = c.execute(
                        "UPDATE issues SET status='closed',closed_at=? WHERE id=? \
                                   AND status!='closed'",
                        params![now(), i],
                    );
                }
            }
            "reopen" => {
                if let Some(i) = &issue {
                    let _ = c.execute(
                        "UPDATE issues SET status='open',closed_at=NULL \
                                   WHERE id=?",
                        params![i],
                    );
                }
            }
            "upsert" => {
                // Full-row merge written by snapshot_store; line format is
                // {"op":"upsert","issue":<id>,"data":{...row...,"deps":[...]}}.
                // Last import wins — git merges line-level conflicts first.
                let iid = issue
                    .clone()
                    .or_else(|| gs(&data, "id"))
                    .unwrap_or_default();
                if !iid.is_empty() {
                    let s = |k: &str| data.get(k).and_then(|x| x.as_str());
                    let f = |k: &str| data.get(k).and_then(|x| x.as_f64());
                    let _ = c.execute(
                        "INSERT OR REPLACE INTO issues(id,title,status,priority,type,owner,\
                        oracle_cmd,allowed_paths,lane,budget_eur,acceptance,\"desc\",\
                        lease_until,lease_epoch,claim_actor,created_at,closed_at,defer_until,\
                        expires_at,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        params![
                            iid,
                            s("title").unwrap_or(""),
                            s("status").unwrap_or("open"),
                            f("priority").unwrap_or(2.0),
                            s("type").unwrap_or("task"),
                            s("owner"),
                            s("oracle_cmd"),
                            s("allowed_paths"),
                            s("lane"),
                            f("budget_eur"),
                            s("acceptance"),
                            s("desc"),
                            f("lease_until"),
                            f("lease_epoch").unwrap_or(0.0),
                            s("claim_actor"),
                            f("created_at"),
                            f("closed_at"),
                            f("defer_until"),
                            f("expires_at"),
                            data.get("meta").map(|m| m.to_string()),
                        ],
                    );
                    if let Some(dl) = data.get("deps").and_then(|x| x.as_array()) {
                        let _ = c.execute("DELETE FROM deps WHERE issue=?", params![iid]);
                        for d in dl {
                            if let Some(on) = d.get("on").and_then(|x| x.as_str()) {
                                let t = d.get("type").and_then(|x| x.as_str()).unwrap_or("blocks");
                                let _ = c.execute(
                                    "INSERT OR IGNORE INTO deps(issue,depends_on,type) \
                                               VALUES(?,?,?)",
                                    params![iid, on, t],
                                );
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        n += 1;
    }
    Ok(json!({"n": n, "conflicts": conflicts}))
}
fn op_budget_claim(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "issue")?;
    let eur = gf(a, "eur")
        .or_else(|| gs(a, "eur").and_then(|s| s.parse().ok()))
        .ok_or_else(|| bad("eur required"))?;
    let got: Option<f64> = c
        .query_row(
            "UPDATE issues SET budget_eur=budget_eur-? WHERE id=? AND budget_eur IS NOT NULL \
         AND budget_eur>=? RETURNING budget_eur",
            params![eur, id, eur],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    match got {
        Some(rem) => {
            ev(
                c,
                "budget_claim",
                Some(&id),
                a,
                &json!({"eur": eur, "remaining": rem}),
            )?;
            Ok(json!({"ok": true, "remaining": rem}))
        }
        None => {
            if issue_row(c, &id)?.is_none() {
                Err(("not_found".into(), format!("issue {id}")))
            } else {
                Err(("over_budget".into(), format!("issue {id} over budget")))
            }
        }
    }
}
fn op_contract(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let v = q_issues(
        c,
        &format!("SELECT {COLS} FROM issues WHERE id=?"),
        vec![types::Value::Text(id.clone())],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let g = |k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let deps: Vec<String> = c
        .prepare("SELECT depends_on FROM deps WHERE issue=?")
        .map_err(ie)?
        .query_map(params![id], |r| r.get(0))
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let t = format!(
        "# gq contract — {id}\n\n## {title}\n\nstatus: {st} · type: {ty} · priority: {pr} · lane: {ln}\n\
        \n## Description\n{ds}\n\n## Acceptance\n{ac}\n\noracle_cmd: {oc}\nallowed_paths: {ap}\n\
        budget_eur: {bu}\ndepends_on: {deps:?}\nowner: {ow}\n",
        id = id, title = g("title"), st = g("status"), ty = g("type"), pr = g("priority"),
        ln = g("lane"), ds = g("desc"), ac = g("acceptance"), oc = g("oracle_cmd"),
        ap = g("allowed_paths"), bu = g("budget_eur"), deps = deps, ow = g("owner"));
    Ok(json!({"contract_text": t, "anchors": null, "priors": null}))
}
fn outbox_row(r: &rusqlite::Row) -> Result<Value, rusqlite::Error> {
    let p: Option<String> = r.get(2)?;
    Ok(
        json!({"id": r.get::<_, i64>(0)?, "kind": r.get::<_, Option<String>>(1)?,
        "payload": p.map(|s| serde_json::from_str(&s).unwrap_or(Value::String(s))).unwrap_or(Value::Null),
        "state": r.get::<_, Option<String>>(3)?, "attempts": r.get::<_, i64>(4)?,
        "run_id": r.get::<_, Option<String>>(5)?}),
    )
}
fn op_outbox_list(c: &Connection, a: &Value) -> R<Value> {
    let (mut sql, mut ps) = (
        "SELECT id,kind,payload,state,attempts,run_id FROM outbox".to_string(),
        vec![],
    );
    if let Some(s) = gs(a, "state") {
        sql.push_str(" WHERE state=?");
        ps.push(types::Value::Text(s));
    }
    sql.push_str(" ORDER BY id");
    let mut st = c.prepare(&sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), outbox_row)
        .map_err(ie)?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(ie)?);
    }
    Ok(Value::Array(out))
}
fn outbox_delivery(c: &Connection, a: &Value) -> R<Option<f64>> {
    let id = req_i(a, "id")?;
    let lease: Option<(String, i64, f64)> = c.query_row(
        "SELECT actor,epoch,lease_until FROM outbox_leases WHERE outbox_id=?",
        params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(ie)?;
    if let Some((actor, epoch, until)) = lease {
        if gs(a, "actor").as_deref() != Some(actor.as_str())
            || gi(a, "epoch") != Some(epoch) || until <= now() {
            return Err(("stale_fence".into(), "outbox runner, delivery epoch and live lease required".into()));
        }
        Ok(Some(until))
    } else {
        Ok(None)
    }
}
fn op_outbox_state(c: &Connection, a: &Value, state: &str) -> R<Value> {
    let id = req_i(a, "id")?;
    let leased = outbox_delivery(c, a)?.is_some();
    if leased {
        let current: String = c.query_row("SELECT state FROM outbox WHERE id=?", params![id], |r| r.get(0)).map_err(ie)?;
        if current != "running" && current != state {
            return Err(("stale_fence".into(), "delivery already finalized with a different outcome".into()));
        }
    }
    let n = if state == "failed" && !leased {
        c.execute(
            "UPDATE outbox SET state='failed',attempts=attempts+1 WHERE id=?",
            params![id],
        )
        .map_err(ie)?
    } else {
        c.execute("UPDATE outbox SET state=? WHERE id=?", params![state, id])
            .map_err(ie)?
    };
    if n == 0 {
        return Err(("not_found".into(), format!("outbox {id}")));
    }
    Ok(json!({"ok": true}))
}
/// `sis outbox_export`: drain pending outbox rows into runner-specific job
/// envelopes. `drain:true` marks exported rows done in the same transaction.
fn op_outbox_export(c: &Connection, a: &Value) -> R<Value> {
    let fmt = gs(a, "format").unwrap_or_else(|| "raw".into());
    let limit = a
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|n| (1..=500).contains(n))
        .unwrap_or(100);
    let runner = if a.get("actor").is_some() {
        let actor = req(a, "actor")?;
        if actor.trim().is_empty() || actor.len() > 128 {
            return Err(bad("runner actor must be nonempty within 128 bytes"));
        }
        Some(actor)
    } else { None };
    let ttl = match a.get("ttl") {
        None => 120.0,
        Some(v) => v.as_f64().filter(|v| v.is_finite() && (5.0..=3600.0).contains(v))
            .ok_or_else(|| bad("delivery ttl must be within 5..3600 seconds"))?,
    };
    if runner.is_none() && a.get("ttl").is_some() {
        return Err(bad("delivery ttl requires explicit runner actor"));
    }
    if runner.is_some() && a["drain"] == true {
        return Err(bad("leased export requires acknowledgement, not drain"));
    }
    let kind = gs(a, "kind");
    let tm = now();
    if runner.is_some() {
        c.execute("UPDATE outbox SET state='failed' WHERE state='running' AND attempts>=3 AND id IN (SELECT outbox_id FROM outbox_leases WHERE lease_until<=?)", params![tm]).map_err(ie)?;
    }
    let mut st = c.prepare("SELECT o.id,o.kind,o.payload,o.run_id FROM outbox o LEFT JOIN outbox_leases l ON l.outbox_id=o.id WHERE (o.state='pending' OR (? AND o.state='running' AND l.lease_until<=? AND o.attempts<3)) AND (? IS NULL OR o.kind=?) ORDER BY o.id LIMIT ?").map_err(ie)?;
    let rows: Vec<(i64, String, String, Option<String>)> = st
        .query_map(params![runner.is_some(), tm, kind, kind, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let mut leases = HashMap::new();
    if let Some(actor) = &runner {
        for (id, _, _, _) in &rows {
            c.execute("INSERT INTO outbox_leases(outbox_id,actor,epoch,lease_until) VALUES(?,?,1,?) ON CONFLICT(outbox_id) DO UPDATE SET actor=excluded.actor,epoch=outbox_leases.epoch+1,lease_until=excluded.lease_until", params![id, actor, tm + ttl]).map_err(ie)?;
            c.execute("UPDATE outbox SET state='running',attempts=attempts+1 WHERE id=?", params![id]).map_err(ie)?;
            let epoch: i64 = c.query_row("SELECT epoch FROM outbox_leases WHERE outbox_id=?", params![id], |r| r.get(0)).map_err(ie)?;
            leases.insert(*id, epoch);
        }
    }
    let env = |id: i64, kind: &str, payload: &str, run_id: &Option<String>| {
        let mut job = json!({"outbox_id": id, "kind": kind,
               "payload": serde_json::from_str::<Value>(payload).unwrap_or(Value::String(payload.into())),
               "run_id": run_id});
        if let Some(epoch) = leases.get(&id) {
            job["delivery_epoch"] = json!(epoch);
            job["delivery_actor"] = json!(runner);
            job["lease_until"] = json!(tm + ttl);
            job["idempotency_key"] = json!(format!("outbox-{id}-delivery-{epoch}"));
        }
        job
    };
    let mut ids = vec![];
    let out = match fmt.as_str() {
        "raw" => {
            let jobs: Vec<Value> = rows
                .iter()
                .map(|(id, k, p, r)| {
                    ids.push(*id);
                    env(*id, k, p, r)
                })
                .collect();
            json!({"format": "raw", "jobs": jobs})
        }
        "pgboss-sql" => {
            let mut sql = String::new();
            for (id, k, p, r) in &rows {
                ids.push(*id);
                let data = env(*id, k, p, r).to_string().replace('\'', "''");
                sql.push_str(&format!(
                    "INSERT INTO pgboss.job(name,data) VALUES('sis-event','{data}'::jsonb);\n"
                ));
            }
            json!({"format": "pgboss-sql", "sql": sql})
        }
        "hatchet" => {
            let jobs: Vec<Value> = rows
                .iter()
                .map(|(id, k, p, r)| {
                    ids.push(*id);
                    json!({"workflow": "sis-event", "input": env(*id, k, p, r)})
                })
                .collect();
            json!({"format": "hatchet", "jobs": jobs})
        }
        "temporal" => {
            let queue = gs(a, "task_queue").unwrap_or_else(|| "sis".into());
            let jobs: Vec<Value> = rows
                .iter()
                .map(|(id, k, p, r)| {
                    ids.push(*id);
                    json!({"workflowType": "SisEvent", "taskQueue": queue,
                           "workflowId": format!("sis-outbox-{id}"),
                           "args": [env(*id, k, p, r)]})
                })
                .collect();
            json!({"format": "temporal", "jobs": jobs})
        }
        other => return Err(bad(format!("unknown export format {other}"))),
    };
    let drained = a.get("drain").and_then(Value::as_bool) == Some(true);
    if drained && !ids.is_empty() {
        let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        c.execute(
            &format!("UPDATE outbox SET state='done' WHERE id IN ({marks})"),
            params_from_iter(ids.iter()),
        )
        .map_err(ie)?;
    }
    ev(
        c,
        "outbox_export",
        None,
        a,
        &json!({"format": fmt, "n": ids.len(), "drained": drained}),
    )?;
    let mut out = out;
    out["n"] = json!(ids.len());
    out["drained"] = json!(drained);
    Ok(out)
}

/// `sis cost_add`/`cost_list`/`cost_rollup`: durable cost ledger per issue.
/// Rollup walks the container tree (meta.parent chain + id-prefix) so a
/// goal reports the spend of all descendants, grouped by issue/actor/wave.
fn op_cost_add(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "issue")?;
    issue_row(c, &id)?.ok_or_else(|| ("not_found".into(), format!("issue {id}")))?;
    let (ti, to, cents) = (
        gi(a, "tokens_in").unwrap_or(0),
        gi(a, "tokens_out").unwrap_or(0),
        gi(a, "cents")
            .or_else(|| gf(a, "cents").map(|x| x as i64))
            .or_else(|| gf(a, "eur").map(|x| (x * 100.0).round() as i64))
            .unwrap_or(0),
    );
    if ti < 0 || to < 0 || cents < 0 {
        return Err(bad("costs must be nonnegative"));
    }
    let wave = gs(a, "wave").filter(|w| w.chars().count() <= 64);
    if a.get("wave").is_some() && wave.is_none() {
        return Err(bad("wave must be at most 64 characters"));
    }
    c.execute(
        "INSERT INTO costs(issue,actor,run_id,wave,tokens_in,tokens_out,cents,currency,note,ts) \
         VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![
            id,
            gs(a, "actor"),
            run_id(a),
            wave,
            ti,
            to,
            cents,
            gs(a, "currency").unwrap_or_else(|| "EUR".into()),
            gs(a, "note"),
            now()
        ],
    )
    .map_err(ie)?;
    let row = c.last_insert_rowid();
    ev(
        c,
        "cost_add",
        Some(&id),
        a,
        &json!({"cost_id": row, "tokens_in": ti, "tokens_out": to, "cents": cents}),
    )?;
    Ok(json!({"ok": true, "id": row}))
}
fn op_cost_list(c: &Connection, a: &Value) -> R<Value> {
    let mut sql = String::from(
        "SELECT id,issue,actor,run_id,wave,tokens_in,tokens_out,cents,currency,note,ts FROM costs",
    );
    let mut ps: Vec<types::Value> = vec![];
    let mut wh = vec![];
    for k in ["issue", "actor", "run_id", "wave"] {
        if let Some(v) = gs(a, k) {
            wh.push(format!("{k}=?"));
            ps.push(types::Value::Text(v));
        }
    }
    if !wh.is_empty() {
        sql.push_str(&format!(" WHERE {}", wh.join(" AND ")));
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    ps.push(types::Value::Integer(
        a.get("limit")
            .and_then(Value::as_u64)
            .filter(|n| (1..=1000).contains(n))
            .unwrap_or(200) as i64,
    ));
    let mut st = c.prepare(&sql).map_err(ie)?;
    let rows = st
        .query_map(params_from_iter(ps.iter()), |r| {
            Ok(json!({"id":r.get::<_,i64>(0)?,"issue":r.get::<_,Option<String>>(1)?,
            "actor":r.get::<_,Option<String>>(2)?,"run_id":r.get::<_,Option<String>>(3)?,
            "wave":r.get::<_,Option<String>>(4)?,"tokens_in":r.get::<_,i64>(5)?,
            "tokens_out":r.get::<_,i64>(6)?,"cents":r.get::<_,i64>(7)?,
            "currency":r.get::<_,Option<String>>(8)?,"note":r.get::<_,Option<String>>(9)?,
            "ts":r.get::<_,f64>(10)?}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    Ok(Value::Array(rows))
}
fn op_cost_rollup(c: &Connection, a: &Value) -> R<Value> {
    let root = req(a, "id")?;
    issue_row(c, &root)?.ok_or_else(|| ("not_found".into(), format!("issue {root}")))?;
    // Subtree: meta.parent links plus id-prefix children (READY_PRED rule).
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack = vec![root.clone()];
    while let Some(cur) = stack.pop() {
        if !seen.insert(cur.clone()) || seen.len() > 512 {
            continue;
        }
        let mut st = c
            .prepare(
                "SELECT id FROM issues WHERE json_extract(meta_json,'$.parent')=? \
                 OR (id LIKE ?||'.%' AND instr(substr(id,length(?)+2),'.')=0)",
            )
            .map_err(ie)?;
        let kids = st
            .query_map(params![cur, cur, cur], |r| r.get::<_, String>(0))
            .map_err(ie)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ie)?;
        for k in kids {
            if !seen.contains(&k) {
                stack.push(k);
            }
        }
    }
    let ids: Vec<String> = seen.into_iter().collect();
    let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let group = |by: &str| -> R<Vec<Value>> {
        let mut st = c
            .prepare(&format!(
                "SELECT COALESCE({by},'(none)') k, COALESCE(SUM(tokens_in),0) ti, \
                 COALESCE(SUM(tokens_out),0) t_o, COALESCE(SUM(cents),0) ce, COUNT(*) n \
                 FROM costs WHERE issue IN ({marks}) GROUP BY k ORDER BY ce DESC"
            ))
            .map_err(ie)?;
        let rows = st
            .query_map(params_from_iter(ids.iter()), |r| {
                Ok(json!({"key":r.get::<_,String>(0)?,"tokens_in":r.get::<_,i64>(1)?,
                    "tokens_out":r.get::<_,i64>(2)?,"cents":r.get::<_,i64>(3)?,
                    "entries":r.get::<_,i64>(4)?}))
            })
            .map_err(ie)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ie)?;
        Ok(rows)
    };
    let totals = c
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(tokens_in),0),COALESCE(SUM(tokens_out),0),\
                 COALESCE(SUM(cents),0),COUNT(*) FROM costs WHERE issue IN ({marks})"
            ),
            params_from_iter(ids.iter()),
            |r| {
                Ok(json!({"tokens_in":r.get::<_,i64>(0)?,"tokens_out":r.get::<_,i64>(1)?,
                    "cents":r.get::<_,i64>(2)?,"eur":r.get::<_,i64>(2)? as f64/100.0,
                    "entries":r.get::<_,i64>(3)?}))
            },
        )
        .map_err(ie)?;
    let budget: Option<f64> = c
        .query_row(
            "SELECT budget_eur FROM issues WHERE id=?",
            params![root],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?
        .flatten();
    Ok(json!({"id": root, "issues": ids.len(), "totals": totals,
        "by_issue": group("issue")?, "by_actor": group("actor")?,
        "by_wave": group("wave")?, "budget_eur": budget}))
}

/// `sis learn`: honest aggregates over the ledger — pass rates (attests,
/// proofs), cost (cents/tokens) and time-to-accepted per group, no invented
/// score. Group key per entity: actor/wave/kind carry their own field;
/// entities without it group via their issue's membership (an issue is in
/// wave W if it has a cost row with wave W, in kind K if it has an attest of
/// kind K). Failed trials stay visible — they are evidence, not weight 0.
fn op_learn(c: &Connection, a: &Value) -> R<Value> {
    let by = gs(a, "group_by").unwrap_or_else(|| "actor".into());
    if !matches!(by.as_str(), "actor" | "wave" | "kind" | "issue") {
        return Err(bad("group_by must be actor|wave|kind|issue"));
    }
    let since = match a.get("since") {
        None => 0.0,
        Some(v) => v.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or_else(|| bad("since must be finite and nonnegative"))?,
    };
    let key_of = |entity: &str| -> String {
        match by.as_str() {
            "actor" => format!("{entity}.actor"),
            "issue" => format!("{entity}.issue"),
            "kind" => format!(
                "COALESCE((SELECT kind FROM attests WHERE issue={entity}.issue LIMIT 1),'verify')"
            ),
            _ => format!(
                "(SELECT wave FROM costs WHERE issue={entity}.issue AND wave IS NOT NULL LIMIT 1)"
            ),
        }
    };
    let mut groups: HashMap<String, Value> = HashMap::new();
    let mut bump = |key: String, field: &str, v: Value| {
        let g = groups
            .entry(key.clone())
            .or_insert_with(|| json!({"key": key}));
        g[field] = v;
    };
    // labels: attests + proofs (pass/fail bound to revision+source)
    let att_key = key_of("attests");
    let mut st = c
        .prepare(&format!(
            "SELECT COALESCE({att_key},'(none)') k, COUNT(*), SUM(passed) \
             FROM attests WHERE ts>=? GROUP BY k"
        ))
        .map_err(ie)?;
    let rows = st
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    for (k, n, p) in rows {
        bump(k.clone(), "attests", json!(n));
        bump(k.clone(), "attest_passed", json!(p));
        bump(k, "attest_pass_rate", json!(p as f64 / n.max(1) as f64));
    }
    let pf_key = key_of("proofs");
    let mut st = c
        .prepare(&format!(
            "SELECT COALESCE({pf_key},'(none)') k, COUNT(*), SUM(passed) \
             FROM proofs WHERE ?=0 OR proof_id IN (SELECT json_extract(data_json,'$.proof_id') FROM events WHERE op='verify' AND ts>=?) GROUP BY k"
        ))
        .map_err(ie)?;
    let rows = st
        .query_map(params![since, since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    for (k, n, p) in rows {
        bump(k.clone(), "proofs", json!(n));
        bump(k.clone(), "proofs_passed", json!(p));
        bump(k, "proof_pass_rate", json!(p as f64 / n.max(1) as f64));
    }
    // cost: cents + tokens per group
    let cost_key = if by == "issue" {
        "issue".to_string()
    } else {
        key_of("costs")
    };
    let mut st = c
        .prepare(&format!(
            "SELECT COALESCE({cost_key},'(none)') k, COALESCE(SUM(cents),0), \
             COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COUNT(*) \
             FROM costs WHERE ts>=? GROUP BY k"
        ))
        .map_err(ie)?;
    let rows = st
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    for (k, cents, ti, to, entries) in rows {
        bump(k.clone(), "cents", json!(cents));
        bump(k.clone(), "tokens_in", json!(ti));
        bump(k.clone(), "tokens_out", json!(to));
        bump(k, "cost_entries", json!(entries));
    }
    // acceptance time: one row per issue, keyed by its first matching
    // membership — actor falls back to the latest prover since close clears
    // claim_actor; multi-wave/kind issues attribute to their first entity.
    let iss_key = match by.as_str() {
        "actor" => "COALESCE(claim_actor,(SELECT actor FROM proofs WHERE issue=issues.id ORDER BY rowid DESC LIMIT 1),'(none)')".to_string(),
        "issue" => "id".to_string(),
        "wave" => "COALESCE((SELECT wave FROM costs WHERE issue=issues.id AND wave IS NOT NULL LIMIT 1),'(none)')".to_string(),
        _ => "COALESCE((SELECT kind FROM attests WHERE issue=issues.id LIMIT 1),'(none)')".to_string(),
    };
    let mut st = c
        .prepare(&format!(
            "SELECT {iss_key} k, COUNT(*), SUM(status='closed'), \
             AVG(CASE WHEN status='closed' AND closed_at>created_at \
             THEN closed_at-created_at END) FROM issues WHERE created_at>=? GROUP BY k"
        ))
        .map_err(ie)?;
    let rows = st
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "(none)".into()),
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<f64>>(3)?,
            ))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    for (k, n, closed, accept) in rows {
        bump(k.clone(), "issues", json!(n));
        bump(k.clone(), "closed", json!(closed));
        bump(k, "accept_secs", json!(accept));
    }
    let mut out: Vec<Value> = groups.into_values().collect();
    out.sort_by(|x, y| {
        y["cents"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&x["cents"].as_i64().unwrap_or(0))
            .then_with(|| x["key"].as_str().cmp(&y["key"].as_str()))
    });
    Ok(json!({"group_by": by, "since": since, "groups": out,
        "proof_window": "verify event timestamps; unknown timestamps excluded for since > 0",
        "issue_window": "created_at cohort", "automatic_promotion": false}))
}

/// `sis sync_export`/`sync_import`: deterministic multi-machine sync bundle.
/// Issues carry deps embedded (snapshot format); memories merge LWW by
/// updated_at. Live claims are never overwritten — they report as conflicts.
fn op_sync_export(c: &Connection, a: &Value) -> R<Value> {
    let issues = q_issues(c, &format!("SELECT {COLS} FROM issues ORDER BY id"), vec![])?;
    let mut st = c
        .prepare("SELECT issue,depends_on,COALESCE(type,'blocks') FROM deps ORDER BY issue,depends_on")
        .map_err(ie)?;
    let mut dep_map: HashMap<String, Vec<Value>> = HashMap::new();
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    for (i, on, ty) in rows {
        dep_map
            .entry(i)
            .or_default()
            .push(json!({"on": on, "type": ty}));
    }
    let mut issues = issues;
    for i in &mut issues {
        if let Some(obj) = i.as_object_mut() {
            let id = obj["id"].as_str().unwrap_or("");
            if let Some(d) = dep_map.remove(id) {
                obj.insert("deps".into(), Value::Array(d));
            }
        }
    }
    let mut st = c
        .prepare("SELECT key,value,updated_at FROM memories ORDER BY key")
        .map_err(ie)?;
    let memories = st
        .query_map([], |r| {
            Ok(json!({"key":r.get::<_,String>(0)?,"value":r.get::<_,String>(1)?,
                "updated_at":r.get::<_,f64>(2)?}))
        })
        .map_err(ie)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ie)?;
    let pid: Option<String> = c
        .query_row("SELECT v FROM kv WHERE k='project_id'", [], |r| r.get(0))
        .optional()
        .map_err(ie)?;
    // proof receipts travel with the bundle: a PR verified on machine A must
    // close on machine B with the same receipt identity.
    let proofs = {
        let mut st = c
            .prepare("SELECT proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt FROM proofs ORDER BY proof_id")
            .map_err(ie)?;
        let rows = st
            .query_map([], |r| {
                Ok(json!({"proof_id":r.get::<_,String>(0)?,"issue":r.get::<_,Option<String>>(1)?,
                    "actor":r.get::<_,Option<String>>(2)?,"epoch":r.get::<_,i64>(3)?,
                    "revision":r.get::<_,Option<String>>(4)?,"source_hash":r.get::<_,Option<String>>(5)?,
                    "cwd":r.get::<_,Option<String>>(6)?,"oracle":r.get::<_,Option<String>>(7)?,
                    "exitcode":r.get::<_,Option<i32>>(8)?,"passed":r.get::<_,i64>(9)?,
                    "timed_out":r.get::<_,i64>(10)?,"output":r.get::<_,Option<String>>(11)?,
                    "review_receipt":r.get::<_,Option<String>>(12)?}))
            })
            .map_err(ie)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ie)?;
        rows
    };
    let attests = {
        let mut st = c
            .prepare("SELECT attest_id,issue,actor,epoch,revision,source_hash,cwd,kind,payload,summary,passed,ts FROM attests ORDER BY attest_id")
            .map_err(ie)?;
        let rows = st
            .query_map([], |r| {
                Ok(json!({"attest_id":r.get::<_,String>(0)?,"issue":r.get::<_,Option<String>>(1)?,
                    "actor":r.get::<_,Option<String>>(2)?,"epoch":r.get::<_,i64>(3)?,
                    "revision":r.get::<_,Option<String>>(4)?,"source_hash":r.get::<_,Option<String>>(5)?,
                    "cwd":r.get::<_,Option<String>>(6)?,"kind":r.get::<_,Option<String>>(7)?,
                    "payload":r.get::<_,Option<String>>(8)?,"summary":r.get::<_,Option<String>>(9)?,
                    "passed":r.get::<_,i64>(10)?,"ts":r.get::<_,Option<f64>>(11)?}))
            })
            .map_err(ie)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ie)?;
        rows
    };
    let events = if a["events"] == true {
        let mut st = c
            .prepare("SELECT seq,ts,op,issue,actor,run_id,idem,data_json FROM events ORDER BY seq")
            .map_err(ie)?;
        let rows = st
            .query_map([], |r| {
                Ok(json!({"seq":r.get::<_,i64>(0)?,"ts":r.get::<_,f64>(1)?,
                    "op":r.get::<_,Option<String>>(2)?,"issue":r.get::<_,Option<String>>(3)?,
                    "actor":r.get::<_,Option<String>>(4)?,"run_id":r.get::<_,Option<String>>(5)?,
                    "idem":r.get::<_,Option<String>>(6)?,
                    "data":r.get::<_,Option<String>>(7)?.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null)}))
            })
            .map_err(ie)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ie)?;
        rows
    } else {
        vec![]
    };
    Ok(json!({"k": "sis-sync", "v": 1, "schema": SCHEMA_VER,
        "project_id": pid, "exported_at": now(),
        "issues": issues, "memories": memories,
        "proofs": proofs, "attests": attests, "events": events}))
}
fn op_sync_import(c: &Connection, a: &Value) -> R<Value> {
    let bundle: Value = if let Some(p) = gs(a, "path") {
        serde_json::from_str(&fs::read_to_string(&p).map_err(ie)?).map_err(ie)?
    } else if let Some(j) = a.get("json") {
        j.clone()
    } else if let Some(s) = gs(a, "json") {
        serde_json::from_str(&s).map_err(ie)?
    } else {
        return Err(bad("path or json required"));
    };
    if bundle["k"].as_str() != Some("sis-sync") {
        return Err(bad("not a sis-sync bundle"));
    }
    if bundle["schema"].as_i64().unwrap_or(0) > SCHEMA_VER {
        return Err(bad("bundle schema newer than this store"));
    }
    let (mut applied, mut skipped, mut conflicts) = (0i64, 0i64, vec![]);
    for i in bundle["issues"].as_array().unwrap_or(&vec![]).iter() {
        let Some(iid) = i["id"].as_str() else {
            skipped += 1;
            continue;
        };
        if let Some((status, _, actor)) = issue_row(c, iid)? {
            let leased: Option<f64> = c
                .query_row(
                    "SELECT lease_until FROM issues WHERE id=?",
                    params![iid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(ie)?
                .flatten();
            if status != "closed" && leased.is_some_and(|u| u > now()) {
                conflicts.push(json!({"id": iid, "reason": "active_claim", "actor": actor}));
                continue;
            }
        }
        let s = |k: &str| i.get(k).and_then(|x| x.as_str());
        let f = |k: &str| i.get(k).and_then(|x| x.as_f64());
        c.execute(
            "INSERT OR REPLACE INTO issues(id,title,status,priority,type,owner,\
            oracle_cmd,allowed_paths,lane,budget_eur,acceptance,\"desc\",\
            lease_until,lease_epoch,claim_actor,created_at,closed_at,defer_until,\
            expires_at,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                iid,
                s("title").unwrap_or(""),
                s("status").unwrap_or("open"),
                f("priority").unwrap_or(2.0),
                s("type").unwrap_or("task"),
                s("owner"),
                s("oracle_cmd"),
                s("allowed_paths"),
                s("lane"),
                f("budget_eur"),
                s("acceptance"),
                s("desc"),
                f("lease_until"),
                f("lease_epoch").unwrap_or(0.0),
                s("claim_actor"),
                f("created_at"),
                f("closed_at"),
                f("defer_until"),
                f("expires_at"),
                i.get("meta").map(|m| m.to_string()),
            ],
        )
        .map_err(ie)?;
        c.execute("DELETE FROM deps WHERE issue=?", params![iid])
            .map_err(ie)?;
        for d in i["deps"].as_array().unwrap_or(&vec![]).iter() {
            if let Some(on) = d["on"].as_str().or_else(|| d["depends_on"].as_str()) {
                let t = d["type"].as_str().unwrap_or("blocks");
                c.execute(
                    "INSERT OR IGNORE INTO deps(issue,depends_on,type) VALUES(?,?,?)",
                    params![iid, on, t],
                )
                .map_err(ie)?;
            }
        }
        applied += 1;
    }
    let mut mem = 0i64;
    for m in bundle["memories"].as_array().unwrap_or(&vec![]).iter() {
        if let (Some(k), Some(v)) = (m["key"].as_str(), m["value"].as_str()) {
            mem += c.execute(
                "INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,\
                 updated_at=excluded.updated_at \
                 WHERE excluded.updated_at>memories.updated_at",
                params![k, v, f64::from(m["updated_at"].as_f64().unwrap_or_else(now))],
            )
            .map_err(ie)? as i64;
        }
    }
    // receipts merge by primary key — never overwrite (a receipt is an
    // append-only fact bound to actor+epoch+revision+source).
    let mut proofs = 0i64;
    for p in bundle["proofs"].as_array().unwrap_or(&vec![]).iter() {
        if p["proof_id"].as_str().is_none() {
            continue;
        }
        proofs += c
            .execute(
                "INSERT OR IGNORE INTO proofs(proof_id,issue,actor,epoch,revision,\
                source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt) \
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    p["proof_id"].as_str(),
                    p["issue"].as_str(),
                    p["actor"].as_str(),
                    p["epoch"].as_i64().unwrap_or(0),
                    p["revision"].as_str(),
                    p["source_hash"].as_str(),
                    p["cwd"].as_str(),
                    p["oracle"].as_str(),
                    p["exitcode"].as_i64(),
                    p["passed"].as_i64().unwrap_or(0),
                    p["timed_out"].as_i64().unwrap_or(0),
                    p["output"].as_str(),
                    p["review_receipt"].as_str().unwrap_or("null"),
                ],
            )
            .map_err(ie)? as i64;
    }
    let mut attests = 0i64;
    for t in bundle["attests"].as_array().unwrap_or(&vec![]).iter() {
        if t["attest_id"].as_str().is_none() {
            continue;
        }
        attests += c
            .execute(
                "INSERT OR IGNORE INTO attests(attest_id,issue,actor,epoch,revision,\
                source_hash,cwd,kind,payload,summary,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    t["attest_id"].as_str(),
                    t["issue"].as_str(),
                    t["actor"].as_str(),
                    t["epoch"].as_i64().unwrap_or(0),
                    t["revision"].as_str(),
                    t["source_hash"].as_str(),
                    t["cwd"].as_str(),
                    t["kind"].as_str(),
                    t["payload"].as_str().unwrap_or("null"),
                    t["summary"].as_str().unwrap_or("null"),
                    t["passed"].as_i64().unwrap_or(0),
                    t["ts"].as_f64().unwrap_or_else(now),
                ],
            )
            .map_err(ie)? as i64;
    }
    ev(
        c,
        "sync_import",
        None,
        a,
        &json!({"applied": applied, "skipped": skipped,
                "conflicts": conflicts.len(), "memories": mem,
                "proofs": proofs, "attests": attests,
                "remote_project": bundle["project_id"]}),
    )?;
    Ok(json!({"applied": applied, "skipped": skipped,
        "conflicts": conflicts, "memories": mem,
        "proofs": proofs, "attests": attests,
        "remote_project": bundle["project_id"]}))
}

/// `sis spans`: read back OTel-shaped span lines emitted under SIS_EMIT.
/// Emission is off by default; the file is append-only host evidence.
fn emit_path(dbp: &str) -> Option<PathBuf> {
    match env::var("SIS_EMIT").ok().as_deref() {
        None | Some("0") => Option::None,
        Some("") | Some("1") | Some("true") => {
            Some(Path::new(dbp).with_extension("otel.jsonl"))
        }
        Some(p) => Some(PathBuf::from(p)),
    }
}
fn emit_span(dbp: &str, cmd: &str, a: &Value, ok: bool, code: Option<&str>, started: f64) {
    let Some(path) = emit_path(dbp) else { return };
    let trace = run_id(a)
        .or_else(|| gs(a, "id"))
        .unwrap_or_else(|| "sis".into());
    let span = json!({"trace_id": trace, "span_id": gen_id(""),
        "name": cmd, "start": started, "end": now(),
        "duration_ms": ((now() - started) * 1000.0).round(),
        "status": if ok {"ok"} else {"error"},
        "error_code": code,
        "attributes": {"sis.cmd": cmd, "sis.issue": a.get("id"),
            "sis.actor": a.get("actor"), "sis.epoch": a.get("epoch")}});
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{span}");
    }
}
fn op_spans(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let _ = c;
    let Some(path) = emit_path(dbp) else {
        return Ok(json!({"enabled": false, "spans": []}));
    };
    let limit = a
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|n| (1..=500).contains(n))
        .unwrap_or(100) as usize;
    let text = fs::read_to_string(&path).unwrap_or_default();
    let spans: Vec<Value> = text
        .lines()
        .rev()
        .take(limit)
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    Ok(json!({"enabled": true, "path": path.to_string_lossy(),
        "spans": spans.into_iter().rev().collect::<Vec<_>>()}))
}
fn op_compact(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let days = gf(a, "days").unwrap_or(30.0);
    let cut = now() - days * 86400.0;
    let path = gs(a, "archive_path").unwrap_or_else(|| {
        let stem = Path::new(dbp)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("sis");
        format!("/tmp/sis-{stem}-events-{}.jsonl", now() as i64)
    });
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,issue,actor,run_id,idem,data_json \
                            FROM events WHERE ts<? ORDER BY seq",
        )
        .map_err(ie)?;
    let rows: Vec<String> = st
        .query_map(params![cut], |r| {
            Ok(json!({"seq": r.get::<_,i64>(0)?, "ts": r.get::<_,f64>(1)?,
            "op": r.get::<_,Option<String>>(2)?, "issue": r.get::<_,Option<String>>(3)?,
            "actor": r.get::<_,Option<String>>(4)?, "run_id": r.get::<_,Option<String>>(5)?,
            "idem": r.get::<_,Option<String>>(6)?,
            "data_json": r.get::<_,Option<String>>(7)?})
            .to_string())
        })
        .map_err(ie)?
        .collect::<Result<_, _>>()
        .map_err(ie)?;
    let archived = rows.len() as i64;
    if archived > 0 {
        fs::write(&path, rows.join("\n") + "\n").map_err(ie)?;
        c.execute("DELETE FROM events WHERE ts<?", params![cut])
            .map_err(ie)?;
    }
    // wisp reap: expired issues get deleted (events stay — provenance).
    let t = now();
    let expired: i64 = c
        .execute(
            "DELETE FROM issues WHERE expires_at IS NOT NULL AND expires_at<=?",
            params![t],
        )
        .map_err(ie)? as i64;
    let kept: i64 = c
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .map_err(ie)?;
    Ok(
        json!({"archived": archived, "kept": kept, "reaped": expired,
              "archive_path": path}),
    )
}
fn op_batch(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let ops = a
        .get("ops")
        .and_then(|v| v.as_array())
        .ok_or_else(|| bad("ops[] required"))?;
    let mut out = vec![];
    for (i, op) in ops.iter().enumerate() {
        let cmd = op
            .get("cmd")
            .and_then(|v| v.as_str())
            .ok_or_else(|| bad("batch child cmd required"))?;
        if matches!(cmd, "verify" | "batch") {
            return Err(bad("verify and nested batch are not allowed in batch"));
        }
        let args = op.get("args").cloned().unwrap_or(json!({}));
        if cmd == "attest" && args["kind"] == "run" {
            return Err(bad("run attest is not allowed in batch"));
        }
        match run_op(c, cmd, &args, dbp) {
            Ok(v) => out.push(v),
            Err((code, msg)) => return Err((code, format!("batch[{i}] {cmd}: {msg}"))),
        }
    }
    Ok(json!({"results": out}))
}

// ---------- dispatch ----------
fn run_op(c: &Connection, cmd: &str, a: &Value, dbp: &str) -> R<Value> {
    agent::authorize(cmd, a)?;
    if cmd == "verify" {
        return agent::verify_request(c, a, dbp);
    }
    if cmd == "attest" && a["kind"] == "run" {
        return agent::attest_run_request(c, a, dbp);
    }
    let idemable = cmd != "verify"
        && (WRITES.contains(&cmd)
            || matches!(
                cmd,
                "acquire" | "checkpoint" | "cancel" | "cancel_ack" | "admin_update"
            ));
    if idemable {
        if let Some(v) = agent::idem_hit(c, cmd, a)? {
            return Ok(v);
        }
    }
    agent::guard(c, cmd, a)?;
    let v = if let Some(result) = agent::dispatch(c, cmd, a, dbp) {
        result?
    } else {
        match cmd {
            "create" | "q" => op_create(c, a),
            "dep" => op_dep(c, a),
            "dep_list" | "dep-list" => op_dep_list(c, a),
            "dep_remove" | "dep-remove" => op_dep_remove(c, a),
            "ready" => op_ready(c, a),
            "list" | "query" => op_list(c, a),
            "count" => op_count(c, a),
            "update" => op_update(c, a),
            "note" | "comment" => op_note(c, a),
            "comments" => op_comments(c, a),
            "changes" => op_changes(c, a),
            "history" => op_history(c, a),
            "unclaim" => op_unclaim(c, a),
            "reclaim" => op_reclaim(c, a),
            "watch" => op_watch(c, a),
            "defer" => op_defer(c, a),
            "undefer" => op_undefer(c, a),
            "children" => op_children(c, a),
            "label" | "tag" => op_label(c, a),
            "rename" => op_rename(c, a),
            "delete" => op_delete(c, a),
            "lint" => op_lint(c, a),
            "types" => op_types(c, a),
            "statuses" => op_statuses(c, a),
            "prime" => op_prime(c, a),
            "gate" => op_gate(c, a),
            "gate_list" | "gate-list" => op_gate_list(c, a),
            "slot_acquire" | "slot-acquire" | "merge_slot" | "merge-slot" => op_slot_acquire(c, a),
            "slot_release" | "slot-release" => op_slot_release(c, a),
            "slot_list" | "slot-list" => op_slot_list(c, a),
            "epic" => op_epic(c, a),
            "dup_scan" | "dup-scan" | "find_duplicates" | "find-duplicates" => op_dup_scan(c, a),
            "goal" | "goal_create" | "goal-create" => op_goal(c, a),
            "sub" | "subgoal" => op_sub(c, a),
            "plan" => op_plan(c, a),
            "goal_tree" | "goal-tree" | "tree" => op_goal_tree(c, a),
            "next" => op_next(c, a),
            "review" => op_review(c, a),
            "goal_done" | "goal-done" => op_goal_done(c, a),
            "claim" => op_claim(c, a),
            "claim_next" | "claim-next" => op_claim_next(c, a),
            "heartbeat" => op_heartbeat(c, a),
            "close" => op_close(c, a),
            "reopen" => op_reopen(c, a),
            "show" => op_show(c, a),
            "search" => op_search(c, a),
            "stale" => op_stale(c, a),
            "orphans" => op_orphans(c, a),
            "stats" => op_stats(c, a),
            "remember" => op_remember(c, a),
            "recall" => op_recall(c, a),
            "export" => op_export(c, a),
            "import" => op_import(c, a),
            "snapshot" => snapshot_store(c, dbp),
            "batch" => op_batch(c, a, dbp),
            "budget_claim" | "budget-claim" => op_budget_claim(c, a),
            "contract" => op_contract(c, a),
            "outbox_list" | "outbox-list" => op_outbox_list(c, a),
            "outbox_done" | "outbox-done" => op_outbox_state(c, a, "done"),
            "outbox_fail" | "outbox-fail" => op_outbox_state(c, a, "failed"),
            "outbox_export" | "outbox-export" => op_outbox_export(c, a),
            "cost_add" | "cost-add" => op_cost_add(c, a),
            "cost_list" | "cost-list" => op_cost_list(c, a),
            "cost_rollup" | "cost-rollup" => op_cost_rollup(c, a),
            "sync_export" | "sync-export" => op_sync_export(c, a),
            "sync_import" | "sync-import" => op_sync_import(c, a),
            "learn" => op_learn(c, a),
            "spans" => op_spans(c, a, dbp),
            "compact" => op_compact(c, a, dbp),
            _ => Err(("bad_cmd".into(), format!("unknown cmd {cmd}"))),
        }?
    };
    if v.to_string().len() > 8 * 1024 * 1024 {
        return Err(("output_too_large".into(), "response exceeds 8 MiB".into()));
    }
    if idemable {
        agent::idem_put(c, cmd, a, &v)?;
    }
    Ok(v)
}
fn env_ok(v: Value) -> Value {
    json!({"ok": true, "data": v})
}
fn env_err(code: &str, msg: &str) -> Value {
    json!({"ok": false, "error": {"code": code, "msg": msg}})
}
fn handle(c: &mut Connection, dbp: &str, req: &Value) -> Value {
    let cmd = req
        .get("cmd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut a = req.get("args").cloned().unwrap_or_else(|| json!({}));
    if a.is_object() {
        for k in ["run_id", "idem", "actor"] {
            if a.get(&k).is_none() {
                if let Some(v) = req.get(&k) {
                    a[&k] = v.clone();
                }
            }
        }
    }
    let writes = !(cmd == "attest" && a["kind"] == "run") && (WRITES.contains(&cmd.as_str())
        || matches!(
            cmd.as_str(),
            "acquire"
                | "checkpoint"
                | "cancel"
                | "cancel_ack"
                | "cancel-ack"
                | "admin_update"
                | "admin-update"
        ));
    if writes {
        if let Err(e) = c.execute_batch("BEGIN IMMEDIATE") {
            return env_err("internal", &e.to_string());
        }
    }
    let t0 = now();
    let res = catch_unwind(AssertUnwindSafe(|| run_op(c, &cmd, &a, dbp)))
        .unwrap_or_else(|_| Err(("internal".into(), "panic".into())));
    {
        let (ok, code) = match &res {
            Ok(_) => (true, None),
            Err((code, _)) => (false, Some(code.as_str())),
        };
        emit_span(dbp, &cmd, &a, ok, code, t0);
    }
    match res {
        Ok(v) => {
            if writes {
                if let Err(e) = c.execute_batch("COMMIT") {
                    let _ = c.execute_batch("ROLLBACK");
                    return env_err("internal", &e.to_string());
                }
                agent::notify();
                // Git-versioned mirror: refresh after every committed write
                // tx (one per batch). Best-effort — a mirror failure must not
                // roll back committed work, but it is never silent.
                if !SNAP_SKIP.contains(&cmd.as_str())
                    && env::var("SIS_SNAPSHOT").ok().as_deref() != Some("0")
                {
                    if let Err((_, m)) = snapshot_store(c, dbp) {
                        eprintln!("{}", env_err("snapshot", &m));
                    }
                }
            }
            env_ok(v)
        }
        Err((code, msg)) => {
            if writes {
                let _ = c.execute_batch("ROLLBACK");
            }
            env_err(&code, &msg)
        }
    }
}

// ---------- serve ----------
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
extern "C" fn on_sig(_: i32) {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

fn handle_conn(mut s: UnixStream, dbp: String) {
    let _client = agent::ClientGuard;
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let mut c = match connect(&dbp) {
        Ok(c) => c,
        Err(_) => return,
    };
    let Ok(cl) = s.try_clone() else { return };
    let mut rd = BufReader::new(cl);
    loop {
        let mut frame = vec![];
        let n = std::io::BufRead::read_until(
            &mut std::io::Read::take(&mut rd, 1048577),
            b'\n',
            &mut frame,
        );
        match n {
            Ok(0) | Err(_) => break,
            Ok(n) if n > 1048576 => {
                let _ = writeln!(
                    s,
                    "{}",
                    env_err("frame_too_large", "request frame exceeds 1 MiB")
                );
                break;
            }
            _ => {}
        }
        let line = match String::from_utf8(frame) {
            Ok(s) => s,
            Err(_) => {
                let _ = writeln!(s, "{}", env_err("bad_args", "frame must be UTF-8"));
                break;
            }
        };
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let req: Value = serde_json::from_str(t).unwrap_or_else(|_| json!({"cmd": "__parse__"}));
        let env = handle(&mut c, &dbp, &req);
        if s.write_all(env.to_string().as_bytes()).is_err() || s.write_all(b"\n").is_err() {
            break;
        }
        // follow: watch subscription — poll new seqs, push each batch as its
        // own NDJSON line. wait>0 = long-poll (one batch then done);
        // follow=true = stream until the client disconnects.
        let cmd = req.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
        let follow = req
            .get("args")
            .and_then(|a| a.get("follow"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let wait_s = req
            .get("args")
            .and_then(|a| a.get("wait"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if cmd == "watch" && (follow || wait_s > 0.0) && env.get("ok") == Some(&Value::Bool(true)) {
            let mut last = env
                .pointer("/data/events")
                .and_then(|v| v.as_array())
                .and_then(|e| e.last())
                .and_then(|e| e.get("seq"))
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| {
                    req.get("args")
                        .and_then(|a| a.get("after"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                });
            let t0 = now();
            loop {
                if SHUTDOWN.load(Ordering::SeqCst) {
                    return;
                }
                let serial = agent::serial();
                agent::wait(serial, Duration::from_millis(1000));
                let w = handle(
                    &mut c,
                    &dbp,
                    &json!(
                    {"cmd": "watch", "args": {"after": last, "limit": 500}}),
                );
                let evs = w
                    .pointer("/data/events")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                if !evs.is_empty() {
                    last = evs
                        .last()
                        .and_then(|e| e.get("seq"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(last);
                    if s.write_all(w.to_string().as_bytes()).is_err() || s.write_all(b"\n").is_err()
                    {
                        return;
                    }
                    if wait_s > 0.0 {
                        break;
                    }
                } else if now() - t0
                    > if wait_s > 0.0 {
                        wait_s.min(300.0)
                    } else {
                        300.0
                    }
                {
                    let _ = s.write_all(b"{\"ok\":true,\"data\":{\"events\":[]}}\n");
                    break;
                }
            }
        }
    }
}
fn serve(dbp: &str) -> i32 {
    let sock = agent::socket(dbp);
    let pidf = format!("{sock}.pid");
    let lockf = format!("{sock}.lock");
    let lf = match fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lockf)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("{}", env_err("internal", &e.to_string()));
            return 2;
        }
    };
    unsafe {
        if libc::flock(lf.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 {
            eprintln!("{}", env_err("bound", "another serve holds the lock"));
            return 3;
        }
    }
    if Path::new(&sock).exists() {
        match UnixStream::connect(&sock) {
            Ok(_) => {
                eprintln!("{}", env_err("bound", "live sis on socket"));
                return 3;
            }
            Err(_) => {
                let _ = fs::remove_file(&sock);
            } // stale file → unlink
        }
    }
    if let Err(e) = connect(dbp) {
        eprintln!("{}", env_err("internal", &e.to_string()));
        return 2;
    }
    let lst = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("{}", env_err("bound", "socket in use"));
            return 3;
        }
        Err(e) => {
            eprintln!("{}", env_err("internal", &e.to_string()));
            return 2;
        }
    };
    use std::os::unix::fs::PermissionsExt;
    if fs::set_permissions(&sock, fs::Permissions::from_mode(0o600)).is_err() {
        return 2;
    }
    let _ = lst.set_nonblocking(true);
    if fs::write(&pidf, std::process::id().to_string()).is_err() {
        return 2;
    }
    // --http PORT: same ops over loopback HTTP (POST / {cmd,args};
    // GET /board, /events?after=N, /health). Hosts without unix-socket
    // support get the identical contract.
    if let Ok(port) = env::var("SIS_HTTP") {
        let d = dbp.to_string();
        std::thread::spawn(move || serve_http(&d, &port));
    }
    unsafe {
        libc::signal(libc::SIGTERM, on_sig as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_sig as *const () as libc::sighandler_t);
    }
    eprintln!("sis serve sock={sock} db={dbp} pid={}", std::process::id());
    while !SHUTDOWN.load(Ordering::SeqCst) {
        match agent::listener_ready(lst.as_raw_fd()) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                eprintln!("sis listener: {error}");
                break;
            }
        }
        match lst.accept() {
            Ok((s, _)) => {
                if !agent::admit() {
                    drop(s);
                    continue;
                }
                let d = dbp.to_string();
                std::thread::spawn(move || handle_conn(s, d));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => {
                eprintln!("sis accept: {error}");
                break;
            }
        }
    }
    agent::notify();
    let _ = fs::remove_file(&sock);
    let _ = fs::remove_file(&pidf);
    let _ = fs::remove_file(&lockf);
    0
}

// ---------- mcp (stdio JSON-RPC, tools prefixed sis_) ----------
const MCP_TOOLS: &[&str] = &[
    "create",
    "dep",
    "dep_list",
    "dep_remove",
    "ready",
    "list",
    "query",
    "count",
    "update",
    "note",
    "comments",
    "changes",
    "history",
    "claim",
    "claim_next",
    "unclaim",
    "reclaim",
    "heartbeat",
    "handoff",
    "close",
    "reopen",
    "delete",
    "defer",
    "undefer",
    "show",
    "search",
    "children",
    "label",
    "rename",
    "lint",
    "types",
    "statuses",
    "prime",
    "watch",
    "stale",
    "orphans",
    "stats",
    "remember",
    "recall",
    "export",
    "import",
    "batch",
    "budget_claim",
    "contract",
    "outbox_list",
    "outbox_done",
    "outbox_fail",
    "outbox_export",
    "attest",
    "cost_add",
    "cost_list",
    "cost_rollup",
    "learn",
    "sync_export",
    "sync_import",
    "spans",
    "compact",
    "gate",
    "gate_list",
    "epic",
    "dup_scan",
    "q",
    "goal",
    "sub",
    "plan",
    "goal_tree",
    "tree",
    "next",
    "review",
    "goal_done",
    "goal_create",
    "subgoal",
];
fn mcp(dbp: &str) -> i32 {
    let mut c = match connect(dbp) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", env_err("internal", &e.to_string()));
            return 2;
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut input = stdin.lock();
    loop {
        let mut frame = vec![];
        match std::io::BufRead::read_until(
            &mut std::io::Read::take(&mut input, 1048577),
            b'\n',
            &mut frame,
        ) {
            Ok(0) | Err(_) => break,
            Ok(n) if n > 1048576 => break,
            _ => {}
        }
        let Ok(l) = String::from_utf8(frame) else {
            break;
        };
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(t) else {
            continue;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
        if method.starts_with("notifications/") {
            continue;
        }
        if method == "tools/call" {
            let name = req.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            if !agent::mcp_registry().iter().any(|op| format!("sis_{}", op["name"].as_str().unwrap_or("")) == name) {
                let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unknown or unavailable tool"}}));
                continue;
            }
        }
        let result = match method {
            "initialize" => json!({"protocolVersion":"2024-11-05",
                "capabilities":{"tools":{}},
                "serverInfo":{"name":"superiss","version":"0.9.0"}}),
            "ping" => json!({}),
            "tools/list" => {
                json!({"tools": agent::mcp_registry().iter().map(|t| json!({
                "name": format!("sis_{}",t["name"].as_str().unwrap_or("")), "description":t["description"],
                "inputSchema": t["inputSchema"]})).collect::<Vec<_>>()})
            }
            "tools/call" => {
                let p = req.get("params").cloned().unwrap_or(json!({}));
                let name = p
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .strip_prefix("sis_")
                    .unwrap_or("")
                    .to_string();
                let args = p.get("arguments").cloned().unwrap_or(json!({}));
                let env = handle(&mut c, dbp, &json!({"cmd": name, "args": args}));
                json!({"content":[{"type":"text","text": env.to_string()}],
                       "isError": env.get("ok") == Some(&Value::Bool(false))})
            }
            _ => {
                if id.is_null() {
                    continue;
                }
                let _ = writeln!(
                    out,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,
                       "error":{"code":-32601,"message":"method not found"}})
                );
                continue;
            }
        };
        if id.is_null() {
            continue;
        }
        let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
    }
    0
}

// ---------- cli ----------
/// Run git in `repo`, returning stdout on success.
fn git_out(repo: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// Fill `files`/`base`/`head`/`repo` on a `changes` call from the real git
/// worktree: tracked edits via `git diff --numstat` + `git diff -U0` hunk
/// headers (new-file line ranges, GitHub-style), untracked files via porcelain.
/// No code lines are stored — only paths, counts and `[[start,end]]` ranges.
fn changes_from_git(a: &mut Value) -> Result<(), (String, String)> {
    let repo = a
        .get("repo")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if git_out(&repo, &["rev-parse", "--git-dir"]).is_none() {
        return Err((
            "not_a_git_repo".into(),
            format!(
                "{} is not a git worktree; pass --files '[{{..}}]' explicitly",
                repo.display()
            ),
        ));
    }
    let head = git_out(&repo, &["rev-parse", "--verify", "HEAD"])
        .map(|s| s.trim().to_string());
    let branch = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string());
    let head_subject = git_out(&repo, &["log", "-1", "--format=%s"])
        .map(|s| s.trim().to_string());
    let base = a
        .get("base")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "HEAD".into());
    let has_base = git_out(&repo, &["rev-parse", "--verify", &base]).is_some();

    let mut files: Vec<Value> = vec![];
    if has_base {
        // numstat: adds\tdels\tpath — binary files print "-".
        let numstat = git_out(&repo, &["diff", "--numstat", "-M", &base, "--"]).unwrap_or_default();
        let mut stat: HashMap<String, (Option<i64>, Option<i64>, Option<String>)> = HashMap::new();
        let mut order: Vec<String> = vec![];
        for l in numstat.lines() {
            let mut p = l.splitn(3, '\t');
            let (ad, de, path) = (p.next(), p.next(), p.next().unwrap_or(""));
            let (renamed_from, path) = match path.split_once(" => ") {
                Some((o, n)) => (Some(o.trim_matches(['{', '}']).to_string()), n.trim_matches('}').trim().to_string()),
                None => (None, path.trim().to_string()),
            };
            if path.is_empty() {
                continue;
            }
            stat.entry(path.clone()).or_insert_with(|| {
                order.push(path.clone());
                (
                    ad.and_then(|v| v.parse::<i64>().ok()),
                    de.and_then(|v| v.parse::<i64>().ok()),
                    renamed_from,
                )
            });
        }
        // -U0 hunk headers give exact edited ranges without emitting code.
        let unified = git_out(&repo, &["diff", "-U0", "--no-color", "-M", &base, "--"]).unwrap_or_default();
        let mut hunks: HashMap<String, Vec<Value>> = HashMap::new();
        let mut cur = String::new();
        let mut old = String::new();
        for l in unified.lines() {
            if let Some(p) = l.strip_prefix("--- a/") {
                old = p.to_string();
            } else if let Some(p) = l.strip_prefix("+++ b/") {
                cur = p.to_string();
            } else if l.starts_with("+++ /dev/null") {
                // deleted file: hunks belong to the a/-side name
                cur = old.clone();
            } else if l.starts_with("@@ ") && !cur.is_empty() {
                // @@ -old_start[,old_len] +new_start[,new_len] @@
                let (oldp, newp) = (
                    l.split('-').nth(1).and_then(|s| s.split_whitespace().next()),
                    l.split('+').nth(1).and_then(|s| s.split_whitespace().next()),
                );
                if let (Some(op), Some(np)) = (oldp, newp) {
                    let (ns, nl) = (
                        np.trim_end_matches(" @@").split(',').next().and_then(|v| v.parse::<i64>().ok()),
                        np.trim_end_matches(" @@").split(',').nth(1).and_then(|v| v.parse::<i64>().ok()).unwrap_or(1),
                    );
                    let (os, ol) = (
                        op.trim_end_matches(" @@").split(',').next().and_then(|v| v.parse::<i64>().ok()),
                        op.trim_end_matches(" @@").split(',').nth(1).and_then(|v| v.parse::<i64>().ok()).unwrap_or(1),
                    );
                    // new-side range; for pure deletions record the removed old range
                    let (s, end) = match (ns, nl) {
                        (Some(s), 0) => (os.unwrap_or(s), os.unwrap_or(s) + ol - 1),
                        (Some(s), n) => (s, s + n - 1),
                        _ => continue,
                    };
                    hunks.entry(cur.clone())
                        .or_default()
                        .push(json!([s, end]));
                }
            }
        }
        for path in order {
            let (ad, de, ren) = stat.get(&path).cloned().unwrap_or((None, None, None));
            let exists = repo.join(&path).exists();
            let status = if ren.is_some() { "R" } else if exists { "M" } else { "D" };
            let mut f = json!({
                "path": path, "adds": ad, "dels": de, "status": status,
                "hunks": hunks.get(&path).cloned().unwrap_or_default(),
            });
            if ad.is_none() && de.is_none() {
                f["binary"] = json!(true);
            }
            if let Some(o) = ren {
                f["renamed_from"] = json!(o);
            }
            files.push(f);
        }
        // --patch: bounded snapshot of the actual unified diff so the evidence
        // survives worktree rewrites; display stays compact either way.
        if a.get("patch").is_some() {
            const CAP: usize = 65536;
            let raw = git_out(&repo, &["diff", "--no-color", "-M", &base, "--"]).unwrap_or_default();
            let (p, truncated) = if raw.len() > CAP {
                (raw[..CAP].to_string(), true)
            } else {
                (raw, false)
            };
            let m = a.as_object_mut().unwrap();
            m.insert("patch".into(), json!(p));
            if truncated {
                m.insert("patch_truncated".into(), json!(true));
            }
        }
    }
    // Untracked files: adds = line count, whole file as one range.
    if let Some(porcelain) = git_out(&repo, &["status", "--porcelain"]) {
        for l in porcelain.lines() {
            if let Some(path) = l.strip_prefix("?? ") {
                // porcelain reports fully untracked dirs as "?? dir/" — they
                // carry no line evidence; reading one would spin on EISDIR
                let path = path.trim().trim_end_matches('/');
                if !repo.join(path).is_file() {
                    continue;
                }
                let n = fs::File::open(repo.join(path))
                    .ok()
                    .map(|f| BufReader::new(f).lines().count() as i64)
                    .unwrap_or(0);
                files.push(json!({
                    "path": path, "adds": n, "dels": 0, "status": "A",
                    "hunks": if n > 0 { vec![json!([1, n])] } else { vec![] },
                }));
            }
        }
    }
    // the store's own snapshot mirror (<db-stem>.issues.jsonl) is rewritten
    // after every mutation — it would noise up every recorded diff
    if let Some(mirror) = a.get("mirror").and_then(|v| v.as_str()) {
        let suffix = format!("/{mirror}");
        files.retain(|f| {
            let p = f["path"].as_str().unwrap_or("");
            p != mirror && !p.ends_with(&suffix)
        });
    }
    let has_repo = a.get("repo").is_some();
    let m = a.as_object_mut().unwrap();
    m.insert("files".into(), json!(files));
    m.insert("base".into(), json!(base));
    m.insert("head".into(), head.map(Value::String).unwrap_or(Value::Null));
    m.insert(
        "head_subject".into(),
        head_subject.map(Value::String).unwrap_or(Value::Null),
    );
    m.insert("branch".into(), branch.map(Value::String).unwrap_or(Value::Null));
    if !has_repo {
        m.insert("repo".into(), json!(repo.display().to_string()));
    }
    Ok(())
}

fn usage() -> ! {
    eprintln!(
        "sis <cmd> [json-args|@file|k=v ...] [--db PATH] [--json]\n\
               cmds: {} snapshot serve mcp",
        MCP_TOOLS.join(" ")
    );
    std::process::exit(1)
}
fn cli_args(cmd: &str, rest: &[String]) -> Value {
    if rest.is_empty() {
        return json!({});
    }
    if rest.len() == 1 {
        let s = &rest[0];
        if s.starts_with('@') {
            if let Ok(t) = fs::read_to_string(&s[1..]) {
                if let Ok(v) = serde_json::from_str(&t) {
                    return v;
                }
            }
        }
        if s.starts_with('{') || s.starts_with('[') {
            if let Ok(v) = serde_json::from_str(s) {
                return v;
            }
        }
    }
    // positional shortcuts
    let keys: &[&str] = match cmd {
        "acquire" => &["actor"],
        "brief" | "resume" => &["id"],
        "tokens" => &["text"],
        "verify" => &["id", "actor", "epoch", "cwd"],
        "checkpoint" | "handoff" => &["id", "actor", "epoch", "text", "next_step"],
        "cancel" | "cancel_ack" | "cancel-ack" => &["id", "actor", "epoch"],
        "unclaim" => &["id", "actor", "epoch"],
        "show" | "contract" | "reopen" | "undefer" | "delete" | "children" | "comments"
        | "history" => &["id", "actor"],
        "claim" | "heartbeat" | "close" => &["id", "actor", "epoch"],
        "claim_next" | "claim-next" => &["actor"],
        "dep" | "dep_remove" | "dep-remove" => &["issue", "depends_on"],
        "rename" => &["from", "to"],
        "gate" => &["name", "state"],
        "slot_acquire" | "slot-acquire" | "merge_slot" | "merge-slot" => &["name", "actor"],
        "slot_release" | "slot-release" => &["name", "actor", "epoch"],
        "epic" => &["id"],
        "dup_scan" | "dup-scan" | "find_duplicates" | "find-duplicates" => &["id"],
        "q" => &["title"],
        "goal" | "goal_create" | "goal-create" => &["name", "objective"],
        "sub" | "subgoal" => &["parent", "title"],
        "plan" => &["name"],
        "goal_tree" | "goal-tree" | "tree" => &["id"],
        "next" => &["goal"],
        "goal_done" | "goal-done" => &["id"],
        "review" => &[],
        "note" | "comment" => &["id", "text"],
        "changes" => &["id"],
        "defer" => &["id", "until"],
        "label" | "tag" => &["id", "add"],
        "create" => &["title"],
        "recall" => &["key"],
        "search" => &["q"],
        "import" | "sync_import" | "sync-import" => &["path"],
        "attest" => &["id", "actor", "epoch", "kind", "path"],
        "cost_add" | "cost-add" => &["issue"],
        "cost_rollup" | "cost-rollup" => &["id"],
        "learn" => &["group_by", "since"],
        "outbox_export" | "outbox-export" => &["format"],
        "remember" => &["key", "value"],
        "budget_claim" | "budget-claim" => &["issue", "eur"],
        "outbox_done" | "outbox-done" | "outbox_fail" | "outbox-fail" => &["id", "err"],
        "ready" => &["lane"],
        _ => &["id"],
    };
    // Mixed form allowed: `dep a b type=gate` — k=v tokens land in the map,
    // remaining positionals fill the cmd's key list in order. `--key value`,
    // `--key=value` and bare `--key` (=true) work like normal CLI flags;
    // `--` ends flag parsing so positionals may start with dashes.
    let mut m = Map::new();
    let mut pos: Vec<&String> = vec![];
    let mut i = 0;
    let mut no_flags = false;
    while i < rest.len() {
        let s = &rest[i];
        if !no_flags && s == "--" {
            no_flags = true;
        } else if !no_flags && s.starts_with("--") {
            let kv = &s[2..];
            let key = kv.split('=').next().unwrap_or("").replace('-', "_");
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                if let Some((_, v)) = kv.split_once('=') {
                    m.insert(key, serde_json::from_str(v).unwrap_or(json!(v)));
                } else if i + 1 < rest.len() && !rest[i + 1].starts_with("--") {
                    i += 1;
                    m.insert(key, serde_json::from_str(&rest[i]).unwrap_or(json!(rest[i].clone())));
                } else {
                    m.insert(key, json!(true));
                }
            } else {
                pos.push(s);
            }
        } else {
            match s.split_once('=') {
                Some((k, v))
                    if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
                {
                    m.insert(k.into(), serde_json::from_str(v).unwrap_or(json!(v)));
                }
                _ => pos.push(s),
            }
        }
        i += 1;
    }
    for (i, s) in pos.iter().enumerate() {
        if i >= keys.len() {
            break;
        }
        if !m.contains_key(keys[i]) {
            m.insert(keys[i].into(), serde_json::from_str(s).unwrap_or(json!(*s)));
        }
    }
    Value::Object(m)
}
const BOARD_HTML: &str = include_str!("web/board.html");

/// Loopback HTTP API — same dispatch as the unix socket.
fn serve_http(dbp: &str, port: &str) {
    use std::net::TcpListener;
    let lst = match TcpListener::bind(format!("127.0.0.1:{port}")) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("sis http bind failed: {e}");
            return;
        }
    };
    let _ = lst.set_nonblocking(true);
    eprintln!("sis http on http://127.0.0.1:{port}");
    while !SHUTDOWN.load(Ordering::SeqCst) {
        match agent::listener_ready(lst.as_raw_fd()) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                eprintln!("sis HTTP listener: {error}");
                break;
            }
        }
        let mut st = match lst.accept() {
            Ok((st, _)) => st,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(error) => {
                eprintln!("sis HTTP accept: {error}");
                break;
            }
        };
        if !agent::admit() {
            drop(st);
            continue;
        }
        let d = dbp.to_string();
        std::thread::spawn(move || {
            let _client = agent::ClientGuard;
            let _ = st.set_nonblocking(false);
            let req = match agent::http_request(&st) {
                Ok(r) => r,
                Err(_) => return,
            };
            let (head, body) = req.split_once("\r\n\r\n").unwrap_or((req.as_str(), ""));
            let line = head.lines().next().unwrap_or("");
            let (method, pathq) = {
                let mut p = line.split_whitespace();
                (p.next().unwrap_or(""), p.next().unwrap_or("/"))
            };
            let (path, query) = pathq.split_once('?').unwrap_or((pathq, ""));
            let send = |st: &mut std::net::TcpStream, code: &str, v: Value| {
                let b = v.to_string();
                let _ = write!(st, "HTTP/1.1 {code}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{b}", b.len());
            };
            let mut c = match connect(&d) {
                Ok(c) => c,
                Err(e) => {
                    send(
                        &mut st,
                        "500 Internal Server Error",
                        env_err("internal", &e.to_string()),
                    );
                    return;
                }
            };
            let call = |c: &mut Connection, cmd: &str, args: Value| {
                handle(c, &d, &json!({"cmd": cmd, "args": args}))
            };
            let out = match (method, path) {
                ("GET", "/health") => env_ok(json!({"ok": true})),
                ("GET", "/board") => {
                    let stats = call(&mut c, "stats", json!({}));
                    let issues = call(&mut c, "list", json!({"limit":1000}));
                    let i = issues.get("data").cloned().unwrap_or(json!([]));
                    env_ok(json!({"stats": stats.get("data").cloned()
                        .unwrap_or(Value::Null), "issues": i}))
                }
                ("GET", "/events") => {
                    let after = query
                        .split('&')
                        .find_map(|kv| kv.strip_prefix("after="))
                        .and_then(|v| v.parse::<i64>().ok())
                        .unwrap_or(0);
                    let wait = query
                        .split('&')
                        .find_map(|kv| kv.strip_prefix("wait="))
                        .and_then(|v| v.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    // long-poll: hold the request until events appear or wait s
                    let mut out = call(&mut c, "watch", json!({"after": after, "limit": 1000}));
                    let t0 = now();
                    while wait > 0.0
                        && now() - t0 < wait.min(300.0)
                        && !SHUTDOWN.load(Ordering::SeqCst)
                    {
                        let empty = out
                            .pointer("/data/events")
                            .and_then(|v| v.as_array())
                            .map(|e| e.is_empty())
                            .unwrap_or(false);
                        if !empty {
                            break;
                        }
                        let serial = agent::serial();
                        agent::wait(serial, Duration::from_secs(1));
                        out = call(&mut c, "watch", json!({"after": after, "limit": 1000}));
                    }
                    out
                }
                ("GET", "/") | ("GET", "/board.html") => {
                    let b = BOARD_HTML;
                    let _ = write!(st, "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\r\n{b}", b.len());
                    return;
                }
                ("POST", _) | ("GET", "/op") => {
                    let src = if method == "POST" {
                        body.to_owned()
                    } else {
                        agent::decode_query(
                            query
                                .split('&')
                                .find_map(|kv| kv.strip_prefix("q="))
                                .unwrap_or("{}"),
                        )
                        .unwrap_or_default()
                    };
                    let req: Value = serde_json::from_str(&src)
                        .unwrap_or_else(|_| json!({"cmd": src.trim_matches('"')}));
                    let cmd = req
                        .get("cmd")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = req.get("args").cloned().unwrap_or(json!({}));
                    call(&mut c, &cmd, args)
                }
                _ => env_err(
                    "bad_cmd",
                    "GET /health /board /events?after=N · POST / {\"cmd\",\"args\"}",
                ),
            };
            send(
                &mut st,
                if out.get("ok") == Some(&Value::Bool(true)) {
                    "200 OK"
                } else {
                    "400 Bad Request"
                },
                out,
            );
        });
    }
}

// Project-store discovery: the nearest .sis/*.db walking up from cwd (the
// convention `mk sis` uses); else an existing cwd "sis.db" (ad-hoc store).
// Returns None when nothing resolves — callers must never silently create
// an implicit store ("sis.db" in a random cwd would be a phantom backlog).
fn discover_db() -> Option<String> {
    let cwd = env::current_dir().unwrap_or_default();
    let mut dir = Some(cwd.as_path());
    while let Some(d) = dir {
        let sis = d.join(".sis");
        if sis.is_dir() {
            let mut dbs: Vec<PathBuf> = fs::read_dir(&sis)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|x| x == "db"))
                        .collect()
                })
                .unwrap_or_default();
            dbs.sort();
            if let Some(first) = dbs.into_iter().next() {
                return Some(first.to_string_lossy().into_owned());
            }
        }
        dir = d.parent();
    }
    let adhoc = cwd.join("sis.db");
    if adhoc.is_file() {
        return Some("sis.db".into());
    }
    None
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let mut db_explicit = env::var("SIS_DB").is_ok();
    let mut db = env::var("SIS_DB")
        .ok()
        .or_else(discover_db)
        .unwrap_or_else(|| "sis.db".into());
    let mut pos: Vec<String> = vec![];
    let mut md = false;
    let mut follow = false;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--db" => {
                i += 1;
                if i < argv.len() {
                    db = argv[i].clone();
                    db_explicit = true;
                }
            }
            "--json" => {}
            "--md" => {
                md = true;
            }
            "--follow" | "-f" => {
                follow = true;
            }
            "--http" => {
                i += 1;
                if i < argv.len() {
                    unsafe {
                        env::set_var("SIS_HTTP", &argv[i]);
                    }
                }
            }
            "-h" | "--help" => usage(),
            s => pos.push(s.to_string()),
        }
        i += 1;
    }
    if pos.is_empty() {
        usage();
    }
    let cmd = pos[0].clone();
    // Store guards: no implicit fresh "sis.db" (phantom backlog), and no
    // read or unknown cmd on a missing store (empty-backlog illusion).
    // Creation is explicit-only: --db/SIS_DB, or SIS_CWD_DB=1 for ad-hoc.
    let db_exists = Path::new(&db).exists();
    if !db_exists {
        if !db_explicit && env::var("SIS_CWD_DB").is_err() {
            eprintln!(
                "{}",
                env_err(
                    "no_project_db",
                    "no .sis/*.db found walking up and no SIS_DB/--db given; \
                     refusing to create implicit 'sis.db' in cwd. cd into a \
                     project, pass --db PATH, or set SIS_CWD_DB=1 for an \
                     ad-hoc store."
                )
            );
            std::process::exit(2);
        }
        if READS.contains(&cmd.as_str()) || !known_cmd(&cmd) {
            eprintln!(
                "{}",
                env_err(
                    "db_missing",
                    &format!(
                        "database {db} does not exist; refusing to report an \
                         empty backlog (cmd {cmd})"
                    )
                )
            );
            std::process::exit(2);
        }
    }
    if cmd == "serve" {
        std::process::exit(serve(&db));
    }
    if cmd == "mcp" {
        std::process::exit(mcp(&db));
    }
    // `sis watch --follow`: live event stream over the daemon socket —
    // prints each pushed batch until Ctrl-C. Needs `sis serve` running.
    if cmd == "watch" && follow {
        let sock = agent::socket(&db);
        let mut args = cli_args(&cmd, &pos[1..]);
        args.as_object_mut()
            .map(|m| m.insert("follow".into(), json!(true)));
        match UnixStream::connect(&sock) {
            Ok(mut s) => {
                let req = json!({"cmd": "watch", "args": args}).to_string() + "\n";
                if s.write_all(req.as_bytes()).is_err() {
                    std::process::exit(2);
                }
                let Ok(cl) = s.try_clone() else {
                    std::process::exit(2)
                };
                for l in BufReader::new(cl).lines() {
                    match l {
                        Ok(t) => println!("{t}"),
                        Err(_) => break,
                    }
                }
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!(
                    "{}",
                    env_err(
                        "internal",
                        &format!("watch --follow needs `sis serve` on {sock}: {e}")
                    )
                );
                std::process::exit(2);
            }
        }
    }
    let mut args = cli_args(&cmd, &pos[1..]);
    // `sis changes`: compute the compact file-edit summary caller-side in the
    // real worktree (cwd), unless an explicit --files payload was given.
    // The daemon only stores the resulting event — it never spawns git.
    if cmd == "changes" && args.get("files").is_none() {
        if let Some(stem) = Path::new(&db).file_stem().and_then(|s| s.to_str()) {
            args["mirror"] = json!(format!("{stem}.issues.jsonl"));
        }
        if let Err(e) = changes_from_git(&mut args) {
            eprintln!("{}", env_err(&e.0, &e.1));
            std::process::exit(2);
        }
    }
    // `sis close`/`sis checkpoint` auto-record the worktree diff as a
    // `changes` event first — closing and checkpointing (agent handoff) are
    // the moments the edit evidence is freshest. Best-effort: missing
    // git/worktree never blocks the command.
    if (cmd == "close" || cmd == "checkpoint" || cmd == "handoff")
        && args.get("no_changes").is_none()
    {
        let mut ev_args = json!({"id": args.get("id").cloned().unwrap_or(Value::Null)});
        for k in ["actor", "run_id"] {
            if let Some(v) = args.get(k) {
                ev_args[k] = v.clone();
            }
        }
        if let Some(stem) = Path::new(&db).file_stem().and_then(|s| s.to_str()) {
            ev_args["mirror"] = json!(format!("{stem}.issues.jsonl"));
        }
        if changes_from_git(&mut ev_args).is_ok() {
            // ok-envelope required: an older daemon answers `unknown_op`
            // inside a delivered envelope — fall back to local dispatch then
            let recorded = transport::request(&db, "changes", &ev_args)
                .ok()
                .flatten()
                .is_some_and(|env| env.get("ok") == Some(&Value::Bool(true)));
            if !recorded {
                if let Ok(mut c) = connect(&db) {
                    let _ = handle(
                        &mut c,
                        &db,
                        &json!({"cmd": "changes", "args": ev_args}),
                    );
                }
            }
        }
    }
    let remote = match transport::request(&db, &cmd, &args) {
        Ok(value) => value,
        Err((code, message)) => {
            eprintln!("{}", env_err(&code, &message));
            std::process::exit(2);
        }
    };
    let env = if let Some(response) = remote {
        response
    } else {
        let mut c = match connect(&db) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("{}", env_err("internal", &e.to_string()));
                std::process::exit(2);
            }
        };
        handle(&mut c, &db, &json!({"cmd": cmd, "args": args}))
    };
    if env.get("ok") == Some(&Value::Bool(true)) {
        let data = env.get("data").cloned().unwrap_or(Value::Null);
        if md && cmd == "export" {
            // backlog.md-Brücke: Issues als Markdown-Liste (menschen-editierbar,
            // kein Sync-Modell — export ist Render, events bleiben Source).
            if let Some(issues) = data.get("issues").and_then(|v| v.as_array()) {
                println!("# superiss export — {} issues\n", issues.len());
                for i in issues {
                    println!(
                        "## {} · {} ({} p{} {})",
                        i["id"].as_str().unwrap_or("?"),
                        i["title"].as_str().unwrap_or(""),
                        i["status"].as_str().unwrap_or("open"),
                        i["priority"].as_i64().unwrap_or(2),
                        i["type"].as_str().unwrap_or("task")
                    );
                    if let Some(o) = i["oracle_cmd"].as_str() {
                        println!("- oracle: `{o}`");
                    }
                    if let Some(a) = i["acceptance"].as_str() {
                        println!("- acceptance: {a}");
                    }
                    if let Some(d) = i["desc"].as_str() {
                        println!("- {d}");
                    }
                    println!();
                }
            }
        } else {
            println!("{}", data);
        }
        std::process::exit(0);
    }
    eprintln!("{}", env);
    let code = env
        .pointer("/error/code")
        .and_then(|v| v.as_str())
        .unwrap_or("internal");
    std::process::exit(if code == "internal" { 2 } else { 1 });
}
