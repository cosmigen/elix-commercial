//! Bounded outbound event coordination for the native bridge.

use crate::protocol::BridgeEvent;
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

#[derive(Clone)]
struct StickyPriorityEntry {
    version: u64,
    event: BridgeEvent,
}

#[derive(Default)]
struct StickyPriorityState {
    order: VecDeque<u64>,
    pending: HashMap<u64, StickyPriorityEntry>,
    next_version: u64,
}

impl StickyPriorityState {
    fn next_version(&mut self) -> u64 {
        self.next_version = self.next_version.wrapping_add(1);
        // Version zero is reserved only as the initial counter value. Wrapping is practically
        // unreachable, but skipping zero keeps acknowledgement identity unambiguous.
        if self.next_version == 0 {
            self.next_version = 1;
        }
        self.next_version
    }
}

/// Producer for priority events that remain pending until the stdout writer acknowledges them.
#[derive(Clone)]
pub struct StickyPrioritySender {
    state: Arc<Mutex<StickyPriorityState>>,
    wake_tx: Sender<()>,
}

/// Consumer for deduplicated priority events.
pub struct StickyPriorityReceiver {
    state: Arc<Mutex<StickyPriorityState>>,
    wake_rx: Receiver<()>,
}

/// Creates a sticky priority queue with a single coalesced writer wake-up.
pub fn sticky_priority_queue() -> (StickyPrioritySender, StickyPriorityReceiver) {
    let state = Arc::new(Mutex::new(StickyPriorityState::default()));
    let (wake_tx, wake_rx) = bounded(1);
    (
        StickyPrioritySender {
            state: Arc::clone(&state),
            wake_tx,
        },
        StickyPriorityReceiver { state, wake_rx },
    )
}

impl StickyPrioritySender {
    /// Retains at most one pending invalidation for a native subscription.
    pub fn send(&self, subscription_id: u64, event: BridgeEvent) {
        let mut state = self.state.lock();
        if !state.pending.contains_key(&subscription_id) {
            let version = state.next_version();
            state.order.push_back(subscription_id);
            state
                .pending
                .insert(subscription_id, StickyPriorityEntry { version, event });
        }
        drop(state);

        // A full wake channel already guarantees that the writer will inspect sticky state.
        let _ = self.wake_tx.try_send(());
    }

    /// Retains only the newest pending event for a process-wide state key.
    ///
    /// Each replacement receives a new version. The writer acknowledges the version it actually
    /// wrote, so an event that arrives after `peek()` but before stdout completion cannot be
    /// deleted by the stale acknowledgement.
    pub fn send_latest(&self, key: u64, event: BridgeEvent) {
        let mut state = self.state.lock();
        let version = state.next_version();
        if !state.pending.contains_key(&key) {
            state.order.push_back(key);
        }
        state
            .pending
            .insert(key, StickyPriorityEntry { version, event });
        drop(state);
        let _ = self.wake_tx.try_send(());
    }

    /// Removes a pending priority event when its owning subscription is destroyed.
    pub fn remove(&self, subscription_id: u64) {
        let mut state = self.state.lock();
        state.pending.remove(&subscription_id);
        state.order.retain(|id| *id != subscription_id);
    }
}

impl StickyPriorityReceiver {
    /// Returns the oldest pending event without consuming it.
    pub fn peek(&self) -> Option<(u64, u64, BridgeEvent)> {
        let mut state = self.state.lock();
        while let Some(subscription_id) = state.order.front().copied() {
            if let Some(entry) = state.pending.get(&subscription_id) {
                return Some((subscription_id, entry.version, entry.event.clone()));
            }
            state.order.pop_front();
        }
        None
    }

    /// Acknowledges only the exact event version that was written successfully.
    ///
    /// If a newer `send_latest()` replacement arrived after the writer's `peek()`, the stale
    /// acknowledgement must not delete it. The still-pending key is rotated to the back so a
    /// continuously changing state stream cannot starve faults or watcher invalidations behind it.
    pub fn acknowledge(&self, subscription_id: u64, version: u64) {
        let mut state = self.state.lock();
        let matches_current = state
            .pending
            .get(&subscription_id)
            .is_some_and(|entry| entry.version == version);
        if !matches_current {
            if state.pending.contains_key(&subscription_id)
                && state.order.front() == Some(&subscription_id)
            {
                state.order.pop_front();
                state.order.push_back(subscription_id);
            }
            return;
        }
        state.pending.remove(&subscription_id);
        if state.order.front() == Some(&subscription_id) {
            state.order.pop_front();
        } else {
            state.order.retain(|id| *id != subscription_id);
        }
    }

