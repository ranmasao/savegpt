# SaveGPT - Implementation Plan

Chrome/Chromium extension (Manifest V3) that exports a ChatGPT conversation to a Markdown
file: participants clearly marked, per-message internal structure preserved, optional
printable timestamps.

**Purpose, as settled in review.** Save *one* conversation to the local machine, in a file
that reads well for a human and parses unambiguously for an agent. OpenAI's own "Export
data" already covers wholesale archival; its output is just unpleasant to read and awkward
to consume. This project is not a better archiver - it is a good single-conversation
exporter. Every scope question below is decided against that sentence.

Status: v0.1 implemented and through four rounds of user acceptance testing. See section
11 for milestone state, and sections 13-16 for the UAT findings that changed the output
format.

---

## 1. Goals and non-goals

### Goals (v1)

1. One-click export of the conversation currently open in the tab.
2. Output is Markdown, saved via the browser download flow.
3. Each message is unambiguously attributed to a participant (user / assistant / tool),
   **unambiguously to a machine as well as to a human** - the file is meant to be consumed
   by agents, not only read. Message boundaries and roles must be recoverable by a parser
   with zero heuristics, for arbitrary and mixed body content. See 5.2.
4. The internal structure of each message survives the export: code fences with language
   tags, nested lists, tables, blockquotes, headings, inline/block math, links, bold and
   italic.
5. Optional timestamp per message, formatted for human reading, configurable.
6. Settings persist across sessions.

### Non-goals (v1, revisit later)

- Bulk export of the whole conversation list - out of scope permanently, not deferred
  (see 12.5).
- Tool / code-interpreter plumbing and reasoning summaries. Note that assistant-generated
  images are *not* in this category, despite arriving as tool messages - see 15.
- Downloading and embedding generated/uploaded images as local files.
- Exporting non-current branches (regenerated answers, edited prompts).
- Formats other than Markdown (HTML, PDF, JSON).
- Firefox/Safari builds (the code should stay portable, but is not a v1 target).

---

## 2. Key decision: where the data comes from

This is the single decision that shapes everything else, so it is spelled out first.

### Option A - read the rendered DOM

Walk the conversation nodes in the page and convert HTML to Markdown (Turndown + GFM).

- Pro: no dependency on private endpoints; works on any page state that renders.
- Con: the original Markdown was already lossy-rendered to HTML. Round-tripping it back
  reintroduces noise: KaTeX becomes markup that must be reverse-engineered from the
  `annotation[encoding="application/x-tex"]` node, code blocks pick up syntax-highlight
  `<span>` soup, tables and nested lists need custom rules.
- Con: virtualized/lazy-rendered long conversations may not have all turns in the DOM.
- Timestamps: **present in the current UI** (reviewer confirmed). Their exact carrier is
  not established yet - see 4.3, which makes pinning this down an explicit task rather
  than an assumption.

### Option B - read the conversation JSON from the web backend (recommended)

The page's own client loads the conversation from `GET /backend-api/conversation/<id>`.
A content script running on `chatgpt.com` shares the page origin, so a `fetch` from it
carries the session cookies. The response contains, per message, the **original Markdown
source** the model produced plus a `create_time` timestamp.

- Pro: perfect fidelity - the source text is taken, not reconstructed. Requirement 4 is
  satisfied by doing nothing.
- Pro: `create_time` gives requirement 5 for free.
- Pro: the whole conversation is present regardless of what is scrolled into view.
- Con: private, undocumented endpoint. It can change shape or gain bot protection without
  notice. Requires an `Authorization: Bearer` token obtained from `/api/auth/session`.
- Con: only works once the conversation has an id in the URL (`/c/<uuid>`). A brand-new
  chat that has not been persisted yet has no id.

### Decision

**Option B as the primary path, Option A as a fallback.** The extractor is defined behind
one interface so either backend can produce the same intermediate model:

```
extract(): Promise<Conversation>
  -> tryApiExtractor()      // preferred
  -> tryDomExtractor()      // used if no conversation id, auth fails, or fetch errors
```

The fallback degrades on structure fidelity (best-effort HTML -> Markdown) and possibly on
timestamps, depending on what 4.3 finds. The UI states which path was used so a
low-fidelity export is never mistaken for a good one.

---

## 3. Data model

One normalized shape between extraction and rendering. Everything downstream is a pure
function of this, which makes it testable without a browser.

```js
/**
 * @typedef {Object} Conversation
 * @property {string}  id            conversation uuid, "" if unknown
 * @property {string}  title
 * @property {string}  url           canonical https://chatgpt.com/c/<id>
 * @property {number?} createTime    unix seconds
 * @property {number?} updateTime    unix seconds
 * @property {string[]} models       distinct model slugs, in order of first use
 * @property {"api"|"dom"} source    which extractor produced this
 * @property {Message[]} messages    in chronological order, current branch only
 */

/**
 * @typedef {Object} Message
 * @property {string}  id
 * @property {"user"|"assistant"|"system"|"tool"} role
 * @property {string?} authorName    tool name, e.g. "python", "web"
 * @property {number?} createTime    unix seconds, null when unknown
 * @property {string?} model         per-message model slug when present
 * @property {Part[]}  parts
 */

/**
 * @typedef {Object} Part
 * @property {"markdown"|"code"|"image"|"thoughts"|"unknown"} kind
 * @property {string}  text          markdown source, or code body, or placeholder
 * @property {string?} language      for kind === "code"
 */
```

---

## 4. Extraction details

### 4.1 API extractor

1. Read the conversation id from `location.pathname` (`/c/<uuid>`, also accept
   `/g/<gizmo>/c/<uuid>`). Bail to the fallback if absent.
2. `GET /api/auth/session` -> `accessToken`. Cache it in memory for the tab's lifetime; it
   is short-lived, so refetch on a 401 and retry once.
