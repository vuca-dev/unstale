//! A person's answer to a [`Menu`]: ↑↓ move the mark, Enter chooses, `d` shows the full figures and comes back to
//! the list, a number marks that option. Keys are read one at a time where the terminal allows it (`stty`) and the
//! menu fits it; otherwise the menu is printed once and the answer is typed, as before ([`view::ask_default`]).

use super::view::{self, Answered, Menu};
use std::io::{Read, Write};

/// One key, as read from the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    Enter,
    /// `1` to `9`: marks that option.
    Digit(usize),
    Details,
    /// Ctrl-C: stop, as the interrupt would have.
    Interrupt,
    /// Ctrl-D, `q`, or the end of input: nothing chosen.
    End,
    Other,
}

/// Reads one key: arrows as the terminal sends them (`ESC [ A`, or `ESC O A` in application mode), `k` and `j` too.
pub fn read_key(input: &mut dyn Read) -> Key {
    let mut b = [0u8; 1];
    let mut next = |input: &mut dyn Read| match input.read(&mut b) {
        Ok(1) => Some(b[0]),
        _ => None,
    };
    match next(input) {
        None | Some(0x04 | b'q' | b'Q') => Key::End,
        Some(0x03) => Key::Interrupt,
        Some(b'\r' | b'\n') => Key::Enter,
        Some(b'k') => Key::Up,
        Some(b'j') => Key::Down,
        Some(b'd' | b'D') => Key::Details,
        Some(c @ b'1'..=b'9') => Key::Digit((c - b'0') as usize),
        Some(0x1b) => match next(input) {
            Some(b'[' | b'O') => match next(input) {
                Some(b'A') => Key::Up,
                Some(b'B') => Key::Down,
                _ => Key::Other,
            },
            _ => Key::Other,
        },
        Some(_) => Key::Other,
    }
}

/// What a key does to the mark at `sel` of `n` options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Mark(usize),
    Choose(usize),
    Details,
    Stop(Answered),
    Interrupt,
    Ignore,
}

pub fn step(key: Key, sel: usize, n: usize, details: bool) -> Step {
    match key {
        Key::Up => Step::Mark(if sel == 0 { n - 1 } else { sel - 1 }),
        Key::Down => Step::Mark((sel + 1) % n),
        Key::Enter => Step::Choose(sel),
        Key::Digit(d) if d <= n => Step::Mark(d - 1),
        Key::Details if details => Step::Details,
        Key::End => Step::Stop(Answered::Nothing),
        Key::Interrupt => Step::Interrupt,
        _ => Step::Ignore,
    }
}

/// The terminal set to pass keys one at a time without echo, restored when dropped.
struct Raw {
    saved: String,
    _signals: signals::Guard,
}

