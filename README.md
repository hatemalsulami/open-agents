# ◆ OpenAgent — open-source AI browser agents for Chrome

AI agents that live in your Chrome side panel and **do things in your browser**: read pages, click, type, fill forms, take screenshots, work across tabs, and report back — like Claude in Chrome, but **open source, bring-your-own-model, and multi-agent**.

**No API key required.** It can run a model entirely on your own machine — or use any cloud provider you already pay for.

| Where the model runs | Options |
|---|---|
| **On your device — no key, works offline** | **Chrome built-in AI (Gemini Nano)** · **WebLLM on WebGPU** (Qwen, Llama, Phi, Gemma) |
| **Cloud API — needs a key** | Anthropic (Claude Sonnet 5 / Opus 5 / Haiku 4.5) · Google (Gemini) · OpenAI (GPT-4o / 4.1) · any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, LM Studio, vLLM) |

No build step, no server, no telemetry. Keys stay in `chrome.storage.local` and requests go **directly** from your browser to the provider you chose — or never leave your machine at all.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select the repo folder.
4. Press `Cmd/Ctrl+Shift+Space` (or click the icon) to open the side panel.
5. Hit **⚙** in the panel, pick a provider, paste your key, press **⟳** to load the live model list, then **Test connection** → **Save**. You never need to leave the panel.

## Running with no API key at all

Pick either on-device provider in setup. Both need **one initial download**, then work with no network and no account.

### Chrome built-in AI (Gemini Nano) — nothing to install
Chrome ships a small model. Choose *"Chrome built-in AI"* and press **Test connection**; Chrome downloads the weights once (~2 GB) and manages them. Needs Chrome 138+ on desktop, roughly 22 GB free disk and 4 GB+ VRAM. If your build hides it, enable `chrome://flags/#prompt-api-for-gemini-nano`. The setup panel tells you exactly which of these is missing.

### WebLLM — genuinely open-source models on your GPU
Runs Qwen 3, Llama 3.2, Phi 3.5, or Gemma 2 locally via WebGPU. Chrome extensions may not load remote scripts, so fetch the runtime once:

```bash
./scripts/fetch-vendor.sh
```

Then reload the extension and pick *"Local open-source model (WebLLM + WebGPU)"*. The model weights (1.5–6 GB depending on choice) download on first use and are cached by the browser; after that it is fully offline.

**Be realistic about small models.** A 1.7B model on your laptop is not Claude. It handles short, concrete tasks ("read this page and summarize it", "find the price on this page") but drifts on long multi-step browsing. To compensate, on-device models get a **reduced 7-tool set** and a **strict JSON protocol** instead of native tool calling, which is far more reliable for them. Bigger local models do better if your GPU can hold them. Neither on-device engine can see screenshots, so the agent relies on page text.

## What it does

### Arabic and English, fully RTL
Press **🌐** in the panel (or pick a language in Settings) to switch. Arabic is a real translation, not a transliteration: the whole interface flips to RTL, dates and numbers use Arabic locale formatting, and URLs, model ids and element refs stay left-to-right so they remain readable inside Arabic text. The agent is also told to reply in your language.

### Mention tabs with @ — and scope the agent to them
Type **@** in the composer to pick from your open tabs. Mentioned tabs become the agent's **scope**: it starts there instead of opening a blank tab, and `list_tabs` shows it nothing else. Click the **🔓** chip to turn it into **🔒** and the agent is *hard-locked* to those sites — navigation anywhere else is refused by the tool layer, not merely discouraged by the prompt.

### Plan mode — for long tasks and small models
The agent writes a short numbered plan, then executes **one step at a time with a fresh context per step**, carrying forward only a one-line finding from each. This is what makes on-device models usable: context stops growing with the task. On by default for on-device models (`auto`), and switchable to always/never in Settings.

### You can see it working
The tab being driven shows a live overlay: a scanning sweep while the agent reads, a pulse around whatever it clicks or types into, and a badge naming the current action. It lives in a closed shadow root with `pointer-events: none`, so it cannot affect the page or intercept your clicks, and it clears itself if a run ends unexpectedly.

### Streaming answers
Replies appear word by word as the model writes them, with a live caret, instead of arriving in one silent block after twenty seconds. When the turn completes the live text is replaced in place by properly rendered markdown — no duplicate bubbles. Streaming changes nothing about what you are charged; turn it off in Settings if you prefer whole answers. On-device models always arrive complete.

