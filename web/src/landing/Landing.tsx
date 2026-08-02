import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { GithubLogo } from "@/icons";
import {
  SETTINGS_PROVIDER_MODEL_PLACEHOLDERS,
  SETTINGS_PROVIDER_OPTIONS,
} from "@/settings-ui-config";
import { HeroThread } from "./HeroThread";
import { FEATURED_PROVIDER } from "./thread-script";

const GITHUB_URL = "https://github.com/ruqqq/nadi-oss";

// The featured provider leads the list; the rest keep their Settings order, so
// the page and the app never disagree about what's on offer. OpenAI OAuth is
// left out on purpose: it needs a ChatGPT OAuth token pasted in Settings, so a
// signed-out visitor can't have it and the page must not promise it.
const PROVIDERS = [...SETTINGS_PROVIDER_OPTIONS]
  .filter((option) => option.value !== "openai-oauth")
  .sort((a, b) => (a.label === FEATURED_PROVIDER ? -1 : b.label === FEATURED_PROVIDER ? 1 : 0));

/**
 * The public page at `/` for signed-out visitors. Everything on it is a claim
 * about Nadi's own scope — never about what another product does or doesn't do,
 * which is a claim that rots the moment someone ships a feature.
 */

type Capability = { key: string; body: string };

// A ledger, not a feature grid: these are things the *same thread* can reach, so
// each body says what it means for you rather than what it is. They are not a
// sequence, so they are not numbered.
const CAPABILITIES: Capability[] = [
  {
    key: "Sandbox",
    body: "A real machine of its own, per thread. It installs what it needs and runs your code, and there was never anything for you to set up.",
  },
  {
    key: "Watchers",
    body: "A six-minute build doesn't hold the conversation hostage. It watches the process and comes back when it exits.",
  },
  {
    key: "Subagents",
    body: "Big jobs split. Agents work in parallel on the same machine, and their findings land back in the one thread.",
  },
  {
    key: "Skills",
    body: "It writes its own instructions, and scripts it can run, then reaches for them next time. Every one is a file you can read, edit, or archive.",
  },
  {
    key: "Memory",
    body: "What it works out with you today, it still knows next month. Every entry is a file you can open and change.",
  },
  {
    key: "Automata",
    body: "Work you saved, running on a schedule without you, reporting back into the thread it learned it in.",
  },
  {
    key: "Web",
    body: "It searches, fetches, and keeps the page, then cites what it actually read rather than what it half-remembers.",
  },
  {
    key: "MCP",
    body: "Bring any MCP server. Every tool gets a policy: run it, ask me first, or never.",
  },
];

// Each service says what it does *for you*, not what it is. A stack list that
// only names products is a logo wall.
const CLOUDFLARE_STACK: Capability[] = [
  { key: "Workers", body: "The whole backend, running at the edge, with no server to keep warm." },
  { key: "Durable Objects", body: "One per thread: its own storage, its own memory of the run." },
  { key: "D1", body: "Your workspace, projects, schedules, and tool policies." },
  { key: "R2", body: "Attachments, and whatever the agent brings back out of the sandbox." },
  { key: "Containers", body: "The sandbox the agent actually runs your code in." },
  {
    key: "Workers AI",
    body: "Reads your images and documents, and can answer with no key at all.",
  },
];

