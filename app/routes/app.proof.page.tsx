import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  List,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { getProofModerationCounts } from "../services/proof.server";
import { getProofEmbedStatus } from "../services/health.server";
import {
  buildPreviewEntryUrl,
  ensurePreviewState,
  sanitizePageHandle,
} from "../services/preview.server";
import {
  GO_LIVE_BLOCKER_TEXT,
  RESULTS_PAGE_LIST_SIZE,
  RESULTS_PAGE_SCOPE,
  getResultsPageContext,
  getStorePage,
  listStorePages,
  parsePageId,
  probeResultsPage,
  resultsPageGoLiveBlockers,
  type ResultsPageProbe,
} from "../services/results-page.server";
import {
  ReadinessCard,
  type ReadinessRow,
} from "../components/rewards/ReadinessCard";

/**
 * "Results page" tab of the proof library (docs/SPEC-v39-results-page.md):
 * turns ONE online-store page into the dedicated before/after results page.
 *
 * The contract staff rely on, in plain terms:
 *  - the app never edits a Shopify page — it only READS the list of pages
 *    (read-only scope) and remembers which one was picked;
 *  - picking a page changes nothing for shoppers: it is a draft that only
 *    the "Preview" link shows, to the previewer's own browser tab;
 *  - shoppers see the gallery only after an explicit "Go live" click, and
 *    "Take offline" / "Remove" put the page back exactly as it was;
 *  - choosing a different page always starts as a draft again (enforced in
 *    sanitizeSettings, not just here).
 *
 * The gallery itself is the existing results widget in its page mode (the
 * proof embed matches the chosen page's id) — same cards, filters and
 * detail viewer as the product pages and the home page, laid out as a grid
 * of every approved result under the page's own title and content.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

async function syncErrorsFor(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
): Promise<string[]> {
  try {
    const sync = await syncSettingsToMetafields(admin, settings);
    return sync.errors;
  } catch (error) {
    return [
      error instanceof Error
        ? error.message
        : "Could not sync settings to storefront metafields.",
    ];
  }
}

/** saveSettings + storefront mirror (the applySettingsPatch pattern).
 *  `retry` re-attempts a failed mirror write once — used when the change
 *  takes something OFF the storefront, which must not silently linger. */
async function savePagePatch(
  shop: string,
  admin: AdminGraphqlClient,
  patch: DeepPartial<BoosterSettings>,
  retry = false,
): Promise<string[]> {
  const next = await saveSettings(shop, patch);
  let errors = await syncErrorsFor(admin, next);
  if (errors.length > 0 && retry) errors = await syncErrorsFor(admin, next);
  return errors;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").slice(0, 80);
  const picking = url.searchParams.get("pick") === "1";

  const [settings, counts, context, embed] = await Promise.all([
    getSettings(session.shop),
    getProofModerationCounts(session.shop),
    getResultsPageContext(admin),
    getProofEmbedStatus(admin),
  ]);
  const page = settings.beforeAfter;
  const hasPage = page.pageId > 0;
  const showPicker = context.canReadPages && (!hasPage || picking);

  const [lookup, list] = await Promise.all([
    context.canReadPages && hasPage ? getStorePage(admin, page.pageId) : null,
    showPicker ? listStorePages(admin, search) : null,
  ]);
  const selected = lookup?.page ?? null;
  // The live handle wins over the stored one (a page can be renamed in
  // Shopify — the storefront gate matches on the id, so it keeps working).
  const handle = selected?.handle ?? page.pageHandle;
  const storefrontOrigin = context.storefrontOrigin || `https://${session.shop}`;

  let previewUrl = "";
  if (hasPage && sanitizePageHandle(handle) !== "") {
    const preview = await ensurePreviewState(session.shop);
    previewUrl = buildPreviewEntryUrl(session.shop, preview.token, {
      pageHandle: handle,
    });
  }
  const probe: ResultsPageProbe =
    hasPage && selected?.isPublished === true
      ? await probeResultsPage(storefrontOrigin, handle)
      : { status: "skipped" };

  const scope = settings.marketScopes.verified_before_after;
  const storePrefix = session.shop.replace(".myshopify.com", "");
  const adminBase = `https://admin.shopify.com/store/${storePrefix}`;
  const pageState = !hasPage
    ? ("none" as const)
    : !lookup || !lookup.ok
      ? ("unknown" as const)
      : selected
        ? ("ok" as const)
        : ("missing" as const);
  // Computed here (not in the component): the rule lives in a .server
  // module, and the "Go live" click re-checks it server-side anyway. A
  // page or count that could not be READ is not treated as a blocker —
  // only a confirmed problem disables the button.
  const goLiveBlockers = resultsPageGoLiveBlockers({
    pageId: page.pageId,
    page:
      pageState === "missing"
        ? null
        : { isPublished: selected ? selected.isPublished : true },
    featureEnabled: page.enabled,
    approvedResults: counts.ok ? counts.results.approved : 1,
  }).map((blocker) => GO_LIVE_BLOCKER_TEXT[blocker]);

  return {
    goLiveBlockers,
    scope: {
      checked: context.ok,
      error: context.error,
      canReadPages: context.canReadPages,
      name: RESULTS_PAGE_SCOPE,
    },
    page: {
      id: page.pageId,
      title: selected?.title ?? page.pageTitle,
      handle,
      live: page.pageLive,
    },
    /** "ok" | "missing" (deleted in Shopify) | "unknown" (could not check) */
    pageState,
    pageLookupError: lookup && !lookup.ok ? lookup.error : "",
    selected,
    picker: list
      ? {
          ok: list.ok,
          error: list.error,
          pages: list.pages,
          hasMore: list.hasMore,
        }
      : null,
    search,
    picking,
    embed: { known: embed.known, enabled: embed.enabled },
    results: {
      enabled: page.enabled,
      countsOk: counts.ok,
      approved: counts.results.approved,
      marketLimited: scope?.mode === "selected",
      marketCount: scope?.mode === "selected" ? scope.markets.length : 0,
    },
    probe,
    previewUrl,
    publicUrl: handle ? `${storefrontOrigin}/pages/${encodeURIComponent(handle)}` : "",
    editPageUrl: hasPage ? `${adminBase}/pages/${page.pageId}` : "",
    newPageUrl: `${adminBase}/pages/new`,
    themeEditorUrl: `${adminBase}/themes/current/editor?context=apps`,
    listSize: RESULTS_PAGE_LIST_SIZE,
  };
};