3. `GET /backend-api/conversation/<id>` with `Authorization: Bearer <token>`.
4. The response's `mapping` is a **tree**, not a list - edits and regenerations create
   siblings. Resolve the displayed conversation by walking parent pointers from
   `current_node` to the root, then reversing. This yields exactly the branch the user
   sees.
5. Filter out nodes that should not appear:
   - `message == null` (the synthetic root)
   - `author.role === "system"`
   - `metadata.is_visually_hidden_from_conversation === true`
   - messages whose parts are all empty strings
6. Map `content` by `content_type`:

   | `content_type`     | handling                                                     |
   | ------------------ | ------------------------------------------------------------ |
   | `text`             | each `parts[]` entry -> `{kind: "markdown"}`                  |
   | `code`             | `{kind: "code", language: content.language ?? "python"}`      |
   | `execution_output` | `{kind: "code", language: "text"}`                            |
   | `multimodal_text`  | strings -> markdown; image pointers -> `{kind: "image"}`       |
   | `thoughts`         | `{kind: "thoughts"}`, included only if the setting is on      |
   | anything else      | `{kind: "unknown"}`, JSON-stringified, never silently dropped |

   The "never silently dropped" rule matters: when the endpoint gains a new content type,
   the export degrades visibly instead of losing text.

7. Tool messages (`author.role === "tool"`) and reasoning (`thoughts`) are **out of v1
   scope** (review decision, Q3). They are dropped, with no setting. Because dropping
   content silently is exactly the failure mode this plan tries to avoid, the omission is
   declared once in the front matter (`omitted: tools, thoughts`) rather than being
   invisible. The `Part` kinds stay in the data model so re-enabling them later is a
   renderer change only.

### 4.2 DOM extractor (fallback)

- Turns: `article[data-testid^="conversation-turn"]`, role from the descendant
  `[data-message-author-role]`, content root `[data-message-id] .markdown`.
- Turndown with the GFM plugin (tables, strikethrough, task lists), plus custom rules:
  - `pre > code` -> fenced block, language from the `language-*` class or the header label.
  - `.katex` -> replace with the `annotation[encoding="application/x-tex"]` text, wrapped
    in `$...$` or `$$...$$` depending on `.katex-display`.
  - `<img>` -> `![alt](src)` when the src is an http(s) URL, placeholder otherwise.
  - Strip the copy/edit/feedback button chrome that sits inside turn containers.
- Before extracting, scroll the conversation container to the top and back to force
  virtualized turns to mount; assert the turn count stops growing before reading.
- `createTime`: see 4.3. Until that investigation lands, the extractor sets `null` and the
  renderer's null-timestamp path (5.4) covers it.

These selectors are ChatGPT's internal markup and will break. Keep them in one file,
`src/extract/dom-selectors.js`, so a break is a one-file fix.

### 4.3 Open investigation: timestamps in the DOM

An earlier draft of this plan asserted the DOM carries no timestamps. That is wrong - they
are visible in the current UI. The carrier is unknown, so M6 opens with a bounded
investigation before any DOM timestamp code is written.

Candidates to check, in order:

1. A `title` / `aria-label` / `datetime` attribute on the turn or a child element - the
   cheapest case, a plain attribute read.
2. Rendered text in a hover tooltip or a per-message metadata row, mounted only on hover
   or only in certain UI settings. If it mounts on demand, the extractor cannot rely on
   it without synthesizing hover events over every turn - slow and fragile. Prefer
   reading whatever data attribute drives the tooltip over driving the UI.
3. Not in the DOM at all, but in the page's client-side store (a `__NEXT_DATA__` /
   hydration payload, or an in-memory cache). Reachable only from the page's own JS
   context, i.e. an injected `MAIN`-world script, not the isolated content script.
4. Only a coarse value (date, or "2h ago") rather than a precise instant.

Deliverable of the investigation: a note in this plan recording which candidate holds,
the precision available, and whether it survives a page reload. That answer decides:

- whether the DOM fallback offers full, coarse, or no timestamps;
- whether case 3 forces a `MAIN`-world injected script, which is a real manifest and
  security change (a page-context script is exposed to the page) and would need its own
  review;
- whether a coarse relative value should be exported at all, or suppressed as misleading.

Note this changes nothing about the choice in section 2: the API path remains preferred
for the original-Markdown fidelity reason, which stands on its own. DOM timestamps only
make the fallback less lossy than assumed.

---

## 5. Markdown rendering

### 5.1 Front matter

YAML front matter, on by default, toggleable - it is useful for Obsidian/static-site
users and noise for everyone else.

```markdown
---
title: "How to tune a Postgres connection pool"
source: https://chatgpt.com/c/6a1f...c9
created: 2026-08-09T14:02:11+02:00
updated: 2026-08-09T14:41:53+02:00
model: gpt-5
omitted: tools, thoughts
conversation_id: 6a1f...c9
exported: 2026-08-10T17:45:00+02:00
exported_by: SaveGPT 0.1.0 (api)
savegpt_format: 1
savegpt_marker: k7f3a1c92e
---
```

Key order is reader-facing first, machine bookkeeping last. `omitted` sits with the
reader's keys deliberately - it is the one line that tells a person the file is not the
whole conversation, and in the first UAT build it was buried under the identifiers.

Title is quoted and inner quotes escaped, so a title containing `:` or `"` cannot corrupt
the document.

`savegpt_format` and `savegpt_marker` are **not** part of the optional front matter: they
are what makes the message framing parseable (5.2). If the user turns front matter off,
these two keys are still emitted, as a minimal two-key block. Everything else in the block
is descriptive and can go.

### 5.2 Message delimiters - unambiguous for agents and humans both

**Requirement (from review): the export must be reliably parseable by an agent, not only
skimmable by a human.** Message bodies are arbitrary and heterogeneous - one message may
be prose, the next a Markdown tutorial containing `##` headings and `---` rules, the next
a fenced block that itself contains fenced blocks, and a single message may mix all of
these. This rules out any delimiter drawn from ordinary Markdown vocabulary.

