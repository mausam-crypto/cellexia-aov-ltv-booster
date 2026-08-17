# Set Savings and Gift Tiers

> **v14.2 note (2026-08-16):** the shipped defaults are now the COMPACT
> ladder (2/3/4/6 → 5/10/15/20 %, KIT2/KIT3/KIT4/KIT6 — `LADDER_PRESETS.compact`)
> and the VALUE-FIRST gifts (119 towel / 200 cream / 350 bag —
> `GIFT_PRESETS.value_first`). The 2/3/5/10 ladder and the cream-first gift
> order described below remain available as the `extended` / `cream_first`
> presets. See docs/SPEC-v14-rewards.md §1 "v14.2 presets".


A plain-language plan for two new boosters in the Cellexia AOV & LTV Booster app:

- **Set savings**: tiered savings when the cart holds several *different* products, applied through the KIT codes.
- **Gift tiers**: free gifts that appear in the cart at spending thresholds, with one progress meter that shows the next gift, free shipping and the next savings tier.

Nothing here is built yet. This explains what we would build, why it is shaped this way, how it fits what already exists, what it changes for you, and the decisions only you can make. Section 12 lists my assumptions about your brief so you can correct them early. The developer detail lives in the appendix at the end.

---

## 1. The short version

- **One new "referee" for both features: a Shopify Discount Function.** Shopify's ordinary discount codes cannot say "5% off when there are two *different* products"; they only count units. The KIT2, KIT3 and KIT5 codes that exist in your store today would trigger on two €1 sachets, or on two units of the same cream. And no ordinary discount can make a specific gift line free only when a threshold is met. A Discount Function is a small program that Shopify runs on every cart and checkout, that we write and control. It decides which KIT tier applies, makes gift lines free, and refuses all of it where it should not apply (wrong market, sachets, gifts, protection line, wholesale customers). Because Shopify itself runs it, typing a code at checkout cannot trick it.
- **The KIT codes stay codes.** KIT2, KIT3, KIT5 and a new KIT10 become codes backed by that referee. The app attaches the right code to the cart automatically as products are added, using a Shopify cart feature that applies a code without reloading the page. Shoppers see the code at checkout, exactly as you asked. (A no-code "automatic" version is possible with the same referee; see decision 2.)
- **Gifts are real products, added at full price and made free by the referee.** That is what makes them clearly visible ("Lip Plumping Formula ~~€37~~ FREE"), keeps stock honest, and makes them impossible to grab free by URL when the threshold is not met.
- **The free-shipping bar becomes a rewards meter** with milestones (free shipping, gift 1, gift 2, gift 3) plus one line for the next savings step ("Add 1 more product to save 10% on everything"). All amounts in the market's currency.
- **Per market everywhere, using the controls you already have.** Both features get the same "Market targeting" card as every current feature, per-market thresholds, and per-market product exclusions with the same picker.
- **Inventory awareness** through a warehouse map (which warehouse serves which market) plus an automatic stock watch that pauses or swaps gifts per market when local stock runs low.
- **Preview before going live** through two additions: a cart simulator (drag a slider for the cart total and a stepper for "products in cart" and watch the meter, nudges and captions change, without touching a real cart) and a "live rehearsal" mode where your own preview cart really gets gifts and codes, all the way into checkout, using draft settings that are not yet live.
- **Rollout in four steps**, switched on for nobody at first, then market by market through the Markets page and the experiment tracker.

Three things I want you to see before anything else, because they change the business, not just the code:

1. **Your Joy referral and reward codes are set to combine with nothing.** With those settings, a referral-code holder would either lose their referral or lose the free gift, and Shopify picks whichever is worth more to the shopper, silently. Making Joy's codes combinable with product discounts is a prerequisite, not a nice-to-have (decision 4). The app also has a safety rule for this: a gift line that did not actually come out free is removed and the shopper is told why.
2. **A percentage discount lowers the total Shopify uses for free shipping.** A shopper at €152 with two products who gets 5% off ends up at €144.40 and would lose free shipping by adding a product. Section 3.5 explains the fix and asks you to opt in per market.
3. **The tier ladder 2/3/5/10 deserves a second look.** With 11 full-size products, "10 different products" is the whole shelf, there is a long empty gap between 5 and 10, and 30% set savings can stack with 20% ladder pricing and 5% Joy to about 47% off, plus gifts and free shipping. Section 3.6 shows the numbers and offers alternatives; the defaults you asked for stay in until you decide.

---

## 2. What I found that shapes the design

I had the app, the theme and the live store researched in depth before writing this. The facts that matter:

