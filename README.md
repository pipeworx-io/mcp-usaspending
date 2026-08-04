# USAspending — Federal Contract & Grant Awards

The U.S. Treasury's USAspending.gov data on federal awards: contracts, grants, loans, and direct payments. Every dollar the federal government has awarded since 2008 (with patchier coverage going back to 2001), broken down by recipient, agency, sub-agency, NAICS code, and place of performance. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Usaspending data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
