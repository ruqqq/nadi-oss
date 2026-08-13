import { SpritesComputeBackend } from "../../../../src/compute/backends/sprites";
import type {
  SpritesClient,
  SpritesExecOptions,
  SpritesExecResult,
  SpritesFsEntry,
  SpritesSessionInfo,
  SpritesSignal,
} from "../../../../src/compute/backends/sprites-client";
import { ComputeError } from "../../../../src/compute/errors";

/**
 * A stateful in-memory stand-in for the sprites.dev API, modelling exactly the
 * seam `SpritesComputeBackend` depends on.
 *
 * Two deliberate design choices:
 *
 *  - Every method throws `ComputeError("runtime_missing")` for an unknown or
 *    deleted sprite, mirroring the real client, where a 404 on any
 *    sprite-scoped route maps to that code. That is what makes the shared
 *    contract's `reportsMissingRuntimeAfterDiscard` case meaningful here.
 *  - The exec interpreter understands ONLY the argv shapes the backend
 *    generates. Anything else exits 127 with `command not found` — a loud
 *    signal to extend this file rather than to special-case the backend.
 *
 * Two fidelity rules this file learned the hard way, both from live probes:
 *
 *  - A launched session's `command` is the INNER process's argv (`sleep 30`),
 *    NOT the wrapper script we sent. Modelling the wrapper here is what let a
 *    "find the session by the process id in its command" backend stay green
 *    while being unable to find anything in production.
 *  - `execDetached` returns the server's session id, and that id has no
 *    relationship to our process id. Any backend that tries to derive one from
 *    the other fails here.
 */

interface FakeSession {
  command: string;
  killed: boolean;
}

interface FakeSprite {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  /** Symlinks, by path → link size. `stat` reports the LINK, never its target. */
  links: Map<string, number>;
  sessions: Map<string, FakeSession>;
  deleted: boolean;
  environment: Record<string, string>;
  memoryMb: number | undefined;
  networkRules: Array<{ domain: string; action: "allow" | "deny" }> | undefined;
}

export interface RecordedNetworkPolicy {
  name: string;
  rules: Array<{ domain: string; action: "allow" | "deny" }>;
}

export interface RecordedKill {
  name: string;
  sessionId: string;
  signal: SpritesSignal;
}

/**
 * How an exec shows up in the call log. `dir` is included — it is the working
 * directory the command actually runs in, so a backend that dropped it would
 * otherwise be indistinguishable here from one that passed it.
 */
