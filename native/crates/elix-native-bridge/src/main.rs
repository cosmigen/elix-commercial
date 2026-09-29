//! ELIX Native Host
//!
//! Persistent local native host process exposing typed domain capabilities over stdio IPC.
//!
//! ### Outbound Queue Capacity and Overflow Policy
//! - **Responses**: Handled via a bounded channel of capacity 256 (`DEFAULT_RESPONSE_CAPACITY`).
//! - **Priority Signals**: Container invalidation (`container-invalidated`) and process-wide latest
//!   state events remain in sticky state until stdout acknowledges the exact frame version written.
//!   A capacity-one wake channel coalesces writer notification; repeated pressure does not create
//!   an unbounded event queue.
//! - **Droppable Events**: Ordinary fine-grained push events (`added`, `removed`, `modified`, `renamed`)
//!   are bounded at 1,024 events (`DEFAULT_EVENT_QUEUE_CAPACITY`).
//! - **Saturation Behavior**: When the outbound queue fills or aggregate budget (2,048 events) is reached,
//!   fine-grained events are dropped at the native boundary. The affected container transitions to
//!   degraded/invalidated state, and a guaranteed `container-invalidated` signal is dispatched to
//!   trigger authoritative reconciliation once pressure subsides.

pub mod dispatcher;
pub mod global_input_rpc;
pub mod outbound;
pub mod preview_rpc;
pub mod protocol;

use crossbeam_channel::bounded;
use dispatcher::Dispatcher;
use outbound::sticky_priority_queue;
use protocol::{read_bounded_frame, BridgeEvent, BridgeRequest, BridgeResponse, FrameRead};
use std::io::{self, Write};
use std::sync::Arc;
use std::thread;

/// Maximum capacity for the response queue.
pub const DEFAULT_RESPONSE_CAPACITY: usize = 256;

/// Maximum capacity for ordinary fine-grained push events before saturation dropping.
pub const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 1024;

