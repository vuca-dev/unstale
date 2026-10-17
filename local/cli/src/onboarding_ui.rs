//! One responsive inline surface, with a short, skippable result presentation.
use std::io::{IsTerminal, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default)]
pub enum Tone {
    #[default]
    Body,
    Fresh,
    Amber,
    Accent,
    Muted,
    Prompt,
    Rule,
}
#[derive(Clone)]
pub struct Line {
    pub text: String,
    pub tone: Tone,
}
impl Line {
    pub fn new(text: impl Into<String>, tone: Tone) -> Self {
        Self {
            text: text.into(),
            tone,
        }
    }
}
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}
fn paint(text: &str, tone: Tone, color: bool) -> String {
    if !color {
        return text.into();
    }
    let code = match tone {
        Tone::Rule => "38;2;103;220;145",
        Tone::Prompt => "1;38;2;224;232;232",
        Tone::Fresh => "1;38;2;103;220;145",
        Tone::Amber => "38;2;232;172;94",
        Tone::Accent => "1;38;2;47;216;198",
        Tone::Muted => "38;2;132;154;158",
        Tone::Body => "38;2;224;232;232",
    };
    format!("\x1b[{code}m{text}\x1b[0m")
}
fn wrap(text: &str, width: usize) -> Vec<String> {
    let text = clean(text);
    if text.is_empty() {
        return vec![String::new()];
    }
    let width = width.max(12);
    let mut lines = vec![];
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + word.chars().count() + 1 > width {
            lines.push(std::mem::take(&mut line));
        }
        for c in word.chars() {
            if line.chars().count() >= width {
                lines.push(std::mem::take(&mut line));
            }
            line.push(c);
        }
        line.push(' ');
    }
    if !line.trim_end().is_empty() {
        lines.push(line.trim_end().into());
    }
    lines
        .into_iter()
        .map(|l| l.trim_end().to_string())
        .collect()
}
fn render(lines: &[Line], width: usize, color: bool) -> Vec<String> {
    lines
        .iter()
        .flat_map(|line| {
            let text = if matches!(line.tone, Tone::Rule) { "━".repeat(width.saturating_sub(2).clamp(1, 64)) } else { line.text.clone() };
            wrap(&text, width.saturating_sub(2))
                .into_iter()
                .map(move |text| format!("  {}", paint(&text, line.tone, color)))
        })
        .collect()
}
fn dimensions() -> Option<(usize, usize)> {
    std::process::Command::new("stty")
        .arg("size")
        .stdin(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            let n: Vec<usize> = s
                .split_whitespace()
                .filter_map(|x| x.parse().ok())
                .collect();
            (n.len() == 2).then(|| (n[0], n[1]))
        })
}
#[derive(Clone, Copy)]
struct Layout {
    scale: usize,
    width: usize,
    height: usize,
}
impl Layout {
    const NORMAL: Self = Self {
        scale: 3,
        width: 128,
        height: 40,
    };
    const COMPACT: Self = Self {
        scale: 2,
        width: 88,
        height: 28,
    };
    fn fit(rows: usize, cols: usize, body: usize) -> Option<Self> {
        [Self::NORMAL, Self::COMPACT]
            .into_iter()
            .find(|l| l.width / 2 + 2 < cols && l.height / 4 + 1 + body <= rows.saturating_sub(2))
    }
}
#[derive(Default, Clone)]
struct Progress {
    title: String,
    detail: String,
    hint: String,
    result: Option<Vec<Line>>,
}
pub struct Display {
    state: Arc<Mutex<Progress>>,
    stop: Arc<AtomicBool>,
    echoed_lines: Arc<AtomicUsize>,
    body_rows: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
    last_plain: Mutex<String>,
    animated: bool,
    size: (usize, usize),
    started: Instant,
}
impl Display {
    pub fn start(enabled: bool) -> Self {
        let interactive = std::io::stderr().is_terminal();
        let color = std::env::var_os("NO_COLOR").is_none();
        let terminal = std::env::var("TERM").unwrap_or_default() != "dumb";
        let size = if interactive && terminal {
            dimensions()
        } else {
            None
        }
        .unwrap_or((24, 80));
        let animated = enabled
            && interactive
            && terminal
            && color
            && std::env::var_os("UNSTALE_REDUCED_MOTION").is_none()
            && Layout::fit(size.0, size.1, 3).is_some();
        let state = Arc::new(Mutex::new(Progress {
            title: "Mapping your repository".into(),
            ..Default::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let echoed_lines = Arc::new(AtomicUsize::new(0));
        let body_rows = Arc::new(AtomicUsize::new(3));
        let signal = stop.clone();
        let progress = state.clone();
        let input_rows = echoed_lines.clone();
        let owned_body = body_rows.clone();
        let started = Instant::now();
        let thread = if interactive && terminal {
            Some(std::thread::spawn(move || {
                let mut size = size;
                let mut measured = Instant::now();
                let mut previous_rows = 0usize;
                loop {
                    if measured.elapsed() >= Duration::from_secs(1) {
                        size = dimensions().unwrap_or(size);
                        measured = Instant::now();
                    }
                    let done = signal.load(Ordering::Acquire);
                    let snapshot = progress.lock().unwrap().clone();
                    let mut body = if let Some(result) = &snapshot.result {
                        render(result, size.1.saturating_sub(1), color)
                    } else {
                        render(
                            &[
                                Line::new(format!("{} {} · {}s", ["◐", "◓", "◑", "◒"][(started.elapsed().as_millis() / 250 % 4) as usize], snapshot.title, started.elapsed().as_secs()), Tone::Accent),
                                Line::new(snapshot.detail, Tone::Body),
                                Line::new(snapshot.hint, Tone::Muted),
                            ],
                            size.1.saturating_sub(1),
                            color,
                        )
                    };
                    if snapshot.result.is_some() && !done {
                        body.extend(render(
                            &[Line::new(
                                "Setup finished · Enter to return now · closes automatically",
                                Tone::Muted,
                            )],
                            size.1.saturating_sub(1),
                            color,
                        ));
                    }
                    if body.len() > size.0.saturating_sub(2) {
                        body = render(
                            &[Line::new(
                                "Setup ready · Enter for full summary",
                                Tone::Fresh,
                            )],
                            size.1.saturating_sub(1),
                            color,
                        );
                        body.truncate(size.0.saturating_sub(2).max(1));
                    }
                    previous_rows = previous_rows.min(size.0.saturating_sub(1));
                    let layout = if animated {
                        Layout::fit(size.0, size.1, body.len())
                    } else {
                        None
                    };
                    let mut frame = layout
                        .map(|l| {
                            // The resting frame stays on screen after exit, so it drops the drifting bands.
                            cloud_with(
                                if done {
                                    31.
                                } else {
                                    started.elapsed().as_secs_f64() + 5.5
                                },
                                l,
                                !done,
                            )
                        })
                        .unwrap_or_default();
                    owned_body.store(body.len(), Ordering::Release);
                    frame.extend(body);
                    let rows = frame.len();
                    let echoed = input_rows.swap(0, Ordering::AcqRel);
                    let mut err = std::io::stderr().lock();
                    if previous_rows > 0 {
                        let _ = write!(err, "\x1b[{}A", previous_rows + echoed);
                    }
                    for line in frame {
                        let _ = writeln!(err, "\r\x1b[2K{line}");
                    }
                    // Only erase rows owned by the previous frame, never earlier shell output.
                    for _ in rows..previous_rows {
                        let _ = writeln!(err, "\r\x1b[2K");
                    }
                    if previous_rows > rows {
                        let _ = write!(err, "\x1b[{}A", previous_rows - rows);
                    }
                    if echoed > 0 {
                        let _ = write!(err, "\r\x1b[2K");
                    }
                    let _ = err.flush();
                    previous_rows = rows;
                    if done {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(if animated { 100 } else { 200 }));
                }
            }))
        } else {
            None
        };
        Self {
            state,
            stop,
            echoed_lines,
            body_rows,
            thread,
            last_plain: Mutex::new(String::new()),
            animated,
            size,
            started,
        }
    }
    pub fn update(&self, title: &str, detail: &str, hint: &str) {
        *self.state.lock().unwrap() = Progress {
            title: title.into(),
            detail: detail.into(),
            hint: hint.into(),
            result: None,
        };
        if self.thread.is_none() {
            let mut last = self.last_plain.lock().unwrap();
            if *last != title {
                eprintln!("  {title} · {detail}");
                *last = title.into();
            }
        }
    }
    pub fn input_echo_counter(&self) -> Option<Arc<AtomicUsize>> {
        self.thread.as_ref()?;
        let echoes = std::process::Command::new("stty")
            .arg("-a")
            .stdin(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split_whitespace()
                    .any(|t| t == "echo")
            });
        echoes.then(|| self.echoed_lines.clone())
    }
    pub fn present(mut self, lines: Vec<Line>, linger: bool, leave: &AtomicBool) {
        let size = if self.thread.is_some() {
            dimensions().unwrap_or(self.size)
        } else {
            self.size
        };
        let mut view = lines.clone();
        let mut readable = render(&view, size.1.saturating_sub(1), false).len();
        // Work is already done and the useful result is visible throughout this skippable presentation.
        let footer = render(
            &[Line::new(
                "Setup finished · Enter to return now · closes automatically",
                Tone::Muted,
            )],
            size.1.saturating_sub(1),
            false,
        )
        .len();
        if Layout::fit(size.0, size.1, readable + footer).is_none() {
            // Reduce padding before cutting useful text or dropping the animated result.
            view.retain(|line| !line.text.trim().is_empty());
            readable = render(&view, size.1.saturating_sub(1), false).len();
        }
        if Layout::fit(size.0, size.1, readable + footer).is_none() {
            view = vec![lines[0].clone(), Line::new("Review ready · the full shortlists print below", Tone::Muted)];
            if let Some(start) = lines.iter().position(|line| matches!(line.tone, Tone::Rule)) {
                view.extend_from_slice(&lines[start..]);
            }
            readable = render(&view, size.1.saturating_sub(1), false).len();
        }
        let hold =
            linger && self.animated && Layout::fit(size.0, size.1, readable + footer).is_some();
        if hold {
            self.state.lock().unwrap().result = Some(view);
            let presented = Instant::now();
            while (self.started.elapsed() < Duration::from_secs(8) || presented.elapsed() < Duration::from_secs(3)) && !leave.load(Ordering::Acquire)
            {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
            let rows = self.body_rows.load(Ordering::Acquire);
            let mut err = std::io::stderr().lock();
            let _ = write!(err, "\x1b[{rows}A");
            for _ in 0..rows {
                let _ = writeln!(err, "\r\x1b[2K");
            }
            let _ = write!(err, "\x1b[{rows}A");
            let _ = err.flush();
        }
        let size = if self.animated {
            dimensions().unwrap_or(size)
        } else {
            size
        };
        let color = std::io::stdout().is_terminal()
            && std::env::var_os("NO_COLOR").is_none()
            && std::env::var("TERM").unwrap_or_default() != "dumb";
        for line in render(&lines, size.1.saturating_sub(1), color) {
            println!("{line}");
        }
    }
}
/// A few lines redrawn in place below output that stays (the printed report and its prompt), on stderr.
pub struct Live {
    rows: usize,
    color: bool,
    /// Lines the terminal echoed from input (Enter) since the last draw, which sit below the drawn rows.
    echoed: Option<Arc<AtomicUsize>>,
}
impl Live {
    /// None when stderr is not an interactive terminal.
    pub fn start(echoed: Option<Arc<AtomicUsize>>) -> Option<Self> {
        let terminal = std::io::stderr().is_terminal() && std::env::var("TERM").unwrap_or_default() != "dumb";
        terminal.then(|| Self { rows: 0, color: std::env::var_os("NO_COLOR").is_none(), echoed })
    }
    pub fn draw(&mut self, lines: &[Line]) {
        let width = dimensions().map_or(80, |d| d.1);
        let body = render(lines, width.saturating_sub(1), self.color);
        let echoed = self.echoed.as_ref().map_or(0, |e| e.swap(0, Ordering::AcqRel));
        let mut err = std::io::stderr().lock();
        if self.rows + echoed > 0 {
            let _ = write!(err, "\x1b[{}A", self.rows + echoed);
        }
        for line in &body {
            let _ = writeln!(err, "\r\x1b[2K{line}");
        }
        // Only rows this region drew before are erased, never the report above it.
        for _ in body.len()..self.rows + echoed {
            let _ = writeln!(err, "\r\x1b[2K");
        }
        if self.rows + echoed > body.len() {
            let _ = write!(err, "\x1b[{}A", self.rows + echoed - body.len());
        }
        let _ = err.flush();
        self.rows = body.len();
    }
    /// The final lines replace the region and stay.
    pub fn settle(mut self, lines: &[Line]) {
        self.draw(lines);
    }
}
impl Drop for Display {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
fn hash(n: usize) -> f64 {
    let x = ((n as f64) * 127.1 + 311.7).sin() * 43758.5453;
    x - x.floor()
}
fn smooth(p: f64) -> f64 {
    let p = p.clamp(0., 1.);
    p * p * (3. - 2. * p)
}
const GLYPHS: [[&str; 7]; 7] = [
    [
        "00000", "00000", "10001", "10001", "10001", "10011", "01101",
    ],
    [
        "00000", "00000", "11110", "10001", "10001", "10001", "10001",
    ],
    [
        "00000", "00000", "01111", "10000", "01110", "00001", "11110",
    ],
    [
        "00100", "00100", "11111", "00100", "00100", "00100", "00010",
    ],
    [
        "00000", "00000", "01110", "00001", "01111", "10001", "01111",
    ],
    [
        "01100", "00100", "00100", "00100", "00100", "00100", "01110",
    ],
    [
        "00000", "00000", "01110", "10001", "11111", "10000", "01111",
    ],
];
#[cfg(test)]
fn cloud(t: f64) -> Vec<String> {
    cloud_with(t, Layout::NORMAL, true)
}
fn cloud_with(t: f64, layout: Layout, ambient: bool) -> Vec<String> {
    let Layout {
        scale,
        width,
        height,
    } = layout;
    let w = width as f64;
    let h = height as f64;
    let phase = t % 32.;
    let mut pixels = vec![vec![None::<[u8; 3]>; width]; height];
    let mut dot = |x: f64, y: f64, c: [u8; 3]| {
        let (x, y) = (x.round() as isize, y.round() as isize);
        if (0..width as isize).contains(&x) && (0..height as isize).contains(&y) {
            pixels[y as usize][x as usize] = Some(c);
        }
    };
    let green = [103, 220, 145];
    let mut flurries = std::collections::BTreeMap::new();
    let amber = [232, 172, 94];
    for side in (0..2).filter(|_| ambient) {
        for i in 0..180 {
            let seed = i + side * 701;
            let x =
                (hash(seed + 50) * (w + 16.) + t * (7. + hash(seed + 90) * 4.)) % (w + 16.) - 8.;
            let arc = (std::f64::consts::PI * (x / w).clamp(0., 1.)).sin();
            let core = if side == 0 {
                h * 0.12 - arc * h * 0.04
            } else {
                h * 0.85 + arc * h * 0.045
            };
            let spread = hash(seed + 200) + hash(seed + 400) + hash(seed + 600) - 1.5;
            let y = core + spread * 3. + (x / w * 9. - t * 0.35 + side as f64 * 2.).sin() * 0.7;
            let c = if spread.abs() < 0.24 && i % 7 == 0 {
                [23, 150, 145]
            } else {
                [37, 80, 80]
            };
            dot(x, y, c);
        }
    }
    let mut letters = std::collections::BTreeSet::new();
    for (letter, glyph) in GLYPHS.iter().enumerate() {
        for (y, row) in glyph.iter().enumerate() {
            for (x, c) in row.bytes().enumerate() {
                if c == b'1' {
                    for dy in 0..scale {
                        for dx in 0..=scale {
                            letters.insert((3 + (letter * 6 + x) * scale + dx, 7 + y * scale + dy));
                        }
                    }
                }
            }
        }
    }
    let letters: Vec<_> = letters.into_iter().collect();
    let assembled = smooth(t / 5.5);
    for (i, &(tx, ty)) in letters.iter().enumerate() {
        let mut stale = 0f64;
        for event in 0..9 {
            let birth = 6.2 + event as f64 * 2.2 + hash(event + 701) * 0.5;
            if phase < birth {
                continue;
            }
            let target = letters[(hash(event + 101) * letters.len() as f64) as usize];
            let radius = ((tx as f64 - target.0 as f64) / (w * (0.05 + hash(event + 201) * 0.1)))
                .powi(2)
                + ((ty as f64 - target.1 as f64) / (h * (0.11 + hash(event + 301) * 0.22))).powi(2);
            if hash(i + event * 911) > 0.78 + hash(event + 401) * 0.22 {
                continue;
            }
            let area = 1. - smooth((radius - 0.3) / 1.1);
            // One quiet repair particle serves a small tile of the current amber patch.
            // Nearby pixels share its arrival instead of each spawning a particle.
            let seed = tx / 3 + (ty / 3) * width.div_ceil(3) + event * 1999;
            let landing = birth + 2.5 + hash(seed + 3001) * 2.4;
            let duration = 1.2 + hash(seed + 3101) * 0.8;
            let flight = (phase - (landing - duration)) / duration;
            let healed = smooth((phase - landing) / 0.25);
            stale = stale.max(area * smooth((phase - birth) / 0.65) * (1. - healed));
            if area > 0.25 && (0.0..1.0).contains(&flight) {
                let p = smooth(flight);
                let sx = tx as f64 - 7. - hash(seed + 3201) * 12.;
                let side = ty as f64 + (hash(seed + 3301) - 0.5) * 5. > h * 0.5;
                let sy = if side { h * 0.87 } else { h * 0.08 } + (hash(seed + 3401) - 0.5) * 3.;
                let curl = (std::f64::consts::PI * flight).sin();
                let fx = sx + (tx as f64 - sx) * p + curl * (hash(seed + 3501) - 0.5) * 3.;
                let fy = sy + (ty as f64 - sy) * p + curl * (hash(seed + 3601) - 0.5) * 3.;
                flurries.entry(seed).or_insert((
                    fx,
                    fy,
                    if flight > 0.65 { green } else { [45, 151, 123] },
                ));
            }
        }
        let mut rgb = [0; 3];
        for ch in 0..3 {
            rgb[ch] = (green[ch] as f64 + (amber[ch] as f64 - green[ch] as f64) * stale) as u8;
        }
        let x = (0.04 + hash(i + 401) * 0.92) * w * (1. - assembled) + tx as f64 * assembled;
        let y = (0.04 + hash(i + 1601) * 0.92) * h * (1. - assembled) + ty as f64 * assembled;
        dot(x, y, rgb);
    }
    for (x, y, color) in flurries.into_values() {
        dot(x, y, color);
    }
    let bits = [[1u32, 8], [2, 16], [4, 32], [64, 128]];
    let mut lines = vec![];
    for row in 0..height / 4 {
        let mut line = String::from("  ");
        for col in 0..width / 2 {
            let mut mask = 0;
            let mut rgb = [0u8; 3];
            for y in 0..4 {
                for x in 0..2 {
                    if let Some(c) = pixels[row * 4 + y][col * 2 + x] {
                        mask |= bits[y][x];
                        if c.iter().map(|v| *v as u16).sum::<u16>()
                            > rgb.iter().map(|v| *v as u16).sum()
                        {
                            rgb = c;
                        }
                    }
                }
            }
            if mask == 0 {
                line.push(' ')
            } else {
                line.push_str(&format!(
                    "\x1b[1m\x1b[38;2;{};{};{}m{}",
                    rgb[0],
                    rgb[1],
                    rgb[2],
                    char::from_u32(0x2800 + mask).unwrap()
                ));
            }
        }
        line.push_str("\x1b[0m");
        lines.push(line);
    }
    lines.push(String::new());
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn action_panel_has_plain_copyable_prompt_and_width_bounded_rules() {
        let prompt = "Use .unstale/skills/onboarding/SKILL.md to review this repository.";
        let lines = vec![Line::new("", Tone::Rule), Line::new(prompt, Tone::Prompt), Line::new("", Tone::Rule)];
        for width in [24, 80, 160] {
            let plain = render(&lines, width, false);
            assert!(!plain.join(" ").contains("\x1b["));
            assert!(plain.iter().all(|line| line.chars().count() <= width));
            let copied = plain[1..plain.len()-1].join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
            if width >= 80 { assert_eq!(copied, prompt); }
            else { assert_eq!(copied.split_whitespace().collect::<String>(), prompt.split_whitespace().collect::<String>()); }
        }
        assert!(paint(prompt, Tone::Prompt, true).contains("\x1b[1;"));
    }
    #[test]
    fn summary_wraps_complete_sentences_and_colors_only_when_requested() {
        let lines = vec![Line::new(
            "A complete capability explanation that must not be cut off mid-sentence.",
            Tone::Fresh,
        )];
        let plain = render(&lines, 32, false);
        assert!(plain.iter().all(|l| l.chars().count() <= 32));
        assert_eq!(
            plain.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" "),
            lines[0].text
        );
        assert!(!plain.join("").contains("\x1b"));
        assert!(render(&lines, 80, true).join("").contains("103;220;145"));
    }
    #[test]
    fn layout_reserves_space_for_the_actual_result_in_short_and_narrow_terminals() {
        assert_eq!(Layout::fit(26, 120, 15).unwrap().scale, 2);
        assert_eq!(Layout::fit(36, 100, 15).unwrap().scale, 3);
        assert!(Layout::fit(20, 40, 15).is_none());
    }
    #[test]
    fn lettering_has_a_balanced_dot_grid_in_both_layouts() {
        // The prior 3-wide/2-high pitch squashed the mark to an 8:1 dot aspect.
        for (layout, time) in [Layout::NORMAL, Layout::COMPACT]
            .into_iter()
            .flat_map(|layout| [31., 32.].into_iter().map(move |time| (layout, time)))
        {
            let frame = cloud_with(time, layout, true);
            let mut points = vec![];
            for (row, line) in frame.iter().enumerate() {
                let mut chars = line.chars().peekable();
                let mut col = 0;
                let mut green = false;
                while let Some(c) = chars.next() {
                    if c == '\x1b' {
                        let mut code = String::new();
                        for c in chars.by_ref() {
                            if c == 'm' {
                                break;
                            }
                            code.push(c);
                        }
                        green = code.contains("103;220;145");
                        continue;
                    }
                    if green && (0x2800..=0x28ff).contains(&(c as u32)) {
                        let mask = c as u32 - 0x2800;
                        for (dy, bits) in
                            [[1u32, 8], [2, 16], [4, 32], [64, 128]].iter().enumerate()
                        {
                            for (dx, bit) in bits.iter().enumerate() {
                                if mask & bit != 0 {
                                    points.push((col * 2 + dx, row * 4 + dy));
                                }
                            }
                        }
                    }
                    col += 1;
                }
            }
            let width = points.iter().map(|p| p.0).max().unwrap()
                - points.iter().map(|p| p.0).min().unwrap()
                + 1;
            let height = points.iter().map(|p| p.1).max().unwrap()
                - points.iter().map(|p| p.1).min().unwrap()
                + 1;
            assert!(
                (width as f64 / height as f64) < 6.5,
                "rendered dot aspect {width}:{height}"
            );
        }
    }
    #[test]
    fn cloud_has_visible_pending_swarm_recovery_and_a_green_rest() {
        let mut amber = false;
        let mut green_particles = false;
        for frame in 144..696 {
            let t = frame as f64 / 24.;
            let image = cloud(t).join("\n");
            for escape in image.split("\x1b[38;2;").skip(1) {
                let Some(rgb) = escape.split('m').next() else {
                    continue;
                };
                let rgb: Vec<u16> = rgb.split(';').filter_map(|v| v.parse().ok()).collect();
                if rgb.len() == 3 {
                    amber |= rgb[0] > 190 && rgb[1] < 195 && rgb[2] < 130;
                    assert!(
                        !(rgb[0] > 220 && rgb[1] > 230 && rgb[2] > 220),
                        "No white surge"
                    );
                    green_particles |= rgb == [45, 151, 123];
                }
            }
        }
        assert!(
            amber && green_particles,
            "Both pending patches and renewal must be visibly rendered"
        );
        let rest = cloud(31.).join("\n");
        assert!(rest.contains("103;220;145m"));
        assert!(!rest.contains("232;172;94m"));
        let exit = cloud_with(31., Layout::NORMAL, false).join("\n");
        assert!(exit.contains("103;220;145m"), "The wordmark stays");
        assert!(!exit.contains("37;80;80m") && !exit.contains("23;150;145m"), "No ambient bands on the exit frame");
    }
}