interface ActionResult {
  ok: boolean;
  intent: string;
  message: string;
  /** Saved in the app but the storefront copy could not be updated. */
  syncErrors: string[];
}

const fail = (intent: string, message: string): ActionResult => ({
  ok: false,
  intent,
  message,
  syncErrors: [],
});

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "choose": {
      const id = parsePageId(form.get("pageId"));
      if (id === 0) return fail(intent, "Pick a page from the list.");
      // Re-read the page so the stored title/handle are Shopify's own, not
      // whatever the browser posted.
      const lookup = await getStorePage(admin, id);
      if (!lookup.ok) {
        return fail(
          intent,
          `Shopify could not be reached to read that page (${lookup.error}). Nothing was changed.`,
        );
      }
      if (!lookup.page) {
        return fail(intent, "That page no longer exists in Shopify. Refresh the list and pick another.");
      }
      const syncErrors = await savePagePatch(session.shop, admin, {
        beforeAfter: {
          pageId: id,
          pageHandle: lookup.page.handle,
          pageTitle: lookup.page.title,
          pageLive: false,
        },
      });
      return {
        ok: true,
        intent,
        message: `“${lookup.page.title}” is set up as a draft. Shoppers see no change until you go live.`,
        syncErrors,
      };
    }

    case "golive": {
      const [settings, counts] = await Promise.all([
        getSettings(session.shop),
        getProofModerationCounts(session.shop),
      ]);
      const pageId = settings.beforeAfter.pageId;
      const lookup = await getStorePage(admin, pageId);
      if (pageId > 0 && !lookup.ok) {
        return fail(
          intent,
          `Shopify could not be reached to check the page (${lookup.error}). Nothing was changed — try again.`,
        );
      }
      if (!counts.ok) {
        return fail(intent, "The approved results could not be counted. Nothing was changed — try again.");
      }
      const blockers = resultsPageGoLiveBlockers({
        pageId,
        page: lookup.page,
        featureEnabled: settings.beforeAfter.enabled,
        approvedResults: counts.results.approved,
      });
      if (blockers.length > 0) {
        return fail(intent, blockers.map((b) => GO_LIVE_BLOCKER_TEXT[b]).join(" "));
      }
      const syncErrors = await savePagePatch(session.shop, admin, {
        beforeAfter: {
          pageLive: true,
          pageHandle: lookup.page?.handle ?? settings.beforeAfter.pageHandle,
          pageTitle: lookup.page?.title ?? settings.beforeAfter.pageTitle,
        },
      });
      return {
        ok: true,
        intent,
        message: "The results page is live. It can take a minute to appear for shoppers.",
        syncErrors,
      };
    }

    case "offline": {
      const syncErrors = await savePagePatch(
        session.shop,
        admin,
        { beforeAfter: { pageLive: false } },
        true,
      );
      return {
        ok: true,
        intent,
        message: "The results page is offline. Shoppers see the page's own content only.",
        syncErrors,
      };
    }

    case "remove": {
      const syncErrors = await savePagePatch(
        session.shop,
        admin,
        {
          beforeAfter: {
            pageId: 0,
            pageHandle: "",
            pageTitle: "",
            pageLive: false,
          },
        },
        true,
      );
      return {
        ok: true,
        intent,
        message: "The page is no longer a results page. Nothing on the page itself was changed.",
        syncErrors,
      };
    }

    case "resync": {
      const settings = await getSettings(session.shop);
      const syncErrors = await syncErrorsFor(admin, settings);
      return {
        ok: syncErrors.length === 0,
        intent,
        message:
          syncErrors.length === 0
            ? "The storefront is up to date."
            : "The storefront could still not be updated.",
        syncErrors,
      };
    }

    default:
      return fail(intent, "Unknown action.");
  }
};