### Cost meter and spend cap
The status bar shows the **estimated money** spent, not just token counts — in USD or SAR. Set **"Stop an agent after spending"** in Settings and an agent halts the moment its estimated spend reaches your limit and tells you why, rather than quietly burning credit. Costs also appear on every board card and in history. Estimates use public list prices and are marked with ≈; on-device models are always free.

### The interface
A labelled tab bar (**Agents · Board · Routines · Knowledge**) with a hand-drawn SVG icon set — no emoji anywhere, so the UI renders identically on every OS and every icon inherits its button's color in light and dark themes. The header keeps the model badge, a voice toggle, a one-tap language switch, and buttons for provider setup and the **full dashboard** (the options page, also reachable from inside the setup card). The starting screen offers four example tasks you can click to load into the composer.

### Precise input mode — makes Google Sheets, Docs & Notion actually work
Apps like Google Docs/Sheets/Slides, Notion and Figma ignore ordinary automated clicks (they check `event.isTrusted`). Precise input mode sends **real hardware-level input** through the Chrome DevTools Protocol, so the agent can genuinely edit them — the capability that lets Claude in Chrome fill spreadsheets. It is **automatic**: on by default only for the specific apps that need it, off everywhere else, so most browsing never triggers it. On those sites Chrome shows a *"started debugging this browser"* banner while the agent works — that is expected and safe, and clicking **Cancel** on it stops the agent immediately. Every debugging session is dropped the moment work finishes. Switch it to always-on or fully off in Settings. Password fields stay blocked in this mode too.

### Task board — live mission control
The **📋** tab is a board of every agent: a card each showing its status (working / needs you / idle / error), **what it is doing right now** with the step count, and **the page it is on** — click the page to jump to that tab. Running agents update live. Below the live cards, **History** keeps the last 100 finished tasks (first task, final answer, tokens spent, when) and survives Chrome restarting the extension, since it is persisted rather than held in memory.

### Voice — have answers read to you
Press **🔈** in the panel to turn on automatic reading, or **🔊** under any single answer to replay just that one. It uses the voices already installed on your machine (`speechSynthesis`) — no API, no network, nothing leaves the device — and picks an Arabic voice when the UI is Arabic. Answers are rewritten for ears first: code blocks and raw URLs are dropped instead of being spelled out, and link text is read in place of the link. Voice and speed are configurable in Settings.

### Batching — the biggest cost saver
The `batch` tool runs up to 8 actions in a single model call (click → type → wait → find). Since every separate tool call is another round trip through the model, batching is where most of the token savings live. A batch **stops at the first failure** and reports which action failed and what was skipped, so a stale element ref costs one batch instead of a whole task.

### Multiple agents at once
Press **＋** to spawn another agent. Each one gets **its own Chrome tab group** (color-coded to its chip) and works in parallel — research a product in one, monitor a dashboard in another, fill a form in a third. Click a chip to switch; double-click to rename.

### Routines — agents on a schedule
The **🕒** tab lets you save a task and a schedule: every day at 08:00, weekdays, weekly, every N minutes, or once at a specific time. Optionally give it a starting URL. Chrome fires the routine via `chrome.alarms`, the agent runs in the background, and you get a desktop notification with the result.

### Export everything
The **⭳** button turns a session into a **self-contained HTML report** — full chat, every tool call with its arguments and output, and **every screenshot the agent took**, all embedded so a single file is shareable. **{ }** exports the raw JSON (conversation, context, usage) for pipelines.

### Custom agent instructions
In Settings, add persistent instructions applied to every agent — language, tone, preferred sites, output format, sites to avoid. Safety rules always take precedence over them.