**About the store**
- Shop currency is EUR; 27 markets, 11 with a non-EUR currency (USD, GBP, CHF, SEK, DKK, NOK, PLN, RON, AUD, CAD, ANG), plus the EU market (CZK and HUF locally) and Rest of World with about 25 local currencies. "In the market's currency" therefore cannot be one EUR number.
- KIT2 (5%, minimum 2 units), KIT3 (10%, minimum 3) and KIT5 (20%, minimum 5) exist as ordinary codes on the "Shop All" collection. KIT10 does not exist. They count units, not different products, and the sachets and the German wholesale duplicate products sit inside "Shop All", so today they count and get the discount. There are no automatic discounts and no app-run discounts yet. About a hundred Joy referral and reward codes exist, all set to combine with nothing.
- The 9 sachet products exist (€1 each), stocked **only** in the German warehouse (Active Ants). The US warehouse (Boxzooka), the Swiss warehouse (SG Spedition) and the Irish partner (Amphora) have zero sachets. This is the single biggest practical constraint on "samples as gifts" for US, Swiss and Irish orders.
- Bamboo Beauty Towels exist at €0 with stock in all four warehouses but are **not published to the Online Store**, so the cart cannot add them today. The Premium Leather Cosmetic Bag is a **draft** at €39 with 494 units, in Germany only.
- Full-size products use the 1/2/3-unit ladder (57 / 96.90 / 136.80 EUR; lip formula 37 / 66.90 / 94.35). A "2 Jars" line is one line, quantity 1, which is why unit-based codes never see it as two.
- Ireland is your primary market and is served by Amphora, which stocks lip formula and towels but no sachets and no cosmetic bag.

**About the app**
- Every widget already follows one pattern: you change settings in the app, the app copies them to the storefront, each widget can be switched on per market and can skip products per market, unfinished changes can be previewed by you alone, and views and clicks are counted. The new features follow that same pattern; nothing new is invented for market targeting or preview.
- The app draws its cart widgets inside the theme's cart drawer and on the cart page. The free-shipping bar measures progress from the cart's item subtotal, and nothing in the app or theme reads discount codes today.
- The theme redraws the cart line list from scratch on every change, always shows the total after all discounts in the footer, has no "discount" row and no place to type a code. Any gift row we show has to be restyled every time the drawer redraws (hide the quantity controls, show FREE).
- The theme's own free-shipping message is switched off, so our bar is the only bar.
- The product page already has the Amazon-style rows in the buy box, "Frequently bought together" with a bundle total and a one-click "Add all", and "You might also like" (link cards, no add button). Neither has a caption slot under its title yet, and the bundle total does not know about discounts.
- The checkout add-ons already know how to add and remove items and how to respect preview and market (the order-protection add-on does exactly that). That is our checkout safety net.
- Two of the app's storefront files are almost at Shopify's size limit: the file that draws the cart widgets, and the Greek and Arabic wording files. This changes how we ship the new wording (section 6).
- The app has no permission yet to create discounts or read stock per warehouse. Adding them means you approve the app once more in Shopify admin (a one-click screen the app already handles).
- The app has no background scheduler today; the stock watch needs a small one (appendix).

---

## 3. Feature A: Set savings

### 3.1 The rule

Default tiers (editable): 2 different products = 5% (KIT2), 3 = 10% (KIT3), 5 = 20% (KIT5), 10 = 30% (KIT10). "Different products" means different products, not units. A "3 Jars" line plus a "1 Stick" line is two products. Two "1 Jar" lines of the same cream is one product. So set savings sit on top of the per-product ladder, as you described.

The percentage applies to all eligible lines in the cart ("save 5% on both", "save 10% on everything").

Never counted and never discounted: gift lines, sachets, the order-protection line, wholesale (B2B) customers, and any product you exclude for a market. Subscription lines: they count and get the saving on the first order only, not on renewals (decision 1).

### 3.2 How the code gets on the cart, and stays right

- Whenever the cart changes, the app counts eligible different products, works out which KIT code belongs on the cart, and if it differs from what is there, updates the cart's codes without a page reload. Shopify reports back whether the code was accepted, and the drawer shows the result immediately.
- Codes the shopper brought themselves (a welcome code, a referral code) are always kept; the app only ever adds or swaps the KIT code. If Shopify says the KIT code cannot sit alongside what the shopper already has, the app does not fight it: the drawer shows plain prices, no set-savings line, and the event is recorded.
- The code carries into checkout by itself. As a best-effort backup, the checkout add-on can attach the right KIT code when **no** code is present at all; it never re-attaches a code the shopper removed on purpose, and it cannot act inside Apple Pay or Google Pay flows.
- The referee is what actually grants the percentage. It re-counts eligible different products at checkout, so a shopper who types a KIT code by hand gets exactly the tier the cart qualifies for, or nothing, and only one KIT code is ever honoured per order. Two KIT codes can never stack.
- The referee also knows the market. Where set savings are off for a market (Market targeting), the app does not attach the code and the referee does not honour it even if typed. Per-market product exclusions are enforced in the same place, so the storefront and checkout can never disagree.

