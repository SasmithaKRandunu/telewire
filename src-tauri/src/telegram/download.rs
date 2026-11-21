//! The chunked, parallel, crash-safe download engine (Plan.md §11).
//!
//! Shape of one transfer:
//!
//! ```text
//!   file size ──► chunk plan (512 KiB units) ──► shared pending queue
//!                                                      │
//!            ┌────────────┬────────────┬───────────────┤  workers pull
//!         worker 0     worker 1     worker 2  …        ▼  the next index
//!            │            │            │
//!            └──── seek + write into <name>.part ──────┘
//!                          │
//!                   manifest.json (which chunks are confirmed on disk)
//!                          │
//!            all chunks done ──► verify length ──► rename to <name>
//! ```
//!
//! Four design points worth stating, because each replaces an obvious-but-worse
//! alternative:
//!
//! 1. **A shared queue of chunk indices *is* the work-stealing scheme** (§11.5).
//!    Statically slicing the file into N ranges makes the whole job wait on its
//!    slowest range. Here a slow connection simply takes fewer chunks, and the
//!    tail of the file is picked up by whichever worker is free.
//! 2. **Chunks are a fixed 512 KiB at 512 KiB-aligned offsets**, including the
//!    final short one. Telegram requires `limit` to divide 1 MiB, `offset` to be
//!    a multiple of 4 KiB, and a request never to straddle a 1 MiB boundary;
//!    512 KiB alignment satisfies all three by construction, and the server
//!    simply returns fewer bytes at end-of-file.
//! 3. **The manifest is the source of truth for resume** (§11.7). It records
//!    only chunks whose bytes are already flushed to the `.part` file, so a
//!    kill -9 at any instant can at worst lose the in-flight chunks, never
//!    corrupt the ones it claims.
//! 4. **The real name only ever appears on a complete file** (§11.2). Everything
//!    happens on `.part`, and the rename is the last step after a length check.

use anyhow::{anyhow, Context, Result};
use grammers_client::media::Downloadable;
use grammers_client::{Client, InvocationError};
use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::{friendly, Telegram};
use crate::model::{Job, JobState, ProgressBatch, ProgressEntry, Settings, EV_JOB, EV_PROGRESS};
use crate::store;

/// 512 KiB — grammers' own `MAX_CHUNK_SIZE`, and the largest value that keeps
/// every request inside a single 1 MiB window.
const CHUNK: u64 = 512 * 1024;
/// Hard ceiling on worker slots, independent of the user's setting.
const MAX_SLOTS: usize = 16;
/// §11.9 — batch progress to the UI instead of emitting per chunk.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);
/// How often the adaptive controller re-evaluates worker count.
const PROBE_INTERVAL: Duration = Duration::from_millis(2200);

/* ------------------------------------------------------------- manifest */

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    size: u64,
    chunk: u64,
    /// Indices of chunks confirmed written to the `.part` file.
    done: Vec<u32>,
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

fn manifest_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part.manifest.json");
    PathBuf::from(s)
}

/// Load the resume set, but only if it demonstrably describes *this* file:
/// same size, same chunking, and a `.part` already preallocated to full length.
/// Anything else is discarded rather than risking a silently corrupt merge.
async fn load_manifest(dest: &Path, size: u64) -> Vec<u32> {
    let mpath = manifest_path(dest);
    let ppath = part_path(dest);
    let Ok(text) = tokio::fs::read_to_string(&mpath).await else {
        return Vec::new();
    };
    let Ok(m) = serde_json::from_str::<Manifest>(&text) else {
        return Vec::new();
    };
    if m.version != 1 || m.size != size || m.chunk != CHUNK {
        return Vec::new();
    }
    match tokio::fs::metadata(&ppath).await {
        Ok(meta) if meta.len() == size => m.done,
        _ => Vec::new(),
    }
}

/// Written via temp-file + rename so a crash mid-write can never leave a
/// half-parsed manifest claiming chunks that aren't there.
async fn save_manifest(dest: &Path, size: u64, done: &[u32]) -> Result<()> {
    let mpath = manifest_path(dest);
    let tmp = mpath.with_extension("json.tmp");
    let text = serde_json::to_string(&Manifest {
        version: 1,
        size,
        chunk: CHUNK,
        done: done.to_vec(),
    })?;
    tokio::fs::write(&tmp, text).await?;
    tokio::fs::rename(&tmp, &mpath).await?;
    Ok(())
}

/* ------------------------------------------------------- DC migration */

/// Data centers this process has already copied its authorization to.
///
/// Large files frequently live on a different DC than the account's home one.
/// Telegram answers `upload.getFile` for those with `FILE_MIGRATE_X`, and the
/// connection to DC X starts out unauthenticated — asking it for the file
/// again would just yield `AUTH_KEY_UNREGISTERED`. The fix is to export an
/// authorization from the home DC and import it there, once per DC per
/// process. grammers does this internally for its own downloader, but
/// `copy_auth_to_dc` is `pub(crate)`, so the engine has to do it itself.
static DC_AUTH: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();

async fn ensure_dc_auth(client: &Client, dc_id: i32) -> Result<()> {
    let done = DC_AUTH.get_or_init(|| Mutex::new(HashSet::new()));
    // The lock is held across the round-trip deliberately: two workers hitting
    // the same migration simultaneously should produce one import, not a race.
    let mut done = done.lock().await;
    if done.contains(&dc_id) {
        return Ok(());
    }

    let exported = client
        .invoke(&tl::functions::auth::ExportAuthorization { dc_id })
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))
        .with_context(|| format!("exporting authorization for DC {dc_id}"))?;
    let tl::enums::auth::ExportedAuthorization::Authorization(auth) = exported;

    client
        .invoke_in_dc(
            dc_id,
            &tl::functions::auth::ImportAuthorization {
                id: auth.id,
                bytes: auth.bytes,
            },
        )
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))
        .with_context(|| format!("importing authorization into DC {dc_id}"))?;

    done.insert(dc_id);
    Ok(())
}

/* --------------------------------------------------------------- control */

struct Control {
    paused: AtomicBool,
    cancelled: AtomicBool,
    /// Whether the scheduler may promote this job. False for a job the user
    /// added to the queue without starting it: it keeps its place in the
    /// order, but `pump` will not run it until the user asks.
    armed: AtomicBool,
}

