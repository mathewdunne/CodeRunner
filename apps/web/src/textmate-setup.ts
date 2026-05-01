import * as monaco from "monaco-editor";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IRawTheme,
  type StateStack,
} from "vscode-textmate";

import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import javaGrammarRaw from "./grammars/java.tmLanguage.json?raw";
import darkModernRaw from "./themes/dark-modern.json?raw";
import darkPlusRaw from "./themes/dark-plus.json?raw";
import darkVsRaw from "./themes/dark-vs.json?raw";

export const THEME_NAME = "dark-modern";

type TmTokenColor = {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
};

type TmTheme = {
  name?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: TmTokenColor[];
};

// vscode-textmate metadata bit layout (verified against installed v9.x):
// fontStyle = (metadata & 0x7800) >>> 11   (4 bits, bit-flags below)
// foreground = (metadata & 0xff8000) >>> 15 (9 bits, index into colorMap)
const FONT_STYLE_MASK = 0x7800;
const FOREGROUND_MASK = 0xff8000;
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

// VS Code's vendored theme JSONs are JSONC (line/block comments + trailing
// commas). Strip both before JSON.parse.
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const themesByInclude: Record<string, TmTheme> = {
  "./dark_plus.json": parseJsonc(darkPlusRaw) as TmTheme,
  "./dark_vs.json": parseJsonc(darkVsRaw) as TmTheme,
};

let setupPromise: Promise<void> | null = null;

export function setupTextMate(): Promise<void> {
  if (!setupPromise) {
    setupPromise = doSetup();
  }
  return setupPromise;
}

async function doSetup(): Promise<void> {
  const wasmBin = await fetch(onigWasmUrl).then((r) => r.arrayBuffer());
  await loadWASM(wasmBin);

  const onigLib = Promise.resolve({
    createOnigScanner: (sources: string[]) => new OnigScanner(sources),
    createOnigString: (str: string) => new OnigString(str),
  });

  const registry = new Registry({
    onigLib,
    loadGrammar: async (scopeName: string) => {
      if (scopeName === "source.java") {
        return parseRawGrammar(javaGrammarRaw, "java.tmLanguage.json");
      }
      return null;
    },
  });

  const darkModern = parseJsonc(darkModernRaw) as TmTheme;
  const resolved = resolveTheme(darkModern);

  // vscode-textmate reads "defaults" from a settings entry with no scope.
  // VS Code synthesizes one from workbench colors before handing the theme to
  // tokenizers; without this, default-colored tokens (variables, punctuation)
  // get vscode-textmate's sentinel #000000 and render black.
  const defaultFg = resolved.colors["editor.foreground"] ?? "#CCCCCC";
  const defaultBg = resolved.colors["editor.background"] ?? "#1E1E1E";

  const tmTheme: IRawTheme = {
    name: "dark-modern",
    settings: [
      { settings: { foreground: defaultFg, background: defaultBg } },
      ...resolved.tokenColors.map((tc) => ({
        scope: tc.scope ?? "",
        settings: tc.settings,
      })),
    ],
  };

  registry.setTheme(tmTheme);

  const colorMap = registry.getColorMap();
  const monacoRules = buildMonacoRules(colorMap);

  const themeColors = filterEditorColors(resolved.colors);
  // editor.foreground is the fallback for tokens with no foreground rule.
  // If the resolved theme didn't surface one, fall back to a sane default.
  if (!themeColors["editor.foreground"]) {
    themeColors["editor.foreground"] = "#CCCCCC";
  }

  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: monacoRules,
    colors: themeColors,
  });

  const grammar = await registry.loadGrammar("source.java");
  if (!grammar) {
    throw new Error("Failed to load Java TextMate grammar");
  }

  monaco.languages.setTokensProvider("java", {
    getInitialState() {
      return new TmState(INITIAL);
    },
    tokenize(line, state) {
      const tmState = (state as TmState).stack;
      const result = grammar.tokenizeLine2(line, tmState);
      const tokens: monaco.languages.IToken[] = [];
      const data = result.tokens;
      for (let i = 0; i < data.length; i += 2) {
        const startIndex = data[i] ?? 0;
        const metadata = data[i + 1] ?? 0;
        const fg = (metadata & FOREGROUND_MASK) >>> 15;
        const fs = (metadata & FONT_STYLE_MASK) >>> 11;
        tokens.push({ startIndex, scopes: `mtk${fg}_${fs}` });
      }
      return {
        tokens,
        endState: new TmState(result.ruleStack),
      };
    },
  });
}

