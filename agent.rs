use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Component, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};

pub fn listener_ready(fd: i32) -> std::io::Result<bool> {
    let mut watched = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut watched, 1, 100) };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    if watched.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        return Err(std::io::Error::other("listener unavailable"));
    }
    Ok(result > 0 && watched.revents & libc::POLLIN != 0)
}

pub fn fts_current(c: &Connection) -> rusqlite::Result<bool> {
    let mut stmt = c.prepare("PRAGMA table_info(issues_fts)")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(!columns.is_empty() && !columns.iter().any(|x| x == "id"))
}
pub fn fts_schema(c: &Connection) -> rusqlite::Result<()> {
    if fts_current(c)? {
        return Ok(());
    }
    c.execute_batch("DROP TRIGGER IF EXISTS issues_fts_ai; DROP TRIGGER IF EXISTS issues_fts_ad; DROP TRIGGER IF EXISTS issues_fts_au; DROP TABLE IF EXISTS issues_fts;")?;
    c.execute_batch(
        r#"
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title, "desc", acceptance, content='issues');
CREATE TRIGGER IF NOT EXISTS issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, "desc", acceptance)
  VALUES (new.rowid, new.title, new."desc", new.acceptance);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, "desc", acceptance)
  VALUES ('delete', old.rowid, old.title, old."desc", old.acceptance);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, "desc", acceptance)
  VALUES ('delete', old.rowid, old.title, old."desc", old.acceptance);
  INSERT INTO issues_fts(rowid, title, "desc", acceptance)
  VALUES (new.rowid, new.title, new."desc", new.acceptance);