fn main() {
    // Install panic hook that logs structured info to stderr (leaving stdout pure JSON)
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[ELIX Native Host Panic] {}", info);
    }));

    // Establish centralized Multi-Threaded Apartment (MTA) policy for host process.
    let _com = match elix_native_core::runtime::apartment::ComApartment::mta() {
        Ok(apartment) => apartment,
        Err(error) => {
            respond_to_first_request_with_startup_error(error);
            return;
        }
    };

    // Explicitly bounded channels for responses, priority events, and droppable fine-grained events
    let (resp_tx, resp_rx) = bounded::<BridgeResponse>(DEFAULT_RESPONSE_CAPACITY);
    let (prio_tx, prio_rx) = sticky_priority_queue();
    let (drop_tx, drop_rx) = bounded::<BridgeEvent>(DEFAULT_EVENT_QUEUE_CAPACITY);

    let watcher = Arc::new(elix_native_core::watcher::NativeNamespaceWatcher::new());
    let watcher_for_writer = Arc::clone(&watcher);

    // Dedicated stdout writer thread guaranteeing atomic newline-delimited framing and prioritized delivery
    let stdout_writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut handle = stdout.lock();

        let write_line = |handle: &mut io::StdoutLock, json_str: &str| -> io::Result<()> {
            writeln!(handle, "{}", json_str)?;
            handle.flush()
        };

        let write_event = |handle: &mut io::StdoutLock, ev: BridgeEvent| -> io::Result<()> {
            if let Ok(s) = serde_json::to_string(&ev) {
                write_line(handle, &s)?;
            }
            if let Some(sub_id) = ev.subscription_id {
                watcher_for_writer.event_consumed(sub_id);
            }
            Ok(())
        };

        loop {
            // Sticky priority state gets one bounded-latency turn even under continuous RPC load.
            // Do not immediately continue afterward: the response queue gets a turn too, preventing
            // rapid foreground-geometry/topology updates from starving request/response traffic.
            if let Some((subscription_id, version, ev)) = prio_rx.peek() {
                if write_event(&mut handle, ev).is_err() {
                    break;
                }
                prio_rx.acknowledge(subscription_id, version);
            }

            if let Ok(res) = resp_rx.try_recv() {
                if let Ok(s) = serde_json::to_string(&res) {
                    if write_line(&mut handle, &s).is_err() {
                        break;
                    }
                }
                continue;
            }

            // Block on select across channels.
            crossbeam_channel::select! {
                recv(resp_rx) -> msg => {
                    match msg {
                        Ok(res) => {
                            if let Ok(s) = serde_json::to_string(&res) {
                                if write_line(&mut handle, &s).is_err() {
                                    break;
                                }
                            }
                        }
                        Err(_) => break, // Channel closed
                    }
                },
                recv(prio_rx.wake_receiver()) -> msg => {
                    if msg.is_err() {
                        break;
                    }
                },
                recv(drop_rx) -> msg => {
                    match msg {
                        Ok(ev) => {
                            if write_event(&mut handle, ev).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                },
            }
        }
    });

    let dispatcher = Dispatcher::with_watcher(watcher, prio_tx.clone(), drop_tx);
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let frame = match read_bounded_frame(&mut input, protocol::MAX_REQUEST_FRAME_BYTES) {
            Ok(FrameRead::Frame(frame)) => frame,
            Ok(FrameRead::TooLarge) => {
                let _ = resp_tx.send(BridgeResponse::error(
                    0,
                    elix_native_core::error::NativeError::invalid_argument(format!(
                        "NDJSON request frame exceeds {} bytes",
                        protocol::MAX_REQUEST_FRAME_BYTES
                    )),
                ));
                continue;
            }
            Ok(FrameRead::Eof) | Err(_) => break,
        };

        let line = match String::from_utf8(frame) {
            Ok(line) => line,
            Err(error) => {
                let _ = resp_tx.send(BridgeResponse::error(
                    0,
                    elix_native_core::error::NativeError::invalid_argument(format!(
                        "NDJSON request is not valid UTF-8: {}",
                        error
                    )),
                ));
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: BridgeRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(parse_err) => {
                let _ = resp_tx.send(BridgeResponse::error(
                    0,
                    elix_native_core::error::NativeError::invalid_argument(format!(
                        "Invalid JSON-RPC request: {}",
                        parse_err
                    )),
                ));
                continue;
            }
        };

        let is_shutdown = request.method == "bridge/shutdown";
        let response = if global_input_rpc::handles(&request.method) {
            global_input_rpc::dispatch(request)
        } else if preview_rpc::handles(&request.method) {
            preview_rpc::dispatch(request)
        } else {
            dispatcher.dispatch(request)
        };
        let _ = resp_tx.send(response);

        if is_shutdown {
            break;
        }
    }

    // Clean disposal of native resources, including registered global hotkeys and DWM thumbnails.
    global_input_rpc::dispose_all();
    let _ = elix_native_core::window_preview::dispose_all();
    dispatcher.dispose();
    drop(dispatcher);

    // Drop channels to allow stdout writer to flush and terminate
    drop(resp_tx);
    drop(prio_tx);
    let _ = stdout_writer.join();
}