### 3.3 Where it is merchandised (each surface has its own on/off switch and wording)

1. **Product page, a line under the buy box.** A quiet row in the same style as the existing Amazon-pattern rows: "Add any second product, save 5% on both. Sets of 3 save 10%." If the shopper already has a different product in the cart, the line becomes personal: "Add this and save 5% on both." It sits with the other buy-box rows so it never jumps around.
2. **"You might also like"** gets a caption under its title: "Add any of these, save 5% on both" (or the next step the shopper is one product away from).
3. **"Frequently bought together"** gets a caption ("Buy all 3 together, save at least 10%"), and its total shows both numbers: "€171.00 → €153.90". The button reads "Add all 3 and save 10%". Because that button already adds everything in one go, the app sees three different products and attaches KIT3 straight away, so the drawer opens already showing the saving. "At least", because a shopper who already has other products in the cart may land on a higher tier. With only two rows the caption and maths say 5%. Sachets and gift products never appear among the suggestions.
4. **Cart drawer nudge.** One line, always pointing at the next step: "Add 1 more product to save 10% on everything." Once a tier is reached, a small two-line reconciliation ("Subtotal €171.00 · Set savings −€17.10 (KIT3)") plus "Add 2 more products to save 20%." Discounted rows show their old and new price so the lines visibly add up to the footer.
5. **In-cart offers, reframed as "Complete your set and save".** The block of suggested other products gets the title "Complete your set and save 5%" (the percentage is the next tier). Each card shows its price as it will be once added ("€57 → €54.15"). Adding one triggers the tier, so the promise is kept the instant they click. The existing ladder cards ("2 jars, save 15%") keep their wording, because they talk about jars of the same product; for a one-product cart the ladder card keeps priority and the set message lives in the "complete your set" title. See section 12 on how I read "unify with the ladder".

### 3.4 Interaction with prices and other discounts

- Ladder prices are ordinary variant prices; KIT percentages apply on top, as intended.
- Joy subscription −5% is a selling-plan price; KIT applies on top for the first order only.
- Only one KIT code per order, ever.
- Joy referral and reward codes: with their current "combine with nothing" setting, a referral holder cannot have KIT savings and their referral at the same time, and Shopify keeps whichever is worth more to the shopper. Decision 4 asks you to make Joy's codes combinable with product discounts (and shipping, if you take the guarantee below). If you cannot, the app's rule is: never remove the shopper's own code; stand down on KIT and gifts and say so in the drawer.

### 3.5 The free-shipping side effect and the guarantee (opt-in per market)

When a percentage code applies, Shopify lowers the discounted subtotal, and your free-shipping rate (€150 in most markets) is checked against that discounted number. A shopper with two products at €152 who gets 5% off ends up at €144.40 and could **lose free shipping by adding a second product**. That is a nasty surprise, and it also makes the meter lie.

The plan handles this with a second, separate automatic discount run by the same referee: a **free-shipping guarantee**. For markets where you switch it on, it makes the *standard* delivery option free whenever the merchandise total *before* percentage discounts (gift lines excluded) meets that market's free-shipping threshold, the same threshold the bar already shows. Express and priority options are never touched. It only ever fires for markets with an explicit threshold you have confirmed; it never uses the app's default €150 fallback. Where your shipping settings already give free shipping, "100% off zero" changes nothing.

Result: the meter, the gifts and free shipping all use one definition of "how much have I spent": the merchandise total before any percentage discount, gift lines and the protection line excluded. Generous, stable (adding a product can never move you backwards), and easy to explain.

Two things to know: the guarantee also helps a shopper whose Joy referral code pushed them under the threshold (a small, positive policy change; decision 3), and if you would rather the app never touched shipping, the alternative is a meter that measures the after-discount total, which works but lets shoppers visibly move backwards.

### 3.6 The tier ladder, with numbers

Your defaults stay in unless you say otherwise. Please look at this before signing off:

- Catalogue: 11 full-size products. Tier 4 at 10 different products means almost the entire shelf; the nudge after tier 3 reads "Add 5 more products to save 30%", which nobody acts on.
- Maximum stack: 30% set savings on top of 20% ladder pricing on top of 5% Joy ≈ 47% off, plus tier-3 gifts, plus free shipping.
- Alternatives worth considering: 2/3/4/6 products at 5/10/15/20%, or keep 2/3/5 and make 30% a "full routine (8+)" tier. Whatever you pick, the app shows a stacking table (ladder × set × Joy) on the settings page so the worst case is never a surprise.
- Before fixing amounts, we pull a baseline from your orders: what share of orders already contain 2, 3 or 5 different products, and already exceed €119, €200, €350. That share is the discount you would give away for nothing, and it is the first number a conversion specialist asks for.

---

## 4. Feature B: Gift tiers

### 4.1 The rule

Per market, a list of spend thresholds in that market's currency, each with its gifts. Your euro example: €119 → free Lip Plumping Formula or a sample set; €200 → bamboo towels + more samples, on top of tier 1; €350 → premium cosmetic bag + even more samples, on top. Tiers are cumulative by default (a tier keeps everything from below); you can switch that off per tier.

"Spend" is the same number as in section 3.5: merchandise before percentage discounts, gift lines and protection line excluded, compared in the cart's currency.

### 4.2 Gifts are real products, made free by the referee

- When a threshold is crossed, the app adds the gift as a normal cart line with a hidden marker, quantity 1. The referee sees the marker, checks that the cart really meets that gift's threshold in that market, and applies 100% off for exactly one unit. Extra units, or a gift added by hand without qualifying, are charged at full price. If a shopper bumps the gift quantity, the app resets it to 1; the referee's one-unit cap is the last line of defence.
- When the cart drops below the threshold, the app removes the gift line.
- **The honesty rule**: a gift line that is not actually free after all discounts (for example because a non-combinable referral code won the tie) is removed, in the drawer and again at checkout, and the shopper sees "Free gift not available with this code". Nobody ever pays for a gift by accident. The checkout removal cannot run inside Apple Pay or Google Pay, which is why the drawer does it first.
- In the drawer and on the cart page the gift row is restyled after every redraw: quantity controls hidden, price shown as "~~€37~~ FREE", a small "Free gift" tag, the theme's own subscription toggles hidden on that row, and a quiet "remove" link. If the shopper removes a gift, we remember it for the session and do not re-add it; the meter shows "add your free gift back" instead.
- Auto-adding never pops the drawer open by itself; the app updates the cart quietly in the background, and a short "Free gift added" notice appears when the drawer is open. When the tier is crossed by an add-to-cart, the theme opens the drawer anyway, so the gift is seen at once.
- Gift products are kept out of everything else: they never count as a "different product", never get KIT percentages, never appear in cross-sell, "Frequently bought together", "You might also like" or the checkout upsell, and never trigger ladder or subscription offers.

### 4.3 Gift pools, choice, and samples

Each tier holds an ordered list of gift options. Two kinds:

- **A specific product** (Lip Plumping Formula 1 stick, bamboo towels, cosmetic bag). If that product is already in the cart as a paid line, the tier falls to its next option, so nobody ends up with two.
- **A sample set**: "N sachets from the sachet pool". Selection rule (configurable): prefer sachets of products **not** already in the cart (my recommended default; the gift becomes a discovery tool that feeds future orders), or rotate, or a fixed set. Sample counts are absolute per tier (for example 2 / 3 / 3), never open-ended, and the total number of gift lines per cart is capped (default 4) so a €350 cart is not twelve gift lines in the drawer, on the packing slip and at the 3PL. Because there are only 9 sachet products, high tiers will partly repeat products the shopper owns; a pre-packed "Discovery set" product per warehouse (one line, one pick) is a cleaner option if you want it (decision 6).

Per tier you choose "auto-add the first available option" (default; the gift is in the cart the moment they qualify, which is what lifts conversion) or "let the shopper choose" (a small chooser inside the gift row: "Prefer the sample set? Swap").

Gift economics worth a look: the full-size lip formula is also your natural €37 add-on and the most likely "frequently bought together" pick. Making it free at €119 will displace some paid lip-formula sales above €119. Cost is trivial (€5.94), the displaced revenue is not. Consider towels or a discovery set at tier 1 and the lip formula at tier 2, or keep it and we track "lip formula attach rate" as a named number.

### 4.4 Store preparation the gifts need

- Bamboo towels: publish to the Online Store (the app can do this) but hidden from search and collections, and give them a real price rather than €0. A €0 product published to the store can be added free by anyone in any quantity, and "~~€0~~ FREE" strikes through nothing.
- Cosmetic bag: make it active and published, hidden the same way. Note the law: saying "worth €39" for a bag never actually sold at €39 is a fictitious reference price under EU consumer rules; either really sell it at €39 or say "free gift" without a value.
- Both need a product type such as "Gift" and a small change to your "Shop All" collection rule so they do not automatically join it, plus a "hidden from search" flag. The app's health page will check all of this.
- Sachets: keep at €1 (the referee makes them free only when earned).
- Sample stock in the US, Swiss and Irish warehouses: either send sachets there, or accept that those markets get a sachet-free pool. The stock watch below handles it automatically once you decide.