The failure to design against is **delimiter forgery**: content that reproduces the
delimiter and splits one message into two, or swallows the next. Note this is not an
exotic case here - a conversation *about* this extension, or one that quotes an earlier
SaveGPT export, contains the literal marker text. A fixed marker string is therefore not
enough.

#### Chosen scheme: nonce-framed blocks

Every document declares a random per-export marker id in its front matter. Every message
is wrapped in an explicit begin/end pair carrying that id:

```markdown
---
title: "How to tune a Postgres connection pool"
savegpt_format: 1
savegpt_marker: k7f3a1c92e
...
---

<!-- savegpt:k7f3a1c92e begin index=1 role=user time=2026-08-09T14:02:11+02:00 -->
# User - turn 1 - 2026-08-09 14:02

...body verbatim...

<!-- savegpt:k7f3a1c92e end index=1 -->

---

<!-- savegpt:k7f3a1c92e begin index=2 role=assistant time=2026-08-09T14:02:40+02:00 model=gpt-5 -->
# ChatGPT - turn 2 - 2026-08-09 14:02

...body verbatim...

<!-- savegpt:k7f3a1c92e end index=2 -->
```

Why each piece:

- **Nonce** (`k` + 9 random hex chars, regenerated per export). Content cannot contain a
  string it could not predict. This is what makes the framing unforgeable rather than
  merely unlikely to collide.
- **Guarantee, not a probability.** After rendering the bodies, scan the concatenated text
  for the literal marker prefix `savegpt:<nonce>`. On a hit - regenerate the nonce and
  re-render. Terminates immediately in practice, and turns "collision is improbable" into
  "collision is impossible in the emitted file", which is what an agent parser needs.
- **Explicit `end`.** A parser never has to infer where a message stops by looking for the
  start of the next one. Bodies ending in half-open structures (an unclosed fence the
  model actually emitted, a trailing table row) cannot bleed into the following message.
- **`index`** on both begin and end, matching. Detects truncation and out-of-order edits.
- **HTML comments.** Invisible in every Markdown renderer, so the human view is unchanged,
  and they survive round-tripping through most editors.
- **`savegpt_format: 1`** in the front matter. A parser can version-check before trusting
  the layout.
- **Human heading inside the frame.** Humans get the outline; agents ignore it and read
  the attributes. Both audiences are served without two output modes.

The attribute list is `key=value`, values unquoted when `[A-Za-z0-9:._+-]*`, otherwise
double-quoted with `\"` escaping. Attributes are ordered and may be extended; parsers must
ignore unknown keys.

This makes the machine-readable framing the **default and non-optional**, replacing the
earlier draft's proposal of headings-by-default with markers behind a setting. A setting
that can turn the frames off would mean an agent cannot rely on them being there, which
defeats the purpose. The `delimiterStyle` setting is therefore dropped; what remains
configurable is the human-facing heading (labels, timestamp position), which lives inside
the frame and cannot affect parsing.

A short **parser contract** ships in the README: split on `^<!-- savegpt:<marker> begin `,
read attributes, take everything up to the matching `end` line as the verbatim body, strip
the one leading heading line if `savegpt_format: 1`. Ten lines of code for a consumer.

#### Bodies are verbatim

In all cases the body is emitted **verbatim** - never indented, never wrapped in a
blockquote, never re-wrapped at a column limit, never escaped. Indenting or quoting a body
is what breaks fenced code and nested lists, and it is the most common bug in tools of
this kind. The nonce framing is what makes verbatim safe: because the delimiters live
outside the Markdown vocabulary the body can use, nothing in the body needs neutralizing.

This also retires `demoteHeadings`. It existed only to stop body headings from polluting
the outline, and it edits the body to do so - unacceptable once verbatim bodies are the
guarantee agents depend on.

### 5.3 Participant labels and the human layout

Labels are configurable, defaulting to `User` and `ChatGPT`.

The layout around them was **revised after the first UAT round** (see 13), where a real
32-turn conversation showed the original `## User <sub>time</sub>` form failing in three
ways. All three follow from bodies being verbatim, and none is fixable by editing bodies:

1. **Heading level.** The assistant's own answers used 60 h1 headings. With the label at
   h2, every speaker label rendered as a *child* of the previous message's last section in
   an editor outline - the conversation's own structure sank below the content's. The
   label is now **h1**. This does not make it outrank body headings, which are also h1; it
   makes turns stay at the outline's top level instead of nesting under the wrong parent.
   No level is safe while bodies are verbatim, and verbatim is not negotiable.
2. **Turn boundaries.** The same file had 75 `---` rules, every one of them inside a
   message and none at a boundary - so the strongest visual separator in the rendered
   document actively misled. A `---` is now emitted **between frames, outside them**, so
   boundaries are visible when rendered and parsers never see it inside a body.
3. **`<sub>` for the timestamp.** Inside a heading it rendered at 0.83x *heading* size and
   below the baseline - it read as a rendering glitch - and in raw view it repeated, in a
   worse format, the ISO time already on the comment line above.

The resulting label is `# <Label> - turn <N> - <time>`, with the turn number included
because a human navigating a long export wants the same index the machine frame carries.
The timestamp is dropped from the label when unknown, and the whole ` - <time>` segment is
dropped when timestamps are off.

### 5.4 Timestamps

- Off by default? No - the requirement calls it optional, and the useful default for a
  saved log is on. Default **on**, easily switched off.
- Rendered inline on the participant line: `# User - turn 1 - 2026-08-09 14:02` (5.3).
- Format setting: `iso` (`2026-08-09T14:02:11+02:00`), `datetime` (`2026-08-09 14:02`,
  default), `time` (`14:02`), `relative-to-start` (`+04:31` from the first message).
