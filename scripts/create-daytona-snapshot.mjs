#!/usr/bin/env node
// Build a custom Daytona snapshot that bakes CLI tools into a base image via
// mise. Defaults reproduce `nadi-medium` (= `daytona-medium` base + a curated
// developer CLI set). The app only *consumes* snapshots by name (workspace /
// agent Sandbox settings -> daytona.create({ snapshot })); creating them is an
// out-of-band operator task, which is what this script does.
//
// Usage:
//   DAYTONA_API_KEY=... node scripts/create-daytona-snapshot.mjs
// The key is read from DAYTONA_API_KEY, falling back to the (possibly
// commented) DAYTONA_API_KEY line in ./.dev.vars for local convenience.
//
// Override via env: SNAPSHOT_NAME, BASE_IMAGE, SNAPSHOT_CPU, SNAPSHOT_MEM,
// SNAPSHOT_DISK, SNAPSHOT_TOOLS (space-separated mise tool names),
// SNAPSHOT_PNPM_VERSION, SNAPSHOT_YARN_VERSION.
import { readFileSync } from "node:fs";
import { Daytona, Image } from "@daytona/sdk";

const NAME = process.env.SNAPSHOT_NAME ?? "nadi-medium";
// Same base + resources as the `daytona-medium` snapshot this mirrors.
const BASE_IMAGE = process.env.BASE_IMAGE ?? "daytonaio/sandbox:0.8.0";
const RESOURCES = {
  cpu: Number(process.env.SNAPSHOT_CPU ?? 2),
  memory: Number(process.env.SNAPSHOT_MEM ?? 4),
  disk: Number(process.env.SNAPSHOT_DISK ?? 8),
};
const ENTRYPOINT = ["sleep", "infinity"]; // matches daytona-medium
const TOOLS = (process.env.SNAPSHOT_TOOLS ?? "gh jq ripgrep fd yq shellcheck")
  .split(/\s+/)
  .filter(Boolean);
const PNPM_VERSION = process.env.SNAPSHOT_PNPM_VERSION ?? "10";
const YARN_VERSION_INPUT = process.env.SNAPSHOT_YARN_VERSION ?? "latest";
const YARN_VERSION = YARN_VERSION_INPUT === "stable" ? "latest" : YARN_VERSION_INPUT;

const apiKey = resolveApiKey();
const daytona = new Daytona({ apiKey });

// mise installs tools into $MISE_DATA_DIR/shims; putting that dir on the image
// PATH makes them resolve in any (even non-login) shell at sandbox runtime.
//
// NOTE: Image.env() escapes `$`, so `ENV PATH=...:${PATH}` would be written
// literally and break PATH. Emit ENV via raw dockerfileCommands so Docker
// expands ${PATH}. USER root lets the install RUN steps write /usr/local.
const image = Image.base(BASE_IMAGE)
  .dockerfileCommands([
    "USER root",
    "ENV MISE_DATA_DIR=/usr/local/share/mise",
    "ENV MISE_CONFIG_DIR=/etc/mise",
    'ENV PATH="/usr/local/share/mise/shims:${PATH}"',
  ])
  .runCommands(
    "set -eux; if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*; fi",
    "set -eux; curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh; /usr/local/bin/mise --version",
    // COSIGN/SLSA off (build robustness); mise still verifies sha256 checksums.
    // Cache dir is inline-only so runtime uses the per-user default (writable).
    `set -eux; MISE_YES=1 MISE_AQUA_COSIGN=false MISE_AQUA_SLSA=false MISE_CACHE_DIR=/tmp/mise-build-cache /usr/local/bin/mise use -g ${TOOLS.join(" ")}; /usr/local/bin/mise reshim`,
    `set -eux; npm install -g pnpm@${PNPM_VERSION} yarn@${YARN_VERSION}`,
    "set -eux; gh --version; jq --version; rg --version; fd --version; yq --version; shellcheck --version",
    "set -eux; pnpm --version; yarn --version",
  );

// Snapshot names are unique per org; delete any existing one first. Deletion is
// async server-side (a create() right after 409s), so poll until it 404s.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const existing = await daytona.snapshot.get(NAME);
  console.log(`[delete] existing ${NAME} (id=${existing.id}) ...`);
  await daytona.snapshot.delete(existing);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      await daytona.snapshot.get(NAME);
    } catch {
      console.log("[delete] confirmed removed");
      break;
    }
  }
} catch (e) {
  console.log(`[delete] no existing ${NAME} (${e?.message ?? e})`);
}

console.log(`[create] building ${NAME} from ${BASE_IMAGE} + [${TOOLS.join(", ")}] ...`);
await daytona.snapshot.create(
  { name: NAME, image, resources: RESOURCES, entrypoint: ENTRYPOINT },
  {
    onLogs: (l) => process.stdout.write(typeof l === "string" ? l : JSON.stringify(l) + "\n"),
    timeout: 0,
  },
);

const created = await daytona.snapshot.get(NAME);
console.log(
  "[done]",
  JSON.stringify({
    name: created.name,
    state: created.state,
    cpu: created.cpu,
    mem: created.mem,
    disk: created.disk,
    entrypoint: created.entrypoint,
  }),
);

function resolveApiKey() {
  if (process.env.DAYTONA_API_KEY) return process.env.DAYTONA_API_KEY.trim();
  try {
    const m = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(
      /^#?\s*DAYTONA_API_KEY=(.+)$/m,
    );
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .dev.vars */
  }
  console.error("DAYTONA_API_KEY not set (env or ./.dev.vars)");
  process.exit(1);
}