export default function ResultsPageTab() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(data.search);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const result = fetcher.data;

  useEffect(() => {
    if (!result) return;
    if (!result.ok) {
      shopify.toast.show(result.message, { isError: true });
    } else if (result.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront could not be updated", {
        isError: true,
      });
    } else {
      shopify.toast.show(result.message);
    }
    if (result.ok && (result.intent === "choose" || result.intent === "remove")) {
      // Close the picker / reset the search once a page is set or cleared.
      setSearchParams({}, { replace: true });
      setConfirmRemove(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const submit = (intent: string, extra: Record<string, string> = {}) =>
    fetcher.submit({ intent, ...extra }, { method: "post" });

  const hasPage = data.page.id > 0;
  const live = hasPage && data.page.live;
  const blockers = data.goLiveBlockers;
  const showPicker = data.picker !== null;
  const pagePath = data.page.handle ? `/pages/${data.page.handle}` : "";

  // ---- readiness rows (only once a page is chosen) ----
  const rows: ReadinessRow[] = [];
  if (hasPage) {
    const editAction = data.editPageUrl
      ? { label: "Edit page in Shopify", url: data.editPageUrl, external: true }
      : undefined;

    if (data.pageState === "missing") {
      rows.push({
        id: "page",
        title: "Page exists and is visible",
        tone: "critical",
        badge: "Not found",
        sentence:
          "This page no longer exists in Shopify, so there is nowhere to show the gallery. Choose another page.",
        action: { label: "Choose another page", onClick: () => setSearchParams({ pick: "1" }) },
      });
    } else if (data.pageState === "unknown") {
      rows.push({
        id: "page",
        title: "Page exists and is visible",
        tone: "attention",
        badge: "Could not check",
        sentence: data.scope.canReadPages
          ? `Shopify did not answer when asked about this page${data.pageLookupError ? ` (${data.pageLookupError})` : ""}. Re-check in a moment.`
          : "The app cannot read your pages until the new permission is approved (see the notice at the top).",
        action: { label: "Re-check", onClick: () => revalidator.revalidate() },
      });
    } else if (data.selected && !data.selected.isPublished) {
      rows.push({
        id: "page",
        title: "Page exists and is visible",
        tone: "critical",
        badge: "Hidden",
        sentence:
          "The page is set to Hidden in Shopify, so nobody can open it, not even the preview. Set its visibility to Visible. Until you go live it only shows its own content.",
        action: editAction,
      });
    } else {
      rows.push({
        id: "page",
        title: "Page exists and is visible",
        tone: "success",
        badge: "Visible",
        sentence: "The page is published, so shoppers and the preview can open it.",
      });
    }

    rows.push(
      !data.embed.known
        ? {
            id: "embed",
            title: "Proof library app embed is on",
            tone: "attention",
            badge: "Could not check",
            sentence:
              "The theme could not be read just now. The gallery is drawn by the “Cellexia proof library” app embed, so make sure it is switched on in the theme editor.",
            action: { label: "Open App embeds", url: data.themeEditorUrl, external: true },
          }
        : data.embed.enabled
          ? {
              id: "embed",
              title: "Proof library app embed is on",
              tone: "success",
              badge: "On",
              sentence: "The app embed that draws the gallery is switched on in your live theme.",
            }
          : {
              id: "embed",
              title: "Proof library app embed is on",
              tone: "critical",
              badge: "Off",
              sentence:
                "The gallery is drawn by the “Cellexia proof library” app embed, and it is off. In the theme editor open App embeds, switch it on, and save.",
              action: { label: "Open App embeds", url: data.themeEditorUrl, external: true },
            },
    );

    const marketNote = data.results.marketLimited
      ? [
          `Before/after results are limited to ${data.results.marketCount} selected market${data.results.marketCount === 1 ? "" : "s"}. Shoppers in other markets will not see the gallery on this page either.`,
        ]
      : undefined;
    if (!data.results.enabled) {
      rows.push({
        id: "results",
        title: "Before/after results are on",
        tone: "critical",
        badge: "Off",
        sentence:
          "Before/after results are switched off for the whole store. Turn them on in the Results tab; the page uses the same switch.",
        action: { label: "Open Results tab", url: "/app/proof/results" },
      });
    } else if (!data.results.countsOk) {
      rows.push({
        id: "results",
        title: "Before/after results are on",
        tone: "attention",
        badge: "Could not count",
        sentence: "The results could not be counted just now. Re-check in a moment.",
        action: { label: "Re-check", onClick: () => revalidator.revalidate() },
      });
    } else if (data.results.approved === 0) {
      rows.push({
        id: "results",
        title: "Before/after results are on",
        tone: "critical",
        badge: "0 approved",
        sentence:
          "There are no approved results yet, so the page would have nothing to show. Approve at least one in the Results tab.",
        action: { label: "Open Results tab", url: "/app/proof/results" },
      });
    } else {
      rows.push({
        id: "results",
        title: "Before/after results are on",
        tone: "success",
        badge: `${data.results.approved} approved`,
        sentence:
          "Every approved result appears on the page automatically, with the same look and options as on product pages. Nothing to copy over.",
        details: marketNote,
      });
    }

    if (data.selected) {
      rows.push(
        data.selected.templateSuffix === ""
          ? {
              id: "template",
              title: "Page layout",
              tone: "success",
              badge: "Default",
              sentence: "The page uses the theme's normal page layout.",
            }
          : {
              id: "template",
              title: "Page layout",
              tone: "attention",
              badge: "Custom layout",
              sentence: `This page uses the special theme layout “page.${data.selected.templateSuffix}”. If that layout was built for the old before/after system, it may still show old content above the gallery. In Shopify, open the page and set “Theme template” to “Default page”.`,
              action: editAction,
            },
      );
      const hasOwnContent =
        data.selected.bodyTextLength > 0 || data.selected.bodyHasMedia;
      rows.push({
        id: "content",
        title: "Page's own content",
        tone: "success",
        badge: hasOwnContent ? "Has its own content" : "Empty",
        sentence: hasOwnContent
          ? `The page still has its own content${data.selected.bodyTextLength > 0 ? ` (about ${data.selected.bodyTextLength} characters of text)` : ""}. The gallery appears right below it. To show only the gallery, delete the old content in Shopify; this app never edits it.`
          : "The page has no content of its own, so shoppers see the page title and then the gallery.",
        action: hasOwnContent ? editAction : undefined,
      });
    }

    if (data.probe.status === "ready") {
      rows.push({
        id: "storefront",
        title: "Gallery is connected on the real page",
        tone: "success",
        badge: "Connected",
        sentence:
          "The real page was loaded and the gallery is wired up on it. It stays invisible to shoppers until you go live.",
      });
    } else if (data.probe.status === "absent") {
      rows.push({
        id: "storefront",
        title: "Gallery is connected on the real page",
        tone: "attention",
        badge: "Not detected yet",
        sentence:
          "The real page loaded, but the gallery is not connected to it yet. Usually the app embed is off, or the latest app update has not been published. It can also take a minute after choosing a page.",
        action: { label: "Re-check", onClick: () => revalidator.revalidate() },
      });
    } else if (data.probe.status === "password") {
      rows.push({
        id: "storefront",
        title: "Gallery is connected on the real page",
        tone: "attention",
        badge: "Store is locked",
        sentence:
          "The storefront is behind a password page, so the real page could not be checked. Use Preview to check it yourself.",
      });
    } else if (data.probe.status === "unreachable") {
      rows.push({
        id: "storefront",
        title: "Gallery is connected on the real page",
        tone: "attention",
        badge: "Could not load",
        sentence: "The real page could not be loaded just now. Re-check in a moment.",
        action: { label: "Re-check", onClick: () => revalidator.revalidate() },
      });
    }
  }

  return (
    <BlockStack gap="400">
      {!data.scope.checked ? (
        <Banner tone="warning" title="Could not check the app's permissions">
          <p>
            Shopify did not answer{data.scope.error ? ` (${data.scope.error})` : ""}. Reload
            this page in a moment.
          </p>
        </Banner>
      ) : !data.scope.canReadPages ? (
        <Banner tone="warning" title="One-time step: approve the new permission">
          <BlockStack gap="200">
            <p>
              To list your pages here, the app needs one extra, read-only
              permission: <b>view Online Store pages</b> (<code>{data.scope.name}</code>).
              It lets the app see the names of your pages. It cannot create,
              edit or delete a page.
            </p>
            <List type="number">
              <List.Item>
                Publish the latest app update (your developer runs the deploy).
              </List.Item>
              <List.Item>
                Close the app and open it again from Shopify admin. Shopify
                asks you to approve the updated permissions.
              </List.Item>
              <List.Item>Approve, then come back to this tab.</List.Item>
            </List>
          </BlockStack>
        </Banner>
      ) : null}

      {result && result.syncErrors.length > 0 ? (
        <Banner
          tone="critical"
          title="Saved in the app, but the storefront was not updated"
          action={{
            content: "Try again",
            onAction: () => submit("resync"),
            loading: busyIntent === "resync",
          }}
        >
          <p>
            Your change is saved here, but it has not reached the storefront
            yet, so shoppers may still see the previous state.
          </p>
          <List>
            {result.syncErrors.map((line) => (
              <List.Item key={line}>{line}</List.Item>
            ))}
          </List>
        </Banner>
      ) : null}

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h2" variant="headingMd">
              Dedicated results page
            </Text>
            <Badge tone={live ? "success" : hasPage ? "attention" : undefined}>
              {live ? "Live" : hasPage ? "Draft — not visible to shoppers" : "Not set up"}
            </Badge>
          </InlineStack>

          {!hasPage ? (
            <BlockStack gap="200">
              <Text as="p">
                Turn one of your Shopify pages into a before/after results
                page. It shows every approved result as a gallery, with the
                same cards, filters and tap-to-see-details as on your product
                pages.
              </Text>
              <List>
                <List.Item>
                  Pick the page below. Nothing changes for shoppers yet.
                </List.Item>
                <List.Item>
                  Preview it. Only you see the gallery.
                </List.Item>
                <List.Item>
                  Click Go live when you are happy. You can take it offline
                  again at any time.
                </List.Item>
              </List>
              <Text as="p" tone="subdued" variant="bodySm">
                This app never edits your page. The page's title and text stay
                yours to manage in Shopify; the gallery is added underneath
                them.
              </Text>
            </BlockStack>
          ) : (
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  {data.page.title || "Untitled page"}
                </Text>
                {pagePath ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {pagePath}
                  </Text>
                ) : null}
              </BlockStack>
              <Text as="p">
                {live
                  ? "Shoppers see the results gallery on this page, below the page's own title and text."
                  : "This page is set up as a draft. Shoppers see no change. Use Preview to check it, then Go live."}
              </Text>
              <InlineStack gap="200" wrap>
                {live ? (
                  <>
                    <Button url={data.publicUrl} target="_blank" variant="primary">
                      View live page
                    </Button>
                    <Button
                      onClick={() => submit("offline")}
                      loading={busyIntent === "offline"}
                      disabled={busy}
                    >
                      Take offline
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      url={data.previewUrl || undefined}
                      target="_blank"
                      disabled={!data.previewUrl || data.pageState === "missing"}
                    >
                      Preview
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => submit("golive")}
                      loading={busyIntent === "golive"}
                      disabled={busy || blockers.length > 0}
                    >
                      Go live
                    </Button>
                  </>
                )}
                {data.scope.canReadPages ? (
                  <Button
                    onClick={() => setSearchParams({ pick: "1" })}
                    disabled={busy || data.picking}
                  >
                    Change page
                  </Button>
                ) : null}
                {confirmRemove ? (
                  <Button
                    tone="critical"
                    onClick={() => submit("remove")}
                    loading={busyIntent === "remove"}
                    disabled={busy}
                  >
                    {live ? "Click again to remove (takes it offline)" : "Click again to remove"}
                  </Button>
                ) : (
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => setConfirmRemove(true)}
                    disabled={busy}
                  >
                    Remove
                  </Button>
                )}
              </InlineStack>
              {!live && blockers.length > 0 ? (
                <BlockStack gap="050">
                  {blockers.map((blocker) => (
                    <Text as="p" tone="critical" variant="bodySm" key={blocker}>
                      {blocker}
                    </Text>
                  ))}
                </BlockStack>
              ) : null}
              {!live && !data.previewUrl && data.pageState !== "missing" ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  Preview is unavailable for this page's web address. You can
                  still go live and check the page directly.
                </Text>
              ) : null}
              <Text as="p" tone="subdued" variant="bodySm">
                Preview opens the real page in a new tab. Only that tab shows
                the draft gallery, and nothing you do there is counted in the
                analytics. Changing the page always starts as a draft again.
              </Text>
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      {showPicker && data.picker ? (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                {hasPage ? "Choose a different page" : "Choose the page"}
              </Text>
              <InlineStack gap="200">
                <Button url={data.newPageUrl} target="_blank" variant="plain">
                  Create a new page in Shopify
                </Button>
                {hasPage ? (
                  <Button onClick={() => setSearchParams({}, { replace: true })}>
                    Cancel
                  </Button>
                ) : null}
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              These are the pages from Online Store → Pages. Picking one does
              not change it and does not show anything to shoppers.
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <Box width="100%">
                <TextField
                  label="Search pages by title"
                  labelHidden
                  placeholder="Search pages by title"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
              </Box>
              <Button
                onClick={() =>
                  setSearchParams(
                    {
                      ...(hasPage ? { pick: "1" } : {}),
                      ...(query.trim() ? { q: query.trim() } : {}),
                    },
                    { replace: true },
                  )
                }
              >
                Search
              </Button>
              <Button onClick={() => revalidator.revalidate()} loading={revalidator.state !== "idle"}>
                Refresh
              </Button>
            </InlineStack>

            {!data.picker.ok ? (
              <Banner tone="critical" title="The list of pages could not be loaded">
                <p>{data.picker.error}</p>
              </Banner>
            ) : data.picker.pages.length === 0 ? (
              <Text as="p" tone="subdued">
                {data.search
                  ? `No page title starts with “${data.search}”. Try another word, or clear the search.`
                  : "This store has no pages yet. Create one in Shopify, then click Refresh."}
              </Text>
            ) : (
              <BlockStack gap="200">
                {data.picker.pages.map((entry) => {
                  const current = entry.id === data.page.id;
                  return (
                    <Box
                      key={entry.id}
                      padding="300"
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                    >
                      <InlineStack align="space-between" blockAlign="center" wrap gap="300">
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {entry.title}
                            </Text>
                            <Badge tone={entry.isPublished ? "success" : undefined}>
                              {entry.isPublished ? "Visible" : "Hidden"}
                            </Badge>
                            {current ? <Badge tone="info">Current</Badge> : null}
                          </InlineStack>
                          <Text as="span" tone="subdued" variant="bodySm">
                            /pages/{entry.handle}
                          </Text>
                        </BlockStack>
                        <Button
                          onClick={() => submit("choose", { pageId: String(entry.id) })}
                          loading={
                            busyIntent === "choose" &&
                            fetcher.formData?.get("pageId") === String(entry.id)
                          }
                          disabled={busy || current}
                        >
                          {current ? "Already chosen" : "Use this page"}
                        </Button>
                      </InlineStack>
                    </Box>
                  );
                })}
                {data.picker.hasMore ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Showing the first {data.listSize} pages. Use the search box
                    to find others.
                  </Text>
                ) : null}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      ) : null}

      {hasPage ? (
        <ReadinessCard
          rows={rows}
          title="Ready to go live?"
          intro="Each row tells you what is fine and what to do next. Nothing here changes your page: the app only reads it."
        />
      ) : null}
    </BlockStack>
  );
}
