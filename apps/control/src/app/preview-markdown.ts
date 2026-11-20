import MarkdownIt from "markdown-it";

/**
 * Markdown rendering for Preview. Everything ships with the control plane —
 * no CDN renderer, no webfonts, no syntax-highlighting bundle — because the
 * whole point is that a student on a locked-down school network can still read
 * their project's README.
 *
 * Raw embedded HTML is disabled (`html: false`). Markdown documents are
 * rendered into a frame that is sandboxed *without* `allow-scripts`, so an
 * inline `<script>` would not run anyway; leaving the parser strict keeps the
 * two layers agreeing with each other. Reports that genuinely need markup are
 * `.html` documents, which take the scripted path instead.
 */
const md = MarkdownIt({
	html: false,
	linkify: true,
	breaks: false,
});

/**
 * GitHub-style heading slug: lowercase, drop anything that is not a word
 * character, space or hyphen, then hyphenate. Good enough that the `#anchor`
 * links people write by hand in a README resolve against the headings above
 * them.
 */
function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.trim()
			// Decomposes accents so the following class drops the combining marks.
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
	);
}

// Give every heading a stable id so intra-document links work. Duplicated
// heading text gets a numeric suffix, matching what readers expect from GitHub.
md.core.ruler.push("preview_heading_anchors", (state) => {
	const used = new Map<string, number>();
	for (let i = 0; i < state.tokens.length; i++) {
		const token = state.tokens[i];
		if (token?.type !== "heading_open") continue;
		const inline = state.tokens[i + 1];
		if (inline?.type !== "inline") continue;

		const base = slugify(inline.content) || "section";
		const seen = used.get(base) ?? 0;
		used.set(base, seen + 1);
		token.attrSet("id", seen === 0 ? base : `${base}-${seen}`);
	}
});

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Deliberately plain: system font stack, no webfonts, colours that stay legible
 * in either theme via `color-scheme` plus `prefers-color-scheme`.
 */
const DOCUMENT_STYLES = `
:root { color-scheme: light dark; --fg: #1b1f23; --muted: #57606a; --bg: #ffffff; --line: #d8dee4; --code-bg: #f2f4f6; --link: #0a58ca; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6edf3; --muted: #9198a1; --bg: #16191d; --line: #30363d; --code-bg: #21262d; --link: #6ea8fe; }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px 32px 64px;
  background: var(--bg); color: var(--fg);
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h1:first-child, h2:first-child { margin-top: 0; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: var(--link); }
code { background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.9em;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
pre { background: var(--code-bg); padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.875em; }
blockquote { margin-left: 0; padding: 0 1em; color: var(--muted); border-left: 3px solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 13px; text-align: left; }
th { background: var(--code-bg); }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
`;

function documentShell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DOCUMENT_STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderMarkdownDocument(source: string, title: string): string {
	return documentShell(title, md.render(source));
}

/**
 * Failures are rendered *into* the frame rather than returned as bare text: the
 * frame is what the student is looking at, and an iframe load event on its own
 * says nothing about whether the response was a success.
 */
export function renderPreviewErrorDocument(
	heading: string,
	detail: string,
): string {
	return documentShell(
		heading,
		`<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(detail)}</p>`,
	);
}
