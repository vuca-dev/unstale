//! The golden transcript, the recording and the gallery page made from them.

use super::*;

pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// What the requests to each host were, by method and path: part of the golden, so a new request shows as a diff.
pub(crate) fn traffic(w: &World) -> Vec<String> {
    let mut lines = vec![];
    let describe = |reqs: Vec<Request>| -> Vec<String> {
        let set: BTreeSet<String> = reqs
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.method,
                    w.normalise(r.path.split('?').next().unwrap_or(""))
                )
            })
            .collect();
        set.into_iter().collect()
    };
    lines.push(format!(
        "catalog host: {}",
        describe(w.catalog_host.requests()).join(", ")
    ));
    let p = describe(w.provider_host.requests());
    lines.push(format!(
        "model provider: {}",
        match w.provider_host.requests().len() {
            0 => "nothing".into(),
            1 => format!("{} (1 request)", p.join(", ")),
            n => format!("{} ({n} requests)", p.join(", ")),
        }
    ));
    let codex: Vec<String> = support::codex_invocations(&w.codex_dir())
        .iter()
        .map(|i| i.split_whitespace().take(2).collect::<Vec<_>>().join(" "))
        .collect();
    lines.push(format!(
        "codex: {}",
        if codex.is_empty() {
            "not run".into()
        } else {
            codex.join(", ")
        }
    ));
    let t = w.trap.requests().len();
    lines.push(format!(
        "anything else: {}",
        if t == 0 {
            "nothing".into()
        } else {
            format!("{t} requests through the proxy")
        }
    ));
    lines
}

/// The golden transcript: what the person or agent saw, command by command, then what was contacted.
pub(crate) fn transcript(
    s: &Scenario,
    se: &Session,
    violations: &[String],
    known: &[String],
) -> String {
    let w = &se.world;
    let mut t = format!("# {}\n# {}\n", s.title, s.dims());
    for r in &se.ran {
        t.push('\n');
        if let Some(n) = &r.note {
            t += &format!("# {n}\n");
        }
        if r.shown.is_empty() {
            continue;
        }
        t += &format!(
            "$ {}{}\n",
            r.shown,
            if r.terminal { "" } else { "  (no terminal)" }
        );
        let out = w.normalise(&strip_ansi(&r.output));
        t += &out;
        if !out.is_empty() && !out.ends_with('\n') {
            t.push('\n');
        }
        // Interrupted by Ctrl-C: the exit status the shell reports differs by system.
        if r.code != 0 && s.invocation.answer == "\u{3}" && questions(&r.output) > 0 {
            t += "[interrupted]\n";
        } else if r.code != 0 {
            t += &format!("[exit {}]\n", r.code);
        }
    }
    t += "\n# contacted\n";
    for l in traffic(w) {
        t += &format!("#   {l}\n");
    }
    if !violations.is_empty() {
        t += "\n# violations\n";
        for l in violations {
            t += &format!("#   {l}\n");
        }
    }
    if !known.is_empty() {
        t += "\n# known product bugs (expected to fail until fixed; see KNOWN_BUGS in checks.rs)\n";
        for l in known {
            t += &format!("#   {l}\n");
        }
    }
    t
}

/// A recording for playback (asciicast v2): the commands typed and their output line by line, at a steady pace so
/// the file is the same on every run.
pub(crate) fn recording(s: &Scenario, se: &Session) -> String {
    let w = &se.world;
    let mut lines =
        vec![json!({"version": 2, "width": 120, "height": 32, "title": s.title}).to_string()];
    let mut t = 0.0f64;
    let mut emit = |t: f64, text: &str| {
        lines.push(json!([(t * 100.0).round() / 100.0, "o", text]).to_string())
    };
    for r in &se.ran {
        if let Some(n) = &r.note {
            emit(t, &format!("\x1b[2m# {n}\x1b[0m\r\n"));
            t += 0.6;
        }
        if r.shown.is_empty() {
            continue;
        }
        emit(t, "\x1b[1m$\x1b[0m ");
        for c in r.shown.chars().take(80) {
            t += 0.025;
            emit(t, &c.to_string());
        }
        if r.shown.chars().count() > 80 {
            emit(t, &r.shown.chars().skip(80).collect::<String>());
        }
        t += 0.4;
        emit(t, "\r\n");
        for l in w.normalise(&r.output).lines() {
            t += 0.06;
            emit(t, &format!("{l}\r\n"));
        }
        t += 0.9;
    }
    lines.join("\n") + "\n"
}

pub(crate) fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/matrix")
}