### 4.5 Inventory awareness

- **Warehouse map**: market → warehouse(s), pre-filled from your own Shopify shipping setup (which location ships to which country) and editable. Shopify's order-routing rules, not the app, decide how a mixed order is split; the map exists so we never auto-add a Germany-only sachet into a US cart and cause a second parcel for a €0.05 sample.
- **Stock watch**: the app listens to Shopify's stock updates for the gift products and re-checks on every settings save. For each market and gift option it computes "available at the mapped warehouse(s)" against a safety floor expressed as days of cover (default 3 days of that gift's own velocity, minimum 100 for sachets, because campaign velocity can outrun a fixed number). Below the floor, that option is paused in that market and the tier falls back to the next option; if nothing is left, the tier is paused and the meter skips it. It un-pauses by itself when stock returns. The dashboard shows "Gift stock by market" with paused rows highlighted, and the health page warns you.
- The referee itself never reads stock; the app writes the current per-market availability into the referee's small settings record, so the storefront and checkout agree.

### 4.6 Currency handling

Thresholds are stored per market as an amount plus a currency, exactly like the free-shipping thresholds today. For markets where you enter nothing, the EUR defaults are converted with Shopify's live rate, both in the storefront and inside the referee (Shopify hands it the rate). Where you enter an amount, that exact amount is used everywhere, so the meter, the gift decision and checkout can never disagree. A "suggest amounts" button pre-fills all non-EUR markets from your EUR numbers so you only tidy the ones you want rounder (US$129, £99, and so on); the multi-currency markets (EU, Rest of World) are locked to EUR by design. Entering amounts for every non-EUR market is a launch prerequisite: converted-at-the-rate amounts can differ by a cent between storefront and checkout at exactly the threshold, and we would rather the meter be a cent stricter than the referee.

---

## 5. The rewards meter (how the two features work together)

The current free-shipping bar becomes one **rewards meter** when either new feature is on for the market:

- A single bar with milestones along it: free shipping (€150), gift 1 (€119), gift 2 (€200), gift 3 (€350), sorted by amount, drawn in the market's currency. The fill runs to the next milestone. The headline is always the nearest money milestone: "You're €23 from a free gift worth €37" → "Free gift unlocked. €31 more for free shipping" → "€81 more for the bamboo towel set".
- Below it, always its own line, the set-savings step, because that one counts products, not money: "Add 1 more product to save 10% on everything."
- One headline and one line, never more. A conversion tip: four milestones is a lot of stops; aligning gift 1 with the free-shipping threshold (both at €119 or both at €150) makes the meter three stops and keeps free shipping, the strongest motivator, from sitting "after" a gift.
- If gift tiers are off for a market but the free-shipping bar is on, the meter is simply the free-shipping bar as today, with its own market targeting still respected.

---

## 6. Admin experience

One new page, **Rewards**, with two cards laid out like the existing feature pages (same save flow, same Market targeting card, same "Market reach: N markets" caption and Edit markets link, same product picker):

**Set savings**: master switch; tier table (products → % → code) with the stacking table underneath; per-surface switches and wording for the five surfaces; a "Connect KIT codes" button that creates or updates the codes in Shopify with a clear warning (section 10); options for subscription lines; the per-market product exclusions card you know from the delivery features; the checkout line text ("KIT3 applied: 10% off your set").

**Gift tiers**: master switch; per-market threshold rows (amount + currency, prefilled, "suggest amounts"); gift options per tier with a variant picker; sample-set rules and caps; cumulative on/off; auto-add or let them choose; the free-shipping guarantee opt-in per market; the warehouse map; the safety floor; a live "Gift stock by market" table.

Both appear in the Markets page and the Features hub automatically, both are flippable in the experiment tracker, and the dashboard gets two new cards.

**Wording in 17 languages.** The Greek and Arabic wording files have no room left, so the new phrases do not go into the theme's wording files. Instead the app ships English defaults built into its storefront files (so nothing is ever blank), fills all 17 languages automatically with the app's existing DeepL translation step the moment you save, marks them "machine translated, please review", and lets you edit any language on the Rewards page. Copy is written to avoid plural traps ("1 product to go", "2 products to go" as separate phrases) so Polish, Greek and Arabic read correctly. Translate & Adapt does not see these phrases; the Rewards page replaces it for this feature only.

---

## 7. Preview before going live