/// Live counters shared between a job's workers and the progress ticker.
struct Live {
    done: AtomicU64,
    total: u64,
    /// How many worker slots should currently be running. The adaptive
    /// controller moves this; workers whose slot index reaches it retire.
    target: AtomicU32,
    active: AtomicU32,
    /// Cumulative bytes per slot; the ticker differentiates these to get each
    /// connection's real throughput.
    per_slot: Vec<AtomicU64>,
    flood_until: AtomicI64,
}

impl Live {
    fn new(total: u64, done: u64, start_workers: u32) -> Self {
        Self {
            done: AtomicU64::new(done),
            total,
            target: AtomicU32::new(start_workers),
            active: AtomicU32::new(0),
            per_slot: (0..MAX_SLOTS).map(|_| AtomicU64::new(0)).collect(),
            flood_until: AtomicI64::new(0),
        }
    }
}

struct Record {
    job: Job,
    control: Arc<Control>,
    live: Option<Arc<Live>>,
}

/* ------------------------------------------------------------- persistence */
/* The queue is part of the user's work, not of the process: closing the app
   must not lose a queued or half-finished transfer. It is also part of the
   *account's* work — a message id only means something inside a session — so
   the snapshot lives in one file per Telegram account (`queue-<id>.json`) and
   records the account id inside it. A different account never sees these rows,
   which matters because resuming a foreign job could only fail.

   Rewritten after every state change (temp file + rename, so a crash mid-write
   leaves the previous snapshot intact). `peer` is deliberately not persisted:
   `run_job` resolves the message from `channel_id`/`message_id` anyway. */

#[derive(Debug, Serialize, Deserialize)]
struct PersistedQueue {
    /// Which account the rows belong to. `None` only ever appears in files
    /// written by an older build, and such a file is not adopted.
    #[serde(default)]
    account_id: Option<i64>,
    #[serde(default)]
    jobs: Vec<Job>,
}

fn queue_path(account_id: i64) -> PathBuf {
    match store::data_dir() {
        Ok(dir) => dir.join(format!("queue-{account_id}.json")),
        Err(_) => PathBuf::from(format!("telewire-queue-{account_id}.json")),
    }
}

/// Read one account's saved queue. A missing, corrupt or partially written file
/// must never stop the app from starting, so every failure path yields `None`.
fn read_queue(path: &Path) -> Option<PersistedQueue> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PersistedQueue>(&text).ok()
}

/// Atomic snapshot write: a crash can leave a `.tmp` file behind, never a
/// half-written queue.
fn write_queue(path: &Path, queue: &PersistedQueue) {
    let Ok(text) = serde_json::to_string(queue) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_ok() {
        store::restrict_permissions(path);
    }
}

/// Turn a saved snapshot into live records, refusing one that belongs to a
/// different account (or to no account at all).
fn restore(saved: PersistedQueue, account_id: i64) -> (HashMap<String, Record>, Vec<String>) {
    let mut jobs = HashMap::new();
    let mut order = Vec::new();

    if saved.account_id != Some(account_id) {
        return (jobs, order);
    }

    for mut job in saved.jobs {
        // A transfer that was running when the process died has no workers any
        // more. Restoring it as "running" would paint a live row with a dead
        // progress bar, so it comes back as paused and resumable.
        if job.state == JobState::Running {
            job.state = JobState::Paused;
        }
        // None of these describe a live process any more.
        job.speed_bps = 0;
        job.workers = 0;
        job.worker_fill.clear();
        job.eta_s = None;
        job.flood_wait_until = None;

        let id = job.id.clone();
        order.push(id.clone());
        jobs.insert(
            id,
            Record {
                job,
                control: Arc::new(Control {
                    paused: AtomicBool::new(false),
                    cancelled: AtomicBool::new(false),
                    // Restored rows wait for the user, exactly as a fresh
                    // "Add to Queue" does.
                    armed: AtomicBool::new(false),
                }),
                live: None,
            },
        );
    }
    (jobs, order)
}

/// Read and normalise the queue saved for `account_id`.
fn load_queue_from(path: &Path, account_id: i64) -> (HashMap<String, Record>, Vec<String>) {
    read_queue(path)
        .map(|saved| restore(saved, account_id))
        .unwrap_or_default()
}

fn load_queue(account_id: i64) -> (HashMap<String, Record>, Vec<String>) {
    load_queue_from(&queue_path(account_id), account_id)
}

/* ---------------------------------------------------------------- engine */

pub struct Engine {
    app: AppHandle,
    tg: Arc<Telegram>,
    jobs: Mutex<HashMap<String, Record>>,
    /// Insertion order, so the queue renders and promotes deterministically.
    order: Mutex<Vec<String>>,
    /// The account the queue belongs to. `None` until sign-in — nothing is
    /// loaded from, or written to, disk before the account is known.
    account: Mutex<Option<i64>>,
    /// Nudges the scheduler to look for promotable work.
    ///
    /// Scheduling is a separate task rather than a direct call because the
    /// natural shape — `pump` starts a job, the job finishes, the finish
    /// promotes the next one — is a recursive async cycle, and `rustc` cannot
    /// prove such a cycle is `Send` (it would have to know the future's size
    /// before it has finished inferring it). One scheduler loop breaks the
    /// cycle and gives queue promotion a single, serialised owner.
    wake: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Engine {
    pub fn new(app: AppHandle, tg: Arc<Telegram>) -> Arc<Self> {
        let (wake, mut wake_rx) = tokio::sync::mpsc::unbounded_channel();
        // The queue is restored in `bind_account`, not here: at construction
        // time nobody is signed in yet, and the rows to load depend on who that
        // turns out to be.
        let engine = Arc::new(Self {
            app,
            tg,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            account: Mutex::new(None),
            wake,
        });

        // `tauri::async_runtime::spawn`, not `tokio::spawn`: this constructor
        // runs inside Tauri's `setup` hook, which is on the main thread with no
        // runtime entered — a bare `tokio::spawn` there panics with "there is
        // no reactor running". Everything spawned later is already inside a
        // command or a task, where either would work.
        let ticker = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move { ticker.progress_loop().await });

        let scheduler = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move {
            while wake_rx.recv().await.is_some() {
                scheduler.pump().await;
            }
        });

