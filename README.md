# Pipnote - Local-First AI Knowledge Base

Pipnote is a local-first desktop notes app for people who want their own private knowledge base on their own machine.

Built with React + TypeScript + Vite + Tauri + Rust.

## Why This Exists

I wanted something that felt like:
- Obsidian for local ownership
- VS Code for folder-first workflow and tabs
- an AI assistant that actually understands your vault

A lot of note tools are great at writing, but weak at cleaning up messy notes, connecting related ideas, or answering from your own files without sending data away.

Pipnote is trying to solve that in a practical way.

## What Makes Pipnote Different

The main value is not just “AI in notes”.
It is more about:
- local-first AI workflows
- folder-first note organization
- Q&A over your own vault
- AI-assisted reorganization with review/approval
- related-note discovery and link suggestions without relying on manual tagging

The goal is to help turn messy personal notes into a usable knowledge base.

## What Is Implemented Right Now

### Core App UX
- local vault open/select flow
- first-run onboarding
- file/folder tree with remembered expand/collapse state
- hide/show sidebar and top bar
- multi-tab editing workflow
- back/forward navigation between opened notes
- favorites and recent notes sections
- inline file/folder rename
- create new file/folder from context menu
- autosave while typing

### Editor UX
- markdown edit / preview / split modes
- live markdown preview
- formatting toolbar (`B`, `I`, `H1`, `Todo`, `Code`, `Quote`)
- in-file search
- vault-wide search
- outline panel from headings
- backlinks panel
- related notes panel
- focus mode and presentation mode
- status bar with line/char/selection info

### File Support
- markdown and text-like notes are editable
- images are previewable
- PDF preview is supported
- DOCX preview is supported as extracted readable text
- PDFs and DOCX are AI-readable for search/Q&A when extraction works
- images are preview-only for now and are not AI-indexed

### AI Features (via Local AI Provider)
- smart note classification on first save
- local embeddings generation and regeneration
- Q&A over your own notes using retrieval
- grounded answer/source display in the Q&A panel
- source snippet jump/open from Q&A results
- link suggestions between related notes
- related notes discovery
- fact extraction for simple direct questions
- AI vault reorganization with approval flow
  - move suggestions
  - delete suggestions
  - merge suggestions
  - structural cleanup suggestions
- suggestion levels:
  - strong
  - recommended
  - optional

### Reorganization UX
- per-item approve/deny
- approve all / deny all
- empty folders can now be suggested as delete actions
- mentioned file preview in reorganize review
- soft delete behavior for destructive actions
- undo log written to `.vn-system/reorg-undo`

### Reliability / Performance Work
- Rust-side semantic search
- semantic cache stats and live diagnostics
- worker-based ranking for semantic operations
- background post-processing queue
- adaptive embedding queue
- large-vault performance scan in settings
- cached keyword search / file content / AI-readable content paths
- safer handling for moved/renamed/deleted files
- vault consistency repair tools

### Theme / Layout Work
- multiple theme families including current app theme, Obsidian-style, and Codex-style direction
- light and dark support
- layout controls for sidebar, top bar, and assistant panel
- assistant edge toggle instead of a floating button

## Tech Stack

- Frontend: React 19, TypeScript, Tailwind CSS
- Desktop shell/backend: Tauri v2 + Rust
- AI runtime: local AI via Ollama or LM Studio
- Tests: Node test runner + Playwright

## Prerequisites

Install these first:

1. Node.js 20+
2. `pnpm` 9+
3. Rust toolchain (stable)
4. Tauri system dependencies for your OS
5. One local AI runtime:
   - Ollama
   - or LM Studio with local server enabled

## Quick Setup

Install dependencies:

```bash
pnpm install
```

### Option A: Ollama

```bash
ollama serve
```

Pull at least:
- one text model for answering/classification
- one embedding model for retrieval

Example:

```bash
ollama pull gpt-oss:120b-cloud
ollama pull nomic-embed-text
```

### Option B: LM Studio

1. Open LM Studio
2. Load a chat/completions-capable model
3. Load an embedding-capable model if you want semantic search and Q&A indexing
4. Start the local server
5. Keep the OpenAI-compatible local endpoint enabled, usually at `http://localhost:1234`

Run the desktop app in dev mode:

