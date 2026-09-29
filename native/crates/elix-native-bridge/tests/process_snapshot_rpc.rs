use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn request(stdin: &mut impl Write, stdout: &mut impl BufRead, payload: Value) -> Value {
    writeln!(stdin, "{}", payload).expect("write native request");
    stdin.flush().expect("flush native request");
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read native response");
    serde_json::from_str(&line).expect("parse native response")
}

#[test]
fn process_snapshot_rpc_advertises_and_returns_stable_host_identity() {
    let exe = env!("CARGO_BIN_EXE_elix-native-host");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn elix-native-host");
    let host_pid = child.id();

    let mut stdin = child.stdin.take().expect("host stdin");
    let stdout = child.stdout.take().expect("host stdout");
    let mut stdout = BufReader::new(stdout);

    let handshake = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 1,
            "method": "bridge/handshake",
            "params": { "protocolVersion": 1, "clientVersion": "phase16d-test" }
        }),
    );
    assert_eq!(
        handshake["result"]["capabilities"]["processObservation"],
        json!(true)
    );

    let snapshot = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 2, "method": "process/getSnapshot", "params": {} }),
    );
    assert!(snapshot.get("error").is_none());
    let result = snapshot.get("result").expect("process snapshot result");
    assert!(result["capturedAt"].as_u64().unwrap_or(0) > 0);

    let processes = result["processes"].as_array().expect("process array");
    assert!(!processes.is_empty());
    assert!(processes.windows(2).all(|pair| {
        pair[0]["processId"].as_u64().unwrap_or(0)
            <= pair[1]["processId"].as_u64().unwrap_or(0)
    }));

    let host = processes
        .iter()
        .find(|process| process["processId"].as_u64() == Some(host_pid as u64))
        .expect("native host process present in its own snapshot");
    assert!(host["processCreationTime"].as_u64().unwrap_or(0) > 0);
    assert!(host["executableName"]
        .as_str()
        .is_some_and(|name| !name.trim().is_empty()));

    let shutdown = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 3, "method": "bridge/shutdown", "params": {} }),
    );
    assert_eq!(shutdown["result"]["ok"], json!(true));

    drop(stdin);
    let status = child.wait().expect("wait native host");
    assert!(status.success());
}