Today the preview can switch draft features on for your own session, but it cannot fake a cart total, and tier amounts have no draft state. Two additions:

1. **Draft amounts.** Tier tables and thresholds get a draft copy inside the preview you already use, so you can change amounts and see them before pressing "Go live". The referee honours the draft too: it recognises the preview marker on your cart and evaluates the draft rules, so a preview checkout shows exactly the discount and free gift a live shopper would get after go-live. Draft honouring stops when preview is disarmed or after the existing 48-hour preview window.
2. **Cart simulator and live rehearsal.** In the Preview Center and in the small preview bar on the storefront, a "simulate cart" control: a slider for the spend and a stepper for "different products in cart", per market. It redraws the meter, nudges, captions and bundle maths instantly without touching any real cart. Then a "Live rehearsal" toggle: your own preview cart really gets gift lines and KIT codes added and removed as you shop, and checkout shows the real numbers.

Honest limits: the storefront still formats money in the market you are actually browsing, so to see US dollars you open the store in the US market (the preview page will offer market-specific links); and a completed rehearsal checkout is a real order that deducts real gift stock unless you cancel it or use a test payment. Rules that keep preview safe: nothing is ever auto-added to a live shopper's cart from a draft, simulation never changes a cart, rehearsal is an explicit toggle, and with preview off the storefront behaves exactly as today (our automated checks enforce this).

---

## 8. Safety nets, abuse and edge cases

- Shopper types a KIT code they do not qualify for → refused, or the tier they do qualify for; only one KIT code per order.
- Shopper adds a gift by URL without qualifying → charged full price; the drawer and checkout remove it.
- Gift not actually free (code conflict, outage) → removed, with a message.
- Shopper raises gift quantity → reset to 1; only one unit ever free.
- Cart drops below a threshold → gift removed; if already in checkout, the checkout add-on removes it (not inside Apple/Google Pay; the drawer acts first).
- Gift out of stock in that market → paused automatically; tier falls back or hides; the meter never promises what cannot ship.
- Shopper's own non-combinable code → we never remove it; we stand down and log it.
- Express checkout from the drawer (Shop Pay etc.) → code and gift are already on the cart, so they carry. The theme has no "Buy it now" button on product pages, so nothing bypasses the cart.
- Cart page (not just the drawer) → same behaviour, made loop-safe because that page reloads on every change.
- Multi-currency markets → EUR amounts converted at Shopify's rate on both sides.
- App server unreachable → the storefront shows what was already on the page; nothing breaks the theme.
- Returns: decide whether a returned €119 order keeps its free lip stick (decision 8).

---

## 9. Measurement