- Timezone: the browser's local zone. The absolute export time in the front matter carries
  the offset so the file is not ambiguous.
- When `createTime` is null (a message the API returns without one, or the DOM fallback if
  4.3 concludes timestamps are unreachable there), the human heading omits the timestamp
  rather than faking it, the frame's `time=` attribute is omitted entirely - not emitted
  empty, so an agent sees absence rather than a parse-worthy blank - and a single note is
  added to the front matter: `timestamps: partial`.
- The frame attribute always carries full ISO-8601 with offset regardless of
  `timestampFormat`. That setting governs the human heading only. Agents get one stable
  machine format; humans get their preference. If 4.3 finds only a coarse DOM value, the
  frame carries the coarsest honest form (`time_precision=day` alongside it) rather than a
  falsely precise instant.

### 5.5 Parts

- `markdown` - verbatim, parts joined by a blank line.
- `code` - wrapped in a fence whose backtick count is `max(3, longest run inside + 1)` so a
  body containing ``` cannot escape the fence.
- `image` - a generic placeholder (review decision, Q4). Alt text is used when the payload
  carries one, otherwise a fixed phrase:

  ```markdown
  > [image: a bar chart of query latency by hour]
  > [image]
  ```

  Blockquote form so it reads as an aside in a renderer and cannot be mistaken for body
  prose. No URL, no file id: v1 does not retain the asset pointer, so adding real image
  export later means re-exporting the conversation, not upgrading existing files. Flagged
  because it is the one v1 shortcut that is not backfillable - accepted as the cost of
  keeping v1 small.
- `thoughts` - dropped in v1, see 4.1 step 7.

### 5.6 Filename

`<sanitized-title>-<YYYY-MM-DD>.md`. Sanitizer: strip control chars and `<>:"/\|?*`,
collapse whitespace to `-`, strip leading/trailing dots and dashes, cap the stem at 80
chars, fall back to `chatgpt-conversation` when the title is empty. Chrome's downloader
resolves collisions with ` (1)` on its own; do not reinvent that.

---

## 6. Extension architecture

```
manifest.json                 MV3
src/
  background/
    service-worker.js         message router, context-menu entry
  content/
    content.js                extractor host; runs on chatgpt.com
    extract/
      index.js                extract() with the API -> DOM fallback
      api.js                  backend-api client + mapping tree walk
      dom.js                  Turndown-based fallback
      dom-selectors.js        every brittle selector, isolated
  render/
    markdown.js               Conversation -> string   (pure, no DOM)
    frontmatter.js            (pure)
    timestamp.js              (pure)
    filename.js               (pure)
  popup/
    popup.html / popup.js     primary UI + the actual download call
  options/
    options.html / options.js full settings page
  settings.js                 defaults + chrome.storage.sync read/write
test/
  fixtures/*.json             captured conversation payloads
  *.test.js                   vitest over the pure modules
```

### 6.1 Manifest

```json
{
  "manifest_version": 3,
  "name": "SaveGPT",
  "version": "0.1.0",
  "permissions": ["activeTab", "downloads", "storage", "scripting"],
  "host_permissions": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      "js": ["content/content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup/popup.html" },
  "options_page": "options/options.html"
}
```

`chat.openai.com` is kept because it still redirects and some users have it bookmarked.

### 6.2 Where the download happens - an MV3 pitfall

`URL.createObjectURL` does not exist in an MV3 service worker, so the common
"build a Blob in the worker and hand it to `chrome.downloads`" recipe fails.

Options, in order of preference:

1. **Do the download in the popup.** The popup is a real document: it can build the Blob,
   call `URL.createObjectURL`, call `chrome.downloads.download({url, filename,
   saveAs})`, and revoke the URL on the `downloads.onChanged` "complete" event. Simplest,
   and the popup is already the trigger. Caveat: the popup closes on focus loss, which
   would revoke the URL early - so revoke from the service worker instead, or keep the
   blob URL alive by having the *content script* create it.
2. `chrome.offscreen` document - the sanctioned workaround, needed anyway if a
   context-menu or keyboard-shortcut trigger is added later (no popup in those flows).
3. A `data:text/markdown;base64,...` URL from the worker - no Blob needed, but Chrome caps
   `data:` URL length and long conversations will exceed it. Rejected.

Plan: **(1), settled.** With bulk export ruled out (Q5), nothing in this project's scope
outlives a popup, so the offscreen document buys nothing and is not planned.

Still isolated behind a single `src/download.js` module exposing
`saveMarkdown(filename, text, {saveAs})` - not as a hedge, but because the popup should
not be in the business of blob URLs and revocation timing. One caveat to handle there: the
popup closing revokes nothing on its own, so revocation happens in the service worker on
the `downloads.onChanged` "complete" event, not in the popup.

### 6.3 Message flow

```
popup "Save"
  -> chrome.tabs.sendMessage(tabId, {type: "EXTRACT"})
  -> content.js: extract() -> Conversation
  -> popup: renderMarkdown(conversation, settings)
  -> popup: blob -> objectURL -> chrome.downloads.download(...)
  -> service worker: downloads.onChanged complete -> revokeObjectURL
```

Rendering runs in the popup, not the content script, so no page-injected code touches
user settings and the pure renderer stays out of the hostile page context.

Failure paths surfaced in the popup, each with a distinct message: not a ChatGPT tab /
conversation not saved yet (no id) / not signed in / endpoint changed (schema mismatch) /
download blocked.

---

## 7. Settings

Stored in `chrome.storage.sync`, one flat object, versioned with a `schemaVersion` so
future migrations are possible.