    /// Returns the coalesced wake receiver used by the stdout writer.
    pub fn wake_receiver(&self) -> &Receiver<()> {
        &self.wake_rx
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.state.lock().pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn invalidation(subscription_id: u64) -> BridgeEvent {
        BridgeEvent {
            event: "watcher/change".to_string(),
            payload: json!({
                "subscriptionId": subscription_id,
                "changeType": "container-invalidated"
            }),
            subscription_id: None,
        }
    }

    fn context_change(revision: u64) -> BridgeEvent {
        BridgeEvent {
            event: "windowsContext/change".to_string(),
            payload: json!({ "snapshot": { "revision": revision } }),
            subscription_id: None,
        }
    }

    #[test]
    fn saturation_keeps_one_sticky_invalidation_per_subscription() {
        let (sender, receiver) = sticky_priority_queue();

        sender.send(1, invalidation(1));
        for _ in 0..1_000 {
            sender.send(1, invalidation(1));
        }
        sender.send(2, invalidation(2));

        assert_eq!(receiver.pending_len(), 2);
        assert!(receiver.wake_receiver().try_recv().is_ok());
        assert!(receiver.wake_receiver().try_recv().is_err());

        let (first_id, first_version, _) =
            receiver.peek().expect("first invalidation remains pending");
        assert_eq!(first_id, 1);
        assert_eq!(receiver.pending_len(), 2);
        receiver.acknowledge(first_id, first_version);

        let (second_id, second_version, _) = receiver
            .peek()
            .expect("second invalidation remains pending");
        assert_eq!(second_id, 2);
        receiver.acknowledge(second_id, second_version);
        assert_eq!(receiver.pending_len(), 0);
    }

    #[test]
    fn latest_state_replacement_survives_stale_writer_acknowledgement() {
        let (sender, receiver) = sticky_priority_queue();
        let key = u64::MAX;

        sender.send_latest(key, context_change(1));
        let (_, first_version, first_event) = receiver.peek().expect("first state");
        assert_eq!(first_event.payload["snapshot"]["revision"], 1);

        // Simulate a new topology/fullscreen replacement arriving while stdout is still writing
        // the frame returned by the first peek.
        sender.send_latest(key, context_change(2));
        receiver.acknowledge(key, first_version);

        let (_, second_version, second_event) = receiver
            .peek()
            .expect("newer state must remain pending after stale acknowledgement");
        assert_ne!(second_version, first_version);
        assert_eq!(second_event.payload["snapshot"]["revision"], 2);

        receiver.acknowledge(key, second_version);
        assert_eq!(receiver.pending_len(), 0);
    }

    #[test]
    fn stale_latest_ack_rotates_key_so_other_priority_events_make_progress() {
        let (sender, receiver) = sticky_priority_queue();
        let context_key = u64::MAX;
        let watcher_key = 7;

        sender.send_latest(context_key, context_change(1));
        let (_, first_version, _) = receiver.peek().expect("context state");
        sender.send(watcher_key, invalidation(watcher_key));
        sender.send_latest(context_key, context_change(2));

        receiver.acknowledge(context_key, first_version);
        let (next_key, watcher_version, _) = receiver
            .peek()
            .expect("watcher invalidation must not be starved by replaced context state");
        assert_eq!(next_key, watcher_key);
        receiver.acknowledge(watcher_key, watcher_version);

        let (final_key, final_version, final_event) = receiver
            .peek()
            .expect("latest context state remains pending");
        assert_eq!(final_key, context_key);
        assert_eq!(final_event.payload["snapshot"]["revision"], 2);
        receiver.acknowledge(context_key, final_version);
        assert_eq!(receiver.pending_len(), 0);
    }
}