export function Landing({
  onSignIn,
  signedIn = false,
}: {
  onSignIn: () => void;
  /** At /about an existing member can be reading this. Don't ask them to sign in again. */
  signedIn?: boolean;
}) {
  const cta = signedIn ? "Open Nadi" : "Sign in";
  return (
    <div className="min-h-dvh bg-background">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <BrandMark className="size-7 rounded-[7px]" />
          <span className="font-display font-semibold text-xl">nadi</span>
          <span className="rounded-full border border-border px-2 py-0.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
            Beta
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" asChild>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Nadi on GitHub"
              title="Nadi on GitHub"
            >
              <GithubLogo aria-hidden className="size-5" />
            </a>
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignIn}>
            {cta}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        {/* Hero — the thesis, then the thread that proves it. The thread runs long
            on purpose, so the thesis is pinned beside it while you read. */}
        <section className="grid items-start gap-10 py-12 lg:grid-cols-2 lg:gap-14 lg:py-20">
          {/* min-w-0: grid items default to min-width:auto, so the thread card's
              min-content width would otherwise stretch the track and scroll the
              whole page sideways on mobile. */}
          <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-16">
            <h1 className="text-balance font-display font-semibold text-4xl leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              One conversation. It does the whole job.
            </h1>
            <p className="max-w-prose text-lg text-muted-foreground leading-relaxed">
              The thread that reads your spreadsheet can run your code, remember what it found, and
              do it again every Monday. No second product to open, nothing to re-upload, no
              explaining yourself twice. On any model, on your own key.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={onSignIn}>
                {cta}
              </Button>
              {!signedIn && (
                <span className="text-muted-foreground text-sm">
                  Invite-only while it’s in beta.
                </span>
              )}
            </div>
          </div>

          <HeroThread />
        </section>

        {/* The cloud/local question, answered in one line. Normally you pick one. */}
        <section className="border-border border-t py-10">
          <div className="flex flex-col gap-2">
            <h2 className="max-w-prose font-display font-semibold text-2xl sm:text-3xl">
              It opens in a tab. It runs on a real machine.
            </h2>
            <p className="max-w-prose text-muted-foreground leading-relaxed">
              Nothing to install, nothing running on your laptop. The agent still gets an isolated
              box it can install into, build in, and keep working in after you close the lid.
            </p>
          </div>
        </section>

        {/* The ledger. */}
        <section className="border-border border-t py-14 lg:py-20">
          <h2 className="max-w-prose font-display font-semibold text-2xl sm:text-3xl">
            Everything in reach of the same thread.
          </h2>

          <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {CAPABILITIES.map((c) => (
              <div key={c.key} className="flex flex-col gap-1.5 border-border border-t pt-4">
                <dt className="font-medium font-mono text-primary text-xs uppercase tracking-widest">
                  {c.key}
                </dt>
                <dd className="text-muted-foreground text-sm leading-relaxed">{c.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Providers — no longer a list, an argument. The list is the evidence for
            it. Note what this section must never become: a claim about what the
            labs do to you. It is a claim about what Nadi doesn't make you bet. */}
        <section className="border-border border-t py-14 lg:py-20">
          <div className="flex flex-col gap-2">
            <h2 className="max-w-prose font-display font-semibold text-2xl sm:text-3xl">
              Your workspace outlives any model in it.
            </h2>
            <p className="max-w-prose text-muted-foreground leading-relaxed">
              Models get retired, repriced, and outclassed by next month’s. Your threads, the memory
              the agent built up, the skills it wrote: none of that leaves with them. Keys are
              yours, so you pay the provider directly and can change your mind mid-thread. Nine to
              choose from, or any endpoint you can name, and one that needs no key at all.
            </p>
          </div>

          <ul className="mt-10 grid gap-x-10 sm:grid-cols-2">
            {PROVIDERS.map((p) => {
              const featured = p.label === FEATURED_PROVIDER;
              return (
                <li
                  key={p.value}
                  className="flex min-w-0 items-baseline justify-between gap-4 border-border border-b py-3"
                >
                  <span className="flex min-w-0 items-baseline gap-2 text-sm">
                    <span className={featured ? "font-medium" : undefined}>{p.label}</span>
                    {featured && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium font-mono text-[10px] text-primary uppercase tracking-wide">
                        Preferred
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[p.value]}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Infrastructure — a badge that says what it's doing for you. */}
        <section className="border-border border-t py-14 lg:py-20">
          <div className="flex flex-col gap-2">
            <h2 className="max-w-prose font-display font-semibold text-2xl sm:text-3xl">
              It runs on Cloudflare.
            </h2>
            <p className="max-w-prose text-muted-foreground leading-relaxed">
              Not a badge. The whole thing: every thread is a Durable Object with its own storage,
              close to you at the edge, which is how the agent keeps its place while it works.
            </p>
          </div>

          <ul className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {CLOUDFLARE_STACK.map((s) => (
              <li key={s.key} className="flex min-w-0 flex-col gap-1 border-border border-t pt-4">
                <span className="font-medium font-mono text-primary text-xs uppercase tracking-widest">
                  {s.key}
                </span>
                <span className="text-muted-foreground text-sm leading-relaxed">{s.body}</span>
              </li>
            ))}
          </ul>

          <a
            href="https://workers.cloudflare.com/"
            target="_blank"
            rel="noreferrer noopener"
            className="mt-8 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest transition-colors hover:border-primary/50 hover:text-foreground"
          >
            Built with Cloudflare Workers
          </a>
        </section>

        {/* Close — the beta, stated plainly. */}
        <section className="border-border border-t py-14 lg:py-20">
          <div className="flex max-w-prose flex-col gap-5">
            <h2 className="font-display font-semibold text-2xl sm:text-3xl">Open a workspace.</h2>
            <p className="text-muted-foreground leading-relaxed">
              {signedIn
                ? "You already have one. Pick up wherever you left off."
                : "Nadi is in private beta, so it’s invite-only for now. Without an invite you can still enter your email, and we’ll add you to the waiting list and write when there’s room."}
            </p>
            <div>
              <Button size="lg" onClick={onSignIn}>
                {cta}
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
          <span className="font-display font-semibold text-muted-foreground">nadi</span>
          <span className="font-mono text-muted-foreground text-xs">Private beta</span>
        </div>
      </footer>
    </div>
  );
}
