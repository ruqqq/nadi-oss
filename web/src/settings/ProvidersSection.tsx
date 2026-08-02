import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ArrowLeft, CaretRight, CheckCircle, Eye, EyeSlash } from "../icons";
import { useMediaQuery } from "../lib/use-media-query";
import {
  previewProviderSecret,
  saveProviderConfig,
  saveProviderModelWhitelist,
  saveProviderSecret,
  type AgentSettingsResponse,
  type ProviderEndpointConfig,
  type ProviderSecretPreview,
  type ProviderModelSearchResult,
  type ProviderSettingsView,
} from "../settings-api";
import { PROVIDER_SECRET_NAME_FIELD_READ_ONLY } from "../settings-ui-config";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import {
  DetailHeading,
  Field,
  FORM_ACTION_BUTTON,
  FormActions,
  FormCard,
  PaneFooter,
  SectionHeading,
} from "./section-ui";
import { SettingsFooterPortal } from "./footer-slot";
import { ProviderModelsCard } from "./ProviderModelsCard";

/** Why this provider needs a clean egress at all — the reason differs per
 *  provider, so the shared card asks each one for its own line. */
const PROXY_HINTS: Record<string, string> = {
  "openai-oauth": "ChatGPT blocks requests originating from Cloudflare. Required in production.",
  "opencode-zen":
    "Zen throttles free models per egress IP, and Cloudflare’s is shared. Needed for the free models.",
};

/** The relay this URL has to point at — self-hosters need to run it themselves,
 *  and its ROUTES table is what decides which path prefix is valid here. */
const PROXY_SOURCE_URL =
  "https://github.com/ruqqq/nadi-oss/blob/main/infra/egress-proxy/server.mjs";

/** Ready / Needs endpoint / Not configured — the one-word state of a provider,
 *  shown as the list indicator's label and the detail heading's eyebrow. */
function statusLabel(provider: ProviderSettingsView): string {
  if (provider.usable) return "Ready";
  return provider.secretPresent ? "Needs endpoint" : "Not configured";
}

