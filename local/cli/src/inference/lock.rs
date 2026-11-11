//! One worker per machine: an exclusive lock on `{cache}/inference/worker.lock`. The operating system releases it
//! when the holder exits, crashed or not, so a stale lock never blocks the next run.

use std::fs::File;
use std::path::Path;

/// Held while model work runs; dropping it releases the lock.
#[derive(Debug)]
pub struct WorkerLock {
    _file: File,
}

/// The worker lock, or `None` when another process (or another handle in this one) holds it: the caller then exits
/// quietly, since that worker is already doing the work.
pub fn try_acquire(dir: &Path) -> Option<WorkerLock> {
    std::fs::create_dir_all(dir).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("worker.lock"))
        .ok()?;
    file.try_lock().ok()?;
    Some(WorkerLock { _file: file })
}

/// The machine's lock, beside the ledger.
pub fn try_acquire_default() -> Option<WorkerLock> {
    try_acquire(&crate::cache::cache_dir().join("inference"))
}