/// Compares `text` with the checked-in file, or rewrites it under `UPDATE_GOLDEN=1`. Returns a mismatch message.
pub(crate) fn golden(rel: &str, text: &str) -> Option<String> {
    let path = golden_dir().join(rel);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        write(&path, text);
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(want) if want == text => None,
        Ok(want) => Some(format!(
            "{rel} changed; review it, then `UPDATE_GOLDEN=1 cargo test --test matrix` rewrites it\n{}",
            diff(&want, text)
        )),
        Err(_) => Some(format!(
            "{rel} is missing; `UPDATE_GOLDEN=1 cargo test --test matrix` writes it"
        )),
    }
}

/// The lines that differ, for a failure message.
pub(crate) fn diff(want: &str, got: &str) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (want.lines().collect(), got.lines().collect());
    let mut out = String::new();
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i), b.get(i));
        if x != y {
            if let Some(x) = x {
                out += &format!("- {x}\n");
            }
            if let Some(y) = y {
                out += &format!("+ {y}\n");
            }
        }
    }
    out.chars().take(4000).collect()
}

// ------------------------------------------------------------------------------------------------------- gallery

pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The playback page: one static file, every scenario grouped by what the user did, no network.
/// A scenario with its transcript and recording.
pub(crate) type Entry<'a> = (&'a Scenario, String, String);

pub(crate) fn gallery(entries: &[Entry]) -> String {
    // Groups in the order the invocations are listed.
    let mut groups: Vec<(&str, Vec<&Entry>)> = vec![];
    for inv in INVOCATIONS {
        if !groups.iter().any(|(g, _)| *g == inv.group) {
            groups.push((inv.group, vec![]));
        }
    }
    for e in entries {
        let g = groups
            .iter_mut()
            .find(|(g, _)| *g == e.0.invocation.group)
            .unwrap();
        g.1.push(e);
    }
    let mut nav = String::new();
    let mut body = String::new();
    let mut data = serde_json::Map::new();
    for (group, list) in groups {
        body += &format!("<section><h2>{}</h2>\n", html_escape(group));
        nav += &format!("<li class=\"g\">{}</li>\n", html_escape(group));
        let mut list = list;
        list.sort_by_key(|e| (!e.0.critical, e.0.title.clone()));
        for (s, text, cast) in list {
            nav += &format!(
                "<li><a href=\"#{}\">{}</a></li>\n",
                s.slug,
                html_escape(&s.title)
            );
            body += &format!(
                "<article id=\"{slug}\"><h3>{title}</h3><p class=\"dims\">{dims}</p>\
                 <div class=\"term\" data-cast=\"{slug}\"><div class=\"bar\"><span>{title}</span><div class=\"ctl\">\
                 <button data-play>Play</button><button data-all>Show all</button>\
                 <select data-speed><option value=\"2\">2×</option><option value=\"1\" selected>1×</option><option value=\"0.5\">0.5×</option></select>\
                 </div></div><pre class=\"screen\"></pre></div>\
                 <details><summary>Transcript and checks</summary><pre class=\"golden\">{golden}</pre></details></article>\n",
                slug = s.slug,
                title = html_escape(&s.title),
                dims = html_escape(&s.dims()),
                golden = html_escape(text),
            );
            data.insert(s.slug.clone(), serde_json::Value::String(cast.clone()));
        }
        body += "</section>\n";
    }
    let data = serde_json::to_string(&data).unwrap().replace("</", "<\\/");
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Environment matrix playback</title>
<style>{css}</style></head>
<body><header><h1>Environment matrix playback</h1>
<p>Each scenario is one simulated developer machine, run end to end by <code>cargo test --test matrix</code>. Play shows the session as it ran; Show all prints it at once. Generated from the golden transcripts; regenerate with <code>UPDATE_GOLDEN=1 cargo test --test matrix</code>.</p></header>
<div class="wrap"><nav><ul>
{nav}</ul></nav><main>
{body}</main></div>
<script>const CASTS = {data};
{js}</script></body></html>
"#,
        css = GALLERY_CSS,
        js = GALLERY_JS,
    )
}

