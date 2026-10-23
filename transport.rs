use super::*;
use std::io::Read;

fn exchange(reader: &mut BufReader<UnixStream>, request: &Value) -> R<Value> {
    let frame = request.to_string() + "\n";
    if frame.len() > 1024 * 1024 {
        return Err(bad("request exceeds 1 MiB"));
    }
    reader.get_mut().write_all(frame.as_bytes()).map_err(ie)?;
    let mut bytes = Vec::new();
    (&mut *reader)
        .take(4 * 1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(ie)?;
    if bytes.len() > 4 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
        return Err((
            "transport".into(),
            "incomplete or oversized response; reconcile before retry".into(),
        ));
    }
    serde_json::from_slice(&bytes).map_err(ie)
}

pub fn request(db: &str, cmd: &str, args: &Value) -> R<Option<Value>> {
    if env::var("SIS_DIRECT").ok().as_deref() == Some("1") {
        return Ok(None);
    }
    let path = agent::socket(db);
    let socket = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(ie(e)),
    };
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(ie)?;
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(ie)?;
    let mut reader = BufReader::new(socket);
    let identity = exchange(&mut reader, &json!({"cmd":"context","args":{}}))?;
    let data = &identity["data"];
    let expected = fs::canonicalize(db).map_err(ie)?;
    let actual = data["db_path"]
        .as_str()
        .and_then(|p| fs::canonicalize(p).ok());
    if identity["ok"] != true
        || actual.as_ref() != Some(&expected)
        || data
            .pointer("/capabilities/protocol")
            .and_then(Value::as_i64)
            != Some(2)
        || data
            .pointer("/capabilities/proof_receipts")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(("transport_identity".into(), "daemon database or contract differs; upgrade the owned daemon or explicitly use SIS_DIRECT=1".into()));
    }
    if cmd == "context" {
        return Ok(Some(identity));
    }
    if data.pointer("/capabilities/schema_version").and_then(Value::as_i64) != Some(SCHEMA_VER) {
        return Err(("transport_identity".into(), "daemon schema differs; upgrade only an owned idle daemon, or use a separate project store".into()));
    }
    if data.pointer("/capabilities/local_zero_execution").and_then(Value::as_bool) != Some(true) {
        return Err(("transport_identity".into(), "daemon execution policy differs; upgrade an owned idle daemon or explicitly use SIS_DIRECT=1".into()));
    }
    let seconds = if cmd == "verify" || (cmd == "attest" && args["kind"] == "run") {
        gf(args, "timeout_secs").unwrap_or(10.0) + 5.0
    } else if cmd == "watch" {
        gf(args, "wait").unwrap_or(0.0) + 5.0
    } else {
        15.0
    };
    let timeout = seconds.clamp(15.0, 305.0);
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs_f64(timeout)))
        .map_err(ie)?;
    // No direct retry after transmission: the daemon may already have committed.
    exchange(&mut reader, &json!({"cmd":cmd,"args":args})).map(Some)
}
