/**
 * Open a URL that must be MINTED first (an artifact view link, a signed
 * download) in a new tab, on browsers that only allow a new tab during the
 * click itself.
 *
 * The obvious spelling — `const url = await mint(); window.open(url)` — works
 * on desktop Chrome and silently does nothing on iOS Safari: the popup
 * allowance belongs to the task the user's tap started, and awaiting anything
 * ends that task. So the tab is claimed SYNCHRONOUSLY, while the gesture is
 * still on the stack, and navigated once the URL arrives.
 *
 * `noopener,noreferrer` cannot be used as an `open()` feature here — with
 * `noopener` the call returns `null` and there is no handle left to navigate.
 * Nulling `opener` on the claimed tab before navigating buys the same
 * protection: the destination never gets a reference back to this window.
 */
export type NewTabResult = { status: "opened" } | { status: "blocked"; url: string };

type OpenFn = (url: string, target: string) => Window | null;

export async function openMintedUrlInNewTab(
  mint: () => Promise<string>,
  openFn: OpenFn = (url, target) => window.open(url, target),
): Promise<NewTabResult> {
  const tab = openFn("", "_blank");
  let url: string;
  try {
    url = await mint();
  } catch (error) {
    // A blank tab left open outlives the toast, which lands in the tab the
    // user came from — they would be looking at an empty page with no error.
    tab?.close();
    throw error;
  }
  if (!tab) return { status: "blocked", url };
  tab.opener = null;
  tab.location.replace(url);
  return { status: "opened" };
}
