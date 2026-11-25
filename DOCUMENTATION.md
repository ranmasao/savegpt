# SaveGPT documentation

Chrome/Chromium extension that saves the ChatGPT conversation you are looking at as a
Markdown file - one that reads well for a human and parses unambiguously for an agent.

Design rationale and decisions live in [PLAN.md](PLAN.md).

## Status: v0.1, for user acceptance testing

Implemented: the API extraction path, the Markdown renderer, the popup, and the download.

Not implemented yet: the DOM fallback (so a conversation with no id in the URL cannot be
exported), tool / code-interpreter plumbing, reasoning summaries, and real image export -
generated images appear as `> [image: <title>]` placeholders rather than files. Omitted
content is declared in the file's front matter rather than dropped silently.

## Install

No build step and no dependencies - the extension is plain ES modules.

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, and pick this directory.
4. Open a saved conversation on `chatgpt.com` (the URL must look like `/c/<id>`), then
   click the SaveGPT toolbar icon and press **Save as Markdown**.

If the tab was already open when the extension was installed or reloaded, the popup
injects the content script on demand; if that fails, reload the tab.

A **Save raw JSON (debug)** link appears in the popup **only for an unpacked install**
(`chrome.management.getSelf().installType === 'development'`). It writes the untouched
backend payload next to the Markdown, which is what makes a bug report actionable. Users
of a packed build never see it.

### Icon

`icons/icon.svg` is the source; the PNGs are generated from it:

```sh
cd icons && for s in 16 32 48 128; do inkscape icon.svg -w $s -h $s -o icon-$s.png; done
```

It is drawn for the 16px case: the brain sits wide and flat, the arrow hangs below rather
than crossing it, the gap between them is transparent rather than white, and both shapes
are the same green so neither disappears on a dark toolbar.

## Output format

```markdown
---
title: "How to tune a Postgres connection pool"
source: https://chatgpt.com/c/6a1f...c9
created: 2026-08-09T14:02:11+02:00
updated: 2026-08-09T14:41:53+02:00
model: gpt-5
conversation_id: 6a1f...c9
exported: 2026-08-10T17:45:00+02:00
exported_by: SaveGPT 0.1.0 (api)
savegpt_format: 1
savegpt_marker: k7f3a1c92e
---

<!-- savegpt:k7f3a1c92e begin index=1 role=user time=2026-08-09T14:02:11+02:00 -->
# User - turn 1 - 2026-08-09 14:02

How do I size a connection pool?

<!-- savegpt:k7f3a1c92e end index=1 -->

---

<!-- savegpt:k7f3a1c92e begin index=2 role=assistant time=2026-08-09T14:02:40+02:00 model=gpt-5 -->
# ChatGPT - turn 2 - 2026-08-09 14:02

Start from the number of cores, not the number of users.

<!-- savegpt:k7f3a1c92e end index=2 -->
```

The speaker label is an h1 carrying the turn number, and turns are separated by a `---`
rule placed **outside** the frames. Both exist because message bodies are verbatim:
assistant answers routinely contain their own h1 headings and their own `---` rules, so
without a top-level label the turns sink below body sections in an editor outline, and
without a boundary rule the only visible rules in the document are the misleading
intra-message ones.

### Why the HTML comments

They are invisible in every Markdown renderer, so the human view is just headings and
prose. They exist so a program never has to guess where a message starts or ends.

`savegpt_marker` is random per export. That is the point: message bodies are written out
**verbatim**, and a body may itself contain headings, `---` rules, nested code fences, or
even a quoted SaveGPT export. Since the body cannot contain a marker it could not predict,
it cannot forge a frame. The renderer also scans the finished bodies for the marker and
regenerates it on a hit, so collision is impossible in an emitted file rather than merely
unlikely.

### Parser contract

- `savegpt_format: 1` - check this before trusting the layout.
- `savegpt_marker: <marker>` - read it, then split on
  `<!-- savegpt:<marker> begin ... -->` and `<!-- savegpt:<marker> end index=N -->`.
