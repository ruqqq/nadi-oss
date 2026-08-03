import type { ComponentType, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import {
  CalendarBlank,
  Cpu,
  Eye,
  GithubLogo,
  Globe,
  Notebook,
  PlugsConnected,
  Robot,
  Toolbox,
} from "@/icons";
import { cn } from "@/lib/utils";
import {
  SETTINGS_PROVIDER_MODEL_PLACEHOLDERS,
  SETTINGS_PROVIDER_OPTIONS,
} from "@/settings-ui-config";
import { HeroThread } from "./HeroThread";
import { Reveal } from "./Reveal";
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
 *
 * The page opens with the same three lines as the link-unfurl card
 * (preview.html?screen=og), in the same order and the same type treatment, so
 * whoever clicks the card lands on the sentence they clicked.
 */

/** An outbound link inside body copy. A function declaration, so it is hoisted
 *  above the module-level CAPABILITIES array that renders it. */
function LandingLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-primary"
    >
      {children}
    </a>
  );
}

type Entry = {
  key: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  body: ReactNode;
  /** Wide tiles carry the claims a cold visitor is least likely to believe. */
  wide?: boolean;
  /** Tinted tiles keep the grid from reading as one flat sheet of text. */
  tinted?: boolean;
};

// A ledger, not a feature grid: these are things the *same conversation* can
// reach, so each body says what it means for you rather than what it is. The
// tiles are deliberately uneven — a coworker is not eight equal bullet points,
// and the two that carry the most weight get the most room.
const CAPABILITIES: Entry[] = [
  {
    key: "Sandbox",
    icon: Cpu,
    wide: true,
    tinted: true,
    body: "A real machine of its own, per thread. It installs what it needs and runs your code, and there was never anything for you to set up.",
  },
  {
    key: "Watchers",
    icon: Eye,
    body: "A six-minute build doesn't hold the conversation hostage. It watches the process and comes back when it exits.",
  },
  {
    key: "Subagents",
    icon: Robot,
    body: "Big jobs split. Agents work in parallel on the same machine, and their findings land back in the one thread.",
  },
  {
    key: "Skills",
    icon: Toolbox,
    body: "It writes its own instructions, and scripts it can run, then reaches for them next time. Every one is a file you can read, edit, or archive.",
  },
  {
    key: "Memory",
    icon: Notebook,
    body: "What it works out with you today, it still knows next month. Every entry is a file you can open and change.",
  },
  {
    key: "Automata",
    icon: CalendarBlank,
    wide: true,
    tinted: true,
    body: "Work you saved, running on a schedule without you, reporting back into the thread it learned it in.",
  },
  {
    key: "Web",
    icon: Globe,
    wide: true,
    body: "It searches, fetches, and keeps the page, then cites what it actually read rather than what it half-remembers.",
  },
  {
    key: "MCP",
    icon: PlugsConnected,
    wide: true,
    body: (
      <>
        Bring any MCP server: <LandingLink href="https://composio.dev/">Composio</LandingLink> for a
        thousand-odd SaaS integrations,{" "}
        <LandingLink href="https://markdump.com">Markdump</LandingLink> for notes it reads and writes
        like a second brain. Every tool gets a policy: run it, ask me first, or never.
      </>
    ),
  },
];

// Each service says what it does *for you*, not what it is. A stack list that
// only names products is a logo wall.
const CLOUDFLARE_STACK: Entry[] = [
  {
    key: "Workers",
    icon: Cpu,
    body: "The whole backend, running at the edge, with no server to keep warm.",
  },
  {
    key: "Durable Objects",
    icon: Notebook,
    body: "One per thread: its own storage, its own memory of the run.",
  },
  { key: "D1", icon: Toolbox, body: "Your workspace, projects, schedules, and tool policies." },
  { key: "R2", icon: Globe, body: "Attachments, and whatever it brings back out of the sandbox." },
  { key: "Containers", icon: Robot, body: "The sandbox it actually runs your code in." },
  {
    key: "Workers AI",
    icon: Eye,
    body: "Reads your images and documents, and can answer with no key at all.",
  },
];

/** The hero headline, set the way the card sets it: a quiet line, then the noun.
 *  Both lines are `nowrap` because the break is authored, not measured. */
