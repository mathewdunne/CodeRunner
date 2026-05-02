# 005 — Dark Modern syntax highlighting via TextMate

**Status:** Superseded by [009](./009-stock-monaco-vscode.md) (2026-05-02)
**Date:** 2026-05-01

## Superseded by 009

The hand-rolled TextMate adapter was the right call when M1 stood alone — pulling in `@codingame/monaco-vscode-api`'s ~30 transitive deps and migrating off `monaco-editor` to get Dark Modern was disproportionate to the value. M2 (decision 008) then needed that ecosystem anyway via `monaco-languageclient`, which dissolved the avoidance: keeping a parallel bespoke runtime for theme + grammar tokenization while the LSP path was already on `@codingame` added zero value and one extra place where a subtle bug could hide. Decision 009 drops this adapter, the vendored `java.tmLanguage.json`, and the three vendored Dark Modern theme JSONs in favour of `@codingame/monaco-vscode-java-default-extension` + `@codingame/monaco-vscode-theme-defaults-default-extension`, which ship VS Code's grammar and theme directly.

The historical implementation notes below remain accurate for the period 2026-05-01 → 2026-05-02 and are kept for posterity.

---

## Context

After Task 4 the editor was rendering `Robot.java` under Monaco's stock `vs-dark` theme. The user's complaint: most identifiers and types showed up plain white, so the editor looked visually flat compared to VS Code with the **Dark Modern** theme they use locally. The first instinct — "just port Dark Modern's color rules onto Monaco's built-in Java tokenizer" — does not work, because:

- Monaco ships a **Monarch**-based Java tokenizer (`monaco-editor/esm/vs/basic-languages/java/java.js`). Monarch emits a small set of coarse tokens: `keyword`, `identifier`, `type.identifier`, `string`, `number`, `comment`, `annotation`, a few delimiters.
- VS Code highlights Java with a **TextMate** grammar that emits very fine-grained scopes like `entity.name.type.class.java`, `variable.other.object.property.java`, `storage.modifier.java`.
- Dark Modern's color rules target the TextMate scopes. Without the TextMate runtime, ~80% of those rules do not match anything, and the result degrades to ~6 colors — barely better than vs-dark.

The right fix is to bring the TextMate runtime into the browser so Monaco can use the same grammar + theme combination VS Code does.

## Decisions

### TextMate runtime via `vscode-textmate` + `vscode-oniguruma`

Both packages are direct deps of the web shell (`vscode-textmate@^9.3.2`, `vscode-oniguruma@^2.0.1`). They are the same packages VS Code uses internally:

- `vscode-oniguruma` ships an Oniguruma WASM regex engine.
- `vscode-textmate` parses TextMate JSON grammars and tokenizes lines, producing either scope-string tokens (`tokenizeLine`) or compact bit-packed metadata (`tokenizeLine2`).

The thin `monaco-editor-textmate` wrapper was considered and skipped — it has lagged Monaco/vscode-textmate releases historically, and the glue we actually need is ~80 lines.

The WASM blob ships at `vscode-oniguruma/release/onig.wasm`. We import it via Vite's `?url` syntax so it gets fingerprinted and copied to `dist/` at build time and served from the dev server during development.

### Vendored grammar + theme files (as `?raw` imports)

Both the Java grammar and the Dark Modern theme files are vendored into the repo, not fetched at runtime:

- `apps/web/src/grammars/java.tmLanguage.json` — copied from `redhat-developer/vscode-java`'s `language-support/java/java.tmLanguage.json` (which itself mirrors `microsoft/vscode`'s `extensions/java/syntaxes/java.tmLanguage.json`).
- `apps/web/src/themes/dark-modern.json`, `dark-plus.json`, `dark-vs.json` — copied from `microsoft/vscode`'s `extensions/theme-defaults/themes/`.

Three theme files because Dark Modern extends Dark+ which extends Dark (Visual Studio) via an `include` field. The chain is resolved in `textmate-setup.ts` (`resolveTheme` walks the `include` graph and merges).

JSON files are imported as `?raw` strings rather than parsed JSON modules because the upstream theme files are **JSONC** (line/block comments + trailing commas). A small `parseJsonc` (~30 lines, no dep) strips both before `JSON.parse`.

### Lazy-built per-(foreground × fontStyle) Monaco rules from the colorMap

Monaco's tokenization API expects each token to carry a single `scopes: string` name that matches a rule registered via `defineTheme`. Our adapter:

1. Builds a `vscode-textmate` `Registry`, registers Dark Modern as the resolved theme (see "Synthetic default settings entry" below).
2. Calls `registry.getColorMap()` to get the palette of unique colors the theme uses (a `string[]` indexed by foreground id, with index 0 reserved as `_NOT_SET`).
3. Enumerates every `(fg, fs)` combo where `fg < colorMap.length` and `fs ∈ [0, 16)` (4 fontStyle bits: italic | bold | underline | strikethrough). Skips combos with neither a real color nor a fontStyle (Monaco interprets an empty `foreground` string as black). Defines one Monaco rule per surviving combo with `token: 'mtk{fg}_{fs}'`.
4. At tokenize time, the `setTokensProvider` adapter calls `grammar.tokenizeLine2(line, state)` and maps each `(startIndex, metadata)` pair to `{ startIndex, scopes: 'mtk{fg}_{fs}' }`. Bit math:
   - `fg = (metadata & 0xff8000) >>> 15` (9 bits)
   - `fs = (metadata & 0x7800) >>> 11` (4 bits)