pub(crate) const GALLERY_CSS: &str = r##":root{--bg:#f7f7f5;--fg:#1d1f21;--muted:#5c6166;--card:#fff;--line:#dedcd6;--term:#101414;--termfg:#d8dee0;--accent:#1f7a5a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121414;--fg:#e4e6e7;--muted:#9aa1a6;--card:#1a1d1e;--line:#2b2f31;--term:#0b0e0e;--termfg:#d8dee0;--accent:#67dc91}}
:root[data-theme="dark"]{--bg:#121414;--fg:#e4e6e7;--muted:#9aa1a6;--card:#1a1d1e;--line:#2b2f31;--term:#0b0e0e;--termfg:#d8dee0;--accent:#67dc91}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
header{padding:20px 16px;border-bottom:1px solid var(--line)}h1{margin:0 0 6px;font-size:22px}header p{margin:0;color:var(--muted);max-width:70ch}
.wrap{display:flex;gap:24px;padding:16px}nav{flex:0 0 280px;position:sticky;top:12px;align-self:flex-start;max-height:calc(100vh - 24px);overflow:auto}
nav ul{list-style:none;margin:0;padding:0}nav li{margin:2px 0}nav li.g{margin-top:14px;font-weight:600}nav a{color:var(--accent);text-decoration:none}
main{flex:1;min-width:0}h2{font-size:18px;margin:8px 0 12px}article{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin:0 0 18px}
h3{margin:0 0 4px;font-size:16px}.dims{margin:0 0 10px;color:var(--muted);font-size:13px}
.term{background:var(--term);color:var(--termfg);border-radius:6px;overflow:hidden}.bar{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;font-size:12px;color:#8a9496;border-bottom:1px solid #222}
.ctl{display:flex;gap:6px}.ctl button,.ctl select{background:#1c2222;color:#d8dee0;border:1px solid #333;border-radius:4px;font-size:12px;padding:2px 8px;cursor:pointer}
.screen{margin:0;padding:10px 12px;min-height:120px;max-height:520px;overflow:auto;font:12.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:13px}.golden{font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:10px;border-radius:6px;overflow:auto}
code{font-family:ui-monospace,Menlo,monospace}@media (max-width:800px){.wrap{display:block}nav{position:static;max-height:none;margin-bottom:16px}}"##;

pub(crate) const GALLERY_JS: &str = r##"function events(cast){return cast.trim().split("\n").slice(1).map(l=>JSON.parse(l));}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
// Minimal SGR: bold, dim, 24-bit and basic colours, reset. Everything else is dropped.
function render(text){let out="",open=0;const re=/\x1b\[([0-9;]*)([A-Za-z])/g;let last=0,m;
while((m=re.exec(text))){out+=esc(text.slice(last,m.index));last=re.lastIndex;if(m[2]!=="m")continue;
const p=m[1].split(";").map(Number);let style="";
for(let i=0;i<p.length;i++){const c=p[i];if(c===0||isNaN(c)){out+="</span>".repeat(open);open=0;}
else if(c===1)style+="font-weight:700;";else if(c===2)style+="opacity:.65;";
else if(c===38&&p[i+1]===2){style+=`color:rgb(${p[i+2]},${p[i+3]},${p[i+4]});`;i+=4;}
else if(c>=30&&c<=37)style+=`color:${["#555","#e06c75","#67dc91","#e8ac5e","#61afef","#c678dd","#56b6c2","#ddd"][c-30]};`;}
if(style){out+=`<span style="${style}">`;open++;}}
out+=esc(text.slice(last));return out+"</span>".repeat(open);}
for(const term of document.querySelectorAll(".term")){const ev=events(CASTS[term.dataset.cast]);const screen=term.querySelector(".screen");
const play=term.querySelector("[data-play]");const all=term.querySelector("[data-all]");const speed=term.querySelector("[data-speed]");
let timer=null,i=0,text="",start=0;
const show=()=>{screen.innerHTML=render(text.replace(/\r/g,""));screen.scrollTop=screen.scrollHeight;};
const stop=()=>{clearTimeout(timer);timer=null;play.textContent=i>=ev.length?"Replay":"Play";};
const tick=()=>{const rate=Number(speed.value);const now=(performance.now()-start)*rate/1000;
while(i<ev.length&&ev[i][0]<=now){text+=ev[i][2];i++;}show();if(i>=ev.length){stop();return;}
timer=setTimeout(tick,Math.max(10,(ev[i][0]-now)*1000/rate));};
play.addEventListener("click",()=>{if(timer){stop();return;}if(i>=ev.length){i=0;text="";}
start=performance.now()-(i?ev[i-1][0]*1000/Number(speed.value):0);play.textContent="Pause";tick();});
all.addEventListener("click",()=>{clearTimeout(timer);timer=null;text=ev.map(e=>e[2]).join("");i=ev.length;show();play.textContent="Replay";});
text=ev.map(e=>e[2]).join("");i=ev.length;show();play.textContent="Replay";}"##;
