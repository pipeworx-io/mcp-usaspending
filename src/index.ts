interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * USAspending MCP — Federal spending data from USAspending.gov API
 *
 * No auth required. All endpoints use POST with JSON body.
 *
 * Tools:
 * - usa_spending_by_agency: federal spending breakdown by agency
 * - usa_award_search: search contract awards by keywords, agency, date range, NAICS
 * - usa_spending_by_category: spending by NAICS, PSC, recipient, or agency
 * - usa_recipient_profile: get a specific contractor's federal spending profile
 * - usa_spending_trends: spending over time for keywords or agency
 */


const BASE = 'https://api.usaspending.gov/api/v2';

async function usaPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Pipeworx/1.0 (gateway.pipeworx.io)',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`USAspending API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'usa_spending_by_agency',
    description:
      'Get federal spending breakdown by agency for a given fiscal year and optional quarter. Shows how much each agency has spent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fiscal_year: {
          type: 'string',
          description: 'Four-digit fiscal year (e.g., "2025"). Defaults to current year.',
        },
        quarter: {
          type: 'number',
          description: 'Fiscal quarter (1-4). Omit for full year.',
        },
      },
    },
  },
  {
    name: 'usa_award_search',
    description:
      'Search federal contract awards by keywords, agency, date range, and NAICS code. Returns recipient, amount, dates, agency, and description. Award types: A=BPA Call, B=Purchase Order, C=Delivery Order, D=Definitive Contract.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search keywords (e.g., ["cybersecurity", "cloud"])',
        },
        agency: { type: 'string', description: 'Awarding agency name (e.g., "Department of Defense")' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        naics: { type: 'string', description: 'NAICS code to filter by (e.g., "541512")' },
        set_aside: { type: 'string', description: 'Set-aside type filter' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10)' },
      },
      required: ['keywords', 'start_date', 'end_date'],
    },
  },
  {
    name: 'usa_spending_by_category',
    description:
      'Get federal spending broken down by category: NAICS code, PSC (product/service code), recipient, awarding agency, or awarding subagency. Useful for market analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category to group by: naics, psc, recipient, awarding_agency, awarding_subagency',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional keywords to filter spending',
        },
        agency: { type: 'string', description: 'Optional awarding agency name filter' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10)' },
      },
      required: ['category', 'start_date', 'end_date'],
    },
  },
  {
    name: 'usa_recipient_profile',
    description:
      'Get a specific contractor or recipient\'s federal spending profile. Shows all contract awards for the named recipient within a date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        recipient_name: { type: 'string', description: 'Recipient/contractor name to search for (e.g., "Lockheed Martin")' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10)' },
      },
      required: ['recipient_name', 'start_date', 'end_date'],
    },
  },
  {
    name: 'usa_spending_trends',
    description:
      'Get federal spending over time for given keywords or agency. Returns spending grouped by fiscal year, quarter, or month. Useful for trend analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to track spending for (e.g., ["artificial intelligence"])',
        },
        agency: { type: 'string', description: 'Optional awarding agency name' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        group: {
          type: 'string',
          description: 'Time grouping: fiscal_year, quarter, or month (default fiscal_year)',
        },
      },
      required: ['keywords', 'start_date', 'end_date'],
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'usa_spending_by_agency':
      return spendingByAgency(args);
    case 'usa_award_search':
      return awardSearch(args);
    case 'usa_spending_by_category':
      return spendingByCategory(args);
    case 'usa_recipient_profile':
      return recipientProfile(args);
    case 'usa_spending_trends':
      return spendingTrends(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildFilters(args: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  if (args.keywords) {
    filters.keywords = args.keywords;
  }

  if (args.start_date && args.end_date) {
    filters.time_period = [
      { start_date: args.start_date as string, end_date: args.end_date as string },
    ];
  }

  if (args.agency) {
    filters.agencies = [
      { type: 'awarding', tier: 'toptier', name: args.agency as string },
    ];
  }

  if (args.naics) {
    filters.naics_codes = [args.naics as string];
  }

  if (args.set_aside) {
    filters.set_aside_type = [args.set_aside as string];
  }

  // Default to contract award types (exclude grants, loans, etc.)
  filters.award_type_codes = ['A', 'B', 'C', 'D'];

  return filters;
}

// ── Response types ──────────────────────────────────────────────────────

type SpendingAgencyResult = {
  results?: {
    name: string;
    amount: number;
    abbreviation?: string;
  }[];
  total?: number;
};

type AwardResult = {
  results?: Record<string, unknown>[];
  page_metadata?: {
    page: number;
    total: number;
    limit: number;
    last_record_unique_id?: number;
    last_record_sort_value?: string;
  };
};

type CategoryResult = {
  results?: {
    name: string;
    amount: number;
    code?: string;
    id?: number;
  }[];
  category?: string;
  total_metadata?: { count: number };
};

type TrendsResult = {
  results?: {
    time_period: {
      fiscal_year: string;
      quarter?: string;
      month?: string;
    };
    aggregated_amount: number;
  }[];
  group?: string;
};

// ── Tool implementations ────────────────────────────────────────────────

async function spendingByAgency(args: Record<string, unknown>) {
  const fiscalYear = (args.fiscal_year as string) ?? String(new Date().getFullYear());
  const body: Record<string, unknown> = {
    type: 'agency',
    filters: { fy: fiscalYear },
  };
  if (args.quarter) {
    (body.filters as Record<string, unknown>).quarter = String(args.quarter);
  }

  const data = (await usaPost('/spending/', body)) as SpendingAgencyResult;

  return {
    fiscal_year: fiscalYear,
    quarter: args.quarter ?? null,
    total: data.total ?? null,
    agencies: (data.results ?? []).map((r) => ({
      name: r.name,
      amount: r.amount,
      abbreviation: r.abbreviation ?? null,
    })),
  };
}

async function awardSearch(args: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const filters = buildFilters(args);

  const body = {
    filters,
    fields: [
      'Award ID',
      'Recipient Name',
      'Award Amount',
      'Total Outlays',
      'Start Date',
      'End Date',
      'Awarding Agency',
      'Awarding Sub Agency',
      'Description',
      'NAICS Code',
      'Contract Award Type',
    ],
    limit,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
  };

  const data = (await usaPost('/search/spending_by_award/', body)) as AwardResult;

  return {
    total_results: data.page_metadata?.total ?? 0,
    limit,
    awards: (data.results ?? []).map((r) => ({
      award_id: r['Award ID'] ?? null,
      recipient_name: r['Recipient Name'] ?? null,
      award_amount: r['Award Amount'] ?? null,
      total_outlays: r['Total Outlays'] ?? null,
      start_date: r['Start Date'] ?? null,
      end_date: r['End Date'] ?? null,
      awarding_agency: r['Awarding Agency'] ?? null,
      awarding_sub_agency: r['Awarding Sub Agency'] ?? null,
      description: r['Description'] ?? null,
      naics_code: r['NAICS Code'] ?? null,
      contract_type: r['Contract Award Type'] ?? null,
    })),
  };
}

async function spendingByCategory(args: Record<string, unknown>) {
  const category = args.category as string;
  const validCategories = ['naics', 'psc', 'recipient', 'awarding_agency', 'awarding_subagency'];
  if (!validCategories.includes(category)) {
    throw new Error(`Invalid category "${category}". Must be one of: ${validCategories.join(', ')}`);
  }

  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const filters = buildFilters(args);

  const body = {
    filters,
    limit,
    page: 1,
  };

  const data = (await usaPost(`/search/spending_by_category/${category}/`, body)) as CategoryResult;

  return {
    category,
    total_count: data.total_metadata?.count ?? 0,
    results: (data.results ?? []).map((r) => ({
      name: r.name,
      amount: r.amount,
      code: r.code ?? null,
      id: r.id ?? null,
    })),
  };
}

async function recipientProfile(args: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const filters: Record<string, unknown> = {
    keywords: [args.recipient_name as string],
    award_type_codes: ['A', 'B', 'C', 'D'],
  };

  if (args.start_date && args.end_date) {
    filters.time_period = [
      { start_date: args.start_date as string, end_date: args.end_date as string },
    ];
  }

  const body = {
    filters,
    fields: [
      'Award ID',
      'Recipient Name',
      'Award Amount',
      'Total Outlays',
      'Start Date',
      'End Date',
      'Awarding Agency',
      'Awarding Sub Agency',
      'Description',
      'NAICS Code',
      'Contract Award Type',
    ],
    limit,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
  };

  const data = (await usaPost('/search/spending_by_award/', body)) as AwardResult;

  return {
    recipient_name: args.recipient_name,
    total_results: data.page_metadata?.total ?? 0,
    limit,
    awards: (data.results ?? []).map((r) => ({
      award_id: r['Award ID'] ?? null,
      recipient_name: r['Recipient Name'] ?? null,
      award_amount: r['Award Amount'] ?? null,
      total_outlays: r['Total Outlays'] ?? null,
      start_date: r['Start Date'] ?? null,
      end_date: r['End Date'] ?? null,
      awarding_agency: r['Awarding Agency'] ?? null,
      awarding_sub_agency: r['Awarding Sub Agency'] ?? null,
      description: r['Description'] ?? null,
      naics_code: r['NAICS Code'] ?? null,
      contract_type: r['Contract Award Type'] ?? null,
    })),
  };
}

async function spendingTrends(args: Record<string, unknown>) {
  const group = (args.group as string) ?? 'fiscal_year';
  const validGroups = ['fiscal_year', 'quarter', 'month'];
  if (!validGroups.includes(group)) {
    throw new Error(`Invalid group "${group}". Must be one of: ${validGroups.join(', ')}`);
  }

  const filters = buildFilters(args);

  const body = {
    group,
    filters,
  };

  const data = (await usaPost('/search/spending_over_time/', body)) as TrendsResult;

  return {
    group,
    data_points: (data.results ?? []).map((r) => ({
      fiscal_year: r.time_period.fiscal_year,
      quarter: r.time_period.quarter ?? null,
      month: r.time_period.month ?? null,
      amount: r.aggregated_amount,
    })),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