Theme = `base: 'vs-dark'`, `inherit: true`. Inheriting from the base provides a fallback for tokens that don't match any rule (with `inherit: false`, Monaco returned a hard-coded black for those tokens — see "Issues encountered" §1).

### Synthetic default-settings entry for the IRawTheme

`vscode-textmate`'s `Registry.setTheme()` reads the **default** foreground/background from the first `settings` entry that has no `scope`. VS Code synthesizes such an entry from its workbench colors before handing the theme to the tokenizer. Without this synthetic entry, `colorMap[1]` (the default-foreground sentinel) remains the hardcoded `#000000`, and every default-styled token (variable usages, semicolons, parens) renders black on a dark background — the bug we hit and fixed.

The fix: prepend `{ settings: { foreground: resolved.colors['editor.foreground'], background: resolved.colors['editor.background'] } }` to the settings array before calling `setTheme`. After this `colorMap[1]` becomes the real Dark Modern default `#CCCCCC`, and unstyled tokens render correctly.

### Allow-listed workbench colors

Dark Modern's `colors` object holds hundreds of workbench keys (`activityBar.*`, `titleBar.*`, terminal palette, etc.) that Monaco doesn't consume. We pass through only the editor-related prefixes (`editor.*`, `editorCursor.*`, `editorLineNumber.*`, `editorIndentGuide.*`, `editorBracketMatch.*`, `scrollbar.*`, `minimap.*`, etc.). Filtering avoids both noise in the theme registration and any future Monaco strict-validation surprises. List lives in `ALLOWED_COLOR_PREFIXES` in `textmate-setup.ts`.

### Idempotent `setupTextMate()`

Setup is gated by a module-level `setupPromise`. Calling it more than once is a no-op (returns the cached promise). `main.ts` `await`s it before creating the editor; future entry points (e.g. a Task-5 jdtls language client wiring) can call it freely.

## Issues encountered during implementation

### 1. Variables and punctuation rendered black on the dark background

Initial implementation set `inherit: false` on the Monaco theme and did not synthesize a default settings entry for `vscode-textmate`. Result: tokens with no specific theme rule (variable usages, `;`, `,`, `(`, `)`, parts of identifier chains) rendered as `rgb(0, 0, 0)` — invisible on Dark Modern's `#1F1F1F` background.

Two compounding causes:

- **`vscode-textmate` colorMap[1] was `#000000`**: that index is the default-foreground sentinel. VS Code overwrites it via a synthetic settings entry; we did not. Fixed by prepending the synthetic entry (see "Synthetic default-settings entry" above).
- **Monaco rules with no `foreground` field**: Monaco does not fall back to `editor.foreground` when a rule explicitly omits foreground; it treats an empty foreground as `#000000`. Fixed by switching to `inherit: true` and skipping rule generation for combos with neither a real color nor a fontStyle.

Verified end-to-end via DOM inspection: post-fix, semicolons resolve to `mtk1` with `rgb(204, 204, 204)` (= `#CCCCCC`), the real Dark Modern default foreground.

### 2. Vendored theme files are JSONC, not JSON

`JSON.parse` choked at line 13 col 43 of `dark-plus.json` on the inline comment

```jsonc
"entity.name.operator.custom-literal" // See https://en.cppreference.com/w/cpp/language/user_literal
```

Adding the `parseJsonc` helper (strip line + block comments outside strings, then strip trailing commas before `]`/`}`) was cheaper than pulling in a dedicated dep. Same parser is reused for all three theme files.

### 3. Monaco renames token classes; mtk indices in the DOM ≠ rule indices in code

Inspecting DOM elements showed classes like `mtk13`, `mtk22`, etc., not the `mtk{fg}_{fs}` names we registered. Monaco internally re-numbers token rules into a compact CSS class palette: `mtkN` in the DOM is "the Nth unique color in Monaco's palette" not "fg=N in the vscode-textmate colorMap". Our `mtk{fg}_{fs}` names are the lookup keys for rules, not what ends up on the DOM. This is fine for correctness but worth noting if anyone debugs by class name.

## Verification results

Run on 2026-05-01 against `apps/web/`:

- `npm install --workspace apps/web vscode-textmate vscode-oniguruma`: 76 packages added, deduped at the workspace root.
- `npm run typecheck --workspace apps/web`: passes.
- Standalone `theme-preview.html` served by `dev:web` (deleted after verification): page rendered with no console errors, all tokens visible:
  - Keywords (`public`, `class`, `void`, `private`, `static`, `final`, `extends`) → `#569CD6` blue.
  - Type names (`Robot`, `TimedRobot`, `Pose2d`, `SmartDashboard`, `int`, `double`) → `#4EC9B0` teal.
  - Strings (`"counter"`) → `#CE9178` orange.
  - Numbers (`2.0`, `0.05`) → `#B5CEA8` green.
  - Comments (`//`, `/** */`) → `#6A9955` green.
  - Annotations (`@Override`) → teal.
  - Variable usages, semicolons, commas, parens → `#CCCCCC` (default fg, visible).
- Full `npm run dev:mvp` stack against the live `Robot.java` from the sim container: user-confirmed visual match with VS Code Dark Modern.

## Out of scope (deliberately)

- TextMate grammars for any language other than Java.
- A theme switcher / light theme toggle. Hardcoded Dark Modern.
- Semantic highlighting from a language server. Comes for free once jdtls is wired (milestone 2): semantic tokens layer on top of TextMate tokens, and Dark Modern already includes semantic-token rules — no extra glue needed in this file.
- Refreshing the vendored grammar/theme JSONs from upstream. Snapshots are pinned; future work can bump them.