function HeroHeadline() {
  const reduce = useReducedMotion();
  const rise = (delay: number) =>
    ({
      initial: reduce ? false : { opacity: 0, y: 24 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] },
    }) as const;
  return (
    <h1 className="font-display font-semibold leading-[0.95] tracking-tight">
      <motion.span
        {...rise(0.05)}
        className="block whitespace-nowrap text-[clamp(2rem,5.5vw,3.25rem)] text-muted-foreground"
      >
        Your AI
      </motion.span>
      {/* Caps take tracking-normal: tracking-tight is tuned for lowercase and
          crowds them badly at this size. */}
      <motion.span
        {...rise(0.12)}
        className="block whitespace-nowrap text-[clamp(2.5rem,10vw,10rem)] uppercase tracking-normal"
      >
        coworker.
      </motion.span>
    </h1>
  );
}

export function Landing({
  onSignIn,
  signedIn = false,
}: {
  onSignIn: () => void;
  /** At /about an existing member can be reading this. Don't ask them to sign in again. */
  signedIn?: boolean;
}) {
  const reduce = useReducedMotion();
  const cta = signedIn ? "Open Nadi" : "Sign in";
  const enter = (delay: number) =>
    ({
      initial: reduce ? false : { opacity: 0, y: 16 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] },
    }) as const;

  return (
    <div className="min-h-dvh bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
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

      <main>
        {/* 1. Hero — the card's words, then the thread that proves them. The
            columns are uneven on purpose: a 50/50 split would shrink the noun to
            the width of the demo beside it. */}
        <section className="mx-auto grid max-w-6xl items-start gap-x-10 gap-y-8 px-6 pt-6 pb-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-x-14 lg:pt-10 lg:pb-24">
          {/* The headline spans both tracks. Set inside a column it would have to
              shrink to the width of the demo beside it, and the noun is the whole
              point of the composition. */}
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            <motion.p
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]"
            >
              On any model, on your own key
            </motion.p>
            <HeroHeadline />
          </div>

          {/* min-w-0: grid items default to min-width:auto, so the thread card's
              min-content width would otherwise stretch the track and scroll the
              whole page sideways on mobile. */}
          <div className="flex min-w-0 flex-col gap-7 lg:sticky lg:top-16">
            <motion.p
              {...enter(0.2)}
              className="max-w-prose text-lg text-muted-foreground leading-relaxed"
            >
              Delegate the work, schedule it to repeat. It learns from every conversation.
            </motion.p>

            <motion.div {...enter(0.28)} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button size="lg" onClick={onSignIn} className="active:translate-y-px">
                {cta}
              </Button>
              {!signedIn && (
                <span className="text-muted-foreground text-sm">
                  Invite-only while it’s in beta.
                </span>
              )}
            </motion.div>
          </div>

          <HeroThread />
        </section>

        {/* 2. The cloud/local question, answered in one line. The only claim on
            the page that gets a surface of its own, which is what marks it as
            the turn in the argument. */}
        <section className="border-border border-y bg-card/60">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
            <Reveal>
              <div className="flex max-w-3xl flex-col gap-4">
                <h2 className="font-display font-semibold text-3xl leading-tight sm:text-4xl">
                  It opens in a tab. It runs on a real machine.
                </h2>
                <p className="text-lg text-muted-foreground leading-relaxed">
                  Nothing to install, nothing running on your laptop. Your coworker still gets an
                  isolated box it can install into, build in, and keep working in after you close
                  the lid.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 3. The ledger, as an uneven grid. Exactly one tile per capability; the
            wide/tinted flags live with the content above, so adding an entry
            can't leave a hole in the grid. */}
        <section className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
          <Reveal>
            <h2 className="max-w-2xl font-display font-semibold text-3xl leading-tight sm:text-4xl">
              Everything in reach of one conversation.
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map((c, i) => {
              const Icon = c.icon;
              return (
                <Reveal
                  key={c.key}
                  delay={Math.min(i, 4) * 0.05}
                  className={c.wide ? "lg:col-span-2" : undefined}
                >
                  <div
                    className={cn(
                      "flex h-full flex-col gap-3 rounded-xl border border-border p-5",
                      c.tinted ? "bg-primary/5" : "bg-card/40",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon aria-hidden className="size-4 text-primary" />
                      <h3 className="font-medium font-mono text-primary text-xs uppercase tracking-widest">
                        {c.key}
                      </h3>
                    </div>
                    <p className="text-muted-foreground text-sm leading-relaxed">{c.body}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* 4. Providers — not a list, an argument, with the list as its evidence.
            Nine bordered rows would read as a spec table, so the evidence is a
            set of chips you scan rather than rows you read. What this section
            must never become: a claim about what the labs do to you. */}
        <section className="border-border border-t">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
            <Reveal>
              <div className="flex max-w-3xl flex-col gap-4">
                <h2 className="font-display font-semibold text-3xl leading-tight sm:text-4xl">
                  Your workspace outlives any model in it.
                </h2>
                <p className="text-lg text-muted-foreground leading-relaxed">
                  Models get retired, repriced, and outclassed by next month’s. Your threads, the
                  memory it built up, the skills it wrote: none of that leaves with them. Keys are
                  yours, so you pay the provider directly and can change your mind mid-thread. Nine
                  to choose from, or any endpoint you can name, and one that needs no key at all.
                </p>
              </div>
            </Reveal>

            <ul className="mt-10 flex flex-wrap gap-2">
              {PROVIDERS.map((p, i) => {
                const featured = p.label === FEATURED_PROVIDER;
                return (
                  <Reveal key={p.value} delay={Math.min(i, 6) * 0.04}>
                    <li
                      className={cn(
                        "flex items-baseline gap-2 rounded-full border px-3.5 py-1.5",
                        featured ? "border-primary/40 bg-primary/10" : "border-border bg-card/40",
                      )}
                    >
                      <span className={cn("text-sm", featured && "font-medium text-primary")}>
                        {p.label}
                      </span>
                      <span className="font-mono text-muted-foreground text-xs">
                        {SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[p.value]}
                      </span>
                    </li>
                  </Reveal>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 5. Infrastructure, as a split: the claim holds the left column while
            the stack moves past it. A different shape from the ledger on
            purpose — two grids in a row would read as one long section. */}
        <section className="border-border border-t">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:py-24">
            <Reveal className="lg:sticky lg:top-24 lg:self-start">
              <div className="flex flex-col gap-4">
                <h2 className="font-display font-semibold text-3xl leading-tight sm:text-4xl">
                  It runs on Cloudflare.
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Not a badge. The whole thing: every thread is a Durable Object with its own
                  storage, close to you at the edge, which is how your coworker keeps its place
                  while it works.
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  It is also open source, Apache-2.0, so this is not the only place it can run.
                  Point a Cloudflare account of your own at it and the same thing is yours: the
                  code, the threads, the keys.
                </p>
                <a
                  href="https://workers.cloudflare.com/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  Built with Cloudflare Workers
                </a>
              </div>
            </Reveal>

            <ul className="flex flex-col">
              {CLOUDFLARE_STACK.map((s, i) => {
                const Icon = s.icon;
                return (
                  <Reveal key={s.key} delay={Math.min(i, 5) * 0.05}>
                    <li className="flex items-start gap-4 border-border border-b py-5">
                      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="font-medium font-mono text-primary text-xs uppercase tracking-widest">
                          {s.key}
                        </span>
                        <span className="text-muted-foreground text-sm leading-relaxed">
                          {s.body}
                        </span>
                      </div>
                    </li>
                  </Reveal>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 6. Close — the beta, stated plainly. */}
        <section className="border-border border-t bg-card/60">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
            <Reveal>
              <div className="flex max-w-2xl flex-col gap-5">
                <h2 className="font-display font-semibold text-3xl leading-tight sm:text-4xl">
                  Open a workspace.
                </h2>
                <p className="text-lg text-muted-foreground leading-relaxed">
                  {signedIn
                    ? "You already have one. Pick up wherever you left off."
                    : "Nadi is in private beta, so it’s invite-only for now. Without an invite you can still enter your email, and we’ll add you to the waiting list and write when there’s room."}
                </p>
                <div>
                  <Button size="lg" onClick={onSignIn} className="active:translate-y-px">
                    {cta}
                  </Button>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <span className="font-display font-semibold text-muted-foreground">nadi</span>
          <span className="font-mono text-muted-foreground text-xs">Private beta</span>
        </div>
      </footer>
    </div>
  );
}