| Key                  | Default        | Effect                                       |
| -------------------- | -------------- | -------------------------------------------- |
| `frontmatter`        | `true`         | emit the descriptive front matter keys       |
| `labelUser`          | `"User"`       | participant label in the human heading       |
| `labelAssistant`     | `"ChatGPT"`    | participant label in the human heading       |
| `timestamps`         | `true`         | show the timestamp in the human heading      |
| `timestampFormat`    | `"datetime"`   | `iso` / `datetime` / `time` / `relative`     |
| `saveAs`             | `false`        | show the Save-As dialog instead of auto-save |
| `convertMath`        | `false`        | rewrite `\( \)` / `\[ \]` to `$` / `$$` (14) |

`includeTools` and `includeThoughts` are gone from v1 with the Q3 decision - those
messages are dropped unconditionally (4.1 step 7). A setting is only worth adding once
both branches are implemented.

Deliberately **not** settings: the message frames, `savegpt_format`, `savegpt_marker`, and
the frame's `time=` attribute. Anything an agent parser depends on must be present in
every file this extension produces, or the parser cannot depend on it. `timestamps: false`
therefore hides the timestamp from the human heading and leaves the machine attribute
intact - the two audiences are configured separately, and only one of them is
configurable at all.

`delimiterStyle`, `machineMarkers`, and `demoteHeadings` from the earlier draft are gone;
5.2 explains why.

The popup exposes all of them; there is no separate options page yet, because the list is
short enough to fit. Layout follows one rule: a control that qualifies another sits
indented under it and greys out when it is irrelevant - so `timestampFormat` lives beneath
the `timestamps` checkbox and is disabled when timestamps are off. Every control carries a
`title` hint explaining what it changes, and in the case of `convertMath`, why it is off
by default.

The raw-JSON debug link is not a setting. It renders only for an unpacked install, which
`chrome.management.getSelf()` reports without needing the `management` permission.

---

## 8. Testing

The extraction/rendering split is what makes this testable, so it is worth stating the
plan explicitly.

- **Pure unit tests (vitest, Node, no browser):** `render/*` and the mapping tree walk in
  `extract/api.js` fed by `test/fixtures/*.json`. Fixtures are real payloads captured from
  DevTools and scrubbed of tokens and personal text.
- Fixture set to cover: a plain Q&A; a conversation with an edited prompt (branch
  selection); one with a regenerated answer; code blocks including one containing triple
  backticks; a table; block and inline LaTeX; a code-interpreter call; an uploaded image;
  a message with `create_time: null`; a title full of filesystem-illegal characters.
- **Adversarial fixtures for the framing (5.2)** - the requirement that the output be
  agent-parseable is only real if it is tested against content designed to break it:
  - a message whose body contains `<!-- savegpt:` with a *different* nonce;
  - a message quoting a complete prior SaveGPT export, front matter and frames included;
  - a message that is itself a Markdown tutorial: `##` headings, `---` rules, YAML block;
  - a message ending in an unclosed code fence;
  - a message mixing prose, nested lists, a table, and two fenced blocks;
  - a body that forces the nonce-collision retry path, by pinning the RNG so the first
    generated nonce is one the body contains. This is the one test that proves the
    "impossible in the emitted file" claim rather than assuming it.
- **Round-trip test:** render -> parse with the ten-line reference parser from the README
  -> assert the recovered bodies are byte-identical to the inputs and the roles, indices,
  and timestamps match. Run over every fixture, adversarial ones included. This is the
  test that actually encodes the agent-parseability requirement; the golden files only
  catch formatting drift.
- **Golden-file tests:** each fixture renders to a checked-in `.md`. A rendering change
  shows up as a readable diff in review. Nonce generation is injected so golden output is
  deterministic.
- **Manual smoke checklist** (no automated browser tests in v1): fresh install, export a
  short chat, export a 200-message chat, export while signed out, export on a non-ChatGPT
  tab, export a brand-new unsaved chat.

---

## 9. Build and tooling

- **esbuild** for bundling (Turndown and the GFM plugin need it; everything else is plain
  ESM). No framework - the popup and options pages are hand-written HTML plus a small
  script. A framework would outweigh the UI.
- `npm run build` -> `dist/`, loadable via `chrome://extensions` -> Load unpacked.
- `npm run watch`, `npm test`, `npm run lint` (eslint + prettier).
- No telemetry, no network calls other than to `chatgpt.com`. Worth stating in the README
  and the store listing, since the extension necessarily reads conversation content.

---

## 10. Risks

| Risk                                              | Mitigation                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `backend-api` changes shape or adds bot protection | Schema-tolerant parsing, unknown content types preserved rather than dropped, DOM fallback exists  |
| DOM selectors change                               | All selectors in one file; fallback path only, so a break is not fatal                             |
| Access token handling                              | Kept in memory only, never written to storage, never logged, never sent anywhere                   |
| Very long conversations                            | Rendering is string concatenation over an already-in-memory JSON payload; fine into the thousands of messages. Blob download avoids the `data:` URL size cap |
| Chrome Web Store review                            | Narrow host permissions, no remote code, no analytics; a clear privacy statement in the listing    |
| Terms of service                                   | The extension reads the user's own conversations, in their own session, at their explicit request - the same data the official "Export data" feature returns. Worth a line in the README nonetheless |

---

## 11. Milestones

1. **M1 - skeleton.** Manifest, popup with one button, content script, message plumbing,
   download of a hardcoded string. Proves the MV3 download path end to end (6.2).
2. **M2 - API extractor.** Session token, conversation fetch, tree walk, `Conversation`
   model. Capture the test fixtures here.
3. **M3 - renderer.** Front matter, nonce framing, participant labels, parts, filename.
   Reference parser + round-trip and adversarial tests, then golden files. This is the
   milestone where requirements 3 and 4 are proven; the round-trip test is its exit
   criterion, not the golden files.