END;
"#,
    )?;
    c.execute_batch("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')")?;
    Ok(())
}
pub fn schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS proofs(proof_id TEXT PRIMARY KEY,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,oracle TEXT,exitcode INTEGER,passed INTEGER,timed_out INTEGER,output TEXT,review_receipt TEXT); CREATE TABLE IF NOT EXISTS checkpoints(seq INTEGER PRIMARY KEY AUTOINCREMENT,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,text TEXT,next_step TEXT,artifacts TEXT,ts REAL); CREATE TABLE IF NOT EXISTS cancellations(issue TEXT PRIMARY KEY,requested INTEGER DEFAULT 0,actor TEXT,ts REAL); CREATE TABLE IF NOT EXISTS agent_state(issue TEXT PRIMARY KEY,cancel_requested INTEGER DEFAULT 0,attempt INTEGER DEFAULT 0,last_error TEXT); CREATE TABLE IF NOT EXISTS attests(attest_id TEXT PRIMARY KEY,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,kind TEXT,payload TEXT,summary TEXT,passed INTEGER,ts REAL); CREATE TABLE IF NOT EXISTS costs(id INTEGER PRIMARY KEY AUTOINCREMENT,issue TEXT,actor TEXT,run_id TEXT,wave TEXT,tokens_in INTEGER DEFAULT 0,tokens_out INTEGER DEFAULT 0,cents INTEGER DEFAULT 0,currency TEXT DEFAULT 'EUR',note TEXT,ts REAL); CREATE TABLE IF NOT EXISTS outbox_leases(outbox_id INTEGER PRIMARY KEY,actor TEXT NOT NULL,epoch INTEGER NOT NULL,lease_until REAL NOT NULL); CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state,kind,id); CREATE INDEX IF NOT EXISTS worker_candidates ON issues(priority,created_at,id) WHERE status IN ('open','deferred','in_progress'); CREATE INDEX IF NOT EXISTS issue_parent ON issues(json_extract(meta_json,'$.parent')); CREATE INDEX IF NOT EXISTS evidence_window ON events(op,ts);")?;
    c.execute(
        "INSERT OR IGNORE INTO kv(k,v) VALUES('project_id',?)",
        params![gen_id("project-")],
    )?;
    Ok(())
}
pub fn redact(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("admin_token");
            for x in m.values_mut() {
                redact(x)
            }
        }
        Value::Array(a) => {
            for x in a {
                redact(x)
            }
        }
        _ => {}
    }
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn budget(v: Option<&Value>) -> R<()> {
    if let Some(v) = v {
        if !v.is_null() && !v.as_f64().is_some_and(|x| x.is_finite() && x >= 0.0) {
            return Err(bad("budget must be finite and nonnegative"));
        }
    }
    Ok(())
}
fn ttl(a: &Value) -> R<f64> {
    let t = a
        .get("ttl")
        .map(|v| v.as_f64())
        .unwrap_or(Some(LEASE_S))
        .ok_or_else(|| bad("ttl must be numeric"))?;
    if !t.is_finite() || !(1.0..=86400.0).contains(&t) {
        return Err(bad("ttl must be finite and within 1..86400"));
    }
    Ok(t)
}
fn who(a: &Value) -> R<String> {
    let s = a
        .get("actor")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("actor required"))?;
    if s.trim().is_empty() || s.chars().count() > 128 {
        return Err(bad("actor must be nonempty and at most 128 characters"));
    }
    Ok(s.into())
}
fn epoch(a: &Value) -> R<i64> {
    let e = req_i(a, "epoch")?;
    if e < 0 {
        Err(bad("epoch must be nonnegative"))
    } else {
        Ok(e)
    }
}
fn task(c: &Connection, id: &str) -> R<Value> {
    q_issues(
        c,
        &format!("SELECT {COLS} FROM issues WHERE id=?"),
        vec![id.to_string().into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ("not_found".into(), format!("issue {id}")))
}
fn cancelled(c: &Connection, id: &str) -> R<bool> {
    Ok(c.query_row(
        "SELECT requested FROM cancellations WHERE issue=?",
        params![id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map_err(ie)?
    .unwrap_or(0)
        != 0)
}
fn active(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let act = who(a)?;
    let ep = epoch(a)?;
    let t = task(c, &id)?;
    if t["lease_epoch"].as_i64() != Some(ep) {
        return Err(("stale_fence".into(), "epoch mismatch".into()));
    }
    if t["status"] != "in_progress" || t["claim_actor"].as_str() != Some(&act) {
        return Err((
            "not_claimed".into(),
            "actor does not own active claim".into(),
        ));
    }
    if t["lease_until"].as_f64().unwrap_or(0.0) <= now() {
        return Err(("lease_expired".into(), "lease expired".into()));
    }
    Ok(t)
}
fn paths(t: &Value) -> R<Vec<String>> {
    match &t["allowed_paths"] {
        Value::Null => Ok(vec![]),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                x.as_str()
                    .map(String::from)
                    .ok_or_else(|| bad("allowed_paths must contain strings"))
            })
            .collect(),
        Value::String(s) => {
            if s.trim().is_empty() {
                return Ok(vec![]);
            }
            if s.starts_with('[') {
                let a: Value = serde_json::from_str(s).map_err(|_| bad("invalid allowed_paths"))?;
                paths(&json!({"allowed_paths":a}))
            } else {
                Ok(vec![s.clone()])
            }
        }
        _ => Err(bad("allowed_paths must be array or string")),
    }
}
fn structured(c: &Connection, id: &str) -> R<Value> {
    let t = task(c, id)?;
    let mut st=c.prepare("SELECT d.depends_on,COALESCE(d.type,'blocks'),b.status,g.state FROM deps d LEFT JOIN issues b ON b.id=d.depends_on LEFT JOIN gates g ON g.name=d.depends_on WHERE d.issue=? ORDER BY d.depends_on,d.type").map_err(ie)?;
    let deps=st.query_map(params![id],|r|Ok(json!({"depends_on":r.get::<_,String>(0)?,"type":r.get::<_,String>(1)?,"status":r.get::<_,Option<String>>(2)?,"gate_state":r.get::<_,Option<String>>(3)?}))).map_err(ie)?.collect::<Result<Vec<_>,_>>().map_err(ie)?;
    let mut security = serde_json::Map::new();
    for key in ["local_zero", "execution", "budget_gate", "review_required", "attest_required"] {
        security.insert(key.into(), t["meta"][key].clone());
    }
    let mut out = json!({"id":id,"title":t["title"],"desc":t["desc"],"acceptance":t["acceptance"],"oracle_cmd":t["oracle_cmd"],"allowed_paths":paths(&t)?,"owner":t["owner"],"lane":t["lane"],"dependencies":deps,"budget_eur":t["budget_eur"],"meta":security});
    // Dependency state is observable blocker information, but only the relation
    // itself belongs to the immutable contract revision.
    let mut stable = out.clone();
    stable["dependencies"] = json!(deps
        .iter()
        .map(|d| json!({"depends_on":d["depends_on"],"type":d["type"]}))
        .collect::<Vec<_>>());
    out["revision"] = json!(digest(stable.to_string().as_bytes()));
    out["dependencies"]=json!(deps.iter().map(|d|{let kind=d["type"].as_str().unwrap_or("blocks");let state=if kind=="gate"{d["gate_state"].as_str().unwrap_or("closed")}else{d["status"].as_str().unwrap_or("missing")};json!({"depends_on":d["depends_on"],"type":kind,"state":if kind=="blocks"||kind=="gate"{Some(state)}else{None},"blocked":kind=="blocks"&&state!="closed"||kind=="gate"&&state!="open"})}).collect::<Vec<_>>());
    out["blocked_by"] = json!(out["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["blocked"] == true)
        .map(|d| d["depends_on"].clone())
        .collect::<Vec<_>>());
    out["status"] = t["status"].clone();
    out["type"] = t["type"].clone();
    Ok(out)
}
fn revision(c: &Connection, id: &str) -> R<String> {
    Ok(structured(c, id)?["revision"].as_str().unwrap().into())
}
fn expected(c: &Connection, a: &Value) -> R<()> {
    if let Some(r) = a.get("expected_revision") {
        if r.as_str() != Some(&revision(c, &req(a, "id")?)?) {
            return Err((
                "revision_conflict".into(),
                "expected_revision does not match".into(),
            ));
        }
    }
    Ok(())
}
fn contract(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let t = structured(c, &id)?;
    let text = serde_json::to_string_pretty(&t).map_err(ie)?;
    Ok(
        json!({"contract_text":text,"revision":t["revision"],"task":t,"structured":t,"anchors":[],"priors":null}),
    )
}
static O200: OnceLock<tiktoken_rs::CoreBPE> = OnceLock::new();
static CL100: OnceLock<tiktoken_rs::CoreBPE> = OnceLock::new();
fn encoding(a: &Value) -> R<String> {
    if let Some(v) = a.get("encoding") {
        return match v.as_str() {
            Some("o200k_base") => Ok("o200k_base".into()),
            Some("cl100k_base") => Ok("cl100k_base".into()),
            _ => Err(("unknown_tokenizer".into(), "unknown encoding".into())),
        };
    }
    match a.get("model").and_then(Value::as_str) {
        None => Ok("o200k_base".into()),
        Some(m)
            if m.starts_with("gpt-4o")
                || m.starts_with("gpt-4.1")
                || m.starts_with("gpt-5")
                || m.starts_with("o1")
                || m.starts_with("o3")
                || m.starts_with("o4") =>
        {
            Ok("o200k_base".into())
        }
        Some(m)
            if m == "gpt-4"
                || m.starts_with("gpt-4-")
                || m.starts_with("gpt-3.5-turbo")
                || m.starts_with("text-embedding-3-")
                || m == "text-embedding-ada-002" =>
        {
            Ok("cl100k_base".into())
        }
        _ => Err((
            "unknown_tokenizer".into(),
            "unknown model; supply a known encoding".into(),
        )),
    }
}
fn count(text: &str, enc: &str) -> R<usize> {
    if text.len() > 1024 * 1024 {
        return Err(bad("text exceeds 1 MiB"));
    }
    let cache = if enc == "cl100k_base" { &CL100 } else { &O200 };
    if cache.get().is_none() {
        let b = if enc == "cl100k_base" {
            tiktoken_rs::cl100k_base()
        } else {
            tiktoken_rs::o200k_base()
        }
        .map_err(ie)?;
        let _ = cache.set(b);
    }
    Ok(cache.get().unwrap().encode_ordinary(text).len())
}
fn tokens(a: &Value) -> R<Value> {
    let text = a
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("text required"))?;
    let enc = encoding(a)?;
    Ok(
        json!({"tokens":count(text,&enc)?,"encoding":enc,"exact":true,"algorithm":"tiktoken-bpe","billing":false}),
    )
}
fn brief(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let enc = encoding(a)?;
    let mut t = structured(c, &id)?;
    let mut omitted = vec![];
    let max = match a.get("max_tokens") {
        None => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| bad("max_tokens must be positive integer"))? as usize,
        ),
    };
    let mut text = serde_json::to_string_pretty(&t).map_err(ie)?;
    let mut n = count(&text, &enc)?;
    if let Some(since) = a.get("since") {
        let since = since
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or_else(|| bad("since must be nonnegative integer"))?;
        let mut st=c.prepare("SELECT seq,ts,op,data_json FROM events WHERE issue=? AND seq>? ORDER BY seq LIMIT 50").map_err(ie)?;
        let history=st.query_map(params![id,since],|r|{let data:Option<String>=r.get(3)?;Ok(json!({"seq":r.get::<_,i64>(0)?,"ts":r.get::<_,f64>(1)?,"op":r.get::<_,String>(2)?,"data":data.and_then(|s|serde_json::from_str::<Value>(&s).ok())}))}).map_err(ie)?.collect::<Result<Vec<_>,_>>().map_err(ie)?;
        t["history"] = json!(history);
        text = serde_json::to_string_pretty(&t).map_err(ie)?;
        n = count(&text, &enc)?;
    } else {
        omitted.push("history");
    }
    if let Some(ch) = latest_changes(c, &id)? {
        t["changes"] = ch;
        text = serde_json::to_string_pretty(&t).map_err(ie)?;
        n = count(&text, &enc)?;
    }
    if max.is_some_and(|m| n > m) && t.get("history").is_some() {
        t.as_object_mut().unwrap().remove("history");
        omitted.push("history");
        text = serde_json::to_string_pretty(&t).map_err(ie)?;
        n = count(&text, &enc)?;
    }
    if max.is_some_and(|m| n > m) && t.get("changes").is_some() {
        t.as_object_mut().unwrap().remove("changes");
        omitted.push("changes");
        text = serde_json::to_string_pretty(&t).map_err(ie)?;
        n = count(&text, &enc)?;
    }
    if max.is_some_and(|m| n > m) {
        t.as_object_mut().unwrap().remove("desc");
        omitted.push("desc");
        text = serde_json::to_string_pretty(&t).map_err(ie)?;
        n = count(&text, &enc)?;
    }
    if max.is_some_and(|m| n > m) {
        return Err((
            "budget_exceeded".into(),
            format!("mandatory contract requires {n} tokens"),
        ));
    }
    let cp = last_checkpoint(c, &id, None)?;
    Ok(
        json!({"id":id,"revision":t["revision"],"text":text,"tokens":n,"encoding":enc,"exact":true,"omitted":omitted,"checkpoint":cp,"cursor":event_cursor(c,&id)?}),
    )
}
fn eligible(c: &Connection, t: &Value, a: &Value) -> R<bool> {
    let id = t["id"].as_str().unwrap();
    let tm = now();
    let st = t["status"].as_str().unwrap_or("");
    if !matches!(st, "open" | "deferred" | "in_progress")
        || st == "deferred" && t["defer_until"].as_f64().is_none_or(|x| x > tm)
        || st == "in_progress" && t["lease_until"].as_f64().unwrap_or(f64::INFINITY) > tm
    {
        return Ok(false);
    }
    if t["defer_until"].as_f64().is_some_and(|x| x > tm)
        || t["expires_at"].as_f64().is_some_and(|x| x <= tm)
        || cancelled(c, id)?
    {
        return Ok(false);
    }
    if !t["oracle_cmd"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Ok(false);
    }
    if let Some(l) = a.get("lane") {
        if &t["lane"] != l {
            return Ok(false);
        }
    }
    let children:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM issues WHERE json_extract(meta_json,'$.parent')=? OR (id>=?||'.' AND id<?||'/' AND instr(substr(id,length(?)+2),'.')=0))",params![id,id,id,id],|r|r.get(0)).map_err(ie)?;
    if children || matches!(t["type"].as_str(), Some("goal" | "epic")) {
        if a["finalize"] != true
            || a["id"].as_str() != Some(id)
            || op_goal_done(c, &json!({"id":id}))?["done"] != true
        {
            return Ok(false);
        }
    }
    if let Some(g) = gs(a, "goal") {
        let found:i64=c.query_row("WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT COUNT(*) FROM sub WHERE x=?",params![g,id],|r|r.get(0)).map_err(ie)?;
        if found == 0 {
            return Ok(false);
        }
    }
    let ready: bool = c
        .query_row(
            &format!("SELECT {BLOCKED} FROM issues i WHERE i.id=?"),
            params![id],
            |r| r.get(0),
        )
        .map_err(ie)?;
    Ok(ready)
}
fn claim(c: &Connection, a: &Value, next: bool, acquire: bool) -> R<Value> {
    let act = who(a)?;
    let ttl = ttl(a)?;
    if next && a["finalize"] == true {
        return Err(bad("finalize requires explicit claim id"));
    }
    let explicit = if next { gs(a, "id").filter(|s| !s.is_empty()) } else { Some(req(a, "id")?) };
    let (sql, values) = if let Some(id) = &explicit {
        task(c, id)?;
        (format!("SELECT {COLS} FROM issues WHERE id=?"), vec![types::Value::Text(id.clone())])
    } else {
        let tm = now();
        (format!("SELECT {COLS} FROM issues WHERE status IN ('open','deferred','in_progress') AND (status='open' OR (status='deferred' AND defer_until<=?) OR (status='in_progress' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?) AND oracle_cmd IS NOT NULL AND trim(oracle_cmd)<>'' ORDER BY priority,created_at,id"), vec![types::Value::Real(tm), types::Value::Real(tm), types::Value::Real(tm)])
    };
    let mut statement = c.prepare(&sql).map_err(ie)?;
    let candidates = statement.query_map(params_from_iter(values.iter()), row_issue).map_err(ie)?;
    for candidate in candidates {
        let t = candidate.map_err(ie)?;
        if !eligible(c, &t, a)? {
            continue;
        }
        let id = t["id"].as_str().unwrap();
        let b = if acquire {
            let mut ba = a.clone();
            ba["id"] = json!(id);
            Some(brief(c, &ba)?)
        } else {
            None
        };
        let lu = now() + ttl;
        c.execute("DELETE FROM claims WHERE issue=?", params![id])
            .map_err(ie)?;
        c.execute("UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,lease_epoch=lease_epoch+1 WHERE id=?",params![act,lu,id]).map_err(ie)?;
        let ep = task(c, id)?["lease_epoch"].as_i64().unwrap();
        let mut out = claim_row(c, id, &act, ep, a)?;
        out["lease_until"] = json!(lu);
        out["revision"] = json!(revision(c, id)?);
        // meta.autorun: enqueue a runner job so an external executor can pick
        // the work up crash-safely (attest kind:"run" records the receipt).
        if let Some(ar) = t.pointer("/meta/autorun") {
            let cmd = ar
                .as_str()
                .or_else(|| ar.get("cmd").and_then(Value::as_str))
                .unwrap_or("");
            if !cmd.trim().is_empty() {
                let payload = json!({"issue":id,"actor":act,"epoch":ep,
                    "cmd":cmd,"cwd":ar.get("cwd").and_then(Value::as_str)});
                c.execute(
                    "INSERT INTO outbox(kind,payload,run_id) VALUES('autorun',?,?)",
                    params![payload.to_string(), run_id(a)],
                )
                .map_err(ie)?;
                out["autorun"] = json!(true);
            }
        }
        if acquire {
            out["contract"] = b.unwrap();
        }
        return Ok(out);
    }
    if next && a.get("id").and_then(|v| v.as_str()).is_none_or(|s| s.is_empty()) {
        Ok(json!({"id":null}))
    } else {
        Err((
            "not_claimable".into(),
            "issue is not a ready executable leaf".into(),
        ))
    }
}
fn heartbeat(c: &Connection, a: &Value) -> R<Value> {
    let t = active(c, a)?;
    let ttl = ttl(a)?;
    let id = req(a, "id")?;
    let lu = now() + ttl;
    c.execute(
        "UPDATE issues SET lease_until=? WHERE id=?",
        params![lu, id],
    )
    .map_err(ie)?;
    c.execute(
        "UPDATE claims SET hb_at=? WHERE issue=? AND actor=?",
        params![now(), id, t["claim_actor"].as_str()],
    )
    .map_err(ie)?;
    ev(c, "heartbeat", Some(&id), a, &json!({"epoch":epoch(a)?}))?;
    Ok(
        json!({"ok":true,"cancel_requested":cancelled(c,&id)?,"revision":revision(c,&id)?,"lease_until":lu}),
    )
}
fn admin(a: &Value) -> R<()> {
    let configured = env::var("SIS_ADMIN_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            (
                "admin_disabled".into(),
                "administrative API disabled".into(),
            )
        })?;
    let supplied = a.get("admin_token").and_then(Value::as_str).unwrap_or("");
    // Hash to fixed size before the constant-time comparison, including length.
    let l = Sha256::digest(configured.as_bytes());
    let r = Sha256::digest(supplied.as_bytes());
    let mut d = 0u8;
    for i in 0..32 {
        d |= l[i] ^ r[i]
    }
    if d != 0 {
        return Err(("unauthorized".into(), "invalid admin token".into()));
    }
    Ok(())
}
fn controller(t: &Value, actor: &str) -> bool {
    t["owner"].as_str() == Some(actor)
        || t.pointer("/meta/controller").and_then(Value::as_str) == Some(actor)
}
fn reopen(c: &Connection, a: &Value) -> R<Value> {
    let id = req(a, "id")?;
    let t = task(c, &id)?;
    if !controller(&t, &who(a)?) {
        admin(a)?
    }
    c.execute("UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,closed_at=NULL,lease_epoch=lease_epoch+1 WHERE id=?",params![id]).map_err(ie)?;
    c.execute("DELETE FROM claims WHERE issue=?", params![id])
        .map_err(ie)?;
    c.execute("DELETE FROM cancellations WHERE issue=?", params![id])
        .map_err(ie)?;
    ev(c, "reopen", Some(&id), a, &json!({"reason":gs(a,"reason")}))?;
    Ok(json!({"ok":true,"epoch":task(c,&id)?["lease_epoch"]}))
}
fn cancel(c: &Connection, a: &Value, ack: bool) -> R<Value> {
    let id = req(a, "id")?;
    let t = task(c, &id)?;
    if ack || t.pointer("/meta/controller").and_then(Value::as_str) != Some(&who(a)?) {
        active(c, a)?;
    }
    if ack {
        if !cancelled(c, &id)? {
            return Err(("not_cancelled".into(), "no cancellation requested".into()));
        }
        c.execute("UPDATE issues SET status='cancelled',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?",params![id]).map_err(ie)?;
        c.execute("DELETE FROM claims WHERE issue=?", params![id])
            .map_err(ie)?;
    } else {
        c.execute("INSERT INTO cancellations(issue,requested,actor,ts) VALUES(?,1,?,?) ON CONFLICT(issue) DO UPDATE SET requested=1,actor=excluded.actor,ts=excluded.ts",params![id,who(a)?,now()]).map_err(ie)?;
    }
    ev(
        c,
        if ack { "cancel_ack" } else { "cancel" },
        Some(&id),
        a,
        &json!({}),
    )?;
    Ok(json!({"ok":true,"cancel_requested":true}))
}

