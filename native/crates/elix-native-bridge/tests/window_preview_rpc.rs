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
fn preview_rpc_advertises_capability_rejects_invalid_windows_and_leaks_nothing() {
    let exe = env!("CARGO_BIN_EXE_elix-native-host");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn elix-native-host");

    let mut stdin = child.stdin.take().expect("host stdin");
    let stdout = child.stdout.take().expect("host stdout");
    let mut stdout = BufReader::new(stdout);

    let handshake = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 1,
            "method": "bridge/handshake",
            "params": { "protocolVersion": 1, "clientVersion": "phase17a-test" }
        }),
    );
    assert_eq!(
        handshake["result"]["capabilities"]["windowPreview"],
        json!(true)
    );

    let before = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 2, "method": "preview/getActive", "params": {} }),
    );
    assert_eq!(before["result"]["previews"], json!([]));

    let invalid = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 3,
            "method": "preview/register",
            "params": {
                "id": "invalid",
                "sourceHwnd": 1,
                "destinationHwnd": 2,
                "destinationRect": { "x": 0, "y": 0, "width": 320, "height": 180 },
                "opacity": 255,
                "visible": true,
                "sourceClientAreaOnly": false,
                "processId": 0,
                "processCreationTime": 0.0
            }
        }),
    );
    assert!(invalid.get("error").is_some());

    let stale = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 4,
            "method": "preview/register",
            "params": {
                "id": "stale-preview",
                "sourceHwnd": 1,
                "destinationHwnd": 2,
                "destinationRect": { "x": 0, "y": 0, "width": 320, "height": 180 },
                "opacity": 255,
                "visible": true,
                "sourceClientAreaOnly": false,
                "processId": 999999,
                "processCreationTime": 123456.0
            }
        }),
    );
    assert!(stale.get("error").is_some());

    let after = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 5, "method": "preview/getActive", "params": {} }),
    );
    assert_eq!(after["result"]["previews"], json!([]));

    let dispose = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 6, "method": "preview/disposeAll", "params": {} }),
    );
    assert_eq!(dispose["result"]["disposed"], json!(0));

    let shutdown = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 7, "method": "bridge/shutdown", "params": {} }),
    );
    assert_eq!(shutdown["result"]["ok"], json!(true));

    drop(stdin);
    let status = child.wait().expect("wait native host");
    assert!(status.success());
}