4. **M4 - timestamps.** Formats, the null-timestamp path, the `timestamps: partial` note.
5. **M5 - settings.** Storage, defaults, options page, popup quick toggles.
6. **M6 - DOM fallback.** Opens with the 4.3 timestamp investigation and records its
   answer in this plan before any code - the outcome may pull a `MAIN`-world script into
   scope, which is a manifest and security change worth knowing about before the Turndown
   work rather than after. Then Turndown rules, virtualization handling, degraded-mode
   notice.
7. **M7 - polish.** Error messages, icons, README, store listing copy.

M1-M4 are the minimum useful product; M5-M7 make it shippable.

### Status

**M1-M4 are implemented and merged into v0.1**, plus the popup half of M5 (settings
persist, no separate options page yet). The API path, renderer, framing, timestamps, and
download all work end to end; `npm run smoke` round-trips the output through the README's
reference parser, including adversarial bodies.

Deliberately deferred to the loop with real data: no build step, no bundler, no dependency
on esbuild yet (section 9 describes the state after M6, when Turndown arrives). v0.1 is
plain ES modules, loadable unpacked as-is.

Next: user acceptance testing against a real conversation, then M6 - starting with the 4.3
timestamp investigation.

---

## 12. Review decisions

Recorded from review. **All review questions are closed** - the plan has no open design
decisions left. Settled items are kept here rather than deleted so the reasoning is not
lost when someone later asks "why isn't there an option for X".

One implementation-time unknown remains, tracked separately as 4.3: how the current UI
carries per-message timestamps in the DOM. It affects only the fallback path and is
answered by looking, not by deciding.

| # | Question | Decision |
| - | -------- | -------- |
| 1 | Delimiter style | **Nonce-framed blocks, non-optional** (5.2). One file that is both cleanly renderable for humans and unambiguous for agents |
| 1a | Extra frame attributes | **No.** Minimal set only: `index`, `role`, `time`, `model` |
| 1b | Sidecar `.json` | **No.** Single Markdown artifact |
| 2 | Front matter default | **On** (see below) |
| 3 | Tool / reasoning messages | **Out of v1.** Dropped, declared via `omitted:` in the front matter |
| 4 | Images | **Deferred.** Generic placeholder, alt text when available (5.5) |
| 5 | Bulk export | **No.** Not just deferred - out of the project's purpose. OpenAI's "Export data" already covers archival; this tool exists to make *one* conversation readable |
| 6 | Firefox | **No.** Chrome/Chromium only. No compatibility shim |

### 1a - frame attributes: the minimal set is final

The frame carries `index`, `role`, `time`, and `model`. Nothing else. Candidates
considered and rejected: `id` (upstream message UUID), `bytes` (body length), `parts`,
`has_code`.

`index` is the renderer's own 1..N sequence over the exported branch - it pairs `begin`
with `end`, orders messages, and reveals truncation. It is *not* stable across exports: if
the user edits or regenerates a message and exports again, `index=4` may denote different
content. Stability across exports is what an upstream `id` would have bought.

That was rejected on purpose: **re-exporting and reconciling the same conversation is not
a workflow this tool supports.** If an export is stale, download it again. Once
synchronization is off the table, the id has no consumer, and it would have cost ~40
opaque characters on every frame line - invisible when rendered, but ugly in a plain
editor, which is half the audience.

`bytes` fell to the same test: it only pays off if files are expected to be truncated in
transit, which is not a scenario here. `parts` and `has_code` were rejected earlier for a
different reason - both are derivable by reading the body, so they add nothing and can
drift out of sync with it.

Attributes can be added later without breaking consumers, since parsers must ignore
unknown keys. Nothing here is a one-way door; there is simply no reason to open it yet.

### 5 - why bulk export is out, not deferred

The scenarios that would motivate it are archival ones: emptying an account before
cancelling, or bulk-loading years of history into a knowledge base. Archival is what
OpenAI's "Export data" is for, and it already works. Its problem is that the output is
hard to read and awkward to consume - a format problem, not a coverage problem.

So this project competes on format, for the conversation the user is looking at right now.
Bulk would mean rebuilding coverage that already exists, and it drags in machinery the
single-conversation case never needs: rate limiting across hundreds of fetches, partial
failure and resume, progress UI, a long-running context (the popup's JS is killed the
moment it loses focus), and filename collision handling across a whole account.

Consequences of settling this as a No rather than a Maybe:

- **6.2 is closed.** The popup download path is the final answer, not a placeholder. The
  offscreen document is not needed. It stays behind `src/download.js` anyway - that costs
  nothing and keeps the popup free of download mechanics - but no offscreen work is
  planned or held in reserve.
- No progress UI, no job queue, no persisted export state anywhere in the design.
- If someone genuinely needs archival, the honest answer is to point them at "Export data"
  rather than to grow this extension into a worse version of it.

### 2 - what the front matter question actually was

Front matter is the YAML block at the very top of the file, between `---` lines. Editors
that understand it (Obsidian, Jekyll/Hugo, many note tools) parse it into document
metadata and hide it from the rendered view; editors that do not show it as literal text
at the top of the document.

The question was whether to emit the descriptive keys (title, source URL, model, created /
updated / exported times) by default, since to a plain-text reader they are noise before
the conversation starts.

It is largely answered by the framing decision: `savegpt_format` and `savegpt_marker` must
be present in every file for the export to be parseable, so a YAML block exists either
way. Given the block is already there, omitting the descriptive keys saves six lines and
loses the answer to "where did this file come from, and when". **Default on.** The setting
survives for anyone who wants the two-key minimum.

---

## 13. UAT round 1

Subject: a real 32-turn conversation ("Strace script creation", 41 mapping nodes, 73 KB of
Markdown), exported by v0.1 and checked against the raw backend payload saved alongside it.

### Verified correct

- **32 of 32 messages exported**, 16 user and 16 assistant. Every body **byte-identical**
  to the corresponding raw payload text, compared character by character - no escaping,
  re-wrapping, or drift. 10 CR characters present in the source survived verbatim.
