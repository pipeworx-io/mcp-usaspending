# USAspending — Federal Contract & Grant Awards

The U.S. Treasury's USAspending.gov data on federal awards: contracts, grants, loans, and direct payments. Every dollar the federal government has awarded since 2008 (with patchier coverage going back to 2001), broken down by recipient, agency, sub-agency, NAICS code, and place of performance. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

Where [SAM.gov](/docs/reference/samgov) is *opportunities* (what the government is buying), USAspending is *awards* (what was actually contracted). For competitive intelligence, lobbying-spend ROI analysis, federal vendor research, or following the money on policy areas, this is the source of truth.

Common flows:

- **"How much has X received in federal contracts?"** → `get_federal_spending({recipient: "X"})` → award totals by year, agency.
- **"Who are the top contractors for the DoD?"** → spend search filtered by agency.
- **"Federal investment in AI / cybersecurity / clean energy?"** → keyword + NAICS / PSC code search.

Used by the `govcon_contractor_profile` and `lobbying_activity` recipes.

## Auth

None. USAspending is fully public, free.

## Award classes

| Class | What it is |
|---|---|
| Contracts (FPDS-NG) | Direct procurement; competitive or sole-source |
| Grants | Discretionary or formula awards (research, state grants) |
| Loans | Federal credit programs (SBA, USDA, Education) |
| Direct payments | Social Security, veterans benefits, etc. |
| IDV (Indefinite Delivery Vehicles) | Master contracts; orders flow against them |

For company-level analysis, contracts are usually what matters. Grants matter for universities and nonprofits.

## Common pitfalls

- **Recipient name normalization.** "Lockheed Martin Corporation," "LOCKHEED MARTIN CORP," "Lockheed Martin" all appear in the data. Aggregate case-insensitively after stripping legal suffixes for clean totals.
- **Parent vs subsidiary.** A large company has many subsidiaries, each with separate UEIs. USAspending includes parent-recipient hierarchy fields — use them for true company-level totals.
- **Obligated vs outlayed dollars.** "Obligated" is what the government committed; "outlayed" is what's actually been paid. The gap can be years for multi-year contracts.
- **NAICS codes for "we sell IT services."** A single contractor can have dozens of NAICS designations. Filtering by NAICS gets you only the awards classified that way; cross-NAICS analysis needs careful aggregation.
- **Lag.** Most awards appear within 30 days of obligation. The very-most-recent quarter is incomplete and revises upward.
- **Unique award IDs.** Awards have stable IDs (PIIDs for contracts, FAINs for grants). Use these for citation; recipient-level totals are the rolled-up view.
- **An IDV is not a contract type, and `IDV_A..IDV_E` is not the IDV set.**
  `usa_award_search` / `usa_recipient_profile` search contract types A-D and
  return IDVs as a SEPARATE `idvs` array, because a single request mixing
  contract and IDV codes is rejected upstream with HTTP 422. The full code set
  is `IDV_A, IDV_B, IDV_B_A, IDV_B_B, IDV_B_C, IDV_C, IDV_D, IDV_E` — the
  `IDV_B` subdivisions are load-bearing: CRS-2, NASA Launch Services II and
  CCtCap are all `IDV_B_B`, so filtering on `IDV_A..IDV_E` returns a few $0
  BPA/BOA/FSS rows and none of the money, which looks like a working IDV
  search. Read `idv_status` on every response: it says whether IDVs are in
  this answer, and reading only `awards` understated SpaceX/NASA by $6.79B
  (fleet #3386).
- **An IDV's dollars and its child orders' dollars are DISJOINT — combining
  them is correct, not a double count.** The IDV row carries obligations
  booked on the umbrella itself and each order carries its own; the parent is
  not a rollup. Measured: `NNK14MA74C` own obligation $1,241,839,006 against
  12 children summing $4,101,857,376, and `80KSC022DA109` is a $0 IDV with
  children summing $34,296,771 — a rollup would make those equal. The only
  error available here is understating by dropping IDVs. Group an order under
  its umbrella with `parent_idv_award_id` (contract rows) and
  `child_orders_in_results` (IDV rows); the parent link is parsed from
  `generated_internal_id`, since the search endpoint publishes no
  `parent_award_piid` and the detail endpoint returns null for it.

## Recompete calendar — `usa_expiring_awards` / `usa_incumbent_profile`

"Which VA IT contracts over $10M expire in the next 12 months, and who holds
them" is the core govcon business-development question, and these two tools
answer it directly — no key, no upstream throttle.

```
usa_expiring_awards({agency: "Department of Veterans Affairs", naics: "5415",
                     min_amount: 10000000, months_ahead: 12})
usa_incumbent_profile({recipient: "Booz Allen"})
```

`usa_expiring_awards` returns the incumbent, period of performance, obligated
dollars, agency/sub-agency, NAICS/PSC and a usaspending.gov link per award.
`usa_incumbent_profile` returns one contractor's portfolio: active awards, total
obligated, ceiling, expirations at 6/12/18 months, top agencies and NAICS.

These read `usaspending_awards_current`, a materialized view of **one row per
award** (626,306 awards from 1,510,983 transactions). Rebuild it after every
pipeline load with `select usaspending_refresh_awards_current();` — it also
restamps the `mirror_as_of` that every response carries.

### What will bite you

- **Grain.** The base table is one row per *transaction*. Every modification
  repeats the award's PIID, so querying `usaspending_contracts` directly counts
  one contract many times and sums its money just as often. Use the view.

- **Two different end dates.** `period_of_performance_current_end_date` is the
  recompete decision point. `period_of_performance_potential_end_date` is when
  all options would be exhausted. An award ending in 6 months whose options run
  3 more years will be *extended*, not recompeted — listing it as a lead is a
  false positive that looks exactly like a real one. `options_status` reports
  `options_remain` / `no_options_remain` / **`unknown`**, and it is `unknown`
  for everything loaded before 2026-08-28: the potential end date was dropped at
  ingest and only starts populating on the next pipeline run.

- **The end date is the latest transaction's, not the maximum.** 5,299 awards
  (0.88%) disagree between the two, because a later modification can *shorten*
  the period. Checked against api.usaspending.gov, latest-transaction matched
  upstream 5 times out of 6 and max matched once. Don't "fix" it to `max()`.

- **The date can still be stale.** A modification filed after `mirror_as_of` may
  have extended an award listed here as expiring — one $1.4B VA award read 14
  months early for that reason. The `usaspending_url` is the live check.

- **IDVs are excluded.** They are ordering vehicles with no period of
  performance, so they have no expiry. 443,315 transactions carry no end date,
  but only 22,221 of 626,306 *awards* lack one, because the date is taken from
  the latest transaction that actually has one.

- **`min_amount` filters obligated dollars, not the ceiling.** A lightly-used
  vehicle with a $40M ceiling and $40k of real work does not pass a $10M floor.

- **`mirror_as_of` comes from the data, not the snapshot filename.** Those have
  disagreed: the pinned snapshot URL read `contracts-all-20260506.zip` while the
  table held action dates through 2026-08-04.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "usaspending": {
      "url": "https://gateway.pipeworx.io/usaspending/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/usaspending/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/usa_spending_by_agency \
  -H 'Content-Type: application/json' \
  -d '{"fiscal_year":"2024"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/usa_spending_by_agency`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-usaspending` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/usaspending/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "usaspending": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-usaspending"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Usaspending data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
