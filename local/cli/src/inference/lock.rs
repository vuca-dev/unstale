//! One worker per machine: an exclusive lock on `{cache}/inference/worker.lock`. The operating system releases it
//! when the holder exits, crashed or not, so a stale lock never blocks the next run.

use super::Deferred;
use std::fs::File;
use std::path::Path;

/// Held while model work runs; dropping it releases the lock.
#[derive(Debug)]
pub struct WorkerLock {
    _file: File,
}

/// The worker lock; `Ok(None)` when another process (or another handle in this one) holds it, and the caller exits
/// quietly, since that worker is already doing the work. `Err(Deferred::Storage)` when it cannot be taken for another
/// reason (an unwritable directory, a filesystem without locks): spend could not be counted there either.
pub fn try_acquire(dir: &Path) -> Result<Option<WorkerLock>, Deferred> {
    std::fs::create_dir_all(dir).map_err(|_| Deferred::Storage)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("worker.lock"))
        .map_err(|_| Deferred::Storage)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(WorkerLock { _file: file })),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(_) => Err(Deferred::Storage),
    }
}

/// The machine's lock, beside the ledger.
pub fn try_acquire_default() -> Result<Option<WorkerLock>, Deferred> {
    try_acquire(&crate::cache::cache_dir().join("inference"))
}