function formatSecretDate(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * Master-detail host for the Providers tab. The list is a zoomed-out view —
 * each provider with a configured/not indicator — and the detail is the
 * secret + endpoint editor (ProviderDetail). Below `lg` it collapses to a
 * drill-down; at `lg`+ the two panes sit side by side. Selection lives in the
 * URL (`/settings/providers/:id`), parsed by the shell.
 */
export function ProvidersSection({
  settings,
  loadError,
  onRetry,
  onProviderChanged,
  selectedId,
  onSelectProvider,
  onBackToList,
}: {
  settings: AgentSettingsResponse | null;
  loadError: Error | null;
  onRetry: () => void;
  onProviderChanged: (provider: ProviderSettingsView) => void;
  /** The provider id in the URL, or null for the list. */
  selectedId: string | null;
  onSelectProvider: (id: string) => void;
  onBackToList: () => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const providers = settings?.providers ?? null; // null = loading

  const inDetail = selectedId !== null;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;
  const selected = providers?.find((p) => p.provider === selectedId) ?? null;

  if (loadError) {
    return (
      <section aria-label="Providers" className="space-y-4">
        <SectionHeading
          title="Providers"
          description="Workspace credentials and endpoint configuration."
        />
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load providers. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Providers" className="space-y-4">
      {showList && (
        <SectionHeading
          title="Providers"
          description="Workspace credentials and endpoint configuration."
        />
      )}

      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {showList && (
          <div>
            {providers === null ? (
              <ul className="space-y-2" aria-busy="true" aria-label="Loading providers">
                {[0, 1, 2, 3].map((i) => (
                  <li key={i}>
                    <Skeleton className="h-14 w-full rounded-lg" />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-2">
                {providers.map((provider) => {
                  const configured = provider.usable;
                  return (
                    <li key={provider.provider}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
                        onClick={() => onSelectProvider(provider.provider)}
                        aria-current={provider.provider === selectedId ? "true" : undefined}
                        aria-label={`${provider.displayName}, ${configured ? "configured" : "not configured"}`}
                      >
                        {configured ? (
                          <CheckCircle aria-hidden className="size-5 shrink-0 text-approve" />
                        ) : (
                          <span
                            aria-hidden
                            className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/40"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                          {provider.displayName}
                        </span>
                        <CaretRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {showDetail && (
          <div className="flex min-h-0 flex-col gap-4">
            {!isDesktop && inDetail && (
              <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBackToList}>
                <ArrowLeft aria-hidden />
                All providers
              </Button>
            )}

            {selectedId && providers === null ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading provider">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : selectedId && !selected ? (
              <div className="rounded-lg border border-border border-dashed py-10 text-center">
                <p className="text-muted-foreground text-sm">Provider not found.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onBackToList}>
                  Back to providers
                </Button>
              </div>
            ) : selected ? (
              <ProviderDetail key={selected.provider} provider={selected} onChanged={onProviderChanged} />
            ) : (
              <div className="hidden items-center justify-center rounded-lg border border-border border-dashed py-16 text-center lg:flex">
                <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">
                  Select a provider to add a key or configure its endpoint.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Which half of the combined save failed, so the detail can say which. */
/** Order-insensitive on selection, but `null` (uncurated) and `[]` (curated to
 *  nothing) are different states and never compare equal. */
function sameModelList(
  a: ProviderModelSearchResult[] | null,
  b: ProviderModelSearchResult[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const key = (m: ProviderModelSearchResult) => `${m.id}\u0000${m.name ?? ""}\u0000${m.reasoning}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

class SaveStepError extends Error {
  constructor(
    readonly step: "config" | "secret" | "models",
    override readonly cause: unknown,
  ) {
    super(`provider save failed: ${step}`);
  }
}

/**
 * The editor for one provider: a preview-able secret plus, for OpenAI-compatible
 * providers, an endpoint (base URL / auth / advanced body) — and for providers the
 * egress proxy serves, a proxy route. Save commits the endpoint and the key together and
 * lives in the shell footer slot. Workers AI is keyless, so it renders a
 * read-only note instead of a form.
 */
function ProviderDetail({
  provider,
  onChanged,
}: {
  provider: ProviderSettingsView;
  onChanged: (provider: ProviderSettingsView) => void;
}) {
  const previewRequestIdRef = useRef(0);
  const secretName = provider.configuredSecretName;
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ProviderSecretPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const savedBodyJson = JSON.stringify(provider.endpointConfig.body, null, 2);
  const [baseUrl, setBaseUrl] = useState(provider.endpointConfig.baseUrl);
  const [proxyUrl, setProxyUrl] = useState(provider.endpointConfig.proxyUrl);
  const [auth, setAuth] = useState<ProviderEndpointConfig["auth"]>(provider.endpointConfig.auth);
  const [bodyJson, setBodyJson] = useState(savedBodyJson);
  const isOpenAICompatibleProvider =
    provider.provider === "deepseek" ||
    provider.provider === "zai" ||
    provider.provider === "qwen" ||
    provider.provider === "opencode-go" ||
    provider.provider === "opencode-zen" ||
    provider.provider === "openai-compatible";
  // Mirrors PROVIDERS_WITH_PROXY on the server, which in turn mirrors the route
  // table in infra/egress-proxy/server.mjs.
  const supportsProxy = provider.provider === "openai-oauth" || provider.provider === "opencode-zen";
  // openai-oauth has no editable baseUrl of its own — its upstream is fixed and
  // the proxy route is the only address a workspace sets.
  const hasConfigurableEndpoint = isOpenAICompatibleProvider || supportsProxy;
  const requiresBaseUrl = provider.provider === "qwen" || provider.provider === "openai-compatible";
  const supportsAuthMode = provider.provider === "openai-compatible";
  const requiresSecret = !(supportsAuthMode && auth === "none");

  // The endpoint and the key save together, so Save has to light up for either.
  // Compared against the saved view, not a submit count: retyping the original
  // value is not a change, and a successful save makes the form clean again.
  // Models are part of THIS pane's Save. The card is controlled: `undefined`
  // means untouched, and `null` vs `[]` stay distinct all the way down.
  const [modelsDraft, setModelsDraft] = useState<
    ProviderModelSearchResult[] | null | undefined
  >(undefined);
  const savedModels = provider.whitelistModels ?? null;
  const modelsDirty =
    modelsDraft !== undefined && !sameModelList(modelsDraft, savedModels);

  const configDirty =
    hasConfigurableEndpoint &&
    ((isOpenAICompatibleProvider && baseUrl !== provider.endpointConfig.baseUrl) ||
      (supportsProxy && proxyUrl !== provider.endpointConfig.proxyUrl) ||
      (supportsAuthMode && auth !== provider.endpointConfig.auth) ||
      (isOpenAICompatibleProvider && bodyJson !== savedBodyJson));
  const secretDirty = secretValue.trim().length > 0;
  const canSave = !saving && (configDirty || secretDirty || modelsDirty);

  useEffect(() => {
    previewRequestIdRef.current += 1;
    setSecretValue("");
    setPreviewing(false);
    setPreview(null);
    setError(null);
    setPreviewError(null);
    setBaseUrl(provider.endpointConfig.baseUrl);
    setProxyUrl(provider.endpointConfig.proxyUrl);
    setAuth(provider.endpointConfig.auth);
    setBodyJson(savedBodyJson);
    setModelsDraft(undefined);
    setSaving(false);
    return () => {
      previewRequestIdRef.current += 1;
    };
    // savedBodyJson, not endpointConfig.body: the object identity changes on
    // every parent render, which would reset the fields mid-edit.
  }, [
    provider.provider,
    provider.configuredSecretName,
    provider.endpointConfig.baseUrl,
    provider.endpointConfig.proxyUrl,
    provider.endpointConfig.auth,
    savedBodyJson,
  ]);

  /** Providers with no key or endpoint (Workers AI) still need a Save for the
   *  model list — without one, a deferred draft could never be committed. */
  const saveModelsOnly = useCallback(async () => {
    if (!modelsDirty || modelsDraft === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveProviderModelWhitelist(provider.provider, modelsDraft);
      onChanged(updated);
      setModelsDraft(undefined);
      toast.success(`Saved ${updated.displayName}`);
    } catch (err: unknown) {
      setError("Couldn’t save the model list.");
      toast.error(err instanceof Error ? err.message : "Couldn’t save the model list.");
    } finally {
      setSaving(false);
    }
  }, [modelsDirty, modelsDraft, provider.provider, onChanged]);

  const save = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!canSave) return;

      let body: ProviderEndpointConfig["body"] = provider.endpointConfig.body;
      if (isOpenAICompatibleProvider) {
        try {
          body = bodyJson.trim() ? (JSON.parse(bodyJson) as ProviderEndpointConfig["body"]) : {};
        } catch {
          setError("Advanced options must be valid JSON.");
          return;
        }
      }

      setSaving(true);
      setError(null);
      previewRequestIdRef.current += 1;
      setPreviewing(false);
      setPreview(null);
      setPreviewError(null);

      // Endpoint first: a key verified against a stale base URL is a false
      // negative. Whichever call runs last carries the view the parent keeps.
      // Holds the config view when the endpoint persisted but the key was
      // rejected: that write is already durable, so the parent has to hear
      // about it even though the submit as a whole failed.
      const persisted: { view: ProviderSettingsView | null } = { view: null };

      void (async () => {
        if (configDirty) {
          persisted.view = await saveProviderConfig(provider.provider, {
            baseUrl,
            proxyUrl,
            auth: supportsAuthMode ? auth : "bearer",
            body,
          }).catch((err: unknown) => {
            throw new SaveStepError("config", err);
          });
        }
        if (secretDirty) {
          persisted.view = await saveProviderSecret(provider.provider, {
            value: secretValue,
            secretName,
          }).catch((err: unknown) => {
            throw new SaveStepError("secret", err);
          });
        }
        // Last, so a rejected key doesn't leave the model list applied while
        // the pane still reads as unsaved.
        if (modelsDirty && modelsDraft !== undefined) {
          persisted.view = await saveProviderModelWhitelist(
            provider.provider,
            modelsDraft,
          ).catch((err: unknown) => {
            throw new SaveStepError("models", err);
          });
        }
        return persisted.view;
      })()
        .then((nextProvider) => {
          if (!nextProvider) return;
          onChanged(nextProvider);
          setSecretValue("");
          setModelsDraft(undefined);
          toast.success(`Saved ${nextProvider.displayName}`);
        })
        .catch((err: unknown) => {
          if (persisted.view) onChanged(persisted.view);
          const step = err instanceof SaveStepError ? err.step : "config";
          if (step === "models") {
            setError("Couldn’t save the model list.");
            toast.error("Couldn’t save the model list.");
            return;
          }
          const cause = err instanceof SaveStepError ? err.cause : err;
          const status = cause instanceof Error ? cause.message.match(/\((\d+)\)/)?.[1] : null;
          if (step === "secret") {
            setError(
              status === "400"
                ? "Check the secret name and replacement value."
                : "Couldn’t save secret.",
            );
            toast.error("Couldn’t save provider secret.");
            return;
          }
          setError(
            status === "400"
              ? "Check the endpoint URL and advanced options."
              : "Couldn’t save provider configuration.",
          );
          toast.error("Couldn’t save provider configuration.");
        })
        .finally(() => setSaving(false));
    },
    [
      canSave,
      configDirty,
      secretDirty,
      modelsDirty,
      modelsDraft,
      baseUrl,
      proxyUrl,
      auth,
      bodyJson,
      secretValue,
      secretName,
      supportsAuthMode,
      isOpenAICompatibleProvider,
      provider.provider,
      provider.endpointConfig.body,
      onChanged,
    ],
  );

  const togglePreview = useCallback(() => {
    if (preview) {
      previewRequestIdRef.current += 1;
      setPreview(null);
      setPreviewError(null);
      return;
    }

    if (!provider.previewAvailable || previewing || saving) return;
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setPreviewing(true);
    setPreviewError(null);
    void previewProviderSecret(provider.provider, { chars: 8 })
      .then((nextPreview) => {
        if (previewRequestIdRef.current === requestId) setPreview(nextPreview);
      })
      .catch(() => {
        if (previewRequestIdRef.current === requestId) {
          setPreviewError("Couldn’t preview the secret prefix.");
        }
      })
      .finally(() => {
        if (previewRequestIdRef.current === requestId) setPreviewing(false);
      });
  }, [preview, provider.previewAvailable, provider.provider, previewing, saving]);

  const previewDisabled = (!provider.previewAvailable && !preview) || previewing || saving;
  const previewLabel = preview
    ? `Hide ${provider.displayName} secret preview`
    : `Preview ${provider.displayName} secret prefix`;

  // Workers AI authenticates through the Worker's own binding — there is no key
  // to enter, preview, or verify, so the detail states that instead of offering
  // an input that would have nothing to save.
  if (provider.provider === "workers-ai") {
    return (
      <div className="space-y-4">
        <DetailHeading eyebrow="Ready" title={provider.displayName} />
        <FormCard title="Managed by Cloudflare">
          <p className="text-muted-foreground text-sm">
            Ready — no configuration required. Models run on Cloudflare’s network and are billed to
            Nadi rather than to a key of yours.
          </p>
        </FormCard>
        <ProviderModelsCard
          provider={provider}
          draft={modelsDraft}
          onDraftChange={setModelsDraft}
        />
        <SettingsFooterPortal>
          <PaneFooter contentClassName="max-w-4xl">
            <FormActions>
              <Button type="button" disabled={!canSave} onClick={() => void saveModelsOnly()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </FormActions>
          </PaneFooter>
        </SettingsFooterPortal>
      </div>
    );
  }

  const formId = `provider-form-${provider.provider}`;

  return (
    <div className="space-y-4">
      <DetailHeading eyebrow={statusLabel(provider)} title={provider.displayName} />

      <form id={formId} className="space-y-4" onSubmit={save}>
        {isOpenAICompatibleProvider && (
          <FormCard title="Endpoint">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:items-end">
              <Field
                label={`Base URL${requiresBaseUrl ? "" : " (default optional)"}`}
                htmlFor={`base-url-${provider.provider}`}
              >
                <Input
                  id={`base-url-${provider.provider}`}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={
                    provider.provider === "qwen"
                      ? "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
                      : provider.endpointConfig.baseUrl
                  }
                  className="font-mono"
                  disabled={saving}
                  spellCheck={false}
                />
              </Field>
              {supportsAuthMode && (
                <Field label="Auth" htmlFor={`auth-${provider.provider}`}>
                  <Select
                    value={auth}
                    onValueChange={(value) => setAuth(value as ProviderEndpointConfig["auth"])}
                    disabled={saving}
                  >
                    <SelectTrigger id={`auth-${provider.provider}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bearer">Bearer key</SelectItem>
                      <SelectItem value="none">No auth</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            <Field
              label="Advanced request body defaults"
              htmlFor={`body-json-${provider.provider}`}
            >
              <Textarea
                id={`body-json-${provider.provider}`}
                value={bodyJson}
                onChange={(event) => setBodyJson(event.target.value)}
                className="min-h-24 resize-y font-mono text-xs"
                disabled={saving}
                spellCheck={false}
              />
            </Field>
          </FormCard>
        )}

        {supportsProxy && (
          <FormCard title="Proxy endpoint">
            <p className="text-muted-foreground text-xs">
              {PROXY_HINTS[provider.provider]}{" "}
              <a
                href={PROXY_SOURCE_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                See the proxy script
              </a>
              .
            </p>
            <Field label="Proxy URL" htmlFor={`proxy-url-${provider.provider}`}>
              <Input
                id={`proxy-url-${provider.provider}`}
                value={proxyUrl}
                onChange={(event) => setProxyUrl(event.target.value)}
                placeholder={`https://proxy.example.com/${provider.provider}`}
                className="font-mono"
                disabled={saving}
                spellCheck={false}
              />
            </Field>
          </FormCard>
        )}

        <FormCard title="Secret">
          {provider.secretPresent && (
            <p className="text-muted-foreground text-xs">
              Updated {formatSecretDate(provider.secretUpdatedAt)}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Secret name" htmlFor={`secret-name-${provider.provider}`}>
              <Input
                id={`secret-name-${provider.provider}`}
                value={secretName}
                placeholder={provider.defaultSecretName}
                readOnly={PROVIDER_SECRET_NAME_FIELD_READ_ONLY}
                className="font-mono"
              />
            </Field>
            <Field
              label={requiresSecret ? "Replacement value" : "Replacement value (optional)"}
              htmlFor={`secret-value-${provider.provider}`}
            >
              <div className="flex gap-2">
                <Input
                  id={`secret-value-${provider.provider}`}
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  disabled={saving}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={togglePreview}
                  disabled={previewDisabled}
                  aria-label={previewLabel}
                  title={previewLabel}
                  aria-busy={previewing}
                >
                  {previewing ? <Spinner /> : preview ? <EyeSlash aria-hidden /> : <Eye aria-hidden />}
                </Button>
              </div>
            </Field>
          </div>

          {preview && (
            <div
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
              role="status"
            >
              <span className="font-mono break-all">{preview.preview}</span>
              {preview.truncated && <span className="text-muted-foreground">…</span>}
            </div>
          )}

          {previewError && (
            <p className="text-reject text-xs" role="alert">
              {previewError}
            </p>
          )}
        </FormCard>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </form>

      {/* Outside the <form> element, but NOT outside its Save: the button below
          is wired to the form id and also commits this card's draft. */}
      <ProviderModelsCard
        provider={provider}
        draft={modelsDraft}
        onDraftChange={setModelsDraft}
      />

      <SettingsFooterPortal>
        <PaneFooter contentClassName="max-w-4xl">
          <FormActions>
            <p className="text-muted-foreground text-xs sm:mr-auto" aria-live="polite">
              {saving
                ? "Saving…"
                : canSave
                  ? "Unsaved changes"
                  : hasConfigurableEndpoint
                    ? "Edit the endpoint or paste a key to save."
                    : "Paste a key to save."}
            </p>
            <Button
              type="submit"
              form={formId}
              className={FORM_ACTION_BUTTON}
              disabled={!canSave}
              aria-busy={saving}
            >
              {saving ? <Spinner /> : null}
              Save
            </Button>
          </FormActions>
        </PaneFooter>
      </SettingsFooterPortal>
    </div>
  );
}