        engine
    }

    /// Ask the scheduler to promote whatever it can. Never blocks, and is safe
    /// to call from inside a running job.
    /// Tell the engine which account is signed in. The queue is scoped to that
    /// account, so this decides which snapshot is loaded — and switching
    /// accounts abandons the previous one instead of showing rows that can only
    /// fail to resume.
    pub async fn bind_account(&self, account_id: i64) {
        let mut account = self.account.lock().await;
        if *account == Some(account_id) {
            return;
        }

        if account.is_some() {
            // A different account: stop the old work and forget its rows. Its
            // file stays on disk, so signing back in restores that queue.
            let mut jobs = self.jobs.lock().await;
            for rec in jobs.values() {
                rec.control.cancelled.store(true, Ordering::SeqCst);
            }
            jobs.clear();
            self.order.lock().await.clear();
        }
        *account = Some(account_id);
        drop(account);

        let (restored_jobs, restored_order) = load_queue(account_id);
        let mut jobs = self.jobs.lock().await;
        let mut order = self.order.lock().await;
        // Nothing should be enqueued before sign-in, but never discard live
        // rows to make room for a snapshot.
        if jobs.is_empty() {
            *jobs = restored_jobs;
            *order = restored_order;
        }
    }

    /// Sign-out. The snapshot stays on disk for that account; the rows leave
    /// memory so they cannot be shown to, or resumed by, whoever signs in next.
    pub async fn unbind_account(&self) {
        let mut account = self.account.lock().await;
        *account = None;
        let mut jobs = self.jobs.lock().await;
        for rec in jobs.values() {
            rec.control.cancelled.store(true, Ordering::SeqCst);
        }
        jobs.clear();
        self.order.lock().await.clear();
    }

    fn nudge(&self) {
        let _ = self.wake.send(());
    }

    /// Snapshot the ordered queue to disk. Called after every state change worth
    /// surviving a crash; the file is a few kilobytes and written atomically.
    ///
    /// The account lock is held while the snapshot is taken so a sign-in switch
    /// cannot interleave and write one account's rows into another's file.
    async fn persist(&self) {
        let account = self.account.lock().await;
        let Some(account_id) = *account else {
            // Not signed in: the rows have no owner, and writing them would
            // leak them into whichever account signs in next.
            return;
        };
        let snapshot: Vec<Job> = {
            let jobs = self.jobs.lock().await;
            let order = self.order.lock().await;
            order
                .iter()
                .filter_map(|id| jobs.get(id).map(|r| r.job.clone()))
                .collect()
        };
        write_queue(
            &queue_path(account_id),
            &PersistedQueue {
                account_id: Some(account_id),
                jobs: snapshot,
            },
        );
    }

    /* ---------------------------------------------------------- listing */

    pub async fn list(&self) -> Vec<Job> {
        let jobs = self.jobs.lock().await;
        let order = self.order.lock().await;
        order
            .iter()
            .filter_map(|id| jobs.get(id).map(|r| r.job.clone()))
            .collect()
    }

    async fn emit_job(&self, job: &Job) {
        let _ = self.app.emit(EV_JOB, job);
    }

    /// Snapshot every live job's counters and push one batched event (§11.9).
    async fn progress_loop(self: Arc<Self>) {
        let mut last_done: HashMap<String, u64> = HashMap::new();
        // Smoothed rate per job. A 400 ms sampling window over a bursty
        // network reads as a speed that leaps and collapses; an EMA shows the
        // figure a person actually wants — "about how fast is this going".
        let mut smooth: HashMap<String, f64> = HashMap::new();
        let mut last_tick = Instant::now();
        // True while the previous tick had anything to say. Used to emit one
        // final all-zero batch when the last transfer ends, so the wire and
        // the readout settle to idle instead of freezing on stale numbers.
        let mut was_live = false;

        loop {
            tokio::time::sleep(PROGRESS_INTERVAL).await;
            let dt = last_tick.elapsed().as_secs_f64().max(0.001);
            last_tick = Instant::now();

            let mut entries = Vec::new();
            let mut total_bps = 0u64;
            {
                let mut jobs = self.jobs.lock().await;
                for (id, rec) in jobs.iter_mut() {
                    let Some(live) = rec.live.as_ref() else { continue };
                    if rec.job.state != JobState::Running {
                        continue;
                    }

                    let done = live.done.load(Ordering::Relaxed);
                    let prev = last_done.get(id).copied().unwrap_or(done);
                    let inst = (done.saturating_sub(prev)) as f64 / dt;
                    last_done.insert(id.clone(), done);

                    // EMA over ~4 windows. The number a person wants from a
                    // speed readout is "roughly how fast", and a raw 400 ms
                    // sample makes it whipsaw between spikes and zero.
                    let s = smooth.entry(id.clone()).or_insert(inst);
                    *s = *s * 0.65 + inst * 0.35;
                    let bps = *s as u64;

                    let active = live.active.load(Ordering::Relaxed);

                    // Each bar is a connection's CUMULATIVE haul this transfer,
                    // relative to the busiest one — so the strip only ever
                    // fills. An earlier version showed per-tick throughput,
                    // which refilled from empty every 400 ms and read as the
                    // download restarting; monotonic is what "progress" means.
                    let slots: Vec<u64> = live
                        .per_slot
                        .iter()
                        .take(active.max(1) as usize)
                        .map(|a| a.load(Ordering::Relaxed))
                        .collect();
                    let peak = slots.iter().copied().max().unwrap_or(0).max(1);
                    let worker_fill: Vec<f32> = slots
                        .iter()
                        .map(|c| (*c as f32 / peak as f32).clamp(0.0, 1.0))
                        .collect();

                    let eta_s = if bps > 0 {
                        Some(live.total.saturating_sub(done) / bps.max(1))
                    } else {
                        None
                    };

                    rec.job.done = done;
                    rec.job.speed_bps = bps;
                    rec.job.eta_s = eta_s;
                    rec.job.workers = active;
                    rec.job.worker_fill = worker_fill.clone();
                    let flood = live.flood_until.load(Ordering::Relaxed);
                    rec.job.flood_wait_until = (flood > 0).then_some(flood);

                    total_bps = total_bps.saturating_add(bps);
                    entries.push(ProgressEntry {
                        id: id.clone(),
                        done,
                        speed_bps: bps,
                        eta_s,
                        workers: active,
                        worker_fill,
                    });
                }
            }

            // One extra all-zero batch after the last live tick, so the wire
            // and the "N active" readout settle to idle instead of freezing at
            // whatever the final live numbers happened to be.
            let live_now = !entries.is_empty();
            if live_now || was_live {
                if !live_now {
                    last_done.clear();
                    smooth.clear();
                }
                let _ = self.app.emit(
                    EV_PROGRESS,
                    ProgressBatch {
                        jobs: entries,
                        total_bps,
                    },
                );
            }
            was_live = live_now;
        }
    }

    /* --------------------------------------------------------- enqueue */

    pub async fn enqueue(
        self: &Arc<Self>,
        channel_id: i64,
        channel_title: String,
        message_ids: Vec<i32>,
        start_now: bool,
    ) -> Result<Vec<Job>> {
        let client = self.tg.client().await?;
        let peer = self
            .tg
            .peer(channel_id)
            .await
            .ok_or_else(|| anyhow!("That channel is no longer open. Select it again."))?;

        let messages = client
            .get_messages_by_id(peer, &message_ids)
            .await
            .map_err(|e| anyhow!(friendly(&e.to_string())))?;

        let settings = store::load_settings();
        let mut created = Vec::new();

        // Preserve the caller's requested message_ids order
        let mut msg_map: HashMap<i32, _> = messages
            .into_iter()
            .flatten()
            .map(|m| (m.id(), m))
            .collect();

        for msg_id in message_ids {
            let Some(message) = msg_map.remove(&msg_id) else { continue };
            let Some(media) = message.media() else { continue };
            let Some((name, mime, size)) = super::channel::describe(&media, message.id()) else {
                continue;
            };
            // Nothing without a raw file location can be range-fetched.
            if media.to_raw_input_location().is_none() {
                continue;
            }

            let dest = destination(&settings, &channel_title, &name, &mime, message.date().timestamp())?;

            // Smart Duplicate Detection: check if identical file already exists on disk
            let already_done = if let Ok(meta) = tokio::fs::metadata(&dest).await {
                meta.len() == size && size > 0
            } else {
                false
            };

            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                channel_id,
                channel_title: channel_title.clone(),
                message_id: message.id(),
                name,
                dest_path: dest.to_string_lossy().into_owned(),
                size,
                done: if already_done { size } else { 0 },
                // Everything joins the queue in the same state. `start_now`
                // only decides whether this job is *armed* to run; an unarmed
                // job waits in the queue exactly where it was inserted until
                // the user starts it.
                state: if already_done {
                    JobState::Done
                } else {
                    JobState::Queued
                },
                speed_bps: 0,
                eta_s: None,
                workers: 0,
                worker_fill: Vec::new(),
                error: None,
                flood_wait_until: None,
                created_at: chrono::Utc::now().timestamp(),
            };

            {
                let mut jobs = self.jobs.lock().await;
                let mut order = self.order.lock().await;
                order.push(job.id.clone());
                jobs.insert(
                    job.id.clone(),
                    Record {
                        job: job.clone(),
                        control: Arc::new(Control {
                            paused: AtomicBool::new(false),
                            cancelled: AtomicBool::new(false),
                            armed: AtomicBool::new(start_now),
                        }),
                        live: None,
                    },
                );
            }
            self.emit_job(&job).await;
            created.push(job);
        }

        if start_now {
            self.pump().await;
        }
        self.persist().await;
        Ok(created)
    }

    /// Promote queued jobs into free slots, respecting `max_concurrent_jobs`.
    async fn pump(self: &Arc<Self>) {
        let settings = store::load_settings();
        let mut to_start = Vec::new();
        {
            let jobs = self.jobs.lock().await;
            let order = self.order.lock().await;
            let running = jobs
                .values()
                .filter(|r| r.job.state == JobState::Running)
                .count();
            let mut free = settings.max_concurrent_jobs as usize - running.min(settings.max_concurrent_jobs as usize);
            for id in order.iter() {
                if free == 0 {
                    break;
                }
                if let Some(rec) = jobs.get(id) {
                    // Queued but not armed means "added to the queue, waiting
                    // for the user" — it must not be promoted on its own, not
                    // even when another transfer finishes and frees a slot.
                    if rec.job.state == JobState::Queued
                        && rec.control.armed.load(Ordering::SeqCst)
                    {
                        to_start.push(id.clone());
                        free -= 1;
                    }
                }
            }
        }
        for id in to_start {
            self.start(id).await;
        }
    }

    async fn start(self: &Arc<Self>, id: String) {
        let (control, job) = {
            let mut jobs = self.jobs.lock().await;
            let Some(rec) = jobs.get_mut(&id) else { return };
            if rec.job.state == JobState::Running {
                return;
            }
            rec.control.paused.store(false, Ordering::SeqCst);
            rec.control.cancelled.store(false, Ordering::SeqCst);
            rec.control.armed.store(true, Ordering::SeqCst);
            rec.job.state = JobState::Running;
            rec.job.error = None;
            (Arc::clone(&rec.control), rec.job.clone())
        };
        self.emit_job(&job).await;
        // Recorded as running so a crash or a normal close restores it as a
        // paused, resumable row rather than forgetting it ever started.
        self.persist().await;

        let engine = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = engine.run_job(&id, control).await;
            engine.finish(&id, outcome).await;
        });
    }

    async fn finish(self: &Arc<Self>, id: &str, outcome: Result<Outcome>) {
        let job = {
            let mut jobs = self.jobs.lock().await;
            let Some(rec) = jobs.get_mut(id) else { return };
            rec.live = None;
            rec.job.speed_bps = 0;
            rec.job.worker_fill.clear();
            rec.job.workers = 0;
            match outcome {
                Ok(Outcome::Complete) => {
                    rec.job.state = JobState::Done;
                    rec.job.done = rec.job.size;
                }
                Ok(Outcome::Paused) => rec.job.state = JobState::Paused,
                Ok(Outcome::Cancelled) => rec.job.state = JobState::Cancelled,
                Err(e) => {
                    // A cancel and a worker failure can race; the user's
                    // explicit action wins over an error they no longer care
                    // about.
                    if rec.job.state != JobState::Cancelled {
                        rec.job.state = JobState::Error;
                        rec.job.error = Some(format!("{e:#}"));
                    }
                }
            }
            rec.job.clone()
        };
        self.emit_job(&job).await;

        if job.state == JobState::Done {
            let settings = crate::store::load_settings();
            if settings.notify_on_complete {
                use tauri_plugin_notification::NotificationExt;
                let _ = self
                    .app
                    .notification()
                    .builder()
                    .title("TeleWire: Download Complete")
                    .body(format!("{}\n{}", job.name, crate::model::human_bytes(job.size)))
                    .show();
            }
        }

        self.persist().await;
        self.nudge();
    }

    /* --------------------------------------------------------- controls */

    /// State flips are reflected to the UI *immediately*, not when the workers
    /// finish draining. Draining can take a couple of seconds (each connection
    /// finishes its in-flight 512 KiB chunk first), and a button that does
    /// nothing for that long invites the double-click that restarts the job.
    pub async fn pause(&self, id: &str) -> Result<()> {
        let job = {
            let mut jobs = self.jobs.lock().await;
            let rec = jobs.get_mut(id).ok_or_else(|| anyhow!("No such download."))?;
            rec.control.paused.store(true, Ordering::SeqCst);
            if rec.job.state == JobState::Running {
                rec.job.state = JobState::Paused;
                rec.job.speed_bps = 0;
                rec.job.eta_s = None;
            }
            rec.job.clone()
        };
        self.emit_job(&job).await;
        self.persist().await;
        Ok(())
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let job = {
            let mut jobs = self.jobs.lock().await;
            let rec = jobs.get_mut(id).ok_or_else(|| anyhow!("No such download."))?;
            // Cancelled is resumable on purpose: the queue shows Retry on a
            // cancelled row, and the manifest makes a restart cheap anyway.
            // Queued is included because a job the user added to the queue and
            // left waiting is started from that same row.
            if !matches!(
                rec.job.state,
                JobState::Queued | JobState::Paused | JobState::Error | JobState::Cancelled
            ) {
                return Ok(());
            }
            rec.control.armed.store(true, Ordering::SeqCst);
            rec.job.state = JobState::Queued;
            rec.job.error = None;
            rec.job.clone()
        };
        self.emit_job(&job).await;
        self.persist().await;
        self.nudge();
        Ok(())
    }

    pub async fn retry(self: &Arc<Self>, id: &str) -> Result<()> {
        self.resume(id).await
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
        let (dest, was_running, job) = {
            let mut jobs = self.jobs.lock().await;
            let rec = jobs.get_mut(id).ok_or_else(|| anyhow!("No such download."))?;
            rec.control.cancelled.store(true, Ordering::SeqCst);
            let running = rec.job.state == JobState::Running;
            // Reflected immediately either way — the workers still drain in the
            // background, but the user's click has already landed.
            rec.job.state = JobState::Cancelled;
            rec.job.speed_bps = 0;
            rec.job.eta_s = None;
            (PathBuf::from(&rec.job.dest_path), running, rec.job.clone())
        };
        self.emit_job(&job).await;

        // A running job tears its own partial file down when its workers see
        // the cancel flag; a queued/paused one has no task to do it.
        if !was_running {
            let _ = tokio::fs::remove_file(part_path(&dest)).await;
            let _ = tokio::fs::remove_file(manifest_path(&dest)).await;
        }
        self.persist().await;
        Ok(())
    }

    pub async fn clear_finished(&self) -> Result<()> {
        // Both guards must leave scope before `persist` takes them again.
        {
            let mut jobs = self.jobs.lock().await;
            let mut order = self.order.lock().await;
            jobs.retain(|_, r| !r.job.state.is_terminal());
            order.retain(|id| jobs.contains_key(id));
        }
        self.persist().await;
        Ok(())
    }

    pub async fn clear_all(&self) -> Result<()> {
        {
            let mut jobs = self.jobs.lock().await;
            let mut order = self.order.lock().await;
            for rec in jobs.values() {
                rec.control.cancelled.store(true, Ordering::SeqCst);
            }
            jobs.clear();
            order.clear();
        }
        self.persist().await;
        Ok(())
    }

    pub async fn pause_all(&self) -> Result<()> {
        let changed = {
            let mut jobs = self.jobs.lock().await;
            let mut list = Vec::new();
            for rec in jobs.values_mut() {
                if rec.job.state == JobState::Running || rec.job.state == JobState::Queued {
                    rec.control.paused.store(true, Ordering::SeqCst);
                    rec.job.state = JobState::Paused;
                    rec.job.speed_bps = 0;
                    rec.job.eta_s = None;
                    list.push(rec.job.clone());
                }
            }
            list
        };
        for job in changed {
            self.emit_job(&job).await;
        }
        self.persist().await;
        Ok(())
    }

    pub async fn resume_all(self: &Arc<Self>) -> Result<()> {
        let changed = {
            let mut jobs = self.jobs.lock().await;
            let mut list = Vec::new();
            for rec in jobs.values_mut() {
                if matches!(
                    rec.job.state,
                    JobState::Queued | JobState::Paused | JobState::Error | JobState::Cancelled
                ) {
                    rec.control.paused.store(false, Ordering::SeqCst);
                    rec.control.cancelled.store(false, Ordering::SeqCst);
                    rec.control.armed.store(true, Ordering::SeqCst);
                    rec.job.state = JobState::Queued;
                    rec.job.error = None;
                    list.push(rec.job.clone());
                }
            }
            list
        };
        for job in changed {
            self.emit_job(&job).await;
        }
        self.persist().await;
        self.nudge();
        Ok(())
    }

    pub async fn reorder_jobs(self: &Arc<Self>, new_order: Vec<String>) -> Result<Vec<Job>> {
        {
            let jobs = self.jobs.lock().await;
            let mut order = self.order.lock().await;
            let mut seen = HashSet::new();
            let mut updated = Vec::with_capacity(order.len());
            for id in new_order {
                if jobs.contains_key(&id) && seen.insert(id.clone()) {
                    updated.push(id);
                }
            }
            for id in order.iter() {
                if seen.insert(id.clone()) {
                    updated.push(id.clone());
                }
            }
            *order = updated;
        }
        self.persist().await;
        self.pump().await;
        Ok(self.list().await)
    }

    pub async fn move_job(self: &Arc<Self>, id: &str, direction: &str) -> Result<Vec<Job>> {
        {
            let mut order = self.order.lock().await;
            let Some(idx) = order.iter().position(|x| x == id) else {
                return Ok(self.list().await);
            };
            match direction {
                "up" if idx > 0 => {
                    order.swap(idx, idx - 1);
                }
                "down" if idx + 1 < order.len() => {
                    order.swap(idx, idx + 1);
                }
                "top" => {
                    let item = order.remove(idx);
                    order.insert(0, item);
                }
                "bottom" => {
                    let item = order.remove(idx);
                    order.push(item);
                }
                _ => {}
            }
        }
        self.persist().await;
        self.pump().await;
        Ok(self.list().await)
    }

    /* ------------------------------------------------------- the transfer */

    async fn run_job(
        self: &Arc<Self>,
        id: &str,
        control: Arc<Control>,
    ) -> Result<Outcome> {
        let (job, settings) = {
            let jobs = self.jobs.lock().await;
            let rec = jobs.get(id).ok_or_else(|| anyhow!("No such download."))?;
            (rec.job.clone(), store::load_settings())
        };

        let client = self.tg.client().await?;
        let dest = PathBuf::from(&job.dest_path);
        // Smart Duplicate Detection: Check if file already finished on disk
        if let Ok(meta) = tokio::fs::metadata(&dest).await {
            if meta.len() == job.size && job.size > 0 {
                return Ok(Outcome::Complete);
            }
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("could not create {}", parent.display()))?;
        }

        let location = self.resolve_location(&client, &job).await?;
        let part = part_path(&dest);
        let size = job.size;
        let total_chunks = size.div_ceil(CHUNK) as u32;

        // Preallocate so every worker can write at its own offset without the
        // file growing underneath it (§11.2).
        {
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(&part)
                .await
                .with_context(|| format!("could not open {}", part.display()))?;
            file.set_len(size).await?;
        }
        store::restrict_permissions(&part);

        let already = load_manifest(&dest, size).await;
        let done_set = Arc::new(Mutex::new(already.clone()));
        let mut pending: Vec<u32> = (0..total_chunks).filter(|i| !already.contains(i)).collect();
        // Hand the lowest offsets out first: sequential-ish access is friendlier
        // to the filesystem and makes a partially-downloaded file useful sooner.
        pending.sort_unstable();
        let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(pending)));

        let start_workers = if settings.adaptive {
            2
        } else {
            settings.max_workers.min(MAX_SLOTS as u32)
        };
        let live = Arc::new(Live::new(
            size,
            already.len() as u64 * CHUNK,
            start_workers.max(1),
        ));
        {
            let mut jobs = self.jobs.lock().await;
            if let Some(rec) = jobs.get_mut(id) {
                rec.live = Some(Arc::clone(&live));
            }
        }

        let ceiling = settings.max_workers.clamp(1, MAX_SLOTS as u32);
        let mut set = tokio::task::JoinSet::new();
        let mut spawned = 0u32;
        // Shared so the first worker to discover a migration spares the rest.
        let dc = Arc::new(AtomicI32::new(0));

        let spawn_worker = |set: &mut tokio::task::JoinSet<Result<()>>, slot: u32| {
            let worker = Worker {
                slot,
                client: client.clone(),
                dc: Arc::clone(&dc),
                location: location.clone(),
                part: part.clone(),
                dest: dest.clone(),
                size,
                queue: Arc::clone(&queue),
                done_set: Arc::clone(&done_set),
                live: Arc::clone(&live),
                control: Arc::clone(&control),
            };
            set.spawn(async move { worker.run().await });
        };

        for slot in 0..start_workers.min(ceiling) {
            spawn_worker(&mut set, slot);
            spawned += 1;
        }

        // Adaptive controller (§11.4). Probes upward while the marginal worker
        // is actually earning its keep, and backs off when it isn't. This is the
        // difference between "several connections" and "faster".
        let controller = {
            let live = Arc::clone(&live);
            let control = Arc::clone(&control);
            tokio::spawn(async move {
                if !settings.adaptive {
                    return;
                }
                let mut last_bytes = live.done.load(Ordering::Relaxed);
                let mut last_rate = 0f64;
                let mut probing_up = true;
                loop {
                    tokio::time::sleep(PROBE_INTERVAL).await;
                    if control.cancelled.load(Ordering::Relaxed)
                        || control.paused.load(Ordering::Relaxed)
                    {
                        return;
                    }
                    let now = live.done.load(Ordering::Relaxed);
                    let rate = (now.saturating_sub(last_bytes)) as f64
                        / PROBE_INTERVAL.as_secs_f64();
                    last_bytes = now;

                    let target = live.target.load(Ordering::Relaxed);
                    if last_rate > 0.0 {
                        let gain = (rate - last_rate) / last_rate;
                        if probing_up && gain < 0.08 {
                            // The extra connection didn't pay for itself. Give
                            // it back and stop climbing.
                            if target > 1 {
                                live.target.store(target - 1, Ordering::Relaxed);
                            }
                            probing_up = false;
                        } else if gain < -0.15 && target > 1 {
                            // Throughput collapsed (congestion, or Telegram
                            // throttling): shed a connection.
                            live.target.store(target - 1, Ordering::Relaxed);
                        } else if probing_up && target < ceiling {
                            live.target.store(target + 1, Ordering::Relaxed);
                        }
                    } else if target < ceiling {
                        live.target.store(target + 1, Ordering::Relaxed);
                    }
                    last_rate = rate;
                }
            })
        };

        // Periodically flush the manifest so a crash costs at most a couple of
        // seconds of work rather than the whole transfer.
        let flusher = {
            let done_set = Arc::clone(&done_set);
            let dest = dest.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let snapshot = done_set.lock().await.clone();
                    let _ = save_manifest(&dest, size, &snapshot).await;
                }
            })
        };

        // Top up worker slots as the controller raises the target.
        let mut failure: Option<anyhow::Error> = None;
        loop {
            let target = live.target.load(Ordering::Relaxed).min(ceiling);
            while spawned < target {
                spawn_worker(&mut set, spawned);
                spawned += 1;
            }

            match tokio::time::timeout(Duration::from_millis(250), set.join_next()).await {
                Ok(Some(Ok(Ok(())))) => {}
                Ok(Some(Ok(Err(e)))) => {
                    failure.get_or_insert(e);
                    control.cancelled.store(true, Ordering::SeqCst);
                }
                Ok(Some(Err(e))) => {
                    failure.get_or_insert(anyhow!("worker panicked: {e}"));
                    control.cancelled.store(true, Ordering::SeqCst);
                }
                // All workers have retired.
                Ok(None) => break,
                // Timeout: loop round to re-check the worker target.
                Err(_) => {}
            }
        }

        controller.abort();
        flusher.abort();

        let final_done = done_set.lock().await.clone();
        let _ = save_manifest(&dest, size, &final_done).await;

        if let Some(e) = failure {
            return Err(e);
        }
        if control.cancelled.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(manifest_path(&dest)).await;
            return Ok(Outcome::Cancelled);
        }
        if control.paused.load(Ordering::SeqCst) {
            return Ok(Outcome::Paused);
        }

        if (final_done.len() as u32) < total_chunks {
            return Ok(Outcome::Paused);
        }

        // §11.10 — verify before the file is allowed to wear its real name.
        let meta = tokio::fs::metadata(&part).await?;
        if meta.len() != size {
            return Err(anyhow!(
                "size check failed: expected {size} bytes on disk, found {}",
                meta.len()
            ));
        }

        let final_path = unique_path(&dest).await;
        tokio::fs::rename(&part, &final_path).await.with_context(|| {
            format!("could not move the finished file into place at {}", final_path.display())
        })?;
        let _ = tokio::fs::remove_file(manifest_path(&dest)).await;

        if final_path != dest {
            let mut jobs = self.jobs.lock().await;
            if let Some(rec) = jobs.get_mut(id) {
                rec.job.dest_path = final_path.to_string_lossy().into_owned();
            }
        }
        Ok(Outcome::Complete)
    }

    /// File references go stale (Telegram rotates them), so the location is
    /// fetched fresh at the start of every attempt rather than cached at
    /// enqueue time.
    async fn resolve_location(
        &self,
        client: &Client,
        job: &Job,
    ) -> Result<tl::enums::InputFileLocation> {
        let peer = self
            .tg
            .peer(job.channel_id)
            .await
            .ok_or_else(|| anyhow!("That channel is no longer open. Select it again."))?;
        let messages = client
            .get_messages_by_id(peer, &[job.message_id])
            .await
            .map_err(|e| anyhow!(friendly(&e.to_string())))?;
        let media = messages
            .into_iter()
            .flatten()
            .next()
            .and_then(|m| m.media())
            .ok_or_else(|| anyhow!("That message no longer exists in the channel."))?;
        media
            .to_raw_input_location()
            .ok_or_else(|| anyhow!("That media can't be downloaded directly."))
    }
}