- All 32 timestamps present, in both the machine attribute and the human label.
- `omitted: thoughts` correctly declared for the 8 dropped reasoning nodes (4 `thoughts`,
  4 `reasoning_recap`).
- The reference parser recovered all 32 frames with sequential, matching begin/end indices.
- File hygiene: single trailing newline, no runaway blank lines, 166 hard-break trailing
  spaces preserved.

### The framing decision, validated empirically

The bodies of this one ordinary conversation contained **75 `---` horizontal rules** and
**60 `#` h1 headings**, plus nested code fences. Rule-delimited messages - option (b) in
5.2, which was a serious candidate at review time - would have split this file into
roughly 75 phantom messages. The question is now settled by data rather than by argument.

### Defects found, and fixed

A readability review of the output found three problems, all of them consequences of
verbatim bodies colliding with the exporter's own structure. All three are fixed in the
renderer; see 5.1 and 5.3 for the reasoning and the resulting format.

1. Speaker labels at h2 nested under body h1 headings in editor outlines - 125 outline
   entries for 32 messages, only 26% of them speaker turns, and one body h2 (`## Why this
   version works`) indistinguishable from a real turn. Labels are now h1.
2. No visible turn boundary when rendered, while 75 intra-message rules shouted. A `---`
   now separates turns, outside the frames.
3. `<sub>` timestamps rendered as a baseline glitch and duplicated the ISO time one line
   above in raw view. Folded into the label instead, with the turn number added.

Front matter key order was also reversed to put reader-facing keys first.

Regenerated from the same payload, the corrected output keeps all 32 bodies
byte-identical, puts all 32 turns at the outline's top level, and adds 31 boundary rules.

### Not exercised by this round

- **The branch walk.** This conversation had 41 nodes and a 41-node current branch - no
  edits, no regenerations, so no sibling branches existed. The tree-walking logic in 4.1
  step 4 remains unverified against real data, and it is the highest-risk untested path.
- Images, tool messages, multipart messages: zero occurrences.
- Filename sanitizing: the title was plain, so no illegal characters were exercised.

Round 2 should use a conversation with an edited or regenerated message and an image.

---

## 14. UAT round 2

Subject: a 68-turn conversation ("Shadow Maps in CG.", 73 mapping nodes, 60 KB), started
in February 2023 on `text-davinci-002-render-sha` and resumed once in August 2026 on
`gpt-5-6-mini`. Chosen because it exercises what round 1 could not.

### The branch walk is now verified

This conversation contains **2 branch points and 3 off-branch nodes**: one regenerated
assistant answer, and one edited user message together with the reply that edit orphaned.
The export contains the current branch only, with the discarded siblings correctly absent.
The highest-risk untested path from round 1 (4.1 step 4) is closed.

Fidelity held: 68 frames, all bodies byte-identical to the payload. Three messages end
mid-sentence; `finish_details` confirms 1 `max_tokens` and 2 `interrupted`, so the
truncation is the source's and was reproduced faithfully.

### Defect: an unterminated code fence breaks containment

The worst finding of either round, and one that attacks the format's central property.

Turn 38 was truncated by the model *inside* a code fence, so its body ends with an opening
fence and no closing one. In a rendered view that fence does not stay inside the message:
it swallowed the `end` comment, the separator rule, the whole of turn 39, and part of turn
40 into a single code block - roughly 27 lines. Turn 39 vanished as a turn, and the
`<!-- savegpt:... -->` comments became **visible literal text**, which is precisely what
choosing HTML comments was supposed to prevent.

The fix is in the renderer: count fence state per body and, when a fence is left open,
append one closing fence line before the `end` comment. The frame then carries
`fence_repaired=1` and the front matter counts the repairs.

This is the first thing the exporter adds to a body, so it is worth being explicit about
why it does not break the verbatim guarantee:

- it **appends**; no existing character is altered, reordered, or escaped;
- it is **declared** on the frame, not silent;
- it is **exactly reversible** - drop the body's last line and the original bytes are back,
  which the test suite asserts;
- the alternative is worse than an edit: leaving it alone corrupts neighbouring messages,
  so "change nothing" does not actually preserve the neighbouring content.

### Defect: `model:` reported the last model, not the conversation's

Front matter said `model: gpt-5-6-mini` while 33 of 34 assistant turns were
`text-davinci-002-render-sha`. The single most substantively wrong line in the file: it
attributed three years of one model's output to another. A long thread resumed later
switches models by definition, so the single-value field was structurally wrong, not
unlucky. Now `model: x` when there is one, `models: [a, b]` when there are several.

### TeX-style math delimiters: opt-in conversion

The final turn writes math as `\( ... \)` and `\[ ... \]` (7 inline, 5 display). ChatGPT's
own viewer renders those; GitHub, Obsidian and VS Code all expect `$` / `$$` and render
stray backslashes instead.

Unlike the fence repair, rewriting delimiters **substitutes** characters inside a body
rather than appending to it, so it cannot be justified the same way. Review decision: make
it a setting, **default off**.

- Off (default): the body is untouched and the front matter says `math: latex-parens`.
- On: prose delimiters are rewritten, the front matter says
  `math: dollar (converted from latex-parens)`, and each affected frame carries
  `math_converted=1`.

The rewrite is applied to prose only - never inside a fenced block, never inside an inline
code span - because those are exactly the places where `\(` and `\[` mean something other
than math. A body that *discusses* the delimiters, or that contains shell or regex using
them, comes through unchanged. Both paths are tested, including a fixture that mixes real
math, a code span naming the token, and a fenced block containing it.

### Readability verdict

Rendered 7/10, raw 8/10, up from 5/10 and 6.5/10 in round 1. All three round-1 changes
were reviewed against this very different file (prose-heavy, few body headings) and all
three were kept:

- **h1 speaker labels**: stronger here than in round 1. With only 2 body headings in 1128
  lines the outline is a clean 68-entry turn index.