class TmState implements monaco.languages.IState {
  constructor(public readonly stack: StateStack) {}
  clone(): monaco.languages.IState {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TmState && other.stack === this.stack;
  }
}

function resolveTheme(theme: TmTheme): { colors: Record<string, string>; tokenColors: TmTokenColor[] } {
  let colors: Record<string, string> = {};
  let tokenColors: TmTokenColor[] = [];
  if (theme.include) {
    const parent = themesByInclude[theme.include];
    if (!parent) {
      throw new Error(`Missing vendored theme include: ${theme.include}`);
    }
    const resolved = resolveTheme(parent);
    colors = { ...resolved.colors };
    tokenColors = [...resolved.tokenColors];
  }
  Object.assign(colors, theme.colors ?? {});
  tokenColors.push(...(theme.tokenColors ?? []));
  return { colors, tokenColors };
}

function buildMonacoRules(colorMap: readonly string[]): monaco.editor.ITokenThemeRule[] {
  const rules: monaco.editor.ITokenThemeRule[] = [];
  // Enumerate (foreground, fontStyle) combos that vscode-textmate can emit.
  // fontStyle is 4 bits (italic|bold|underline|strikethrough) so 16 combos.
  // We skip rules that would have neither a real foreground nor a fontStyle,
  // because Monaco treats an empty-string foreground as black — better to omit
  // the rule and let editor.foreground take over.
  for (let fg = 0; fg < colorMap.length; fg++) {
    const color = colorMap[fg];
    const hasColor = fg !== 0 && typeof color === "string" && color.length > 0;
    for (let fs = 0; fs < 16; fs++) {
      const fontStyle = fontStyleString(fs);
      if (!hasColor && !fontStyle) continue;
      const rule: monaco.editor.ITokenThemeRule = { token: `mtk${fg}_${fs}` };
      if (hasColor) {
        rule.foreground = stripHash(color);
      }
      if (fontStyle) {
        rule.fontStyle = fontStyle;
      }
      rules.push(rule);
    }
  }
  return rules;
}

function fontStyleString(fs: number): string | undefined {
  const parts: string[] = [];
  if (fs & FONT_STYLE_ITALIC) parts.push("italic");
  if (fs & FONT_STYLE_BOLD) parts.push("bold");
  if (fs & FONT_STYLE_UNDERLINE) parts.push("underline");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripHash(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

// Monaco's defineTheme accepts editor-related workbench colors and silently
// ignores most others, but it does throw on a handful (e.g. anything ending in
// a non-color value). We allow-list the keys Monaco actually consumes.
const ALLOWED_COLOR_PREFIXES = [
  "editor.",
  "editorCursor.",
  "editorLineNumber.",
  "editorIndentGuide.",
  "editorWhitespace.",
  "editorGutter.",
  "editorBracketMatch.",
  "editorBracketHighlight.",
  "editorOverviewRuler.",
  "editorRuler.",
  "editorWidget.",
  "editorSuggestWidget.",
  "editorHoverWidget.",
  "editorError.",
  "editorWarning.",
  "editorInfo.",
  "editorHint.",
  "editorLink.",
  "editorUnnecessaryCode.",
  "editorActiveLineNumber.",
  "editorCodeLens.",
  "editorGroup.",
  "editorMarkerNavigation.",
  "diffEditor.",
  "scrollbar.",
  "scrollbarSlider.",
  "minimap.",
  "minimapSlider.",
  "minimapGutter.",
];

function filterEditorColors(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    if (ALLOWED_COLOR_PREFIXES.some((prefix) => k.startsWith(prefix))) {
      out[k] = v;
    }
  }
  return out;
}