enum Outcome {
    Complete,
    Paused,
    Cancelled,
}

/* ---------------------------------------------------------------- worker */

struct Worker {
    slot: u32,
    client: Client,
    /// Which data center this file actually lives on. 0 = the account's home
    /// DC; set once a `FILE_MIGRATE` reply tells us otherwise. Shared across
    /// the job's workers so only the first one to hit it pays the redirect.
    dc: Arc<AtomicI32>,
    location: tl::enums::InputFileLocation,
    part: PathBuf,
    dest: PathBuf,
    size: u64,
    queue: Arc<Mutex<std::collections::VecDeque<u32>>>,
    done_set: Arc<Mutex<Vec<u32>>>,
    live: Arc<Live>,
    control: Arc<Control>,
}

impl Worker {
    async fn run(self) -> Result<()> {
        // Each worker holds its own handle so seek+write never races another
        // worker's file cursor.
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&self.part)
            .await
            .with_context(|| format!("could not open {}", self.part.display()))?;

        self.live.active.fetch_add(1, Ordering::Relaxed);
        let result = self.pump(&mut file).await;
        self.live.active.fetch_sub(1, Ordering::Relaxed);
        let _ = file.flush().await;
        result
    }

    async fn pump(&self, file: &mut tokio::fs::File) -> Result<()> {
        loop {
            if self.control.cancelled.load(Ordering::Relaxed)
                || self.control.paused.load(Ordering::Relaxed)
            {
                return Ok(());
            }
            // Retire when the adaptive controller has lowered the target below
            // this slot index.
            if self.slot >= self.live.target.load(Ordering::Relaxed) {
                return Ok(());
            }

            let Some(index) = self.queue.lock().await.pop_front() else {
                return Ok(());
            };

            match self.fetch(index).await {
                Ok(bytes) => {
                    let offset = index as u64 * CHUNK;
                    file.seek(std::io::SeekFrom::Start(offset)).await?;
                    file.write_all(&bytes).await?;
                    // Flush before claiming the chunk: the manifest must never
                    // promise bytes the OS hasn't been handed yet (§11.7).
                    file.flush().await?;

                    self.done_set.lock().await.push(index);
                    let n = bytes.len() as u64;
                    self.live.done.fetch_add(n, Ordering::Relaxed);
                    self.live.per_slot[self.slot as usize].fetch_add(n, Ordering::Relaxed);
                }
                Err(e) => {
                    // Put the chunk back so another worker (or a later retry)
                    // can take it — losing it would silently truncate the file.
                    self.queue.lock().await.push_front(index);
                    return Err(e);
                }
            }
        }
    }

    /// One `upload.getFile` call, with flood-wait and retry handling.
    async fn fetch(&self, index: u32) -> Result<Vec<u8>> {
        let offset = index as u64 * CHUNK;
        // Always request a full aligned chunk; at end-of-file the server
        // simply returns the remaining bytes.
        let request = tl::functions::upload::GetFile {
            precise: false,
            cdn_supported: false,
            location: self.location.clone(),
            offset: offset as i64,
            limit: CHUNK as i32,
        };

        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let dc = self.dc.load(Ordering::Relaxed);
            let sent = if dc > 0 {
                self.client.invoke_in_dc(dc, &request).await
            } else {
                self.client.invoke(&request).await
            };
            match sent {
                Ok(tl::enums::upload::File::File(f)) => {
                    self.live.flood_until.store(0, Ordering::Relaxed);
                    let expected = (self.size - offset).min(CHUNK) as usize;
                    if f.bytes.len() < expected {
                        return Err(anyhow!(
                            "Telegram returned {} bytes for a {expected}-byte chunk",
                            f.bytes.len()
                        ));
                    }
                    return Ok(f.bytes.into_iter().take(expected).collect());
                }
                Ok(tl::enums::upload::File::CdnRedirect(_)) => {
                    // We never set `cdn_supported`, so this should be
                    // unreachable; treat it as a hard error rather than
                    // pretending we handled it.
                    return Err(anyhow!("Telegram redirected this file to a CDN, which TeleWire does not support yet."));
                }
                // The file lives on another data center. Copy the
                // authorization there once, remember the DC for the rest of
                // this job, and retry the same chunk — this is the difference
                // between "large files fail" and "large files work", since
                // Telegram routinely stores them off the home DC.
                Err(InvocationError::Rpc(ref rpc)) if rpc.is("FILE_MIGRATE") => {
                    let Some(target) = rpc.value.map(|v| v as i32) else {
                        return Err(anyhow!("Telegram asked for a data center it didn't name"));
                    };
                    ensure_dc_auth(&self.client, target).await?;
                    self.dc.store(target, Ordering::Relaxed);
                    continue;
                }
                Err(InvocationError::Rpc(ref rpc)) if rpc.is("FLOOD_WAIT") => {
                    // §11.8 — back off exactly this task for exactly as long as
                    // Telegram asked, then carry on. The rest of the job keeps
                    // running.
                    let secs = rpc.value.unwrap_or(5).min(600) as u64;
                    self.live.flood_until.store(
                        chrono::Utc::now().timestamp() + secs as i64,
                        Ordering::Relaxed,
                    );
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                    if self.control.cancelled.load(Ordering::Relaxed) {
                        return Err(anyhow!("cancelled"));
                    }
                    continue;
                }
                Err(e) => {
                    // Check if cancelled or paused during retry
                    if self.control.cancelled.load(Ordering::Relaxed) {
                        return Err(anyhow!("cancelled"));
                    }
                    if self.control.paused.load(Ordering::Relaxed) {
                        return Err(anyhow!("paused"));
                    }

                    // Transient transport hiccups or network drop: exponential backoff auto-retry.
                    // Allows recovering from Wi-Fi drops, network switches, or brief disconnects.
                    if attempt < 20 {
                        // 1s, 2s, 4s, 8s, 16s, capped at 30s
                        let delay_secs = (1u64 << (attempt.min(5) - 1)).min(30);
                        eprintln!(
                            "[telewire] Network error on chunk {index} (attempt {attempt}/20: {e}). Retrying in {delay_secs}s..."
                        );
                        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
                        continue;
                    }

                    return Err(anyhow!(friendly(&e.to_string())))
                        .with_context(|| format!("chunk {index} of {}", self.dest.display()));
                }
            }
        }
    }
}