- **Turn numbers**: the only stable navigation handle across 68 near-identical headings,
  and they mirror `index=` for anyone moving between the raw and parsed views.
- **`---` between turns**: load-bearing in raw view and in Obsidian. Mildly redundant on
  GitHub, which already draws a rule under an h1.

Remaining readability notes, all traced to source content rather than the exporter: prose
lines up to 583 characters unwrapped, and an outline whose entries carry turn numbers but
no topic.

---

## 15. UAT round 3

Subject: "Lego Babylon-5 Model" - a short image-generation conversation, 11 mapping nodes,
no branches. Small, and it broke the exporter worse than either large file did.

### Defect: generated images were dropped, and with them half the conversation

The export contained 4 turns: **user, user, assistant, user**. Two user messages in a row
with nothing between them, and a file ending on an unanswered prompt. The conversation as
recorded made no sense - turn 2 says "this is total crap, all models are wrong" about an
image that was not in the file.

Cause: a generated image arrives as a `tool` message whose content is `multimodal_text`
holding an `image_asset_pointer`. The role filter dropped it before the image handling in
4.1 step 6 could ever run. Two images, both the actual answers to the user's prompts, were
discarded and summarised as `omitted: tools`.

This was a bug, not the Q3 scope decision doing its job. Q3 put *tool plumbing* out of
scope - the `{"skipped_mainline":true}` call nodes, which are still dropped. An image the
assistant produced and the user reacted to is conversation content, and Q4 already decided
how to render it. The role check simply ran first.

Fix: a `tool` message carrying image pointers is attributed to the assistant and rendered
through the existing image placeholder. Alt text comes from the message's
`image_gen_title` when the pointer has none, which is how the placeholders read
`> [image: LEGO Babylon 5 space station display]`. The export is now 6 turns and
alternates properly.

### Consequence: a structural invariant worth testing

Two consecutive user turns is the visible signature of a dropped reply. It is cheap to
assert and it would have caught this defect without anyone reading the file, so it is now
part of the payload test suite.

### Consequence: extraction became testable

This is the third round in which verification meant re-implementing the mapping walk in a
throwaway script - which means the thing being verified was a copy, not the shipped code.
The pure part of extraction now lives in `src/extract/mapping.js`, and the content script
loads it with a dynamic import of an extension URL (declared in `web_accessible_resources`),
since a declared content script cannot use a static `import`. Production and the tests now
run the same function.

`npm run payloads` points at a directory of saved `*.raw.json` files and asserts, per
conversation: one frame per message, sequential begin/end indices, verbatim bodies modulo
declared fence repairs, no undeclared drops, and no consecutive user turns. Payloads stay
out of the repository - they are personal conversations - so the suite skips when the
directory is absent.

### Verified across all three UAT payloads

| conversation | turns | images | omitted |
| ------------ | ----- | ------ | ------- |
| Lego Babylon-5 | 6 | 2 | tools |
| Shadow Maps in CG | 68 | 0 | thoughts |
| Strace script creation | 32 | 0 | thoughts |

### Still not exercised

User-uploaded images and file attachments (all images here were assistant-generated),
code-interpreter output, and web-search citations.

---

## 16. UAT round 4

Subject: a Russian-language game-design conversation, 13 nodes, 8 exported turns, one
web-search turn. Two new shapes at once: non-ASCII throughout, and citations.

### Verified without changes

- **Non-ASCII content and title.** Cyrillic body text, emoji, and box-drawing diagrams
  inside fenced blocks all survive verbatim. The filename sanitizer keeps Cyrillic
  (`Идея-инди-игры-2026-08-10.md`) - it strips only filesystem-illegal characters, not
  non-Latin ones, which is the right behaviour.
- **Mid-conversation model switch**, correctly reported as
  `models: [gpt-5-6, gpt-5-6-mini]` thanks to the round-2 fix. This is the second payload
  to exercise it.

### Defect: web-search citations were emitted as garbage, and their URLs lost

ChatGPT marks citations and entity chips inline with private-use codepoints
(U+E200..U+E2FF) wrapping text its own client resolves. Exported raw, they read:

```
в entity["video_game","The Lost Vikings","1993 puzzle platformer"] щит ...
... взбираться на щит Olaf. citeturn0search7turn0search19
```

Ten invisible codepoints, two unreadable pseudo-tokens, and - worse - the actual source
URLs, which live in `metadata.content_references`, were dropped entirely. An export that
silently discards the sources behind a claim is a bad archive.

Fix: each reference carries `matched_text` (the exact span, offsets included) and an `alt`
that is *already* the Markdown to substitute. So this is not a rewrite the exporter has to
invent - the payload delimits the span and supplies the replacement:

```
... взбираться на щит Olaf. ([Blizzard News](https://news.blizzard.com/en-gb/article/...))
```

Entities become their display name (`The Lost Vikings`), citations become links, and any
marker codepoint left unaccounted for is stripped rather than shipped. Counts appear as
`citations: N resolved` in the front matter and `citations=N` on the frame.

One trap found while implementing: the `sources_footnote` reference matches a **bare
space** and replaces it with nothing. Applying it deletes a real word separator - the
first attempt produced `Да,ты правильно`. References that would consume plain whitespace
are now skipped.

### Invariant added

No private-use codepoint may appear in an exported file, and no `citeturn` or
`entity["` text may survive. Both are asserted per payload.

### Verified across all four UAT payloads

| conversation | turns | notes |
| ------------ | ----- | ----- |
| Lego Babylon-5 | 6 | 2 generated images |
| Shadow Maps in CG | 68 | branches, math, truncated fence |
| Strace script creation | 32 | code-heavy |
| Идея инди-игры | 8 | non-ASCII, 3 citations resolved |

### Still not exercised

User-uploaded images and file attachments, and code-interpreter output.