fn stty(args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("stty")
        .args(args)
        .stdin(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// The terminal's rows and columns, where `stty` can tell.
fn size() -> Option<(usize, usize)> {
    let s = stty(&["size"])?;
    let mut it = s.split_whitespace().map(|n| n.parse::<usize>().ok());
    Some((it.next()??, it.next()??))
}

/// Whether the menu and its hint can be redrawn in place on a terminal of `rows` and `cols`: no line wider than the
/// terminal (a wrapped line would leave a copy behind at each redraw) and fewer lines than it has.
pub fn fits(menu: &Menu, rows: usize, cols: usize) -> bool {
    let mut lines = menu.lines(menu.default);
    lines.push(menu.hint().to_string());
    lines.len() < rows && lines.iter().all(|l| l.chars().count() <= cols)
}

impl Raw {
    fn enter() -> Option<Raw> {
        if std::env::var("TERM").is_ok_and(|t| t == "dumb") {
            return None;
        }
        let saved = stty(&["-g"]).filter(|s| !s.is_empty())?;
        // From here a signal puts the terminal back as it was before exiting.
        let signals = signals::install();
        let raw = Raw {
            saved,
            _signals: signals,
        };
        // Keys one at a time, and nothing waiting: what was typed before the menu drew is not an answer to it.
        stty(&["-icanon", "-echo", "-isig", "min", "0", "time", "0"])?;
        let mut buf = [0u8; 256];
        let mut input = std::io::stdin();
        while input.read(&mut buf).is_ok_and(|n| n > 0) {}
        stty(&["min", "1", "time", "0"])?;
        // Each `?` above drops `raw`, which restores what was saved.
        Some(raw)
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        let _ = stty(&[&self.saved]);
    }
}

/// SIGHUP, SIGINT and SIGTERM while the menu is up: the terminal settings and the cursor restored, then the exit the
/// signal would have caused. Only calls that are safe in a signal handler (`tcsetattr`, `write`, `_exit`).
mod signals {
    use std::sync::atomic::{AtomicBool, Ordering};

    const SIGNALS: [i32; 3] = [1, 2, 15];
    const SIG_ERR: usize = usize::MAX;
    /// Larger than `struct termios` on every system the client is built for (60 bytes on Linux, 72 on macOS).
    static mut SAVED: [u8; 256] = [0; 256];
    static HAVE: AtomicBool = AtomicBool::new(false);

    #[allow(clashing_extern_declarations)]
    unsafe extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
        fn tcgetattr(fd: i32, t: *mut u8) -> i32;
        fn tcsetattr(fd: i32, when: i32, t: *const u8) -> i32;
        fn write(fd: i32, b: *const std::ffi::c_void, n: usize) -> isize;
        fn _exit(code: i32) -> !;
    }

    extern "C" fn on(sig: i32) {
        // SAFETY: async-signal-safe calls only; SAVED is written once, before the handler is installed.
        unsafe {
            if HAVE.load(Ordering::Acquire) {
                tcsetattr(0, 0, (&raw const SAVED).cast());
            }
            let show = b"\x1b[?25h\n";
            write(1, show.as_ptr().cast(), show.len());
            _exit(128 + sig);
        }
    }

    /// The handlers that were there before, put back when dropped.
    pub struct Guard {
        prev: [usize; 3],
    }

    pub fn install() -> Guard {
        // SAFETY: SAVED is only written here, while no handler of ours is installed.
        unsafe {
            HAVE.store(tcgetattr(0, (&raw mut SAVED).cast()) == 0, Ordering::Release);
            let h = on as extern "C" fn(i32) as usize;
            Guard {
                prev: SIGNALS.map(|s| signal(s, h)),
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            for (s, p) in SIGNALS.iter().zip(self.prev) {
                if p != SIG_ERR {
                    // SAFETY: restores the handler `signal` returned for this signal.
                    unsafe { signal(*s, p) };
                }
            }
        }
    }
}

/// Lines printed, for moving back over them.
fn draw(out: &mut dyn Write, menu: &Menu, sel: usize) -> usize {
    let mut lines = menu.lines(sel);
    lines.push(menu.hint().to_string());
    for l in &lines {
        let _ = writeln!(out, "{l}");
    }
    let _ = out.flush();
    lines.len()
}

/// Back over `n` lines and clears from there down.
fn erase(out: &mut dyn Write, n: usize) {
    if n > 0 {
        let _ = write!(out, "\x1b[{n}A\r\x1b[J");
    }
}

/// Asks with keys read one at a time; `None` where the terminal cannot do that (the caller asks for a typed
/// answer). `details` are the full figures `d` shows. Ctrl-C stops the program as the interrupt would.
pub fn choose(menu: &Menu, details: &[String]) -> Option<Answered> {
    // Too small to redraw in place: the typed answer instead.
    let (rows, cols) = size()?;
    if !fits(menu, rows, cols) {
        return None;
    }
    let raw = Raw::enter()?;
    let mut out = std::io::stdout();
    let mut input = std::io::stdin().lock();
    let n = menu.rows.len();
    let mut sel = menu.default.min(n - 1);
    let mut _cursor = Cursor::hide(&mut out);
    let mut drawn = draw(&mut out, menu, sel);
    let answer = loop {
        match step(
            read_key(&mut input),
            sel,
            n,
            menu.details && !details.is_empty(),
        ) {
            Step::Mark(i) => {
                sel = i;
                erase(&mut out, drawn);
                drawn = draw(&mut out, menu, sel);
            }
            Step::Choose(i) => break Answered::Option(i),
            Step::Details => {
                erase(&mut out, drawn);
                for l in details {
                    let _ = writeln!(out, "{l}");
                }
                let _ = writeln!(out);
                drawn = draw(&mut out, menu, sel);
            }
            Step::Stop(a) => break a,
            Step::Interrupt => {
                let _ = writeln!(out);
                drop(_cursor);
                drop(raw);
                std::process::exit(130);
            }
            Step::Ignore => {}
        }
    };
    // The list stays as it was answered, the chosen option marked.
    let _ = out.flush();
    drop(raw);
    Some(answer)
}

/// The cursor hidden while the mark is what moves, shown again when dropped.
struct Cursor;

impl Cursor {
    fn hide(out: &mut dyn Write) -> Cursor {
        let _ = write!(out, "\x1b[?25l");
        Cursor
    }
}

impl Drop for Cursor {
    fn drop(&mut self) {
        let mut out = std::io::stdout();
        let _ = write!(out, "\x1b[?25h");
        let _ = out.flush();
    }
}

/// Asks: keys one at a time where the terminal allows it, else the menu printed once and a typed answer.
pub fn ask(menu: &Menu, details: &[String]) -> Answered {
    if let Some(a) = choose(menu, details) {
        return a;
    }
    let mut out = std::io::stdout();
    for l in menu.lines(menu.default) {
        let _ = writeln!(out, "{l}");
    }
    view::ask_default(
        menu.rows.len(),
        menu.default,
        &menu.typed_prompt(),
        details,
        &mut std::io::stdin().lock(),
        &mut out,
    )
}
