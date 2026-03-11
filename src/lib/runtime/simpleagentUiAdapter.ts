import fs from "node:fs/promises";
import path from "node:path";

let cachedTemplate: string | null = null;

function rewriteTemplateEndpoints(template: string, runtimePrefix: string) {
  let next = template;
  const replacements: Array<[string, string]> = [
    ['"/api/', `"${runtimePrefix}/api/`],
    ["'/api/", `'${runtimePrefix}/api/`],
    ['"/health"', `"${runtimePrefix}/health"`],
    ["'/health'", `'${runtimePrefix}/health'`],
  ];
  for (const [from, to] of replacements) {
    next = next.replaceAll(from, to);
  }
  return next;
}

async function loadTemplate() {
  if (cachedTemplate !== null) return cachedTemplate;
  const templatePath = path.join(process.cwd(), "src", "lib", "runtime", "simpleagent-ui-template.html");
  cachedTemplate = await fs.readFile(templatePath, "utf8");
  return cachedTemplate;
}

export async function renderSimpleagentUiHtml(input: {
  deploymentId: string;
  forceOneclickMode?: boolean;
  hideBotUi?: boolean;
  hideSessionUi?: boolean;
}) {
  const template = await loadTemplate();
  const runtimePrefix = `/api/runtime/${encodeURIComponent(input.deploymentId)}/simpleagent`;
  const oneclickMode = input.forceOneclickMode !== false;
  const hideBotUi = input.hideBotUi !== false;
  const hideSessionUi = input.hideSessionUi === true;

  const bootstrap = `
<script>
(() => {
  const runtimePrefix = ${JSON.stringify(runtimePrefix)};
  const forceOneclickMode = ${oneclickMode ? "true" : "false"};
  const hideBotUi = ${hideBotUi ? "true" : "false"};
  const hideSessionUi = ${hideSessionUi ? "true" : "false"};

  const rewriteUrl = (raw) => {
    try {
      const text = String(raw || "").trim();
      if (!text) return text;

      let value = text;
      if (/^https?:\/\//i.test(value)) {
        const parsed = new URL(value);
        if (parsed.origin !== window.location.origin) return value;
        value = parsed.pathname + parsed.search + parsed.hash;
      }

      if (value.startsWith(runtimePrefix + "/")) return value;
      if (value === "/health") return runtimePrefix + "/health";
      if (value.startsWith("/api/")) return runtimePrefix + value;
      return value;
    } catch {
      return String(raw || "");
    }
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) {
      return nativeFetch(rewriteUrl(String(input)), init);
    }
    if (typeof Request === "function" && input instanceof Request) {
      const rewrittenUrl = rewriteUrl(input.url);
      if (rewrittenUrl === input.url) {
        return nativeFetch(input, init);
      }
      return nativeFetch(new Request(rewrittenUrl, input), init);
    }
    return nativeFetch(input, init);
  };

  if (typeof window.EventSource === "function") {
    const NativeEventSource = window.EventSource;
    // eslint-disable-next-line no-global-assign
    window.EventSource = function (url, config) {
      return new NativeEventSource(rewriteUrl(String(url)), config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  try {
    const current = new URL(window.location.href);
    if (forceOneclickMode && !current.searchParams.get("ui_mode")) {
      current.searchParams.set("ui_mode", "oneclick");
    }
    if (hideBotUi && !current.searchParams.get("hide_bot_session") && !current.searchParams.get("hide_bot_ui")) {
      current.searchParams.set("hide_bot_session", "1");
    }
    if (hideBotUi && !current.searchParams.get("hide_bot_ui")) {
      current.searchParams.set("hide_bot_ui", "1");
    }
    if (hideSessionUi && !current.searchParams.get("hide_session_ui")) {
      current.searchParams.set("hide_session_ui", "1");
    }
    const nextPath = current.pathname + current.search + current.hash;
    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    if (nextPath !== currentPath) {
      window.history.replaceState(window.history.state, "", nextPath);
    }
  } catch {}
})();
</script>`;

  const adaptedTemplate = rewriteTemplateEndpoints(template, runtimePrefix);

  if (adaptedTemplate.includes("</head>")) {
    return adaptedTemplate.replace("</head>", `${bootstrap}\n</head>`);
  }
  return `${bootstrap}\n${adaptedTemplate}`;
}
