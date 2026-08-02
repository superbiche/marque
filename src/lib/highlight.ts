import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme,
} from "shiki";

const COMMON_LANGS: BundledLanguage[] = [
  "bash",
];

const THEMES: BundledTheme[] = ["github-light", "github-dark"];

let promise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!promise) {
    const attempt = createHighlighter({ themes: THEMES, langs: COMMON_LANGS });
    promise = attempt;
    void attempt.catch(() => {
      if (promise === attempt) promise = null;
    });
  }
  return promise;
}

export async function highlightCode(
  code: string,
  lang: string | undefined,
  theme: "light" | "dark" = "dark"
): Promise<string> {
  const hl = await getHighlighter();
  const loaded = hl.getLoadedLanguages();
  let resolvedLang = lang && loaded.includes(lang as BundledLanguage) ? lang : "";
  if (lang && !resolvedLang) {
    try {
      await hl.loadLanguage(lang as BundledLanguage);
      resolvedLang = lang;
    } catch {
      resolvedLang = "";
    }
  }
  return hl.codeToHtml(code, {
    lang: resolvedLang || "text",
    theme: theme === "dark" ? "github-dark" : "github-light",
  });
}
