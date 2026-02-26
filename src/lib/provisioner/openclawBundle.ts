function readEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  // Handle accidentally quoted or newline-suffixed env values from CLI imports.
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
}

function readBool(name: string, fallback: boolean) {
  const value = readEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

let warnedAboutFloatingImage = false;

function isDigestRef(image: string) {
  return /@sha256:[a-f0-9]{64}$/i.test(image.trim());
}

function isFloatingImageRef(image: string) {
  const trimmed = image.trim();
  if (!trimmed) return true;
  if (isDigestRef(trimmed)) return false;

  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const hasExplicitTag = lastColon > lastSlash;
  if (!hasExplicitTag) return true;

  const tag = trimmed.slice(lastColon + 1).trim().toLowerCase();
  return !tag || tag === "latest";
}

export function getOpenClawImage() {
  const image = readEnv("OPENCLAW_IMAGE") || "alpine/openclaw:latest";
  const requirePinned = readBool("OPENCLAW_REQUIRE_PINNED_IMAGE", false);
  if (isFloatingImageRef(image)) {
    const message =
      `OPENCLAW_IMAGE must be pinned (tag or digest, not floating/latest). Current value: ${image}`;
    if (requirePinned) {
      throw new Error(`${message}. Set a stable image tag/digest or disable OPENCLAW_REQUIRE_PINNED_IMAGE.`);
    }
    if (!warnedAboutFloatingImage) {
      warnedAboutFloatingImage = true;
      console.warn(`[oneclick] ${message}`);
    }
  }
  return image;
}

export function getOpenClawPort() {
  return Number(readEnv("OPENCLAW_CONTAINER_PORT") || "18789");
}

export function getOpenClawStartCommand() {
  return readEnv("OPENCLAW_START_COMMAND") || "gateway --allow-unconfigured";
}

export function shouldAllowInsecureControlUi() {
  return readBool("OPENCLAW_ALLOW_INSECURE_CONTROL_UI", true);
}