fn canonical_cwd(a: &Value) -> R<PathBuf> {
    let p = PathBuf::from(req(a, "cwd")?);
    let p = fs::canonicalize(p).map_err(|e| bad(format!("invalid cwd: {e}")))?;
    if !p.is_dir() {
        return Err(bad("cwd must be a directory"));
    }
    Ok(p)
}
fn fingerprint(t: &Value, cwd: &Path, dbp: &str) -> R<String> {
    let ps = paths(t)?;
    if ps.is_empty() {
        return Err(("missing_scope".into(), "allowed_paths required".into()));
    }
    let db = fs::canonicalize(dbp).unwrap_or_else(|_| PathBuf::from(dbp));
    let mut files = std::collections::BTreeMap::new();
    let mut total = 0usize;
    let mut seen = HashSet::new();
    fn walk(
        path: &Path,
        root: &Path,
        cwd: &Path,
        db: &Path,
        files: &mut std::collections::BTreeMap<String, String>,
        total: &mut usize,
        seen: &mut HashSet<PathBuf>,
    ) -> R<()> {
        let name = path.file_name().and_then(|x| x.to_str()).unwrap_or("");
        if [".git", ".sis", ".cache", "target", ".venv", "__pycache__"].contains(&name) {
            return Ok(());
        }
        let resolved =
            fs::canonicalize(path).map_err(|e| bad(format!("scope {}: {e}", path.display())))?;
        if !resolved.starts_with(root) {
            return Err((
                "scope_escape".into(),
                format!("escaping symlink/path {}", path.display()),
            ));
        }
        let ds = db.to_string_lossy();
        let rs = resolved.to_string_lossy();
        if resolved == db || rs == format!("{ds}-wal") || rs == format!("{ds}-shm") {
            return Ok(());
        }
        let md = fs::metadata(&resolved).map_err(ie)?;
        if md.is_dir() {
            if fs::symlink_metadata(path)
                .map_err(ie)?
                .file_type()
                .is_symlink()
            {
                return Err((
                    "invalid_scope".into(),
                    "directory symlinks are not fingerprinted".into(),
                ));
            }
            if !seen.insert(resolved.clone()) {
                return Ok(());
            }
            let mut entries = fs::read_dir(path)
                .map_err(ie)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(ie)?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                walk(&e.path(), root, cwd, db, files, total, seen)?
            }
        } else if md.is_file() {
            let key = path
                .strip_prefix(cwd)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            if files.contains_key(&key) {
                return Ok(());
            }
            let remaining = 32 * 1024 * 1024usize - *total;
            if md.len() > remaining as u64 {
                return Err(("scope_too_large".into(), "scope exceeds 32 MiB".into()));
            }
            let mut content = vec![];
            fs::File::open(path)
                .map_err(ie)?
                .take(remaining as u64 + 1)
                .read_to_end(&mut content)
                .map_err(ie)?;
            *total = total
                .checked_add(content.len())
                .ok_or_else(|| bad("scope too large"))?;
            if *total > 32 * 1024 * 1024 || files.len() >= 10000 {
                return Err((
                    "scope_too_large".into(),
                    "scope exceeds 32 MiB or 10000 files".into(),
                ));
            }
            files.insert(key, digest(&content));
        } else {
            return Err(bad("scope must contain regular files/directories"));
        }
        Ok(())
    }
    for p in ps {
        let p = PathBuf::from(p);
        if p.components().any(|x| x == Component::ParentDir) {
            return Err(("scope_escape".into(), "parent traversal in scope".into()));
        }
        let full = if p.is_absolute() { p } else { cwd.join(p) };
        let resolved =
            fs::canonicalize(&full).map_err(|e| bad(format!("scope {}: {e}", full.display())))?;
        if !resolved.starts_with(cwd) && !cwd.starts_with(&resolved) {
            return Err(("scope_escape".into(), "scope is outside cwd".into()));
        }
        let root = if resolved.is_dir() {
            full.clone()
        } else {
            full.parent().unwrap().to_path_buf()
        };
        let root = fs::canonicalize(root).map_err(ie)?;
        walk(&full, &root, cwd, &db, &mut files, &mut total, &mut seen)?;
    }
    Ok(digest(
        serde_json::to_string(&files).map_err(ie)?.as_bytes(),
    ))
}
fn recorded_cost(c: &Connection, id: &str) -> R<i64> {
    c.query_row(
        "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION \
         SELECT i.id FROM issues i JOIN sub s ON \
         json_extract(i.meta_json,'$.parent')=s.id OR \
         (i.id LIKE s.id||'.%' AND instr(substr(i.id,length(s.id)+2),'.')=0)) \
         SELECT COALESCE(SUM(CASE WHEN c.cents>0 THEN c.cents ELSE 0 END),0) \
         FROM costs c WHERE c.issue IN (SELECT id FROM sub)",
        params![id], |r| r.get(0),
    ).map_err(ie)
}
fn local_zero_guard(c: &Connection, t: &Value) -> R<bool> {
    if t.pointer("/meta/local_zero").and_then(Value::as_bool) != Some(true) {
        return Ok(false);
    }
    if t["budget_eur"].as_f64() != Some(0.0) {
        return Err(("local_zero_budget".into(), "local_zero requires budget_eur exactly 0".into()));
    }
    if recorded_cost(c, t["id"].as_str().ok_or_else(|| bad("task id required"))?)? > 0 {
        return Err(("budget_exceeded".into(), "local_zero refuses already recorded positive costs".into()));
    }
    if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err(("local_zero_unavailable".into(), "local_zero requires the macOS sandbox-exec OS sandbox".into()));
    }
    Ok(true)
}
fn execution_evidence() -> Value {
    json!({"mode":"local_zero","sandbox":"macos-seatbelt","network":"denied", "ipc":"denied","writes":"cwd","credential_environment":"cleared"})
}
fn local_run_contract(t: &Value, cmd: &str, cwd: &Path) -> R<()> {
    if t.pointer("/meta/local_zero").and_then(Value::as_bool) == Some(true) {
        if let Some(execution) = t.pointer("/meta/execution") {
            let expected_cwd = execution["cwd"].as_str().and_then(|s| fs::canonicalize(s).ok());
            if execution["cmd"].as_str() != Some(cmd)
                || expected_cwd.as_deref() != Some(cwd) {
                return Err(("execution_mismatch".into(), "run cmd/cwd does not match meta.execution".into()));
            }
        }
    }
    Ok(())
}
fn execute(oracle: &str, cwd: &Path, timeout: u64, local_zero: bool) -> R<(Option<i32>, bool, String)> {
    use std::process::{Command, Stdio};
    let mut cmd = if local_zero {
        let quoted = serde_json::to_string(&cwd.to_string_lossy()).map_err(ie)?;
        let profile = format!("(version 1) (deny default) (allow process-fork process-exec sysctl-read file-read*) (deny syscall-unix (syscall-number 147)) (deny syscall-unix (syscall-number 82)) (deny syscall-unix (syscall-number 244)) (allow file-write* (subpath {quoted})) (deny file-read* (require-all (require-any (subpath \"/Users\") (subpath \"/private/var/root\")) (require-not (subpath {quoted}))))");
        let mut sandbox = Command::new("/usr/bin/sandbox-exec");
        sandbox.arg("-p").arg(profile).arg("/bin/sh");
        sandbox.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", cwd).env("TMPDIR", cwd).env("LANG", "C").env("LC_ALL", "C");
        sandbox
    } else {
        Command::new("/bin/sh")
    };
    cmd.arg("-c")
        .arg(oracle)
        // this-process binding knobs must not leak into oracle children:
        // a nested `sis`/test would otherwise hit the daemon's own socket
        .env_remove("SIS_ADMIN_TOKEN")
        .env_remove("SIS_SOCK")
        .env_remove("SIS_DIRECT")
        .env_remove("SIS_DB")
        .env_remove("SIS_CWD_DB")
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(ie)?;
    let pid = child.id() as i32;
    let mut readers = vec![];
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    fn reader(mut input: impl Read + Send + AsRawFd + 'static, bounded: bool,
              stop: std::sync::Arc<std::sync::atomic::AtomicBool>) -> std::thread::JoinHandle<R<Vec<u8>>> {
        std::thread::spawn(move || {
            if bounded {
                let fd = input.as_raw_fd();
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
                    return Err(ie(std::io::Error::last_os_error()));
                }
            }
            let mut out = vec![];
            let mut buf = [0; 4096];
            loop {
                if bounded && stop.load(Ordering::Relaxed) { break; }
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Err(e) if bounded && e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                    Ok(n) => {
                        let take = (32768usize.saturating_sub(out.len())).min(n);
                        out.extend_from_slice(&buf[..take]);
                    }
                }
            }
            Ok(out)
        })
    }
    readers.push(reader(child.stdout.take().unwrap(), local_zero, stop.clone()));
    readers.push(reader(child.stderr.take().unwrap(), local_zero, stop.clone()));
    let start = std::time::Instant::now();
    let mut timed = false;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(ie)? {
            break s;
        }
        if start.elapsed() >= Duration::from_secs(timeout) {
            timed = true;
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            break child.wait().map_err(ie)?;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    if local_zero {
        let drain = std::time::Instant::now();
        while readers.iter().any(|r| !r.is_finished()) && drain.elapsed() < Duration::from_millis(100) {
            std::thread::sleep(Duration::from_millis(1));
        }
        stop.store(true, Ordering::Relaxed);
    }
    let mut out = vec![];
    for r in readers {
        out.extend(r.join().map_err(|_| bad("execution pipe reader panicked"))??)
    }
    Ok((
        status.code(),
        timed,
        String::from_utf8_lossy(&out).into_owned(),
    ))
}
fn verify(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let t = active(c, a)?;
    let id = req(a, "id")?;
    expected(c, a)?;
    let local_zero = local_zero_guard(c, &t)?;
    if cancelled(c, &id)? {
        return Err((
            "cancel_requested".into(),
            "task cancellation requested".into(),
        ));
    }
    let cwd = canonical_cwd(a)?;
    let rev = revision(c, &id)?;
    let hash = fingerprint(&t, &cwd, dbp)?;
    let timeout = match a.get("timeout_secs") {
        None => 10,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=300).contains(n))
            .ok_or_else(|| bad("timeout_secs must be integer within 1..300"))?,
    };
    let oracle = t["oracle_cmd"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ("missing_oracle".into(), "oracle required".into()))?;
    let (exit, timed, mut output) = execute(oracle, &cwd, timeout, local_zero)?;
    if let Ok(secret) = env::var("SIS_ADMIN_TOKEN") {
        if !secret.is_empty() {
            output = output.replace(&secret, "[redacted]");
        }
    }
    c.execute_batch("BEGIN IMMEDIATE").map_err(ie)?;
    let result = (|| {
        let current = active(c, a)?;
        local_zero_guard(c, &current)?;
        let after = fingerprint(&current, &cwd, dbp)?;
        if revision(c, &id)? != rev || after != hash {
            return Err((
                "stale_proof".into(),
                "contract or source changed during verification".into(),
            ));
        }
        if cancelled(c, &id)? {
            return Err((
                "cancel_requested".into(),
                "task cancelled during verification".into(),
            ));
        }
        let passed = exit == Some(0) && !timed;
        let proof = gen_id("proof-");
        let mut review = a.get("review_receipt").cloned().unwrap_or(Value::Null);
        redact(&mut review);
        c.execute("INSERT INTO proofs(proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![proof,id,who(a)?,epoch(a)?,rev,hash,cwd.to_string_lossy(),oracle,exit,passed,timed,output,review.to_string()]).map_err(ie)?;
        let mut out = json!({"proof_id":proof,"passed":passed,"exit_code":exit,"timed_out":timed,"revision":rev,"source_hash":hash});
        if local_zero { out["execution"] = execution_evidence(); }
        ev(
            c,
            "verify",
            Some(&id),
            a,
            &out,
        )?;
        idem_put(c, "verify", a, &out)?;
        Ok(out)
    })();
    match result {
        Ok(v) => {
            c.execute_batch("COMMIT").map_err(ie)?;
            notify();
            Ok(v)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
fn close(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let id = req(a, "id")?;
    let t = task(c, &id)?;
    who(a)?;
    epoch(a)?;
    if t["status"] != "closed" {
        active(c, a)?;
    }
    if cancelled(c, &id)? {
        return Err(("cancel_requested".into(), "task cancelled".into()));
    }
    let proof = gs(a, "proof_id").ok_or_else(|| {
        (
            "proof_required".into(),
            "successful stored proof_id required".into(),
        )
    })?;
    let p:Option<(String,i64,String,String,String,String,bool,String)>=c.query_row("SELECT actor,epoch,revision,source_hash,cwd,oracle,passed,review_receipt FROM proofs WHERE proof_id=? AND issue=?",params![proof,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get::<_,Option<String>>(7)?.unwrap_or_else(||"null".into())))).optional().map_err(ie)?;
    let (act, ep, rev, hash, cwd, oracle, pass, review) =
        p.ok_or_else(|| ("proof_required".into(), "proof receipt not found".into()))?;
    if !pass {
        return Err(("proof_required".into(), "proof did not pass".into()));
    }
    if act != who(a)?
        || ep != epoch(a)?
        || rev != revision(c, &id)?
        || oracle != t["oracle_cmd"].as_str().unwrap_or("")
        || fingerprint(&t, Path::new(&cwd), dbp).map_err(|_| {
            (
                "stale_proof".into(),
                "proof source unavailable or changed".into(),
            )
        })? != hash
    {
        return Err((
            "stale_proof".into(),
            "proof does not match active contract/source/claim".into(),
        ));
    }
    if t.pointer("/meta/review_required").and_then(Value::as_bool) == Some(true) {
        let r: Value = serde_json::from_str(&review).unwrap_or(Value::Null);
        if r["reviewer"]
            .as_str()
            .is_none_or(|x| x.trim().is_empty() || x == act)
            || r["verdict"] != "pass"
            || r["revision"] != rev
            || r["source_hash"] != hash
            || !r
                .get("artifact")
                .or_else(|| r.get("artifact_ref"))
                .and_then(Value::as_str)
                .is_some_and(|x| !x.trim().is_empty())
        {
            return Err((
                "review_required".into(),
                "matching independent review receipt required".into(),
            ));
        }
    }
    if let Some(req) = t.pointer("/meta/attest_required") {
        let needed: Vec<String> = match req {
            Value::Array(arr) => arr
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            Value::String(s) => vec![s.clone()],
            Value::Bool(true) => vec![],
            _ => return Err(bad("meta.attest_required must be bool/string/array")),
        };
        let have: HashSet<String> = c
            .prepare(
                "SELECT DISTINCT kind FROM attests WHERE issue=? AND revision=? \
                 AND source_hash=? AND passed=1",
            )
            .map_err(ie)?
            .query_map(params![id, rev, hash], |r| r.get::<_, String>(0))
            .map_err(ie)?
            .collect::<Result<_, _>>()
            .map_err(ie)?;
        let missing: Vec<&String> = needed.iter().filter(|k| !have.contains(*k)).collect();
        if !missing.is_empty() || (needed.is_empty() && have.is_empty()) {
            return Err((
                "attest_required".into(),
                format!("passed attests required for current contract/source: {missing:?}"),
            ));
        }
    }
    // meta.budget_gate: refuse close when the recorded cost rollup of this
    // issue's container subtree already exceeds its budget_eur.
    local_zero_guard(c, &t)?;
    if t.pointer("/meta/budget_gate").and_then(Value::as_bool) == Some(true) {
        let spent = recorded_cost(c, &id)?;
        let budget = t["budget_eur"].as_f64().ok_or_else(|| ("budget_missing".into(), "budget_gate requires an explicit budget_eur".into()))? * 100.0;
        if spent as f64 > budget {
            return Err((
                "budget_exceeded".into(),
                format!("cost rollup {spent}c exceeds budget {budget}c"),
            ));
        }
    }
    if t["status"] == "closed" && t["lease_epoch"].as_i64() == Some(ep) {
        return Ok(json!({"ok":true}));
    }
    if matches!(t["type"].as_str(), Some("goal" | "epic")) && op_goal_done(c, a)?["done"] != true {
        return Err((
            "children_open".into(),
            "container children still open".into(),
        ));
    }
    let reason = gs(a, "reason").unwrap_or_else(|| "done".into());
    c.execute("UPDATE issues SET status='closed',closed_at=?,lease_until=NULL,claim_actor=NULL WHERE id=?",params![now(),id]).map_err(ie)?;
    c.execute("DELETE FROM claims WHERE issue=?", params![id])
        .map_err(ie)?;
    ev(
        c,
        "close",
        Some(&id),
        a,
        &json!({"proof_id":proof,"reason":reason,"epoch":ep}),
    )?;
    let payload = json!({"issue":id,"title":t["title"],"reason":reason,"actor":act,"ts":now()});
    c.execute(
        "INSERT INTO outbox(kind,payload,run_id) VALUES('lesson',?,?)",
        params![payload.to_string(), run_id(a)],
    )
    .map_err(ie)?;
    Ok(json!({"ok":true}))
}
/// `sis attest`: bind a structured machine-checkable receipt to the active
/// claim's revision + source fingerprint. Supplementary host evidence — the
/// executable oracle stays required; `meta.attest_required` makes kinds
/// mandatory for close (mirrors review_required semantics).
fn xml_attr(tag: &str, key: &str) -> Option<i64> {
    for q in ['"', '\''] {
        let needle = format!("{key}={q}");
        if let Some(p) = tag.find(&needle) {
            let rest = &tag[p + needle.len()..];
            let end = rest.find(q).unwrap_or(rest.len().min(12));
            if let Ok(n) = rest[..end].trim().parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}
fn junit_counts(text: &str) -> Value {
    let (mut tests, mut fails, mut errs, mut skips) = (0i64, 0i64, 0i64, 0i64);
    let mut hits = 0;
    if let Some(p) = text.find("<testsuites") {
        if let Some(e) = text[p..].find('>') {
            let tag = &text[p..p + e];
            for (k, acc) in [
                ("tests", &mut tests),
                ("failures", &mut fails),
                ("errors", &mut errs),
                ("skipped", &mut skips),
            ] {
                if let Some(n) = xml_attr(tag, k) {
                    *acc += n;
                    hits += 1;
                }
            }
        }
    }
    if hits == 0 {
        let mut rest = text;
        while let Some(p) = rest.find("<testsuite ") {
            let tail = &rest[p..];
            let e = tail.find('>').unwrap_or(tail.len());
            let tag = &tail[..e];
            tests += xml_attr(tag, "tests").unwrap_or(0);
            fails += xml_attr(tag, "failures").unwrap_or(0);
            errs += xml_attr(tag, "errors").unwrap_or(0);
            skips += xml_attr(tag, "skipped").unwrap_or(0);
            hits += 1;
            rest = &tail[e..];
        }
    }
    json!({"tests": tests, "failures": fails, "errors": errs,
           "skipped": skips, "parsed": hits > 0})
}
fn autorun_delivery(c: &Connection, a: &Value, cmd: &str, remaining: f64) -> R<()> {
    let Some(id) = a.get("outbox_id") else { return Ok(()); };
    let delivery = json!({"id":id, "actor":a["delivery_actor"], "epoch":a["delivery_epoch"]});
    let expected_key = format!("outbox-{}-delivery-{}", req_i(&delivery, "id")?, req_i(&delivery, "epoch")?);
    if gs(a, "idem").as_deref() != Some(expected_key.as_str()) {
        return Err(("stale_fence".into(), "leased execution requires its stable idempotency key".into()));
    }
    let until = outbox_delivery(c, &delivery)?.ok_or_else(|| ("stale_fence".into(), "leased delivery required".into()))?;
    if until <= now() + remaining {
        return Err(("stale_fence".into(), "delivery lease is too short for execution deadline".into()));
    }
    let payload: Option<String> = c.query_row("SELECT payload FROM outbox WHERE id=? AND kind='autorun' AND state='running'", params![req_i(&delivery, "id")?], |r| r.get(0)).optional().map_err(ie)?;
    let payload: Value = serde_json::from_str(&payload.ok_or_else(|| ("stale_fence".into(), "active autorun delivery required".into()))?).map_err(ie)?;
    if let Some(expected) = payload["cwd"].as_str() {
        if fs::canonicalize(expected).map_err(ie)? != PathBuf::from(canonical_cwd(a)?) {
            return Err(("stale_fence".into(), "execution directory differs from leased job".into()));
        }
    }
    if payload["issue"] != a["id"] || payload["actor"] != a["actor"] || payload["epoch"] != a["epoch"] || payload["cmd"].as_str() != Some(cmd) {
        return Err(("stale_fence".into(), "execution does not match leased job".into()));
    }
    Ok(())
}
fn attest_run(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let t = active(c, a)?;
    let id = req(a, "id")?;
    expected(c, a)?;
    let local_zero = local_zero_guard(c, &t)?;
    if cancelled(c, &id)? {
        return Err(("cancel_requested".into(), "task cancellation requested".into()));
    }
    let cwd = canonical_cwd(a)?;
    let rev = revision(c, &id)?;
    let hash = fingerprint(&t, &cwd, dbp)?;
    let payload = a.get("payload").cloned().unwrap_or(Value::Null);
    if payload.to_string().len() > 65536 {
        return Err(bad("payload exceeds 64 KiB"));
    }
    let cmd = gs(a, "cmd").or_else(|| payload["cmd"].as_str().map(String::from))
        .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
        .ok_or_else(|| bad("run attest needs nonempty cmd within 8 KiB"))?;
    let timeout = match a.get("timeout_secs") {
        None => 10,
        Some(v) => v.as_u64().filter(|n| (1..=60).contains(n))
            .ok_or_else(|| bad("timeout_secs must be integer within 1..60"))?,
    };
    local_run_contract(&t, &cmd, &cwd)?;
    autorun_delivery(c, a, &cmd, timeout as f64 + 2.0)?;
    let (exit, timed, mut output) = execute(&cmd, &cwd, timeout, local_zero)?;
    if let Ok(secret) = env::var("SIS_ADMIN_TOKEN") {
        if !secret.is_empty() {
            output = output.replace(&secret, "[redacted]");
        }
    }
    c.execute_batch("BEGIN IMMEDIATE").map_err(ie)?;
    let result = (|| {
        let current = active(c, a)?;
        local_zero_guard(c, &current)?;
        autorun_delivery(c, a, &cmd, 0.0)?;
        if cancelled(c, &id)? {
            return Err(("cancel_requested".into(), "task cancelled during attestation".into()));
        }
        if revision(c, &id)? != rev || fingerprint(&current, &cwd, dbp)? != hash {
            return Err(("stale_proof".into(), "contract or source changed during attestation".into()));
        }
        let out = attest(c, a, dbp, Some((exit, timed, output)))?;
        idem_put(c, "attest", a, &out)?;
        Ok(out)
    })();
    match result {
        Ok(out) => {
            c.execute_batch("COMMIT").map_err(ie)?;
            notify();
            Ok(out)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
fn attest(c: &Connection, a: &Value, dbp: &str, executed: Option<(Option<i32>, bool, String)>) -> R<Value> {
    let t = active(c, a)?;
    let id = req(a, "id")?;
    if cancelled(c, &id)? {
        return Err((
            "cancel_requested".into(),
            "task cancellation requested".into(),
        ));
    }
    let cwd = canonical_cwd(a)?;
    let rev = revision(c, &id)?;
    let hash = fingerprint(&t, &cwd, dbp)?;
    let kind = req(a, "kind")?;
    let payload = a.get("payload").cloned().unwrap_or(Value::Null);
    if payload.to_string().len() > 65536 {
        return Err(bad("payload exceeds 64 KiB"));
    }
    let (passed, summary) = match kind.as_str() {
        "junit" => {
            let rel = gs(a, "path").or_else(|| payload["path"].as_str().map(String::from))
                .ok_or_else(|| bad("junit attest needs path"))?;
            let f = fs::canonicalize(cwd.join(rel)).map_err(ie)?;
            if !f.starts_with(&cwd) || !f.is_file() {
                return Err(bad("junit path must be a file inside cwd"));
            }
            let bytes = fs::read(&f).map_err(ie)?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(bad("junit file exceeds 4 MiB"));
            }
            let s = junit_counts(&String::from_utf8_lossy(&bytes));
            (s["tests"].as_i64() > Some(0)
                && s["failures"] == 0
                && s["errors"] == 0, s)
        }
        "coverage" => {
            let pct = gf(a, "percent")
                .or_else(|| payload["percent"].as_f64())
                .filter(|x| x.is_finite() && (0.0..=100.0).contains(x))
                .ok_or_else(|| bad("coverage needs percent 0..100"))?;
            let min = gf(a, "min").or_else(|| payload["min"].as_f64()).unwrap_or(0.0);
            (pct >= min, json!({"percent": pct, "min": min}))
        }
        "smoke" => {
            let url = gs(a, "url").or_else(|| payload["url"].as_str().map(String::from))
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| bad("smoke needs url"))?;
            let status = gi(a, "status").or_else(|| payload["status"].as_i64())
                .filter(|s| (100..=599).contains(s))
                .ok_or_else(|| bad("smoke needs status 100..599"))?;
            let expect = gi(a, "expect").or_else(|| payload["expect"].as_i64()).unwrap_or(200);
            (status == expect, json!({"url": url, "status": status, "expect": expect}))
        }
        "artifact" => {
            let r = gs(a, "ref").or_else(|| payload["ref"].as_str().map(String::from))
                .or_else(|| gs(a, "path"))
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| bad("artifact needs ref or path"))?;
            (true, json!({"ref": r, "digest": payload.get("digest").cloned().unwrap_or(Value::Null)}))
        }
        "custom" => (
            a.get("passed").or_else(|| payload.get("passed")).and_then(Value::as_bool)
                .ok_or_else(|| bad("custom attest needs passed bool"))?,
            json!({"note": gs(a, "note").or_else(|| payload["note"].as_str().map(String::from))}),
        ),
        // Only attest_run may supply execution evidence; never accept a
        // client-supplied result or execute commands under the writer lock.
        "run" => {
            let cmd = gs(a, "cmd").or_else(|| payload["cmd"].as_str().map(String::from))
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| bad("run attest needs cmd"))?;
            if cmd.len() > 8192 {
                return Err(bad("run cmd exceeds 8 KiB"));
            }
            let timeout = match a.get("timeout_secs") {
                None => 10,
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=60).contains(n))
                    .ok_or_else(|| bad("timeout_secs must be integer within 1..60"))?,
            };
            let _ = timeout;
            let (exit, timed, output) = executed.ok_or_else(|| bad("run attest requires standalone execution"))?;
            let mut summary = json!({"cmd": cmd, "exit_code": exit, "timed_out": timed,
                       "output": output});
            if t.pointer("/meta/local_zero").and_then(Value::as_bool) == Some(true) {
                summary["execution"] = execution_evidence();
            }
            (
                exit == Some(0) && !timed,
                summary,
            )
        }
        other => return Err(bad(format!("unknown attest kind {other}"))),
    };
    let attest = gen_id("attest-");
    c.execute("INSERT INTO attests(attest_id,issue,actor,epoch,revision,source_hash,cwd,kind,payload,summary,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        params![attest,id,who(a)?,epoch(a)?,rev,hash,cwd.to_string_lossy(),kind,payload.to_string(),summary.to_string(),passed,now()]).map_err(ie)?;
    ev(
        c,
        "attest",
        Some(&id),
        a,
        &json!({"attest_id":attest,"kind":kind,"passed":passed,"revision":rev,"source_hash":hash}),
    )?;
    Ok(json!({"attest_id":attest,"kind":kind,"passed":passed,"summary":summary,"revision":rev,"source_hash":hash}))
}
fn event_cursor(c: &Connection, id: &str) -> R<i64> {
    c.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM events WHERE issue=?",
        params![id],
        |r| r.get(0),
    )
    .map_err(ie)
}
fn last_checkpoint(c: &Connection, id: &str, dbp: Option<&str>) -> R<Value> {
    let row:Option<Value>=c.query_row("SELECT seq,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts FROM checkpoints WHERE issue=? ORDER BY seq DESC LIMIT 1",params![id],|r|{let art:String=r.get(8)?;Ok(json!({"seq":r.get::<_,i64>(0)?,"actor":r.get::<_,String>(1)?,"epoch":r.get::<_,i64>(2)?,"revision":r.get::<_,String>(3)?,"source_hash":r.get::<_,String>(4)?,"cwd":r.get::<_,String>(5)?,"text":r.get::<_,String>(6)?,"next_step":r.get::<_,String>(7)?,"artifacts":serde_json::from_str::<Value>(&art).unwrap_or(Value::Null),"ts":r.get::<_,f64>(9)?}))}).optional().map_err(ie)?;
    if let Some(mut row) = row {
        let mut stale = row["revision"].as_str() != Some(&revision(c, id)?);
        if let Some(db) = dbp {
            stale |= fingerprint(&task(c, id)?, Path::new(row["cwd"].as_str().unwrap()), db)
                .ok()
                .as_deref()
                != row["source_hash"].as_str();
        }
        row["stale"] = json!(stale);
        Ok(row)
    } else {
        Ok(Value::Null)
    }
}
fn checkpoint(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let t = active(c, a)?;
    expected(c, a)?;
    let id = req(a, "id")?;
    let text = req(a, "text")?;
    let next = req(a, "next_step")?;
    let art = a.get("artifacts").cloned().unwrap_or(json!([]));
    if text.len() + next.len() + art.to_string().len() > 16384 {
        return Err(bad("checkpoint exceeds 16 KiB"));
    }
    let cwd = if a.get("cwd").is_some() {
        canonical_cwd(a)?
    } else {
        let parent = Path::new(dbp)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let root = if parent.file_name().is_some_and(|x| x == ".sis") {
            parent.parent().unwrap_or(parent)
        } else {
            parent
        };
        fs::canonicalize(root).map_err(ie)?
    };
    let hash = fingerprint(&t, &cwd, dbp)?;
    let rev = revision(c, &id)?;
    c.execute("INSERT INTO checkpoints(issue,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts) VALUES(?,?,?,?,?,?,?,?,?,?)",params![id,who(a)?,epoch(a)?,rev,hash,cwd.to_string_lossy(),text,next,art.to_string(),now()]).map_err(ie)?;
    ev(
        c,
        "checkpoint",
        Some(&id),
        a,
        &json!({"revision":rev,"source_hash":hash,"next_step":next}),
    )?;
    last_checkpoint(c, &id, Some(dbp))
}
/// `sis handoff`: checkpoint + release the lease in one step so the next
/// agent can claim immediately instead of waiting out the lease TTL.
/// `to` names the intended successor (advisory, searchable in history).
fn handoff(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let cp = checkpoint(c, a, dbp)?;
    let id = req(a, "id")?;
    op_unclaim(c, a)?;
    c.execute(
        "UPDATE issues SET lease_epoch=lease_epoch+1 WHERE id=?",
        params![id],
    )
    .map_err(ie)?;
    ev(
        c,
        "handoff",
        Some(&id),
        a,
        &json!({"to": a.get("to"), "next_step": a.get("next_step")}),
    )?;
    Ok(json!({"ok": true, "released": true, "checkpoint": cp}))
}
fn op_who(c: &Connection, a: &Value) -> R<Value> {
    // dirty-worktree attribution: map each dirty/untracked path to the
    // recorded changes event (and hence claim/actor) that produced it —
    // answers "wem gehört dieser Stand?" instead of guessing. Orphaned
    // paths (no matching changes event) surface explicitly.
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let repo = a
        .get("repo")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| cwd.join(s))
        .unwrap_or(cwd);
    let top = git_out(&repo, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad(format!("not a git worktree: {}", repo.display())))?;
    let root = PathBuf::from(&top);
    let head = git_out(&root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string());
    let branch = git_out(&root, &["branch", "--show-current"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut stx = c
        .prepare(
            "SELECT e.issue,e.seq,e.actor,i.status,i.claim_actor,
                    json_extract(e.data_json,'$.head_subject')
             FROM events e JOIN issues i ON i.id=e.issue
             JOIN (SELECT issue,MAX(seq) s FROM events WHERE op='changes' GROUP BY issue) latest
               ON latest.issue=e.issue AND latest.s=e.seq
             WHERE EXISTS (SELECT 1 FROM json_each(e.data_json,'$.files') f
                           WHERE json_extract(f.value,'$.path')=?1)",
        )
        .map_err(ie)?;
    // contract-scope fallback for tasks without recorded evidence yet:
    // an open/in-progress issue whose allowed_paths cover the file is a
    // weaker (declared, not measured) attribution — labeled via:"scope".
    let mut scope_rows: Vec<(String, String, Option<String>, Vec<String>)> = vec![];
    {
        let mut s = c
            .prepare(
                "SELECT id,status,claim_actor,allowed_paths FROM issues
                 WHERE status IN ('in_progress','open')
                   AND allowed_paths IS NOT NULL AND allowed_paths != ''",
            )
            .map_err(ie)?;
        let rows = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(ie)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(ie)?;
        for (id, status, actor, stored) in rows {
            let t = json!({"allowed_paths": stored});
            if let Ok(ps) = paths(&t) {
                scope_rows.push((id, status, actor, ps));
            }
        }
    }
    let scope_match = |path: &str,
                       rows: &Vec<(String, String, Option<String>, Vec<String>)>| {
        rows.iter()
            .filter(|(_, _, _, ps)| {
                ps.iter().any(|e| {
                    let e = e.trim().trim_start_matches("./").trim_end_matches("**");
                    let e = e.trim_end_matches('/');
                    !e.is_empty() && (path == e || path.starts_with(&format!("{e}/")))
                })
            })
            .map(|(id, status, actor, _)| {
                json!({"issue": id, "status": status, "claim_actor": actor,
                       "actor": Value::Null, "via": "scope"})
            })
            .collect::<Vec<Value>>()
    };
    let mut dirty = vec![];
    let mut by_issue: serde_json::Map<String, Value> = serde_json::Map::new();
    for l in git_out(&root, &["status", "--porcelain", "-uall"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
    {
        if l.len() < 4 {
            continue;
        }
        let st = l[..2].trim().to_string();
        let rest = &l[3..];
        let (path, renamed_from) = rest
            .split_once(" -> ")
            .map(|(o, n)| (n.trim().to_string(), Some(o.trim().to_string())))
            .unwrap_or_else(|| (rest.trim().trim_end_matches('/').to_string(), None));
        if path.is_empty() {
            continue;
        }
        let mut claims = stx
            .query_map(params![&path], |r| {
                Ok(json!({
                    "issue": r.get::<_, String>(0)?, "seq": r.get::<_, i64>(1)?,
                    "actor": r.get::<_, String>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "claim_actor": r.get::<_, Option<String>>(4)?,
                    "head_subject": r.get::<_, Option<String>>(5)?,
                    "via": "changes",
                }))
            })
            .map_err(ie)?
            .collect::<rusqlite::Result<Vec<Value>>>()
            .map_err(ie)?;
        if claims.is_empty() {
            claims = scope_match(&path, &scope_rows);
        }
        for cl in &claims {
            let id = cl["issue"].as_str().unwrap_or_default().to_string();
            let e = by_issue.entry(id).or_insert_with(|| {
                json!({"issue": cl["issue"], "actor": cl["actor"],
                       "status": cl["status"], "claim_actor": cl["claim_actor"], "files": 0})
            });
            e["files"] = json!(e["files"].as_i64().unwrap_or(0) + 1);
        }
        let mut d = json!({"path": path, "status": st, "claims": claims});
        if let Some(o) = renamed_from {
            d["renamed_from"] = json!(o);
        }
        dirty.push(d);
    }
    let matched = dirty
        .iter()
        .filter(|d| !d["claims"].as_array().is_none_or(|v| v.is_empty()))
        .count();
    let orphaned: Vec<Value> = dirty
        .iter()
        .filter(|d| d["claims"].as_array().is_none_or(|v| v.is_empty()))
        .map(|d| d["path"].clone())
        .collect();
    Ok(json!({
        "repo": top, "head": head, "branch": branch, "dirty": dirty,
        "summary": {
            "dirty": dirty.len(), "matched": matched,
            "by_issue": by_issue.into_iter().map(|(_, v)| v).collect::<Vec<Value>>(),
            "orphaned": orphaned,
        },
    }))
}
fn resume(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    let id = req(a, "id")?;
    let t = task(c, &id)?;
    let since = gi(a, "since").unwrap_or(0);
    let mut st = c
        .prepare(
            "SELECT seq,ts,op,data_json FROM events WHERE issue=? AND seq>? ORDER BY seq LIMIT 100",
        )
        .map_err(ie)?;
    let events=st.query_map(params![id,since],|r|{let s:String=r.get(3)?;Ok(json!({"seq":r.get::<_,i64>(0)?,"ts":r.get::<_,f64>(1)?,"op":r.get::<_,String>(2)?,"data":serde_json::from_str::<Value>(&s).unwrap_or(Value::Null)}))}).map_err(ie)?.collect::<Result<Vec<_>,_>>().map_err(ie)?;
    let cursor = events
        .last()
        .and_then(|e| e["seq"].as_i64())
        .unwrap_or(since);
    let latest_verification = c
        .query_row(
            "SELECT seq,ts,data_json FROM events WHERE issue=? AND op='verify' ORDER BY seq DESC LIMIT 1",
            params![id],
            |r| {
                let raw: String = r.get(2)?;
                Ok(json!({"seq":r.get::<_,i64>(0)?,"ts":r.get::<_,f64>(1)?,"op":"verify", "data":serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)}))
            },
        )
        .optional()
        .map_err(ie)?;
    let last_error = latest_verification.filter(|event| event["data"]["passed"] == false);
    Ok(
        json!({"contract":structured(c,&id)?,"checkpoint":last_checkpoint(c,&id,Some(dbp))?,"cancel_requested":cancelled(c,&id)?,"status":t["status"],"attempt":t["lease_epoch"],"last_error":last_error,"changes":latest_changes(c,&id)?.unwrap_or(Value::Null),"run_state":run_state(c,&id,&t)?,"events":events,"cursor":cursor}),
    )
}

pub fn idem_hit(c: &Connection, cmd: &str, a: &Value) -> R<Option<Value>> {
    let Some(key) = gs(a, "idem") else {
        return Ok(None);
    };
    let mut payload = a.clone();
    redact(&mut payload);
    payload.as_object_mut().map(|m| m.remove("idem"));
    let hash = digest(payload.to_string().as_bytes());
    let row: Option<String> = c
        .query_row(
            "SELECT v FROM kv WHERE k=?",
            params![format!("idem:{key}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(ie)?;
    let Some(row) = row else { return Ok(None) };
    let value: Value = serde_json::from_str(&row).map_err(ie)?;
    if value["cmd"] == cmd && value["actor"] == json!(actor(a)) && value["payload_hash"] == hash {
        Ok(Some(value["data"].clone()))
    } else {
        Err((
            "idem_conflict".into(),
            "idempotency key payload/command/actor mismatch".into(),
        ))
    }
}
pub fn idem_put(c: &Connection, cmd: &str, a: &Value, v: &Value) -> R<()> {
    if let Some(key) = gs(a, "idem") {
        let mut payload = a.clone();
        redact(&mut payload);
        payload.as_object_mut().map(|m| m.remove("idem"));
        c.execute(
            "INSERT INTO kv(k,v) VALUES(?,?)",
            params![format!("idem:{key}"),json!({"cmd":cmd,"actor":actor(a),"payload_hash":digest(payload.to_string().as_bytes()),"data":v}).to_string()],
        )
        .map_err(ie)?;
    }
    Ok(())
}
fn paged(c: &Connection, cmd: &str, a: &Value) -> R<Value> {
    let limit = match a.get("limit") {
        None => 1000,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=1000).contains(n))
            .ok_or_else(|| bad("limit must be 1..1000"))? as usize,
    };
    let mut args = a.clone();
    args["limit"] = json!(limit + 1);
    args.as_object_mut().unwrap().remove("fields");
    args.as_object_mut().unwrap().remove("cursor");
    if let Some(cur) = a
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        args["_after"] = serde_json::from_str(cur).map_err(|_| bad("malformed cursor"))?;
    }
    let raw = match cmd {
        "list" | "query" => op_list(c, &args)?,
        "ready" => op_ready(c, &args)?,
        _ => op_next(c, &args)?,
    };
    let mut rows = raw.as_array().unwrap().clone();
    let cursor_mode = a.get("cursor").is_some() || a.get("paginate") == Some(&json!(true));
    let key = |v: &Value| -> R<(i64, String, String)> {
        Ok((
            v["priority"]
                .as_i64()
                .ok_or_else(|| bad("invalid cursor priority"))?,
            v["created_at"].to_string(),
            v["id"]
                .as_str()
                .ok_or_else(|| bad("invalid cursor id"))?
                .into(),
        ))
    };
    if let Some(cur) = a
        .get("cursor")
        .filter(|v| !v.is_null() && v.as_str() != Some(""))
    {
        let cur = cur.as_str().ok_or_else(|| bad("invalid cursor"))?;
        let v: Value = serde_json::from_str(cur).map_err(|_| bad("malformed cursor"))?;
        let k = key(&v)?;
        let ts = v["created_at"]
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| bad("invalid cursor timestamp"))?;
        rows.retain(|r| {
            let p = r["priority"].as_i64().unwrap_or(2);
            let rt = r["created_at"].as_f64().unwrap_or(0.0);
            p > k.0
                || p == k.0
                    && (rt > ts || rt == ts && r["id"].as_str().unwrap_or("") > k.2.as_str())
        });
    }
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        rows.last().map(|r| {
            json!({"priority":r["priority"],"created_at":r["created_at"],"id":r["id"]}).to_string()
        })
    } else {
        None
    };
    if let Some(fields) = a.get("fields") {
        let f = fields
            .as_array()
            .ok_or_else(|| bad("fields must be string array"))?;
        if f.iter().any(|v| !v.is_string()) {
            return Err(bad("fields must be string array"));
        }
        for row in &mut rows {
            let old = row.as_object().unwrap();
            let mut out = Map::new();
            for k in f {
                let k = k.as_str().unwrap();
                if let Some(v) = old.get(k) {
                    out.insert(k.into(), v.clone());
                }
            }
            *row = Value::Object(out);
        }
    }
    if cursor_mode {
        Ok(json!({"items":rows,"next_cursor":next}))
    } else {
        Ok(json!(rows))
    }
}
pub fn guard(c: &Connection, cmd: &str, a: &Value) -> R<()> {
    if !a.is_object() && cmd != "dep" {
        return Err(bad("arguments must be object"));
    }
    if a.get("epoch").is_some() {
        epoch(a)?;
    }
    if a.get("actor").is_some() {
        who(a)?;
    }
    if matches!(
        cmd,
        "create" | "q" | "goal" | "goal_create" | "goal-create" | "sub" | "subgoal"
    ) {
        budget(a.get("budget_eur"))?;
        if a.get("allowed_paths").is_some() {
            paths(a)?;
        }
        if a.get("meta").is_some_and(|m| !m.is_object()) {
            return Err(bad("meta must be object"));
        }
    }
    if matches!(
        cmd,
        "slot_acquire" | "slot-acquire" | "merge_slot" | "merge-slot"
    ) {
        who(a)?;
        ttl(a)?;
    }
    if matches!(cmd, "slot_release" | "slot-release") {
        who(a)?;
        epoch(a)?;
    }
    if cmd == "update" {
        expected(c, a)?;
        let set = a.get("set").unwrap_or(a);
        for k in [
            "status",
            "lease_until",
            "lease_epoch",
            "claim_actor",
            "claim_id",
            "closed_at",
            "proof",
            "proof_id",
            "cancel_requested",
        ] {
            if set.get(k).is_some() {
                return Err((
                    "forbidden_field".into(),
                    format!("worker update cannot mutate {k}"),
                ));
            }
        }
        budget(set.get("budget_eur"))?;
        if set.get("budget_eur") == Some(&Value::Null)
            && task(c, &req(a, "id")?)?["budget_eur"].is_number()
        {
            return Err(("over_budget".into(), "budget cannot be removed".into()));
        }
        if let Some(meta) = set.get("meta") {
            if meta.get("controller").is_some() || meta.get("review_required").is_some() {
                return Err((
                    "forbidden_field".into(),
                    "controller/review policy requires administrative mutation".into(),
                ));
            }
        }
        if let Some(v) = set.get("budget_eur").and_then(Value::as_f64) {
            let t = task(c, &req(a, "id")?)?;
            if t["budget_eur"].as_f64().is_none_or(|old| v > old) {
                return Err(("over_budget".into(), "budget cannot increase".into()));
            }
        }
    }
    if cmd == "plan" && a.get("template").is_none() {
        validate_plan(a)?;
    }
    if matches!(cmd, "budget_claim" | "budget-claim") {
        let v = a.get("eur").ok_or_else(|| bad("eur required"))?;
        budget(Some(v))?;
    }
    if matches!(cmd, "defer" | "undefer" | "delete" | "rename") {
        let id = gs(a, "id")
            .or_else(|| gs(a, "from"))
            .ok_or_else(|| bad("id required"))?;
        let t = task(c, &id)?;
        if t["status"] == "in_progress" {
            active(c, &{
                let mut a = a.clone();
                a["id"] = json!(id);
                a
            })?;
        }
    }
    Ok(())
}
pub fn authorize(cmd: &str, a: &Value) -> R<()> {
    if matches!(
        cmd,
        "admin_update" | "admin-update" | "import" | "sync_import" | "sync-import"
    ) {
        admin(a)?
    }
    Ok(())
}
pub fn dispatch(c: &Connection, cmd: &str, a: &Value, dbp: &str) -> Option<R<Value>> {
    Some(match cmd {
        "acquire" => claim(c, a, true, true),
        "claim" => claim(c, a, false, false),
        "claim_next" | "claim-next" => claim(c, a, true, false),
        "contract" => contract(c, a),
        "brief" => brief(c, a),
        "tokens" => tokens(a),
        "verify" => verify(c, a, dbp),
        "attest" => attest(c, a, dbp, None),
        "close" => close(c, a, dbp),
        "heartbeat" => heartbeat(c, a),
        "reopen" => reopen(c, a),
        "cancel" => cancel(c, a, false),
        "cancel_ack" | "cancel-ack" => cancel(c, a, true),
        "checkpoint" => checkpoint(c, a, dbp),
        "handoff" => handoff(c, a, dbp),
        "who" => op_who(c, a),
        "resume" => resume(c, a, dbp),
        "unclaim" => active(c, a).and_then(|_| {
            let v = op_unclaim(c, a)?;
            c.execute(
                "UPDATE issues SET lease_epoch=lease_epoch+1 WHERE id=?",
                params![req(a, "id")?],
            )
            .map_err(ie)?;
            Ok(v)
        }),
        "admin_update" | "admin-update" => admin(a).and_then(|_| {
            if !a.get("reason").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty()) {
                return Err(bad("administrative correction requires a reason"));
            }
            let mut safe = a.clone();
            redact(&mut safe);
            expected(c, &safe)?;
            op_update(c, &safe)
        }),
        "import" => admin(a).and_then(|_| op_import(c, a)),
        "ready" | "next" | "list" | "query" => paged(c, cmd, a),
        "prime" => dispatch(c,"capabilities",&json!({}),dbp).unwrap().map(|capabilities|
            json!({"protocol":"Superiss 0.9; explicit project DB; NDJSON Unix socket or CLI", "loop":"acquire(actor) -> work inside contract -> verify(id,actor,epoch,cwd) -> close(id,actor,epoch,proof_id) -> readback", "rules":["executable oracle and satisfied dependencies before dispatch","heartbeat before lease expiry","checkpoint and resume for recovery","mandatory acceptance survives token budgets","no mutation retry after uncertain transport"],"capabilities":capabilities})),
        "capabilities" => {
            let all = registry();
            let names: Vec<Value> = all
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|op| op["name"].clone())
                .collect();
            let mut result = json!({"schema":SCHEMA_VER,"schema_version":SCHEMA_VER,
                "version":"0.9.0","protocol":2,
                "project_id":c.query_row("SELECT v FROM kv WHERE k='project_id'",[],|r|r.get::<_,String>(0)).map_err(ie).ok(),
                "operations":names,"encodings":["o200k_base","cl100k_base"],
                "proof_receipts":true,"billing":false,"local_zero_execution":true});
            if a.get("schemas").and_then(Value::as_bool) == Some(true) {
                result["ops"] = all;
            }
            Ok(result)
        }
        "context" => (|| {
            let p = fs::canonicalize(dbp).unwrap_or_else(|_| PathBuf::from(dbp));
            Ok(
                json!({"project_id":c.query_row("SELECT v FROM kv WHERE k='project_id'",[],|r|r.get::<_,String>(0)).map_err(ie).ok(),"pid":std::process::id(),"instance_id":INSTANCE_ID.get_or_init(||gen_id("instance-")),"db_path":p,"capabilities":dispatch(c,"capabilities",a,dbp).unwrap()?,"stats":op_stats(c,a)?}),
            )
        })(),
        _ => return None,
    })
}
pub fn registry() -> Value {
    serde_json::from_str(include_str!("ops.json")).unwrap_or_else(|_| json!({"ops":[]}))["ops"]
        .clone()
}
pub fn mcp_registry() -> Vec<Value> {
    let compact = env::var("SIS_MCP_PROFILE").ok().as_deref() == Some("agent");
    registry()
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|v| {
            !compact
                || [
                    "acquire",
                    "heartbeat",
                    "checkpoint",
                    "resume",
                    "verify",
                    "close",
                    "brief",
                    "context",
                    "capabilities",
                    "cancel",
                    "cancel_ack",
                    "tokens",
                ]
                .contains(&v["name"].as_str().unwrap_or(""))
        })
        .cloned()
        .collect()
}
pub fn socket(dbp: &str) -> String {
    env::var("SIS_SOCK").unwrap_or_else(|_| {
        let p = fs::canonicalize(dbp).unwrap_or_else(|_| {
            let p = PathBuf::from(dbp);
            let p = if p.is_absolute() {
                p
            } else {
                env::current_dir().unwrap_or_default().join(p)
            };
            p.parent()
                .and_then(|parent| fs::canonicalize(parent).ok())
                .and_then(|parent| p.file_name().map(|name| parent.join(name)))
                .unwrap_or(p)
        });
        format!(
            "/tmp/sis-{}.sock",
            &digest(p.to_string_lossy().as_bytes())[..20]
        )
    })
}
static EVENTS: OnceLock<(Mutex<u64>, Condvar)> = OnceLock::new();
static INSTANCE_ID: OnceLock<String> = OnceLock::new();
fn events() -> &'static (Mutex<u64>, Condvar) {
    EVENTS.get_or_init(|| (Mutex::new(0), Condvar::new()))
}
pub fn serial() -> u64 {
    *events().0.lock().unwrap_or_else(|e| e.into_inner())
}
pub fn notify() {
    let (m, cv) = events();
    let mut n = m.lock().unwrap_or_else(|e| e.into_inner());
    *n += 1;
    cv.notify_all();
}
pub fn wait(serial: u64, duration: Duration) {
    let (m, cv) = events();
    let n = m.lock().unwrap_or_else(|e| e.into_inner());
    let _ = cv.wait_timeout_while(n, duration, |n| {
        *n == serial && !SHUTDOWN.load(Ordering::SeqCst)
    });
}
pub fn verify_request(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    execution_request(c, a, dbp, "verify")
}
pub fn attest_run_request(c: &Connection, a: &Value, dbp: &str) -> R<Value> {
    execution_request(c, a, dbp, "attest")
}
fn execution_request(c: &Connection, a: &Value, dbp: &str, cmd: &str) -> R<Value> {
    if !c.is_autocommit() {
        return Err(bad("verify cannot run inside batch"));
    }
    guard(c, cmd, a)?;
    let _lock = if let Some(idem) = gs(a, "idem") {
        use std::os::unix::fs::OpenOptionsExt;
        let db = fs::canonicalize(dbp).map_err(ie)?;
        let folder = db.parent().unwrap().join(".sis/verify-locks");
        fs::create_dir_all(&folder).map_err(ie)?;
        let key = digest(format!("{}\0{idem}", db.to_string_lossy()).as_bytes());
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(folder.join(key))
            .map_err(ie)?;
        let timeout = a
            .get("timeout_secs")
            .and_then(Value::as_u64)
            .filter(|n| (1..=300).contains(n))
            .unwrap_or(10)
            + 5;
        let started = std::time::Instant::now();
        loop {
            let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if ret == 0 {
                break;
            }
            if started.elapsed() >= Duration::from_secs(timeout) {
                return Err((
                    "busy".into(),
                    "bounded wait for verification exceeded".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Some(file)
    } else {
        None
    };
    if let Some(v) = idem_hit(c, cmd, a)? {
        return Ok(v);
    }
    if cmd == "attest" { attest_run(c, a, dbp) } else { verify(c, a, dbp) }
}
static CLIENTS: AtomicU64 = AtomicU64::new(0);
pub fn admit() -> bool {
    let max = env::var("SIS_MAX_CLIENTS")
        .ok()
        .and_then(|x| x.parse::<u64>().ok())
        .filter(|x| *x > 0 && *x <= 1024)
        .unwrap_or(64);
    if CLIENTS.fetch_add(1, Ordering::SeqCst) >= max {
        CLIENTS.fetch_sub(1, Ordering::SeqCst);
        false
    } else {
        true
    }
}
pub struct ClientGuard;
impl Drop for ClientGuard {
    fn drop(&mut self) {
        CLIENTS.fetch_sub(1, Ordering::SeqCst);
    }
}
pub fn http_request(st: &std::net::TcpStream) -> R<String> {
    let _ = st.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = st.set_write_timeout(Some(Duration::from_secs(10)));
    let mut rd = BufReader::new(st.try_clone().map_err(ie)?);
    let mut head = String::new();
    loop {
        let mut bytes = vec![];
        let n = std::io::BufRead::read_until(
            &mut std::io::Read::take(&mut rd, 16385),
            b'\n',
            &mut bytes,
        )
        .map_err(ie)?;
        if n == 0 {
            return Err(bad("incomplete HTTP headers"));
        }
        if head.len() + n > 16384 {
            return Err(bad("HTTP headers too large"));
        }
        let line = String::from_utf8(bytes).map_err(ie)?;
        head.push_str(&line);
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    let mut length = 0usize;
    let mut seen = false;
    for line in head.lines().skip(1) {
        if let Some((key, val)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding") {
                return Err(bad("transfer encoding unsupported"));
            }
            if key.eq_ignore_ascii_case("content-length") {
                if seen {
                    return Err(bad("duplicate content length"));
                }
                seen = true;
                length = val
                    .trim()
                    .parse()
                    .map_err(|_| bad("invalid content length"))?
            }
        }
    }
    if length > 1048576 {
        return Err(bad("HTTP body exceeds 1 MiB"));
    }
    let mut body = vec![0; length];
    rd.read_exact(&mut body).map_err(ie)?;
    head.push_str(&String::from_utf8(body).map_err(ie)?);
    Ok(head)
}

pub fn validate_plan(a: &Value) -> R<()> {
    let subs = a
        .get("subs")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("subs must be array"))?;
    for (i, s) in subs.iter().enumerate() {
        budget(s.get("budget_eur"))?;
        if let Some(ds) = s.get("deps") {
            for d in ds.as_array().ok_or_else(|| bad("deps must be array"))? {
                let j = d
                    .as_u64()
                    .ok_or_else(|| bad("dependency index must be integer"))?
                    as usize;
                if j >= subs.len() || i == j {
                    return Err(bad("dependency index must exist and be nonself"));
                }
            }
        }
    }
    Ok(())
}

pub fn decode_query(raw: &str) -> R<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = bytes
                .next()
                .ok_or_else(|| bad("incomplete percent encoding"))?;
            let low = bytes
                .next()
                .ok_or_else(|| bad("incomplete percent encoding"))?;
            let pair = [high, low];
            let hex = std::str::from_utf8(&pair).map_err(|_| bad("invalid percent encoding"))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad("invalid percent encoding"))?);
        } else {
            out.push(if byte == b'+' { b' ' } else { byte });
        }
    }
    String::from_utf8(out).map_err(|_| bad("query is not UTF-8"))
}

pub fn cursor_filter(a: &Value, sql: &mut String, values: &mut Vec<types::Value>) -> R<()> {
    if let Some(cur) = a.get("_after") {
        let priority = cur["priority"]
            .as_i64()
            .ok_or_else(|| bad("invalid cursor priority"))?;
        let created = cur["created_at"]
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| bad("invalid cursor timestamp"))?;
        let id = cur["id"].as_str().ok_or_else(|| bad("invalid cursor id"))?;
        sql.push_str(" AND (i.priority,i.created_at,i.id)>(?,?,?)");
        values.extend([
            types::Value::Integer(priority),
            types::Value::Real(created),
            types::Value::Text(id.into()),
        ]);
    }
    Ok(())
}