function describeExec(options: SpritesExecOptions): string {
  return options.dir === undefined
    ? options.argv.join(" ")
    : `${options.argv.join(" ")} @${options.dir}`;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export class FakeSpritesClient implements SpritesClient {
  /**
   * Every client method call, in order, as `method:argument` strings. The
   * ordering assertions (memory policy before network policy) and the
   * "recoverable release touches no provider" assertion both read this.
   */
  readonly calls: string[] = [];
  /**
   * The full options object of every `execCollect`, in order. `calls` above
   * flattens an exec to its argv + dir, which cannot show whether a timeout was
   * passed — and the backend's own execs must always carry one, or an
   * unanswered socket hangs them forever.
   */
  readonly execCollectOptions: SpritesExecOptions[] = [];
  /**
   * The full options of every `execDetached`, in order. The runtime env has to
   * ride on the DETACHED launch too — a create-time `environment` reaches no
   * command on sprites — and `calls` cannot show it.
   */
  readonly execDetachedOptions: SpritesExecOptions[] = [];
  /**
   * The `environment` of every `createSprite`. It reaches no command on the
   * live provider, so what matters is that no secret is written into it.
   */
  readonly createdEnvironments: Array<Record<string, string>> = [];
  readonly networkPolicies: RecordedNetworkPolicy[] = [];
  readonly memoryPolicies: Array<{ name: string; limitMb: number }> = [];
  readonly killCalls: RecordedKill[] = [];
  /** One-shot failure injections, mirroring the Cloudflare fake's seams. */
  failNextFsList: Error | undefined;
  failNextExec: Error | undefined;
  failNextCreate: Error | undefined;
  /**
   * One-shot IN-BAND exec failure: the socket completes normally and reports a
   * non-zero exit. Distinct from `failNextExec`, which throws — a backend that
   * only handles the throwing shape silently accepts the other.
   */
  nextExecResult: SpritesExecResult | undefined;
  /**
   * One-shot: the NEXT `listSessions` answers normally and then clears every
   * session — a process that exits between the list and the kill.
   */
  dropSessionsOnNextList = false;
  /**
   * When set, every `execCollect` comes back with stderr folded into stdout and
   * an EMPTY stderr — the shape a replayed (already-exited) session has live.
   */
  mergeExecStreams = false;

  private readonly sprites = new Map<string, FakeSprite>();
  private sessionSeq = 0;
  /** The id `execDetached` handed out, for the wrapper interpreter to register. */
  private pendingSessionId: string | undefined;

  async createSprite(name: string, input: { environment?: Record<string, string> }): Promise<void> {
    this.calls.push(`createSprite:${name}`);
    this.createdEnvironments.push({ ...input.environment });
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = undefined;
      throw error;
    }
    this.sprites.set(name, {
      files: new Map(),
      // `/workspace` is deliberately ABSENT: the backend's acquire is what
      // creates it, on both the fresh and the recovery path.
      dirs: new Set(["/", "/tmp"]),
      links: new Map(),
      sessions: new Map(),
      deleted: false,
      environment: { ...input.environment },
      memoryMb: undefined,
      networkRules: undefined,
    });
  }

  async deleteSprite(name: string): Promise<void> {
    this.calls.push(`deleteSprite:${name}`);
    const sprite = this.sprites.get(name);
    // Delete is idempotent in the real client (404 is the goal state).
    if (sprite) sprite.deleted = true;
  }

  async listSprites(maxResults?: number): Promise<{ names: string[] }> {
    this.calls.push(`listSprites:${maxResults ?? ""}`);
    const names = [...this.sprites.entries()].filter(([, s]) => !s.deleted).map(([name]) => name);
    return { names: maxResults === undefined ? names : names.slice(0, maxResults) };
  }

  async setNetworkPolicy(
    name: string,
    rules: Array<{ domain: string; action: "allow" | "deny" }>,
  ): Promise<void> {
    this.calls.push(`setNetworkPolicy:${name}`);
    const sprite = this.alive(name);
    sprite.networkRules = rules.map((rule) => ({ ...rule }));
    this.networkPolicies.push({ name, rules: rules.map((rule) => ({ ...rule })) });
  }

  async setMemoryPolicy(name: string, limitMb: number): Promise<void> {
    this.calls.push(`setMemoryPolicy:${name}`);
    const sprite = this.alive(name);
    sprite.memoryMb = limitMb;
    this.memoryPolicies.push({ name, limitMb });
  }

  async execCollect(name: string, options: SpritesExecOptions): Promise<SpritesExecResult> {
    this.calls.push(`execCollect:${describeExec(options)}`);
    this.execCollectOptions.push({ ...options });
    const result = this.runExec(name, options);
    if (!this.mergeExecStreams) return result;
    // The server's "fast_path": a session that already exited replays with
    // stdout and stderr MERGED on stream 1 and no stream-2 frame at all, so
    // `stderr` arrives empty with its content sitting in `stdout`.
    return {
      exitCode: result.exitCode,
      stdout: `${result.stderr}${result.stdout}`,
      stderr: "",
    };
  }

  /**
   * Returns the session id the server discloses in its `session_info` frame.
   * The id is minted here and deliberately shares nothing with the process id —
   * the real one is a small integer counter on the server.
   */
  async execDetached(name: string, options: SpritesExecOptions): Promise<string> {
    this.calls.push(`execDetached:${describeExec(options)}`);
    this.execDetachedOptions.push({ ...options });
    this.sessionSeq += 1;
    const sessionId = String(this.sessionSeq);
    this.pendingSessionId = sessionId;
    this.runExec(name, options);
    this.pendingSessionId = undefined;
    return sessionId;
  }

  async listSessions(name: string): Promise<SpritesSessionInfo[]> {
    this.calls.push(`listSessions:${name}`);
    const sprite = this.alive(name);
    const sessions = [...sprite.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      command: session.command,
    }));
    // The kill/exit race: the caller gets a live-looking listing, and the
    // sessions are gone by the time it acts on one.
    if (this.dropSessionsOnNextList) {
      this.dropSessionsOnNextList = false;
      sprite.sessions.clear();
    }
    return sessions;
  }

  async killSession(name: string, sessionId: string, signal: SpritesSignal): Promise<void> {
    this.calls.push(`killSession:${name}:${sessionId}:${signal}`);
    this.killCalls.push({ name, sessionId, signal });
    const sprite = this.alive(name);
    const session = sprite.sessions.get(sessionId);
    // A 404 on the kill route is NOT idempotent in the real client — it maps to
    // `runtime_missing` like any other sprite-scoped 404. Modelling that is what
    // lets the backend's kill-races-an-exit handling be tested.
    if (!session) throw new ComputeError("runtime_missing", "sprites_kill_failed: 404");
    session.killed = true;
    sprite.sessions.delete(sessionId);
    // NO rc sentinel is written, deliberately. The signal goes to the wrapper's
    // process group, so the killed `bash` never reaches its trailing
    // `printf %s "$?" > <rc>`: the real aftermath of a kill is a process with no
    // session AND no exit evidence, which is exactly the `failed` arm of
    // `getProcessStatus`. Writing 137/143/130 here would have been the fake
    // agreeing with a hope — and it would have hidden the only outcome a
    // caller actually sees in production.
    //
    // A wrapper CAN still record an rc after a kill, if the signal reached only
    // the inner command and bash survived to run the `printf`. That is why the
    // backend reads the rc file FIRST and only falls back to the session list —
    // both orderings are handled, but only the no-rc one is modelled here.
  }

  async fsRead(
    name: string,
    path: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType?: string } | null> {
    this.calls.push(`fsRead:${path}`);
    const sprite = this.alive(name);
    const file = sprite.files.get(path);
    // The one route where 404 is an answer rather than a fault.
    if (!file) return null;
    return { bytes: toArrayBuffer(file) };
  }

  async fsWrite(
    name: string,
    path: string,
    bytes: ArrayBuffer,
    mkdirParents: boolean,
  ): Promise<void> {
    this.calls.push(`fsWrite:${path}`);
    const sprite = this.alive(name);
    // Parents are created REGARDLESS of the flag: the live server does that, and
    // a fake that enforced `false` would test a constraint nothing upholds.
    void mkdirParents;
    addDirs(sprite, parentPath(path));
    sprite.files.set(path, new Uint8Array(bytes.slice(0)));
  }

  async fsList(name: string, path: string): Promise<SpritesFsEntry[]> {
    this.calls.push(`fsList:${path}`);
    if (this.failNextFsList) {
      const error = this.failNextFsList;
      this.failNextFsList = undefined;
      throw error;
    }
    const sprite = this.alive(name);
    // A missing directory is a 404, which the real client maps to
    // `runtime_missing` — a THROW either way, never an empty listing.
    if (!sprite.dirs.has(path)) {
      throw new ComputeError("runtime_missing", "sprites_fs_list_failed: 404");
    }
    // The real listing carries a `type` string per entry, which is why a symlink
    // survives as one here instead of being flattened by an `isDir` boolean.
    const entries: SpritesFsEntry[] = [];
    for (const [filePath, contents] of sprite.files) {
      if (parentPath(filePath) === path) {
        entries.push({ name: baseName(filePath), type: "file", size: contents.byteLength });
      }
    }
    for (const dir of sprite.dirs) {
      if (dir !== path && parentPath(dir) === path) {
        entries.push({ name: baseName(dir), type: "directory", size: 0 });
      }
    }
    for (const [linkPath, size] of sprite.links) {
      if (parentPath(linkPath) === path) {
        entries.push({ name: baseName(linkPath), type: "symlink", size });
      }
    }
    return entries;
  }

  // ---- test seams ---------------------------------------------------------

  /** Names of sprites that exist and are not deleted. */
  liveSprites(): string[] {
    return [...this.sprites.entries()].filter(([, s]) => !s.deleted).map(([name]) => name);
  }

  /** Seed a sprite directly, for tests that never call `acquire`. */
  seedSprite(name: string): void {
    if (!this.sprites.has(name)) {
      this.sprites.set(name, {
        files: new Map(),
        dirs: new Set(["/", "/tmp", "/workspace"]),
        links: new Map(),
        sessions: new Map(),
        deleted: false,
        environment: {},
        memoryMb: undefined,
        networkRules: undefined,
      });
    }
  }

  /** Seed a running session (a process the backend can later stop). */
  seedSession(name: string, sessionId: string, command: string): void {
    this.seedSprite(name);
    this.alive(name).sessions.set(sessionId, { command, killed: false });
  }

  /** Read a file's text, for asserting what a wrapper actually wrote. */
  readText(name: string, path: string): string | null {
    const file = this.sprites.get(name)?.files.get(path);
    return file === undefined ? null : DECODER.decode(file);
  }

  /** Place a symlink; `stat` (no `-L`) reports it as a link of `size` bytes. */
  seedSymlink(name: string, path: string, size: number): void {
    this.seedSprite(name);
    this.alive(name).links.set(path, size);
  }

  /** Place a file directly (bypassing the backend's write path). */
  seedFile(name: string, path: string, contents: string): void {
    this.seedSprite(name);
    const sprite = this.alive(name);
    addDirs(sprite, parentPath(path));
    sprite.files.set(path, ENCODER.encode(contents));
  }

  // ---- exec interpreter ---------------------------------------------------

  private runExec(name: string, options: SpritesExecOptions): SpritesExecResult {
    const sprite = this.alive(name);
    if (this.failNextExec) {
      const error = this.failNextExec;
      this.failNextExec = undefined;
      throw error;
    }
    if (this.nextExecResult) {
      const result = this.nextExecResult;
      this.nextExecResult = undefined;
      return result;
    }
    const [shell, flag, script] = options.argv;
    if (shell !== "bash" || flag !== "-c" || script === undefined) {
      return notFound(options.argv.join(" "));
    }
    const wrapper = WRAPPER_RE.exec(script);
    if (wrapper?.groups) return this.runWrapper(sprite, script, wrapper.groups);
    return this.runScript(sprite, script);
  }

  /**
   * The background wrapper `startProcess` builds. Everything runs synchronously
   * EXCEPT a `sleep`, which stays "running" (a session with no rc file) until
   * `killSession` ends it — that is what exercises the running/stop paths.
   */
  private runWrapper(
    sprite: FakeSprite,
    script: string,
    groups: Record<string, string | undefined>,
  ): SpritesExecResult {
    const cwd = unquote(groups.cwd ?? "");
    const inner = unquote(groups.cmd ?? "");
    const outPath = groups.out ?? "";
    const errPath = groups.err ?? "";
    const rcPath = groups.rc ?? "";
    const stdinPath = groups.stdin ?? "/dev/null";
    // The wrapper writes rc to a temp path and RENAMES it, so a poll can never
    // read a half-written file. Modelled literally: a wrapper that stopped
    // renaming to the path the backend reads would leave rc absent here.
    if (groups.rctmp !== groups.rcmoved) {
      throw new Error(`wrapper renames ${groups.rcmoved}, but wrote ${groups.rctmp}`);
    }
    // Same idea, for the OTHER rc write (the acquire-failure `exit 97` path):
    // it must write-then-rename to the SAME rc path the main run uses.
    if (groups.exit97tmp !== groups.exit97tmp2 || groups.exit97rc !== groups.rc) {
      throw new Error(
        `exit-97 write targets ${groups.exit97rc} via ${groups.exit97tmp}/${groups.exit97tmp2}, expected the main rc path ${rcPath}`,
      );
    }
    // The refresher's self-check and its `while` guard must watch the SAME rc
    // path as the main run — otherwise it could never observe completion.
    if (groups.refresherRc !== groups.rc || groups.refresherRc2 !== groups.rc) {
      throw new Error(
        `refresher watches ${groups.refresherRc}/${groups.refresherRc2}, not ${rcPath}`,
      );
    }
    // The refresher's tick cap must stay ABOVE the runtime `timeout` allows the
    // command, or the hold lapses out from under a legitimately running command
    // and the sprite hibernates mid-run. Both values come from the same wrapper,
    // so this catches a cap hardcoded to a constant (which passes any
    // single-timeout assertion) as well as one scaled the wrong way.
    const secs = Number.parseInt(groups.secs ?? "0", 10);
    const cap = Number.parseInt(groups.capTicks ?? "0", 10);
    if (cap <= secs / 60) {
      throw new Error(
        `refresher cap ${cap} ticks is not above the command's own ${secs}s runtime (${secs / 60} ticks)`,
      );
    }
    // The completion callback, when present, must read back the SAME rc path
    // the main run just wrote — not a different one, and not a re-read of
    // `$?`. Only meaningful when the wrapper actually carries a callback
    // (`groups.cbRc` is `undefined` for the no-callback wrappers most tests
    // in this file build).
    if (groups.cbRc !== undefined && groups.cbRc !== groups.rc) {
      throw new Error(
        `completion callback reads ${groups.cbRc}, not the recorded rc path ${rcPath}`,
      );
    }
    // The C1 guard: acquire, refresh, and release must all target the SAME
    // hold id. Captured as three separate groups (not a `\k<name>`
    // backreference) precisely so a mismatch fails HERE, loudly and
    // specifically, instead of the regex simply refusing to match and the
    // wrapper falling through to `runScript`'s much less informative 127.
    if (groups.holdId !== groups.holdId2 || groups.holdId !== groups.holdId3) {
      throw new Error(
        `hold id mismatch across acquire/refresh/release: ${groups.holdId} / ${groups.holdId2} / ${groups.holdId3}`,
      );
    }

    if (cwd && !sprite.dirs.has(cwd)) {
      // `cd` failed, so the redirections never happened; only the rc file is
      // written, by the trailing `printf`.
      sprite.files.set(rcPath, ENCODER.encode("1"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (/^\s*sleep\b/.test(inner)) {
      if (this.pendingSessionId === undefined) {
        throw new Error("a long-running command must be launched through execDetached");
      }
      // `command` is the INNER argv, exactly as the live listing reports it —
      // the wrapper script, and therefore the process id, is NOT in it.
      sprite.sessions.set(this.pendingSessionId, { command: inner, killed: false });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const stdin =
      stdinPath === "/dev/null"
        ? ""
        : DECODER.decode(sprite.files.get(stdinPath) ?? new Uint8Array());
    const result = runInner(sprite, inner, stdin);
    sprite.files.set(outPath, ENCODER.encode(result.stdout));
    sprite.files.set(errPath, ENCODER.encode(result.stderr));
    sprite.files.set(rcPath, ENCODER.encode(String(result.exitCode)));
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  /** The tiny set of foreground scripts the backend's file ops generate. */
  private runScript(sprite: FakeSprite, script: string): SpritesExecResult {
    const tokens = tokenize(script);
    const [command] = tokens;
    if (command === "stat" && tokens[1] === "-c" && tokens[2] === "%F:%s" && tokens[3] === "--") {
      const path = tokens[4] ?? "";
      // No `-L`, so a link reports as ITSELF — checked before files/dirs.
      const linkSize = sprite.links.get(path);
      if (linkSize !== undefined) {
        return { exitCode: 0, stdout: `symbolic link:${linkSize}`, stderr: "" };
      }
      if (sprite.dirs.has(path)) return { exitCode: 0, stdout: "directory:4096", stderr: "" };
      const file = sprite.files.get(path);
      if (file) {
        return { exitCode: 0, stdout: `regular file:${file.byteLength}`, stderr: "" };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `stat: cannot statx '${path}': No such file or directory\n`,
      };
    }
    if (command === "mkdir" && tokens[1] === "-p" && tokens[2] === "--") {
      addDirs(sprite, tokens[3] ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "rm" && tokens[1] === "-rf" && tokens[2] === "--") {
      removeTree(sprite, tokens[3] ?? "");
      // `rm -rf` on an absent path still succeeds.
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "mv" && tokens[1] === "--") {
      const from = tokens[2] ?? "";
      const to = tokens[3] ?? "";
      const file = sprite.files.get(from);
      if (file === undefined) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `mv: cannot stat '${from}': No such file or directory\n`,
        };
      }
      sprite.files.delete(from);
      sprite.files.set(to, file);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Anything else is a plain foreground command (`runCommand` passes the
    // caller's command straight through), so it runs on the same inner
    // interpreter the wrapper uses — including its loud 127 for the unknown.
    const result = runInner(sprite, script, "");
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private alive(name: string): FakeSprite {
    const sprite = this.sprites.get(name);
    if (!sprite || sprite.deleted) {
      throw new ComputeError("runtime_missing", `sprites_missing: ${name}`);
    }
    return sprite;
  }
}

/**
 * A fresh backend wired to a fresh fake client, exposing both.
 *
 * `env` is the runtime environment the registry passes at construction — the
 * production path for workbench vars and the minted `GH_TOKEN`.
 */
export function createFakeSpritesBackend(env?: Record<string, string>): {
  backend: SpritesComputeBackend;
  client: FakeSpritesClient;
} {
  const client = new FakeSpritesClient();
  return {
    backend: new SpritesComputeBackend({ client, ...(env === undefined ? {} : { env }) }),
    client,
  };
}

/**
 * The wrapper shape `SpritesComputeBackend.startProcess` builds. `cmd` is greedy
 * so the LAST redirection triple anchors the match — a command containing `> `
 * therefore still parses.
 *
 * `SpritesComputeBackend.workHold` is unconditional (never `undefined`), so
 * every real wrapper carries the acquire/refresher/release apparatus around
 * the core `timeout ... ; printf ...` shape — there is no hold-less wrapper
 * to model here. The three `holdId*` groups are captured SEPARATELY (not via
 * a `\k<name>` backreference) so `runWrapper` can compare them explicitly and
 * throw a loud, specific error on a mismatch, the same way it already does
 * for `rctmp`/`rcmoved` — this is the fixture-side guard for exactly the C1
 * regression class (a release targeting a different hold id than the one the
 * wrapper acquired).
 *
 * The completion-callback block (`cbRc`/`cbTimeout`/`cbUrl`/`cbToken`/`cbBody`)
 * is OPTIONAL — most wrappers built in this file's tests carry no
 * `completionCallback` — and, when present, sits between the rc write and the
 * release curl, never after it: see `buildSpritesWrapper`'s ordering doc. It
 * is pinned to the EXACT shape `ThreadComputeService.buildCompletionCallback`
 * emits (curl flags, header order, JSON key order) rather than loosened to
 * "any curl call", per the same reasoning as every other fragment here — a
 * permissive pattern here would stop catching a real wrapper regression. That
 * includes the `{ ...; } >/dev/null 2>&1` GROUP around it: every fragment in a
 * detached session redirects, and the group (rather than a suffix) is what
 * makes the redirect cover a multi-segment fragment.
 *
 * The refresher's two orphan guards are pinned here too, `capTicks` captured so
 * `runWrapper` can check it against `secs`. Loosening this fragment would let a
 * wrapper whose refresher outlives its parent — ~24h of awake billing, measured;
 * see `buildSpritesWrapper`'s doc — parse cleanly.
 */
const WRAPPER_RE =
  /^cd (?<cwd>.+?) && curl -sf --unix-socket \/\.sprite\/api\.sock -H 'Content-Type: application\/json' -X POST http:\/\/sprite\/v1\/tasks -d '\{"name":"(?<holdId>[^"]+)","expire":"5m"\}' >\/dev\/null 2>&1 \|\| \{ printf %s 97 > (?<exit97tmp>\S+) && mv -f (?<exit97tmp2>\S+) (?<exit97rc>\S+); exit 97; \}; __nadi_parent="\$\$"; \( __nadi_ticks=0; while \[ ! -f (?<refresherRc>\S+) \]; do sleep 60; \[ -f (?<refresherRc2>\S+) \] && break; kill -0 "\$__nadi_parent" 2>\/dev\/null \|\| break; __nadi_ticks=\$\(\(__nadi_ticks\+1\)\); \[ "\$__nadi_ticks" -gt (?<capTicks>\d+) \] && break; curl -sf --unix-socket \/\.sprite\/api\.sock -H 'Content-Type: application\/json' -X PUT http:\/\/sprite\/v1\/tasks\/(?<holdId2>[^ ]+) -d '\{"expire":"5m"\}' >\/dev\/null 2>&1 \|\| true; done \) & timeout (?<secs>\d+) bash -c (?<cmd>.+) < (?<stdin>\S+) > (?<out>\S+) 2> (?<err>\S+); __nadi_rc="\$\?"; printf %s "\$__nadi_rc" > (?<rctmp>\S+) && mv -f (?<rcmoved>\S+) (?<rc>\S+)(?:; NADI_EXIT_CODE="\$\(cat (?<cbRc>\S+)\)"; \{ curl -sf -m (?<cbTimeout>\d+) -X POST (?<cbUrl>\S+) -H 'Authorization: Bearer (?<cbToken>[^']*)' -H 'Content-Type: application\/json' -d "(?<cbBody>\{\\"processId\\":\\"[^\\]*\\",\\"exitCode\\":\$NADI_EXIT_CODE\})" ; \} >\/dev\/null 2>&1)?; curl -sf --unix-socket \/\.sprite\/api\.sock -X DELETE http:\/\/sprite\/v1\/tasks\/(?<holdId3>[^ ]+) >\/dev\/null 2>&1; exit "\$__nadi_rc"$/;

interface InnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The inner-command interpreter. `&&` composition short-circuits; anything the
 * interpreter does not know exits 127, so a contract test that grows a new
 * command shape fails loudly here instead of being quietly absorbed.
 */
function runInner(sprite: FakeSprite, command: string, stdin: string): InnerResult {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const part of splitAnd(command)) {
    const step = runSingle(sprite, part.trim(), stdin);
    stdout += step.stdout;
    stderr += step.stderr;
    exitCode = step.exitCode;
    if (exitCode !== 0) break;
  }
  return { stdout, stderr, exitCode };
}

function runSingle(sprite: FakeSprite, command: string, stdin: string): InnerResult {
  const tokens = tokenize(command);
  const [head, ...rest] = tokens;
  if (head === undefined) return { stdout: "", stderr: "", exitCode: 0 };
  if (head === "true") return { stdout: "", stderr: "", exitCode: 0 };
  if (head === "false") return { stdout: "", stderr: "", exitCode: 1 };
  if (head === "echo") return { stdout: `${rest.join(" ")}\n`, stderr: "", exitCode: 0 };
  if (head === "printf") {
    const [format, ...args] = rest;
    const rendered =
      format === undefined
        ? ""
        : format === "%s"
          ? args.join("")
          : format.replace(/%s/g, () => args.shift() ?? "");
    return { stdout: rendered, stderr: "", exitCode: 0 };
  }
  if (head === "exit") {
    return { stdout: "", stderr: "", exitCode: Number.parseInt(rest[0] ?? "0", 10) || 0 };
  }
  if (head === "sh" && rest[0] === "-c" && rest[1] !== undefined) {
    return runInner(sprite, rest[1], stdin);
  }
  if (head === "cat") {
    if (rest.length === 0) return { stdout: stdin, stderr: "", exitCode: 0 };
    let stdout = "";
    for (const path of rest) {
      const file = sprite.files.get(path);
      if (file === undefined) {
        return {
          stdout,
          stderr: `cat: ${path}: No such file or directory\n`,
          exitCode: 1,
        };
      }
      stdout += DECODER.decode(file);
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: `bash: ${head}: command not found\n`, exitCode: 127 };
}

function notFound(script: string): SpritesExecResult {
  return { exitCode: 127, stdout: "", stderr: `bash: ${script}: command not found\n` };
}

/** Split on top-level `&&` (quotes are not crossed by the backend's commands). */
function splitAnd(command: string): string[] {
  return command.split(/\s&&\s/);
}

/** Split a script into argv, honouring the single-quoting `shellQuote` emits. */
function tokenize(script: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (quoted) {
      if (char === "'") {
        quoted = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'") {
      quoted = true;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    if (char === "\\" && script[index + 1] === "'") {
      current += "'";
      index += 1;
      started = true;
      continue;
    }
    current += char ?? "";
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Undo `shellQuote` for a single already-isolated token. */
function unquote(token: string): string {
  const tokens = tokenize(token);
  return tokens.length === 1 ? (tokens[0] ?? "") : tokens.join(" ");
}

function addDirs(sprite: FakeSprite, path: string): void {
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current += `/${segment}`;
    sprite.dirs.add(current);
  }
}

function removeTree(sprite: FakeSprite, path: string): void {
  sprite.files.delete(path);
  sprite.dirs.delete(path);
  const prefix = `${path}/`;
  // Snapshot before deleting: the loops mutate the very collections they read.
  const filePaths = [...sprite.files.keys()];
  const dirPaths = [...sprite.dirs];
  for (const key of filePaths) if (key.startsWith(prefix)) sprite.files.delete(key);
  for (const dir of dirPaths) if (dir.startsWith(prefix)) sprite.dirs.delete(dir);
}

function parentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