- Frame attributes are `key=value`, space-separated. Values are unquoted when they match
  `[A-Za-z0-9:._+-]*` and double-quoted with `\"` escaping otherwise. Attributes may be
  added in later versions: **ignore unknown keys**.
- Current attributes: `index` (1..N, on both begin and end), `role` (`user` or
  `assistant`), `time` (ISO-8601 with offset, absent when unknown), `model` (assistant
  messages), `fence_repaired` (see below).
- `fence_repaired=1` means the source message was truncated inside a code fence and the
  exporter appended one closing fence line to the body. **Drop the body's last line to
  recover the original bytes exactly.** Nothing else about the body was changed. Without
  this repair an unterminated fence swallows the following frames into one rendered code
  block, which both corrupts the reading view and makes the machine framing visible.
- Inside a frame, the first line is the human heading (`# <label> - turn N[ - <time>]`)
  and the second is blank. Everything after that, up to the `end` comment, is the message
  body exactly as written.
- Between frames there is a `---` rule. It is outside every frame, so it never appears in
  a parsed body; ignore anything between an `end` comment and the next `begin`.
- `omitted:` in the front matter lists content kinds this export dropped.
- `timestamps: partial` means at least one message had no known time.
- `model:` is emitted when the whole conversation used one model; `models: [a, b]` when it
  switched. The per-message `model=` attribute is authoritative either way.
- `fence_repairs: N` counts the bodies carrying `fence_repaired=1`.
- `citations: N resolved` means N web-search citations or entity chips were turned into
  ordinary Markdown. ChatGPT marks these inline with private-use codepoints
  (U+E200..U+E2FF) that only its own client renders; each one carries the replacement
  Markdown in the payload, so a citation becomes `([Blizzard News](https://...))` and an
  entity chip becomes its display name. Affected frames carry `citations=N`. Any marker
  codepoint the payload does not account for is stripped and counted as
  `citation_markers_stripped: N`. No private-use codepoint ever reaches the file.
- `math: latex-parens` means at least one body writes math with `\( \)` / `\[ \]` rather
  than `$` / `$$`. ChatGPT's own viewer renders those; GitHub, Obsidian and VS Code do
  not. By default the exporter flags this and leaves the body alone.
- `math: dollar (converted from latex-parens)` means the **Convert math to $ / $$** option
  was on, and those delimiters were rewritten so the math renders. Affected frames carry
  `math_converted=1`. The rewrite touches prose only - fenced blocks and inline code spans
  are left exactly as they were, since that is where the same characters mean something
  else.

A working implementation of exactly this contract is in
[`test/smoke.mjs`](test/smoke.mjs) (`parse`), which the test suite round-trips against
adversarial content.

## Development

```sh
npm test                                        # both suites
npm run smoke                                   # round-trip and adversarial unit tests
SAVEGPT_FIXTURES=~/Downloads npm run payloads   # verify against real saved payloads
```

`npm run payloads` reads every `*.raw.json` in the given directory - save them with the
popup's debug link - and asserts, per conversation: one frame per message, sequential
begin/end indices, verbatim bodies modulo declared fence repairs, no undeclared drops, and
no two consecutive user turns (the signature of a reply having been dropped). Payloads are
personal conversations and are not committed, so the suite skips when the directory is
absent.

The render modules (`src/render/*`) and the payload-to-Conversation mapping
(`src/extract/mapping.js`) are pure - no DOM, no `chrome.*` - so they run under Node
unchanged, and the tests exercise the same code the extension ships.
`src/content/content.js` handles only auth and fetching; it stays a classic script, since
a declared content script cannot use a static `import`, and pulls in the mapping module
via a dynamic import of an extension URL.

## Privacy

No telemetry, no third-party servers. The extension talks only to `chatgpt.com`, using
your existing session, and writes files through the browser's own download mechanism.
