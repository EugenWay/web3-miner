#![no_std]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use sails_rs::prelude::*;

// ---- Domain types ----------------------------------------------------------

/// Per-player profile stored on-chain.
#[derive(Default, Clone, Encode, Decode, TypeInfo)]
pub struct Profile {
    /// Best single-run score the player has ever submitted.
    pub high_score: u128,
    /// Total runs ended (death or win → submit_run was called).
    pub runs_completed: u64,
}

/// One row of the leaderboard, returned by `top_players`.
#[derive(Clone, Encode, Decode, TypeInfo)]
pub struct LeaderboardEntry {
    pub player: ActorId,
    pub high_score: u128,
    pub runs_completed: u64,
}

/// Service events. The contract is voucher-only — no value transfers
/// — so events are limited to score lifecycle.
#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ProfileEvent {
    /// `submit_run` improved the caller's high score.
    NewHighScore { player: ActorId, score: u128 },
    /// `submit_run` was called — emitted on every run end (win or death).
    RunSubmitted { player: ActorId, score: u128 },
}

// ---- Service state ---------------------------------------------------------

struct ProfileStore {
    profiles: BTreeMap<ActorId, Profile>,
}

static mut STORE: Option<ProfileStore> = None;

#[allow(static_mut_refs)]
fn store() -> &'static mut ProfileStore {
    // Single-threaded WASM — Sails actor model means no concurrent access.
    unsafe {
        let ptr = &raw mut STORE;
        (*ptr).get_or_insert_with(|| ProfileStore {
            profiles: BTreeMap::new(),
        })
    }
}

// ---- Service ---------------------------------------------------------------

pub struct RoboMinerProfile(());

impl RoboMinerProfile {
    pub fn create() -> Self {
        let _ = store();
        Self(())
    }
}

#[sails_rs::service(events = ProfileEvent)]
impl RoboMinerProfile {
    /// Records a finished run (death-with-end OR diamond win).
    /// `score` = money_at_run_end + (50_000 if diamond_won). If it
    /// beats the player's existing high score, also fires NewHighScore.
    /// Always increments runs_completed.
    ///
    /// Player pays no value — this is voucher-friendly. Sponsor covers
    /// gas via a Vara voucher targeting this program.
    #[export]
    pub fn submit_run(&mut self, score: u128) {
        let player = sails_rs::gstd::msg::source();
        let entry = store().profiles.entry(player).or_default();
        entry.runs_completed = entry.runs_completed.saturating_add(1);
        if score > entry.high_score {
            entry.high_score = score;
            self.emit_event(ProfileEvent::NewHighScore { player, score })
                .expect("event emit failed");
        }
        self.emit_event(ProfileEvent::RunSubmitted { player, score })
            .expect("event emit failed");
    }

    /// Wipe the caller's profile. Useful for tests / fresh restart.
    #[export]
    pub fn reset_self(&mut self) {
        let player = sails_rs::gstd::msg::source();
        store().profiles.remove(&player);
    }

    // ---- Queries -----------------------------------------------------------

    /// Profile for `player`. Defaults to all-zeros if never submitted.
    #[export]
    pub fn profile(&self, player: ActorId) -> Profile {
        store().profiles.get(&player).cloned().unwrap_or_default()
    }

    /// Number of distinct players who've submitted at least one run.
    #[export]
    pub fn total_players(&self) -> u64 {
        store().profiles.len() as u64
    }

    /// Top N players by `high_score`, descending. Limit clamped to 50
    /// for gas safety.
    #[export]
    pub fn top_players(&self, limit: u32) -> Vec<LeaderboardEntry> {
        const MAX_LEADERBOARD: u32 = 50;
        let n = limit.min(MAX_LEADERBOARD) as usize;
        if n == 0 {
            return Vec::new();
        }
        let mut all: Vec<LeaderboardEntry> = store()
            .profiles
            .iter()
            .map(|(player, p)| LeaderboardEntry {
                player: *player,
                high_score: p.high_score,
                runs_completed: p.runs_completed,
            })
            .collect();
        all.sort_by(|a, b| {
            b.high_score
                .cmp(&a.high_score)
                .then_with(|| b.runs_completed.cmp(&a.runs_completed))
        });
        all.truncate(n);
        all
    }
}

// ---- Program ---------------------------------------------------------------

#[derive(Default)]
pub struct Program(());

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        Self(())
    }

    pub fn robo_miner_profile(&self) -> RoboMinerProfile {
        RoboMinerProfile::create()
    }
}
