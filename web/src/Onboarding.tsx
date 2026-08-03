import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { OfflineBanner } from "./components/OfflineBanner";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { ModelCombobox } from "./components/settings/ModelCombobox";
import { EmpowerStep } from "./components/onboarding/EmpowerStep";
import { InstallStep } from "./components/onboarding/InstallStep";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Spinner } from "./components/ui/spinner";
import { Textarea } from "./components/ui/textarea";
import { Globe, Key } from "./icons";
import { armAutomatonNudge } from "./lib/automaton-nudge";
import type { FeaturedConnectionId } from "./lib/featured-connections";
import { cn } from "./lib/utils";
import {
  RECOMMENDED_ONBOARDING_PROVIDER,
  isKeylessOnboardingProvider,
  onboardingProviderOptions,
  onboardingStepPath,
  parseOnboardingStep,
  resolveOnboardingStep,
  visibleOnboardingSteps,
} from "./lib/onboarding";
import type { OnboardingStepDef, OnboardingStepId } from "./lib/onboarding";
import { track } from "./lib/posthog";
import {
  type AgentSettingsResponse,
  type ModelInputModality,
  type ProviderEndpointConfig,
  type SettingsProvider,
  buildDefaultAgentSettingsSaveInput,
  getWebToolsSettings,
  saveDefaultAgentSettings,
  saveExaSecret,
  saveProviderConfig,
  saveProviderSecret,
  verifyExaSecret,
  verifyProviderSecret,
} from "./settings-api";

/** Where a user with no account at all goes to get one. */
const PROVIDER_SIGN_UP: Partial<Record<SettingsProvider, { url: string; label: string }>> = {
  "opencode-go": { url: "https://opencode.ai/go", label: "Create an OpenCode account" },
  "opencode-zen": { url: "https://opencode.ai/zen", label: "Create an OpenCode Zen account" },
};

const EXA_SIGN_UP = "https://dashboard.exa.ai/api-keys";

const PROVIDER_KEY_DOCS: Record<string, { url: string; hint: string }> = {
  openai: { url: "https://platform.openai.com/api-keys", hint: "Starts with sk-…" },
  anthropic: { url: "https://console.anthropic.com/settings/keys", hint: "Starts with sk-ant-…" },
  openrouter: { url: "https://openrouter.ai/keys", hint: "Starts with sk-or-…" },
  deepseek: { url: "https://platform.deepseek.com/api_keys", hint: "DeepSeek API key" },
  zai: { url: "https://z.ai/model-api", hint: "Z.AI API key" },
  qwen: { url: "https://modelstudio.console.alibabacloud.com", hint: "DashScope API key" },
  "opencode-go": { url: "https://opencode.ai/go", hint: "OpenCode Go API key" },
  "opencode-zen": { url: "https://opencode.ai/zen", hint: "OpenCode Zen API key" },
  "openai-compatible": { url: "", hint: "Bearer token, if required" },
};

const DEFAULT_ONBOARDING_MODELS: Record<SettingsProvider, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
  openrouter: "openai/gpt-5.4-mini",
  "openai-oauth": "gpt-5.4-mini",
  "workers-ai": "@cf/moonshotai/kimi-k2.7-code",
  deepseek: "deepseek-v4-pro",
  zai: "glm-5.2",
  qwen: "qwen-plus",
  "opencode-go": "deepseek-v4-flash",
  "opencode-zen": "deepseek-v4-pro",
  "openai-compatible": "model-id",
};

const DEFAULT_ONBOARDING_BASE_URLS: Partial<Record<SettingsProvider, string>> = {
  deepseek: "https://api.deepseek.com",
  zai: "https://api.z.ai/api/paas/v4",
  qwen: "",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  "openai-compatible": "",
};

function statusFromError(err: unknown): string | null {
  return err instanceof Error ? (err.message.match(/\((\d+)\)/)?.[1] ?? null) : null;
}

function isOnboardingProvider(
  provider: string,
  options: { value: SettingsProvider }[],
): provider is SettingsProvider {
  return options.some((option) => option.value === provider);
}

function isCompatibleOnboardingProvider(provider: SettingsProvider): boolean {
  return (
    provider === "deepseek" ||
    provider === "zai" ||
    provider === "qwen" ||
    provider === "opencode-go" ||
    provider === "opencode-zen" ||
    provider === "openai-compatible"
  );
}