### Token discipline
Agent runs cost real money, so the extension actively manages context: old screenshots are dropped from what the model sees (they're the single biggest cost) while staying in exports, older tool output is truncated, and live token usage is shown in the status bar. Tune both in Settings.

### Tools the model gets
**Targeted lookups (cheap, context-friendly):** `find` — locate elements by description, returns a handful of refs · `read_section` — read only the passages about a topic · `extract_links` — compact link list

**Whole-page reads (expensive):** `read_page` · `get_page_text` · `screenshot`

**Actions:** `navigate` · `click` · `type_text` · `select_option` · `scroll` · `press_key`

**Tabs:** `list_tabs` · `open_tab` · `switch_tab` · `close_tab` · `wait`

Page reads are capped to a character budget derived from the model's context window (1,500 for Gemini Nano, 16,000 for cloud models), and a result that still overruns is truncated with a pointer to `find`. On-device models get a reduced 8-tool set that leads with the targeted lookups, because a small model that reaches for `read_page` on YouTube exhausts its window in one call.

## Can I use my Claude Pro / Max subscription?

**No — and no extension can.** Anthropic subscriptions authenticate claude.ai and Claude Code only; third-party applications must use an **API key** from the [Anthropic Console](https://console.anthropic.com/settings/keys), which is billed separately from a Pro/Max plan. Any tool claiming to spend your subscription is reusing your browser session credentials, which risks your account. The same applies to ChatGPT Plus and Gemini Advanced.

If cost is the concern: **Gemini 2.5 Flash** has a free tier that comfortably runs this extension, and **Ollama is free forever** on your own machine.

## Safety model

- **Password fields are hard-blocked** in the content script — the model cannot override it.
- **Approval mode** — switch to *"Ask me before every action"* to approve or deny each tool call.
- **Prompt-injection defense** — the system prompt treats page content as data, never instructions, and tells the agent to report injection attempts. This is a mitigation, not a guarantee: **don't leave an agent unattended on sensitive logged-in sessions (banking, email).**
- **No middleman** — no backend exists; the only network calls are to your chosen provider.
- Chrome internal pages (`chrome://`) are inaccessible by design.

## Architecture

```
manifest.json      MV3, no build step — plain ES modules

background/
  service-worker.js  owns all sessions; port protocol; routine alarms
  agent.js           the loop: model → tools → results → model
  tools.js           tool schemas + tab/navigation/screenshot executors
  session.js         per-agent state, event log, context pruning
  routines.js        schedules ⇄ chrome.alarms

providers/
  index.js           registry, shared message format, config validation,
                     actionable API-error messages
  models.js          curated catalogs + live model listing
  anthropic.js · gemini.js · openai.js (also all compatible endpoints)
  local.js           on-device adapter (built-in AI + WebLLM)
  json-tools.js      tool calling for models with no native tool API

offscreen/           invisible page hosting on-device inference
                     (WebGPU is unavailable in service workers)
vendor/              WebLLM runtime — fetched, never committed

content/
  content-script.js  page reading (indexed outline) + DOM actions

sidepanel/           chat UI, session chips, routines view
  markdown.js        safe renderer (builds DOM, never innerHTML)
  export.js          HTML report + JSON export
ui/setup.js          provider setup form — shared by panel and options
ui/i18n.js           English + Arabic strings, RTL switching
background/scope.js  tab/origin boundary enforcement for @-mentions
options/             advanced settings
scripts/dev-harness.html   runs the setup form outside Chrome, with assertions
```

**One internal message format.** Everything is Anthropic-style content blocks (`text` / `image` / `tool_use` / `tool_result`); each adapter converts to its wire format. Adding a provider is one file implementing `chat()`.

**Typing that frameworks see.** `type_text` sets values through the native setter and fires `input`/`change`, so React/Vue forms register it.

**Model lists are fetched, not hardcoded.** Provider catalogs drift and vary by billing tier, so once a key is entered the extension loads the models that key can really call and silently switches away from one that has become unavailable. A model or quota error explains which setting to change rather than echoing the raw API text.

## Development

No toolchain required. To exercise the setup form without loading the extension:

```bash
python3 -m http.server 8899
```

then open `http://localhost:8899/scripts/dev-harness.html` — it runs the real component against a stubbed `chrome.storage` and prints assertions.

## Known limitations (roadmap)

- Responses are non-streaming (each step appears when it completes).
- Sessions live in the service worker; Chrome may discard them after long idle periods.
- No cross-origin iframe access (Chrome restriction; would need the `debugger` API).
- Routines only fire while Chrome is running.
- Scope locking covers extension-driven navigation; it is not a substitute for browser-level site blocking.

## Contributing

PRs welcome. Keep the no-build-step rule, keep files focused, and never weaken the safety model (password block, approval gating, injection defenses).

## License

[MIT](LICENSE)
