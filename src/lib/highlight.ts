import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const loadBash = () => import("@shikijs/langs/bash");
const loadC = () => import("@shikijs/langs/c");
const loadCpp = () => import("@shikijs/langs/cpp");
const loadCsharp = () => import("@shikijs/langs/csharp");
const loadCss = () => import("@shikijs/langs/css");
const loadDiff = () => import("@shikijs/langs/diff");
const loadDockerfile = () => import("@shikijs/langs/dockerfile");
const loadGo = () => import("@shikijs/langs/go");
const loadHtml = () => import("@shikijs/langs/html");
const loadJava = () => import("@shikijs/langs/java");
const loadJavaScript = () => import("@shikijs/langs/javascript");
const loadJson = () => import("@shikijs/langs/json");
const loadJsx = () => import("@shikijs/langs/jsx");
const loadKotlin = () => import("@shikijs/langs/kotlin");
const loadMarkdown = () => import("@shikijs/langs/markdown");
const loadPhp = () => import("@shikijs/langs/php");
const loadPython = () => import("@shikijs/langs/python");
const loadRuby = () => import("@shikijs/langs/ruby");
const loadRust = () => import("@shikijs/langs/rust");
const loadSql = () => import("@shikijs/langs/sql");
const loadSwift = () => import("@shikijs/langs/swift");
const loadToml = () => import("@shikijs/langs/toml");
const loadTsx = () => import("@shikijs/langs/tsx");
const loadTypeScript = () => import("@shikijs/langs/typescript");
const loadVue = () => import("@shikijs/langs/vue");
const loadXml = () => import("@shikijs/langs/xml");
const loadYaml = () => import("@shikijs/langs/yaml");

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  bash: loadBash,
  shellscript: loadBash,
  sh: loadBash,
  shell: loadBash,
  zsh: loadBash,
  c: loadC,
  cpp: loadCpp,
  "c++": loadCpp,
  csharp: loadCsharp,
  "c#": loadCsharp,
  cs: loadCsharp,
  css: loadCss,
  diff: loadDiff,
  docker: loadDockerfile,
  dockerfile: loadDockerfile,
  go: loadGo,
  html: loadHtml,
  java: loadJava,
  javascript: loadJavaScript,
  js: loadJavaScript,
  cjs: loadJavaScript,
  mjs: loadJavaScript,
  json: loadJson,
  jsx: loadJsx,
  kotlin: loadKotlin,
  kt: loadKotlin,
  kts: loadKotlin,
  markdown: loadMarkdown,
  md: loadMarkdown,
  php: loadPhp,
  python: loadPython,
  py: loadPython,
  ruby: loadRuby,
  rb: loadRuby,
  rust: loadRust,
  rs: loadRust,
  sql: loadSql,
  swift: loadSwift,
  toml: loadToml,
  tsx: loadTsx,
  typescript: loadTypeScript,
  ts: loadTypeScript,
  cts: loadTypeScript,
  mts: loadTypeScript,
  vue: loadVue,
  xml: loadXml,
  yaml: loadYaml,
  yml: loadYaml,
};

let promise: Promise<HighlighterCore> | null = null;

// The two themes Shiki emits as CSS variables in the dual-theme output.
// `codeToHtml` is called with `defaultColor: false`, so the markup carries no
// inline color/background: every colour is a `--shiki-light-*` /
// `--shiki-dark-*` custom property that `src/styles/markdown.css` maps onto
// `color`/`background-color` per screen theme, and forces back to the light
// values when printing (issue #49).
export const SHIKI_LIGHT_THEME = "github-light";
export const SHIKI_DARK_THEME = "github-dark";

export function getHighlighter(): Promise<HighlighterCore> {
  if (!promise) {
    const attempt = createHighlighterCore({
      engine: createJavaScriptRegexEngine({ forgiving: true }),
      themes: [
        import("@shikijs/themes/github-light"),
        import("@shikijs/themes/github-dark"),
      ],
      langs: [loadBash()],
    });
    promise = attempt;
    void attempt.catch(() => {
      if (promise === attempt) promise = null;
    });
  }
  return promise;
}

// One render serves both themes: `codeToHtml` emits `--shiki-light` /
// `--shiki-dark` (and `-bg`) variables instead of inline colours, so the
// screen theme is chosen purely in CSS. A theme flip therefore re-renders
// nothing, and printing never needs to re-render in light.
export async function highlightCode(
  code: string,
  lang: string | undefined
): Promise<string> {
  const hl = await getHighlighter();
  const themes = { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME };
  const loaded = hl.getLoadedLanguages();
  let resolvedLang = lang && loaded.includes(lang) ? lang : "";
  if (lang && !resolvedLang) {
    const loader = LANGUAGE_LOADERS[lang];
    if (!loader) {
      return hl.codeToHtml(code, { lang: "text", themes, defaultColor: false });
    }
    try {
      await hl.loadLanguage(loader);
      resolvedLang = lang;
    } catch {
      resolvedLang = "";
    }
  }
  return hl.codeToHtml(code, {
    lang: resolvedLang || "text",
    themes,
    defaultColor: false,
  });
}