/**
 * First-run setup for a brand-new user with no provider key and no threads.
 * Step 1 connects one model provider (API key); step 2 confirms the default
 * assistant. On completion the user drops into the normal chat experience.
 */
export function Onboarding({
  user,
  settings,
  workersAiEnabled = false,
  initialStep,
  installed = false,
  onComplete,
}: {
  user: { email?: string };
  settings: AgentSettingsResponse;
  workersAiEnabled?: boolean;
  /** Resume target when returning from an MCP OAuth redirect. */
  initialStep?: OnboardingStepId;
  /** Hides the install step for a user already running the installed PWA. */
  installed?: boolean;
  onComplete: () => void;
}) {
  const steps = useMemo(() => visibleOnboardingSteps({ installed }), [installed]);
  const [step, setStep] = useState<OnboardingStepId>(() =>
    resolveOnboardingStep(initialStep, steps),
  );
  const providerOptions = useMemo(
    () => onboardingProviderOptions({ workersAi: workersAiEnabled }),
    [workersAiEnabled],
  );
  // Replays (?onboarding=force) start from what the workspace already has, so
  // nothing gets silently overwritten. A fresh user has none of this and falls
  // back to the first option and its product defaults.
  const initialProvider = isOnboardingProvider(settings.agent.provider, providerOptions)
    ? settings.agent.provider
    : (providerOptions[0]?.value ?? "openai");
  const initialEndpoint = settings.providers.find(
    (p) => p.provider === initialProvider,
  )?.endpointConfig;

  // Step 1 — provider key
  const [provider, setProvider] = useState<SettingsProvider>(initialProvider);
  const [baseUrl, setBaseUrl] = useState(
    initialEndpoint?.baseUrl || (DEFAULT_ONBOARDING_BASE_URLS[initialProvider] ?? ""),
  );
  const [auth, setAuth] = useState<"bearer" | "none">(initialEndpoint?.auth ?? "bearer");
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Step 2 — default assistant
  const [systemPrompt, setSystemPrompt] = useState(settings.agent.systemPrompt);
  const [modelEdited, setModelEdited] = useState(false);
  const [model, setModel] = useState(
    settings.agent.model || DEFAULT_ONBOARDING_MODELS[initialProvider],
  );
  const [modelInputModalities, setModelInputModalities] = useState<ModelInputModality[]>(
    settings.agent.modelInputModalities?.length ? settings.agent.modelInputModalities : ["text"],
  );
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Step 3 — web search (optional)
  const [exaKey, setExaKey] = useState("");
  const [savingExa, setSavingExa] = useState(false);
  const [exaError, setExaError] = useState<string | null>(null);
  const [exaAlreadySet, setExaAlreadySet] = useState(false);

  // Empower step — the connections that resolved as AUTHORIZED, so completion
  // can seed a nudge that never asks for data the agent can't get. A server row
  // is not enough: consent can be denied, abandoned, or fail after the row
  // exists.
  const [connectedIds, setConnectedIds] = useState<FeaturedConnectionId[]>([]);
  // Whether a calendar-named tool actually resolved on an authorized
  // connection. Composio finishing OAuth is not the same as a calendar
  // account being attached inside it, so this is derived from resolved tool
  // names, never from which connections are authorized.
  const [calendarConnected, setCalendarConnected] = useState(false);

  // Only reached once the required steps are done, so load the current state
  // lazily rather than paying for it on every onboarding mount.
  useEffect(() => {
    if (step !== "empower") return;
    let cancelled = false;
    getWebToolsSettings()
      .then((settings) => {
        if (!cancelled) setExaAlreadySet(settings.exaSecretPresent);
      })
      .catch(() => {
        // A failed read just means we offer the input; saving still works.
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // The wizard lives at "/", so only the query changes between steps — App's own
  // path state never moves and cannot drive this. The wizard owns its own history.
  useEffect(() => {
    // Base entry, so the FIRST step is a real history entry to come back to.
    window.history.replaceState(null, "", onboardingStepPath(step));
    // Intentionally mount-only: later steps push (see `goToStep`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // How many entries this wizard has pushed and not yet popped. `history.back()`
  // is only ours to call while this is above zero — a tab opened straight at
  // `?step=assistant` has no wizard entry behind it (the mount effect REPLACED
  // that one), so an unguarded back would leave the app entirely.
  const pushDepthRef = useRef(0);

  useEffect(() => {
    const onPop = () => {
      const next = parseOnboardingStep(window.location.search);
      // A back that leaves the wizard's own entries (no step param) is not ours
      // to handle — App's router owns that navigation.
      if (!next) return;
      pushDepthRef.current = Math.max(0, pushDepthRef.current - 1);
      setStep(resolveOnboardingStep(next, steps));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [steps]);

  /** Forward navigation pushes, so back returns to the previous step. */
  const goToStep = useCallback((next: OnboardingStepId) => {
    window.history.pushState(null, "", onboardingStepPath(next));
    pushDepthRef.current += 1;
    setStep(next);
  }, []);

  /** Back within the wizard, without ever escaping the app. */
  const goBack = useCallback(
    (fallback: OnboardingStepId) => {
      if (pushDepthRef.current > 0) window.history.back();
      else goToStep(fallback);
    },
    [goToStep],
  );

  /** Move to the next visible step, or finish if this was the last one. */
  const advance = useCallback(() => {
    const index = steps.findIndex((s) => s.id === step);
    const next = steps[index + 1];
    if (next) goToStep(next.id);
    else {
      armAutomatonNudge(localStorage, { calendarConnected });
      onComplete();
    }
  }, [steps, step, goToStep, onComplete, calendarConnected]);

  const secretName = useMemo(
    () => settings.providers.find((p) => p.provider === provider)?.configuredSecretName,
    [provider, settings.providers],
  );
  const docs = PROVIDER_KEY_DOCS[provider];
  const signUp = PROVIDER_SIGN_UP[provider];

  // The key itself is write-only, so a replay can't prefill it — but it can let
  // the saved one stand. Leaving the field blank keeps it; typing replaces it.
  const savedKeyPresent =
    settings.providers.find((p) => p.provider === provider)?.secretPresent ?? false;
  const keepSavedKey = savedKeyPresent && apiKey.trim().length === 0;

  const keyless = isKeylessOnboardingProvider(provider);

  const submitKey = async (event: FormEvent) => {
    event.preventDefault();
    if (savingKey) return;
    // Workers AI authenticates via the Worker's own binding — there is no key to
    // verify and no secret to store, so step 1 is just the choice itself.
    if (keyless) {
      track("settings_saved", { source: "onboarding", provider });
      setKeyError(null);
      goToStep("assistant");
      return;
    }
    const endpointConfig: ProviderEndpointConfig | undefined = isCompatibleOnboardingProvider(
      provider,
    )
      ? // Onboarding never sets a proxy route — that lives in Settings.
        { baseUrl: baseUrl.trim(), proxyUrl: "", auth, body: {} }
      : undefined;
    if ((provider === "qwen" || provider === "openai-compatible") && !baseUrl.trim()) {
      setKeyError("Enter the provider base URL.");
      return;
    }
    if (auth === "bearer" && apiKey.trim().length === 0 && !savedKeyPresent) {
      setKeyError("Enter an API key.");
      return;
    }
    setSavingKey(true);
    setKeyError(null);
    const key = apiKey.trim();
    try {
      if (endpointConfig) {
        await saveProviderConfig(provider, endpointConfig);
      }

      // Nothing to verify or save — the stored key stays as it is.
      if (keepSavedKey) {
        goToStep("assistant");
        return;
      }
      // Verify the key with the provider first. Only a definitive rejection
      // blocks; if the provider is unreachable we still save (soft-allow) so an
      // outage never traps setup.
      let reason: "valid" | "invalid" | "unreachable" = "unreachable";
      if (!(provider === "openai-compatible" && auth === "none")) {
        try {
          reason = (
            await verifyProviderSecret(provider, {
              value: key,
              ...(endpointConfig ? { endpointConfig } : {}),
            })
          ).reason;
        } catch {
          reason = "unreachable";
        }
      } else {
        reason = "valid";
      }
      if (reason === "invalid") {
        setKeyError(
          `That key was rejected by ${formatProviderLabel(provider)}. Check it and try again.`,
        );
        return;
      }

      if (!(provider === "openai-compatible" && auth === "none")) {
        await saveProviderSecret(provider, { value: key, secretName });
      }
      track("settings_saved", { source: "onboarding", provider });
      if (reason === "unreachable") {
        toast("Key saved — we couldn't verify it just now.");
      }
      setApiKey("");
      goToStep("assistant");
    } catch (err) {
      setKeyError(
        statusFromError(err) === "400"
          ? "That key doesn't look right. Check it and try again."
          : "Could not save the key. Try again in a moment.",
      );
    } finally {
      setSavingKey(false);
    }
  };

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (savingAgent || systemPrompt.trim().length === 0 || model.trim().length === 0) return;
    setSavingAgent(true);
    setAgentError(null);
    try {
      await saveDefaultAgentSettings(
        buildDefaultAgentSettingsSaveInput({
          systemPrompt,
          model,
          modelInputModalities,
          currentProvider: settings.agent.provider,
          reasoningEffort: settings.agent.reasoningEffort,
          selectedProvider: provider,
          providerChanged: true,
          showReasoning: settings.agent.showReasoning,
        }),
      );
      track("settings_saved", { source: "onboarding", provider, model });
      goToStep("empower");
    } catch (err) {
      setAgentError(
        statusFromError(err) === "400"
          ? "Check the model name and instructions."
          : "Could not save. Try again in a moment.",
      );
    } finally {
      setSavingAgent(false);
    }
  };

  const skipWebSearch = () => {
    if (savingExa) return;
    // Skipping with a key already stored keeps it — don't imply otherwise.
    if (!exaAlreadySet) toast("You can add a web search key anytime in Settings → Tools.");
    advance();
  };

  const submitWebSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (savingExa) return;
    const key = exaKey.trim();
    if (key.length === 0) {
      setExaError("Enter an Exa API key.");
      return;
    }
    setSavingExa(true);
    setExaError(null);
    try {
      // Same soft-allow contract as the provider key: only a definitive
      // rejection blocks, so an Exa outage never traps setup.
      let reason: "valid" | "invalid" | "unreachable" = "unreachable";
      try {
        reason = (await verifyExaSecret(key)).reason;
      } catch {
        reason = "unreachable";
      }
      if (reason === "invalid") {
        setExaError("That key was rejected by Exa. Check it and try again.");
        return;
      }

      await saveExaSecret(key);
      track("settings_saved", { source: "onboarding", provider, webSearch: true });
      setExaKey("");
      toast.success(
        reason === "unreachable"
          ? "Key saved — we couldn't verify it just now."
          : "Web search enabled",
      );
      advance();
    } catch (err) {
      setExaError(
        statusFromError(err) === "400"
          ? "That key doesn't look right. Check it and try again."
          : "Could not save the key. Try again in a moment.",
      );
    } finally {
      setSavingExa(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        <span className="font-display font-semibold text-lg leading-none">nadi</span>
        <span className="text-muted-foreground" aria-hidden="true">
          /
        </span>
        <span className="text-muted-foreground text-sm">setup</span>
      </header>

      <OfflineBanner />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl p-4 md:p-6">
          {step === "provider" && (
            <div className="mb-6 space-y-1">
              <h1 className="font-display font-semibold text-2xl">Welcome to Nadi</h1>
              <p className="text-muted-foreground text-sm">
                {user.email ? `Signed in as ${user.email}. ` : ""}
                Let's connect a model provider so your assistant can run — it takes about a minute.
              </p>
            </div>
          )}

          <StepIndicator steps={steps} step={step} />

          {step === "provider" ? (
            <Card className="mt-4 p-4">
              <form className="space-y-4" onSubmit={submitKey}>
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {providerOptions.map((option) => {
                      const active = option.value === provider;
                      return (
                        <Button
                          key={option.value}
                          type="button"
                          variant={active ? "default" : "outline"}
                          aria-pressed={active}
                          disabled={savingKey}
                          onClick={() => {
                            const saved = settings.providers.find(
                              (p) => p.provider === option.value,
                            )?.endpointConfig;
                            setProvider(option.value);
                            setBaseUrl(
                              saved?.baseUrl || (DEFAULT_ONBOARDING_BASE_URLS[option.value] ?? ""),
                            );
                            setAuth(saved?.auth ?? "bearer");
                            if (!modelEdited) {
                              setModel(DEFAULT_ONBOARDING_MODELS[option.value]);
                              setModelInputModalities(["text"]);
                            }
                            setKeyError(null);
                          }}
                          className="h-auto min-h-10 flex-col gap-0.5 whitespace-normal px-2 text-center text-xs sm:text-sm"
                        >
                          {option.label}
                          {option.value === RECOMMENDED_ONBOARDING_PROVIDER && (
                            <span
                              className={cn(
                                "font-medium text-[10px] uppercase tracking-wide",
                                active ? "text-primary-foreground/80" : "text-primary",
                              )}
                            >
                              Recommended
                            </span>
                          )}
                        </Button>
                      );
                    })}
                  </div>

                  {/* A key field is useless to someone with no account. Send them
                      straight to sign-up rather than making them go find it. */}
                  {signUp && !savedKeyPresent && (
                    <p className="text-muted-foreground text-xs">
                      Don’t have an account?{" "}
                      <a
                        href={signUp.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-primary underline underline-offset-2"
                      >
                        {signUp.label}
                      </a>{" "}
                      — it takes a minute, then paste the key below.
                    </p>
                  )}
                </div>

                {isCompatibleOnboardingProvider(provider) && (
                  <div className="space-y-1.5">
                    <Label htmlFor="onboarding-base-url">Base URL</Label>
                    <Input
                      id="onboarding-base-url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={
                        provider === "qwen"
                          ? "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
                          : DEFAULT_ONBOARDING_BASE_URLS[provider]
                      }
                      disabled={savingKey}
                    />
                  </div>
                )}

                {provider === "openai-compatible" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="onboarding-auth">Auth</Label>
                    <Select
                      value={auth}
                      onValueChange={(value) => setAuth(value as "bearer" | "none")}
                    >
                      <SelectTrigger id="onboarding-auth">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bearer">Bearer key</SelectItem>
                        <SelectItem value="none">No auth</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {keyless && (
                  <p className="text-muted-foreground text-sm">
                    No API key needed — Workers AI runs on Cloudflare's network, billed to Nadi.
                    Pick it and you're straight into chat.
                  </p>
                )}

                {!keyless && !(provider === "openai-compatible" && auth === "none") && (
                  <div className="space-y-1.5">
                    <Label htmlFor="onboarding-api-key">API key</Label>
                    <Input
                      id="onboarding-api-key"
                      type="password"
                      autoComplete="off"
                      autoFocus
                      placeholder={docs?.hint}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      disabled={savingKey}
                    />
                    <p className="text-muted-foreground text-xs">
                      {savedKeyPresent
                        ? "A key is already saved for this provider. Leave this blank to keep it."
                        : "Stored encrypted for your workspace and never shown again."}{" "}
                      {docs?.url ? (
                        <a
                          href={docs.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          Where do I find it?
                        </a>
                      ) : null}
                    </p>
                  </div>
                )}

                {keyError !== null && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{keyError}</AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    savingKey ||
                    (!keyless &&
                      ((auth === "bearer" && apiKey.trim().length === 0 && !savedKeyPresent) ||
                        ((provider === "qwen" || provider === "openai-compatible") &&
                          baseUrl.trim().length === 0)))
                  }
                  aria-busy={savingKey}
                >
                  {savingKey ? <Spinner label="Saving key" /> : <Key aria-hidden />}
                  {keyless
                    ? "Continue"
                    : keepSavedKey
                      ? "Continue with saved key"
                      : "Connect provider"}
                </Button>
              </form>
            </Card>
          ) : step === "assistant" ? (
            <Card className="mt-4 p-4">
              <form className="space-y-4" onSubmit={submitAgent}>
                <div className="space-y-1.5">
                  <Label htmlFor="onboarding-system-prompt">Assistant instructions</Label>
                  <Textarea
                    id="onboarding-system-prompt"
                    className="min-h-40 resize-y"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    disabled={savingAgent}
                  />
                  <p className="text-muted-foreground text-xs">
                    This shapes how your assistant responds. You can change it anytime in Settings.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="onboarding-model">Model</Label>
                  <ModelCombobox
                    inputId="onboarding-model"
                    provider={provider}
                    value={model}
                    onChange={(next) => {
                      setModel(next);
                      setModelEdited(true);
                      setModelInputModalities(["text"]);
                    }}
                    onModelSelected={(selectedModel) =>
                      setModelInputModalities(selectedModel.inputModalities)
                    }
                    placeholder={DEFAULT_ONBOARDING_MODELS[provider]}
                    disabled={savingAgent}
                  />
                  <p className="text-muted-foreground text-xs">
                    A model ID available on {formatProviderLabel(provider)}.
                  </p>
                </div>

                {agentError !== null && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{agentError}</AlertDescription>
                  </Alert>
                )}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setAgentError(null);
                      goBack("provider");
                    }}
                    disabled={savingAgent}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={
                      savingAgent || systemPrompt.trim().length === 0 || model.trim().length === 0
                    }
                    aria-busy={savingAgent}
                  >
                    {savingAgent ? <Spinner label="Saving your assistant" /> : null}
                    Continue
                  </Button>
                </div>
              </form>
            </Card>
          ) : step === "empower" ? (
            <EmpowerStep
              onConnectedChange={setConnectedIds}
              onCalendarConnectedChange={setCalendarConnected}
              exaCard={
                <Card className="gap-3 p-4">
                  <form className="space-y-4" onSubmit={submitWebSearch}>
                    <div className="space-y-1">
                      <h2 className="font-display font-semibold text-lg">
                        Let Nadi search the web
                      </h2>
                      <p className="text-muted-foreground text-sm">
                        With an Exa key, Nadi can search the web and cite what it finds. Without
                        one, it can still read pages you link to.
                      </p>
                    </div>

                    {exaAlreadySet && (
                      <Alert>
                        <AlertDescription>
                          Web search is already set up for this workspace. Saving a key replaces
                          it.
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="onboarding-exa-key">Exa API key</Label>
                      <Input
                        id="onboarding-exa-key"
                        type="password"
                        autoComplete="off"
                        placeholder="Starts with exa_…"
                        value={exaKey}
                        onChange={(e) => setExaKey(e.target.value)}
                        disabled={savingExa}
                      />
                      <p className="text-muted-foreground text-xs">
                        Stored encrypted for your workspace and never shown again.
                      </p>
                      {!exaAlreadySet && (
                        <p className="text-muted-foreground text-xs">
                          Don’t have a key?{" "}
                          <a
                            href={EXA_SIGN_UP}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-primary underline underline-offset-2"
                          >
                            Sign up for Exa
                          </a>{" "}
                          — or skip this and set it up later in Settings.
                        </p>
                      )}
                    </div>

                    {exaError !== null && (
                      <Alert variant="destructive" role="alert">
                        <AlertDescription>{exaError}</AlertDescription>
                      </Alert>
                    )}

                    <Button
                      type="submit"
                      className="w-full"
                      disabled={savingExa || exaKey.trim().length === 0}
                      aria-busy={savingExa}
                    >
                      {savingExa ? <Spinner label="Enabling web search" /> : <Globe aria-hidden />}
                      {exaAlreadySet ? "Replace key" : "Enable web search"}
                    </Button>
                  </form>
                </Card>
              }
              onContinue={skipWebSearch}
            />
          ) : step === "install" ? (
            <InstallStep onDone={advance} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StepIndicator({ steps, step }: { steps: OnboardingStepDef[]; step: OnboardingStepId }) {
  const index = steps.findIndex((s) => s.id === step);
  const current = index < 0 ? 0 : index;
  const label = steps[current]?.label ?? "";
  return (
    <div className="space-y-2">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Step {current + 1} of {steps.length} · {label}
      </p>
      <div className="flex gap-1.5" aria-hidden="true">
        {steps.map((entry, i) => (
          <span
            key={entry.id}
            className={cn("h-1 flex-1 rounded-full", i <= current ? "bg-primary" : "bg-border")}
          />
        ))}
      </div>
    </div>
  );
}

function formatProviderLabel(provider: SettingsProvider): string {
  // Look through the full set, not the account's filtered one — a label should
  // resolve even for a provider this account can't currently pick.
  const options = onboardingProviderOptions({ workersAi: true });
  return options.find((o) => o.value === provider)?.label ?? provider;
}
