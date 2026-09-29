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
fn window_control_rpc_advertises_capability_and_rejects_unsafe_targets() {
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
            "params": { "protocolVersion": 1, "clientVersion": "phase14-test" }
        }),
    );
    assert_eq!(
        handshake["result"]["capabilities"]["windowControl"],
        json!(true)
    );

    let missing_lifetime = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 2,
            "method": "windowControl/execute",
            "params": {
                "action": "activate",
                "target": {
                    "hwnd": 1,
                    "processId": 1,
                    "threadId": 1,
                    "processCreationTime": 0,
                    "className": "DefinitelyNotAWindow"
                }
            }
        }),
    );
    assert_eq!(missing_lifetime["error"]["domain"], json!("window-control"));
    assert_eq!(
        missing_lifetime["error"]["code"],
        json!("IDENTITY_UNVERIFIABLE")
    );

    let missing_class = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 3,
            "method": "windowControl/execute",
            "params": {
                "action": "activate",
                "target": {
                    "hwnd": 1,
                    "processId": 1,
                    "threadId": 1,
                    "processCreationTime": 1,
                    "className": "   "
                }
            }
        }),
    );
    assert_eq!(missing_class["error"]["domain"], json!("window-control"));
    assert_eq!(
        missing_class["error"]["code"],
        json!("IDENTITY_UNVERIFIABLE")
    );

    let stale = request(
        &mut stdin,
        &mut stdout,
        json!({
            "id": 4,
            "method": "windowControl/execute",
            "params": {
                "action": "activate",
                "target": {
                    "hwnd": 1,
                    "processId": 1,
                    "threadId": 1,
                    "processCreationTime": 1,
                    "className": "DefinitelyNotAWindow"
                }
            }
        }),
    );
    assert_eq!(stale["error"]["domain"], json!("window-control"));
    assert_eq!(stale["error"]["code"], json!("STALE_WINDOW"));

    let shutdown = request(
        &mut stdin,
        &mut stdout,
        json!({ "id": 5, "method": "bridge/shutdown", "params": {} }),
    );
    assert_eq!(shutdown["result"]["ok"], json!(true));

    drop(stdin);
    let status = child.wait().expect("wait native host");
    assert!(status.success());
}