fn respond_to_first_request_with_startup_error(error: elix_native_core::error::NativeError) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let request_id = match read_bounded_frame(&mut input, protocol::MAX_REQUEST_FRAME_BYTES) {
        Ok(FrameRead::Frame(frame)) => serde_json::from_slice::<BridgeRequest>(&frame)
            .map(|request| request.id)
            .unwrap_or(0),
        _ => 0,
    };
    if let Ok(frame) = serde_json::to_string(&BridgeResponse::error(request_id, error)) {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", frame);
        let _ = handle.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::BridgeRequest;
    use serde_json::json;

    fn create_test_dispatcher() -> Dispatcher {
        let (prio_tx, _prio_rx) = sticky_priority_queue();
        let (drop_tx, _drop_rx) = bounded(16);
        Dispatcher::new(prio_tx, drop_tx)
    }

    #[test]
    fn test_dispatcher_handshake() {
        let dispatcher = create_test_dispatcher();

        let req = BridgeRequest {
            id: 1,
            method: "bridge/handshake".to_string(),
            params: json!({ "protocolVersion": 1, "clientVersion": "0.1.0" }),
        };

        let resp = dispatcher.dispatch(req);
        assert_eq!(resp.id, 1);
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());

        let res_val = resp.result.unwrap();
        assert_eq!(
            res_val.get("protocolVersion").and_then(|v| v.as_u64()),
            Some(1)
        );
    }

    #[test]
    fn test_dispatcher_ping() {
        let dispatcher = create_test_dispatcher();

        let req = BridgeRequest {
            id: 2,
            method: "bridge/ping".to_string(),
            params: json!({}),
        };

        let resp = dispatcher.dispatch(req);
        assert_eq!(resp.id, 2);
        assert!(resp.result.is_some());
        let res_val = resp.result.unwrap();
        assert!(res_val.get("timestamp").is_some());
    }

    #[test]
    fn test_dispatcher_rejects_incompatible_protocol() {
        let dispatcher = create_test_dispatcher();
        let response = dispatcher.dispatch(BridgeRequest {
            id: 5,
            method: "bridge/handshake".to_string(),
            params: json!({ "protocolVersion": 2, "clientVersion": "0.1.0" }),
        });

        assert_eq!(response.error.unwrap().code, "INCOMPATIBLE_PROTOCOL");
    }

    #[test]
    fn test_dispatcher_rejects_oversized_shortcut_batch() {
        let dispatcher = create_test_dispatcher();
        let paths = vec!["test.lnk"; protocol::MAX_SHORTCUT_BATCH_ITEMS + 1];
        let response = dispatcher.dispatch(BridgeRequest {
            id: 6,
            method: "shortcuts/resolveBatch".to_string(),
            params: json!({ "paths": paths }),
        });

        assert_eq!(response.error.unwrap().code, "INVALID_ARGUMENT");
    }

    #[test]
    fn test_dispatcher_known_folders() {
        let dispatcher = create_test_dispatcher();

        let req = BridgeRequest {
            id: 3,
            method: "knownFolders/resolve".to_string(),
            params: json!({ "id": "Desktop" }),
        };

        let resp = dispatcher.dispatch(req);
        assert_eq!(resp.id, 3);
        assert!(resp.result.is_some());
    }

    #[test]
    fn test_dispatcher_unknown_method() {
        let dispatcher = create_test_dispatcher();

        let req = BridgeRequest {
            id: 4,
            method: "unknown/method".to_string(),
            params: json!({}),
        };

        let resp = dispatcher.dispatch(req);
        assert_eq!(resp.id, 4);
        assert!(resp.error.is_some());
        let err = resp.error.unwrap();
        assert_eq!(err.code, "METHOD_NOT_FOUND");
    }

    #[test]
    fn test_dispatcher_app_bar() {
        let dispatcher = create_test_dispatcher();

        // Register
        let reg_req = BridgeRequest {
            id: 10,
            method: "appBar/register".to_string(),
            params: json!({
                "id": "bridge-test-bar",
                "edge": "top",
                "rect": { "x": 0, "y": 0, "width": 1920, "height": 40 }
            }),
        };
        let resp = dispatcher.dispatch(reg_req);
        assert_eq!(resp.id, 10);
        // May succeed or return valid error on non-interactive test
        if resp.error.is_none() {
            // Get registered
            let get_req = BridgeRequest {
                id: 11,
                method: "appBar/getRegistered".to_string(),
                params: json!({}),
            };
            let get_resp = dispatcher.dispatch(get_req);
            assert_eq!(get_resp.id, 11);
            assert!(get_resp.result.is_some());

            // Unregister
            let unreg_req = BridgeRequest {
                id: 12,
                method: "appBar/unregister".to_string(),
                params: json!({ "id": "bridge-test-bar" }),
            };
            let unreg_resp = dispatcher.dispatch(unreg_req);
            assert_eq!(unreg_resp.id, 12);
            assert!(unreg_resp.result.is_some());
        }
        dispatcher.dispose();
    }
}