/* ------------------------------------------------------------ file paths */

/// `<root>/<media_type>/<channel>/<YYYY-MM>/<name>` depending on organization settings.
fn destination(
    settings: &Settings,
    channel_title: &str,
    name: &str,
    mime: &str,
    date_unix: i64,
) -> Result<PathBuf> {
    let mut path = PathBuf::from(&settings.download_root);
    if settings.organize_by_type {
        let kind = crate::model::MediaKind::classify(mime, name);
        let folder = match kind {
            crate::model::MediaKind::Video => "Videos",
            crate::model::MediaKind::Audio => "Audio",
            crate::model::MediaKind::Photo => "Photos",
            crate::model::MediaKind::Document => "Documents",
        };
        path.push(folder);
    }
    if settings.organize {
        path.push(sanitize_filename::sanitize(channel_title));
        let dt = chrono::DateTime::from_timestamp(date_unix, 0).unwrap_or_else(chrono::Utc::now);
        path.push(dt.format("%Y-%m").to_string());
    }
    path.push(sanitize_filename::sanitize(name));
    Ok(path)
}

/// Never overwrite: an existing file with the real name is, by this engine's
/// own invariant, a complete download.
async fn unique_path(dest: &Path) -> PathBuf {
    if tokio::fs::metadata(dest).await.is_err() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let parent = dest.parent().map(Path::to_path_buf).unwrap_or_default();
    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod queue_tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "telewire-queue-test-{}-{tag}.json",
            std::process::id()
        ))
    }

    fn job(id: &str, state: JobState, done: u64) -> Job {
        Job {
            id: id.to_string(),
            channel_id: 100,
            channel_title: "Test channel".into(),
            message_id: 42,
            name: format!("{id}.bin"),
            dest_path: format!("C:/tmp/{id}.bin"),
            size: 1_000,
            done,
            state,
            speed_bps: 512,
            eta_s: Some(9),
            workers: 2,
            worker_fill: vec![0.5, 0.5],
            error: None,
            flood_wait_until: None,
            created_at: 1_700_000_000,
        }
    }

    /// The exact path a restart takes: write a snapshot, read it back, restore.
    #[test]
    fn restore_round_trip_keeps_order_and_pauses_running() {
        let path = temp_path("roundtrip");
        write_queue(
            &path,
            &PersistedQueue {
                account_id: Some(7),
                jobs: vec![
                    job("a", JobState::Running, 300),
                    job("b", JobState::Queued, 0),
                    job("c", JobState::Done, 1_000),
                ],
            },
        );

        let (jobs, order) = load_queue_from(&path, 7);
        let _ = std::fs::remove_file(&path);

        assert_eq!(order, vec!["a", "b", "c"], "queue order must survive");
        assert_eq!(jobs.len(), 3);
        assert_eq!(
            jobs["a"].job.state,
            JobState::Paused,
            "a running row comes back paused"
        );
        assert_eq!(jobs["a"].job.done, 300, "progress survives");
        assert_eq!(jobs["a"].job.speed_bps, 0);
        assert_eq!(jobs["a"].job.workers, 0);
        assert!(jobs["a"].job.eta_s.is_none());
        assert!(jobs["a"].job.worker_fill.is_empty());
        assert!(
            !jobs["a"].control.armed.load(Ordering::SeqCst),
            "restored rows wait for the user"
        );
        assert_eq!(jobs["b"].job.state, JobState::Queued);
        assert_eq!(jobs["c"].job.state, JobState::Done);
    }

    #[test]
    fn restore_rejects_another_accounts_queue() {
        let path = temp_path("foreign");
        write_queue(
            &path,
            &PersistedQueue {
                account_id: Some(7),
                jobs: vec![job("a", JobState::Paused, 10)],
            },
        );
        let (jobs, order) = load_queue_from(&path, 8);
        let _ = std::fs::remove_file(&path);
        assert!(jobs.is_empty(), "another account must not see these rows");
        assert!(order.is_empty());
    }

    #[test]
    fn restore_rejects_unowned_snapshot() {
        let path = temp_path("unowned");
        write_queue(
            &path,
            &PersistedQueue {
                account_id: None,
                jobs: vec![job("a", JobState::Queued, 0)],
            },
        );
        let (jobs, _) = load_queue_from(&path, 7);
        let _ = std::fs::remove_file(&path);
        assert!(jobs.is_empty());
    }

    #[test]
    fn corrupt_snapshot_loads_empty() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not json").unwrap();
        let (jobs, order) = load_queue_from(&path, 7);
        let _ = std::fs::remove_file(&path);
        assert!(jobs.is_empty());
        assert!(order.is_empty());
    }

    #[test]
    fn missing_snapshot_loads_empty() {
        let (jobs, order) = load_queue_from(&temp_path("missing"), 7);
        assert!(jobs.is_empty());
        assert!(order.is_empty());
    }

    #[test]
    fn snapshots_are_per_account() {
        let seven = queue_path(7).to_string_lossy().into_owned();
        let eight = queue_path(8).to_string_lossy().into_owned();
        assert_ne!(seven, eight);
        assert!(seven.contains("queue-7"));
    }
}