- New counted events: nudge shown/clicked, tier reached, code attached (with tier), gift added/removed/swapped/paused per market.
- When an order is paid, the app now records which codes were on it and which lines were gifts, so the dashboard shows: share of orders using each KIT tier, different products per order, gifts given per tier, lip-formula attach rate, and revenue from the "complete your set" cards.
- The experiment tracker measures **before/after per market** (it is not an A/B tool; it compares a market's window with its own preceding window). Primary numbers: net revenue per session and gross margin per order per market. Secondary: share of orders reaching each tier, different products per order, attach rate. Run at least two weeks per market (weekly patterns, subscription cycles), and take the pre-launch baseline from section 3.6 first.

---

## 10. Build order and what changes for you

**Step 0, decisions and store prep (you)**: answer section 11; publish the towel and activate the bag with real prices, hidden from search and out of "Shop All"; make Joy's referral and reward codes combinable; decide sachet stock outside Germany; enter non-EUR thresholds (or approve "suggest amounts"); read the baseline numbers.

**Step 0.5, a half-day live check (us)**: on your store, confirm how Shopify reports codes in the cart, how a referee-backed code shows in the drawer totals, what a referral code does next to a KIT code, and what a refused code looks like at checkout. Cheap insurance before building.

**Step 1, engine (invisible to shoppers)**: the referee; new permissions (discounts, stock, locations) with the one-time re-approval; the Rewards page; the referee's settings record; draft amounts in preview; automatic health checks; the two automatic discounts created switched off; the KIT codes created under temporary names. Nothing changes for shoppers, and today's KIT codes keep working as they do now.

**Step 2, set savings surfaces**: at go-live of set savings, in one action, the old KIT2/3/5 codes are retired and the new KIT2/3/5/10 take their names (codes are unique per shop; the old codes' usage history is lost, and from that moment a cart of 3 units of one product no longer gets 10%: decision 5). Then: cart attaches codes; nudge and reconciliation lines; "complete your set" reframe; product-page line; captions and bundle maths; counting.

**Step 3, gift tiers**: auto add/remove; row restyling; rewards meter replacing the free-shipping bar; checkout safety net; stock watch and warehouse map; free-shipping guarantee switched on per market; counting.

**Step 4, preview and launch**: cart simulator, live rehearsal, per-market go-live through the Markets page, experiments. Suggested first market: **Germany or the Netherlands** (served by the German warehouse, which holds every gift), not Ireland (Amphora has no sachets or bag) unless Amphora is stocked first. Then the other euro markets, then non-EUR markets once their thresholds are set.

Each step ships as a normal app update with the usual automated checks (one storefront file's size allowance goes up slightly for the new rows). Also for you: a short shopper-facing explainer page ("How set savings and free gifts work") for support and for the checkout code line, and a note to your 3PLs that gift lines print at €0.00.

---

## 11. Decisions I need from you (with my recommended default)

1. **Which lines count toward and receive set savings?** Default: all full-size products; subscription lines count and get it on the first order only; never sachets, gifts, protection line, wholesale.
2. **Codes vs automatic.** Default: keep KIT codes as you asked (visible at checkout, marketing-friendly). The no-code version uses the same referee but is a different discount type with a different connect flow, so it is a decision, not a toggle.
3. **Free-shipping guarantee** (section 3.5). Default: yes, standard delivery option only, opt-in per market, and it applies to any qualifying pre-discount cart (including referral-code carts).
4. **Joy referral and reward codes**: make them combinable with product (and shipping) discounts. Default: yes, in Joy's settings, before step 2. Without it, referral holders lose either the referral or the gift and KIT savings.
5. **KIT semantics change**: from step 2, "3 units of one product" no longer gets 10%; only 3 different products do. Are the KIT codes in live ads or emails today? Default: proceed, with the shopper explainer page.
6. **Gift definition per tier and per region.** Confirm the euro example (119 / 200 / 350) or align gift 1 with free shipping; confirm lip formula at tier 1 despite the displacement risk; individual sachets vs a pre-packed Discovery set; the towel and bag prices; sachet stock outside Germany. Default: towel or Discovery set at tier 1, lip formula at tier 2, bag at tier 3, cumulative, auto-add with swap, sachet-free pool for US/CH/IE until stocked.
7. **Tier ladder** (section 3.6). Default: keep 2/3/5/10 at 5/10/20/30 as you asked, after you have seen the baseline and the stacking table.
8. **Returns**: does a returned order keep the gift? Default: gift must be returned or its value is deducted, stated in the returns policy.
9. **First market and thresholds for non-EUR markets.** Default: Germany first, then Netherlands; "suggest amounts" for non-EUR markets, tidied by you.

Defaults you can change later without deciding now: shoppers may remove a gift (remembered for the session); wording via the Rewards page with DeepL prefill; safety floor 3 days of cover / min 100 sachets; total gift lines per cart capped at 4.

---

## 12. How I read your brief (correct me if wrong)

- **"Unifying the logic with the existing variant ladder."** I read this as one coherent savings system in the cart: the ladder cards and the set nudge share one "next best step" engine so they never contradict each other, and the ladder stays as variant prices. I did **not** read it as "2-jar and 3-jar variants count as 2 or 3 toward set tiers"; that would double-reward the same units and I advise against it. Say the word if you meant the latter.
- **"The in-cart upsell reframed as complete your set and save."** In the app the "cart upsell" label belongs to the ladder cards; the "other products" block is the cross-sell. I applied the reframe to the block that adds *other* products, gave the whole offers area one consistent "Complete your set and save" frame, and left the ladder cards' jar wording alone (they get priority for one-product carts). If you meant the ladder cards themselves should be reworded, that is a copy change, not a structural one.
- **"Auto-apply in cart + at checkout."** In the cart: yes, and it carries into checkout. At checkout: best-effort re-attach only when no code is present, never inside Apple/Google Pay.
- **"Integrates with the existing market exclusion system."** Both halves: per-market on/off (Market targeting) and per-market product exclusions, enforced in the storefront and in the referee.
- **"Very customisable."** Tiers, thresholds, pools, sample rules, cumulative, choice, per-surface switches and wording, per-market everything, safety floor, warehouse map, checkout line text.
- **"Perfect preview."** Draft amounts, simulator, rehearsal, referee honouring drafts; with the two honest limits in section 7.

---

## Appendix: for the developer

Kept short; the research reports hold the file-and-line detail.

- **Discount architecture**: one Function extension (unified Discount Function API, cart.lines target plus delivery-options target), backing (a) the KIT code discount(s): product class, `combinesWith` product+order+shipping true, grant only when the triggering KIT code equals the tier the cart qualifies for (or highest entered KIT code if `enteredDiscountCodes` is available at the chosen API version), `appliesOnSubscription` true with `recurringCycleLimit` 1; (b) "Cellexia gifts" automatic: product class only, 100% off `cartLine{id, quantity:1}` for lines carrying `_cellexia_gift` whose variant is in the tier pool for the buyer's country→market and whose pre-discount non-gift spend meets the tier; (c) "Cellexia free shipping guarantee" automatic: shipping class only, cheapest delivery option per group, only for opted-in markets with an explicit threshold, never the global fallback. Prefer one KIT node with four redeem codes if `discountRedeemCodeBulkAdd` accepts app discounts; otherwise four nodes with the "triggering code must match" rule. Market gate on `localization.country.isoCode` through a country→market map (market handle is deprecated in Function input). Config from a dedicated small shop metafield (`$app:cellexia/rewards`, well under 10 KB) written in the same `metafieldsSet` as the two existing mirrors, holding live + draft (+ tokenHash while armed), tier tables, per-market amounts, pools, per-market gift availability, exclusions, opt-ins. Draft honoured when cart attribute `_cx_preview` equals tokenHash.
- **Scopes/toolchain**: add `write_discounts`, `read_inventory`, `read_locations`; subscribe `inventory_levels/update`; function build rides `shopify app deploy`; Functions in a custom app need Plus (store is Plus).
- **Storefront**: `POST /cart/update.js {discount}` replaces the whole code set: always send the union of the shopper's codes plus the KIT code; treat `applicable:false` as stand-down, at most one correction per cart change. New shared `spendCents()` = Σ `original_line_price` over non-gift, non-protection lines, used by shipbar, az free line, meter and nudges (today they read `items_subtotal_price`, which drops the moment a product-class code applies). `quietRefresh()`/`themeRefresh()` must write `total_price` into the theme's footer spans, not `items_subtotal_price`. Line property `_cellexia_gift` (the `_cellexia_*` prefix is what the webhook and extensions already recognise; `_cx_*` is for cart attributes). Gift-row decorator matches rows by index into `state.cart.items` inside `renderAll()` after `fetchCart()`, never inserts siblings inside `.mini-cart__list`, restyles via CSS + textContent only. Exclude gift lines and sachets from `distinctProductCount`, `upgradeCandidates`, `findPlanForItem`, cross-sell/FBT/similar picks (extend the protection-handle exclusion) and the checkout-upsell exclusions. Reset gift quantity to 1 on change. Cart page: idempotent by cart signature. One tier helper twinned byte-for-byte across cart and pdp assets (harness twin rule) plus a sim that runs the Function's logic on the same fixtures; ES5 only.
- **Settings**: two FeatureKeys only (`set_savings`, `gift_tiers`), surfaces as sub-flags; new dynamic-record keys with distinct names and sanitize/validate pairs and caps (pools at section level ≤4 tiers × ≤4 options; per market only amounts + currency; exclusions record; location map); Liquid emits only the current market's numbers plus gift option price/title/image; documented Liquid budget move (currently 475 B headroom under 96,500; cap 102,400); FeatureKey pins 35→37; ALLOWED_FEATURES/TYPES/LABELS; `OrderPayload` + `OrderStat` gain discount codes and gift flags (migration in both Prisma schemas).
- **Preview**: `draftConfig` gains `simCart`, draft tiers/thresholds, `rehearsal` flag (add to both duplicated validators); per-market tables for the simulated market come from `preview-config` JSON, not Liquid; PreviewDiagnostic line in the checkout extension for "gift not eligible: €X below €Y".
- **Stock watch**: `GiftStock{shop, market, variantId, available, updatedAt}` recomputed on settings save, on the filtered inventory webhook, and lazily when a proxy read finds it older than 15 min; availability served through the existing `cart-data` proxy call, never through the settings blob (each settings write is a full metafield re-sync); fail closed at add time.
- **Copy**: English defaults in the JS assets, proxy-served overrides via the existing `translate_boosters` DeepL path, cached per session; no plural objects.
- **Health checks**: KIT nodes exist/active and bound to the deployed function; both automatic nodes present (active as expected); gift variants active, published to Online Store, in the buyer markets' catalogues, hidden from search, not in Shop All, excluded from recommendation surfaces, in stock at mapped locations; rewards metafield fingerprint; warehouse map covers all enabled markets; free-shipping thresholds still match Shopify's rates (with a periodic re-detect).
- **Live spike (step 0.5)**: `discount_codes` presence/shape in `/cart.js`; Function-backed code reflected in drawer totals; cookie-applied Joy code visible in the cart's code set; `applicable:false` surface; refused-code appearance at checkout; Joy conflict outcome before and after enabling combinability.