```bash
pnpm tauri:dev
```

If you only want the web UI during development:

```bash
pnpm dev
```

## Recommended First Run

1. Launch the app
2. Choose your vault folder
3. Finish onboarding
4. Open `Settings`
5. Choose your local AI provider and check the selected models
6. Generate or repair embeddings
7. Ask a few questions in the Q&A panel
8. Run `Reorganize Vault` and approve only the suggestions you trust first

## Local AI Provider Notes

Pipnote blocks AI actions if the selected local AI provider is unavailable.

That means these actions should not run if your provider is down or the selected models are invalid:
- Reorganize Vault
- Regenerate embeddings
- Retry failed embeddings
- Repair stale/missing embeddings
- normal Q&A over your vault

The app should show one clear error instead of spamming many errors.

### Provider-specific notes

- Ollama:
  - default base URL: `http://localhost:11434`
  - good default when you want a simple local model workflow
- LM Studio:
  - default base URL: `http://localhost:1234`
  - uses the OpenAI-compatible local server APIs
  - embeddings work only if the loaded LM Studio setup exposes an embeddings-capable model

## Search and Q&A Notes

Pipnote currently uses a local retrieval flow roughly like this:
- generate/query embeddings locally
- do semantic retrieval over your vault
- combine with keyword search when needed
- build grounded context from the best matching notes/documents
- ask the local text model to answer from that context

It also has fallback behavior:
- if no relevant note context is found, it can return a more general model answer
- that answer should be labeled more clearly as general, not strongly grounded

## Build Commands

```bash
pnpm build
pnpm tauri:build
```

Platform-specific:

```bash
pnpm tauri:build:mac
pnpm tauri:build:win
```

Note for macOS:
- `pnpm tauri:build` now produces a `.app` bundle and a shareable `.dmg`
- the DMG includes an `Applications` shortcut and an install readme
- users should drag `Pipnote.app` into `Applications` instead of running it from the mounted disk image

## Scripts

- `pnpm dev` - run Vite dev server
- `pnpm tauri:dev` - run full desktop app in dev
- `pnpm build` - build frontend
- `pnpm tauri:build` - build desktop app
- `pnpm lint` - run ESLint
- `pnpm test:editor` - run core editor/logic tests
- `pnpm test:e2e` - run Playwright tests
- `pnpm test:e2e:headed` - run Playwright with headed browser
- `pnpm test:e2e:ui` - run Playwright UI mode

## Current Limitations

This project has improved a lot, but it is still an MVP and there are real limitations.

### AI / Retrieval
- answer quality still depends on embedding quality, extraction quality, and local model quality
- some PDFs or DOCX files may still fail if text extraction is poor or the document is messy
- very weak retrieval can still produce answers that need more ranking tuning

### File Support
- images are preview-only right now
- image OCR is not implemented yet
- PDF/DOCX support depends on extracted text, not perfect native document understanding

### Reorganization
- reorganization suggestions are much better than before, but still not perfect
- some edge-case suggestions can still be too aggressive or too cautious
- destructive changes are reviewed and logged, but users should still confirm carefully

### UX / Testing
- some advanced block-level editing ideas are still partial
- full end-to-end regression coverage is not complete yet
- bundle size is still a bit heavier than ideal and could use more code splitting

## Project Structure

- `src/` - React app
- `src/components/` - UI components
- `src/contexts/` - app/editor/theme/settings contexts
- `src/services/` - vault, search, local AI, reorganize, related notes, facts, performance
- `src/services/providers/` - provider-specific adapters for Ollama and LM Studio
- `src/utils/` - helpers, ranking, formatting, chunking, performance utilities
- `src-tauri/` - Rust backend commands and filesystem bridge
- `tests/` - editor and utility tests

## Product Direction

The bigger direction for Pipnote is:
- local-first AI knowledge base
- smarter automatic linking between related notes
- better cleanup of messy vaults
- stronger grounded Q&A from your own files
- a note app that feels practical, private, and fast enough to use every day

## Final Note

This project has been built through a lot of iteration, feedback, bug fixing, redesigns, and honest trial-and-error.

It is not pretending to be perfect.
It is trying to be genuinely useful.

If you try it and find rough edges, that feedback is extremely valuable.
