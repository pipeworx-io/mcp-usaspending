interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * USAspending MCP — Federal spending data from USAspending.gov API
 *
 * No auth required. All endpoints use POST with JSON body.
 *
 * Tools (seven — the list below was stuck at five while the recompete pair
 * shipped in #616, so anyone reading the header undercounted the pack):
 * - usa_spending_by_agency: federal spending breakdown by agency
 * - usa_award_search: search contract awards by keywords, agency, date range, NAICS
 * - usa_spending_by_category: spending by NAICS, PSC, recipient, or agency
 * - usa_recipient_profile: get a specific contractor's federal spending profile
 * - usa_spending_trends: spending over time for keywords or agency
 * - usa_expiring_awards: the recompete calendar — awards whose period ends soon
 * - usa_incumbent_profile: one contractor's whole portfolio and its expirations
 *
 * ── Two things to know before you touch a store-backed tool here (#1078) ──
 *
 * THE CLIENT TIMEOUT IS NOT A DIAL YOU CAN TURN. PostgREST enforces the
 * `authenticated` role's statement_timeout, 8s, and no client setting raises
 * it. mirrorRpc's 9s budget sits just past that on purpose. A query that needs
 * longer than ~8s cannot be made to work by waiting longer — it has to get
 * faster or return less.
 *
 * COUNT THE CTE REFERENCES BEFORE BLAMING THE DATA. usa_incumbent_profile took
 * 61 SECONDS and read like a volume problem. It was not: "Lockheed Martin"
 * matches 1,049 awards and aggregating them once takes about a second. The
 * function named its `mine` CTE eleven times, once per scalar in the
 * jsonb_build_object, so it counted the same thousand rows eleven times. A
 * trigram index on the leading-wildcard ILIKE took 61s to 17.5s; collapsing
 * the scalars into one FILTER pass took it to 165ms. Both are in migration
 * 126. If one of these functions is slow, EXPLAIN ANALYZE it and count the
 * references before you reach for an index or a bigger budget.
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'USAspending');
}


// One retry on 5xx / network error. Was infinite-recursing into itself
// (the inner call was `retryFetch` instead of `fetch`) — that blew CF
// worker CPU until the runtime killed the request with error 1102. The
// recursion bug poisoned every compound tool that touched this pack
// (govcon_opportunity_scan + ask_pipeworx-routed queries about federal
// spending). User filed ~15 bug reports about it 2026-05-18..21.
//
// Separately: USAspending sometimes hangs requests originating from
// Cloudflare egress IPs (responds in ~300ms from a residential IP, never
// responds from a CF Worker). Without an AbortController the worker sits
// in `await fetch()` until its execution budget runs out — outcome
// "canceled", wallTime ~30s, cpuTime ~4ms, no exception, gateway 503.
// Cap each attempt at FETCH_TIMEOUT_MS so a hang becomes a fast error
// the compound tools can fall through `safe()` on instead.
const FETCH_TIMEOUT_MS = 8000;
async function retryFetch(url: string, opts?: RequestInit): Promise<Response> {
  for (let i = 0; i < 2; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status < 500) return res;
      if (i === 1) return res;
    } catch (err) {
      clearTimeout(timer);
      // AbortError = our own timeout. The upstream is genuinely
      // unreachable (typically CF egress block); retrying with the same
      // path is pointless — bail immediately so safe() in compound tools
      // gets its fallback fast.
      if (err instanceof Error && err.name === 'AbortError') {
        // 2026-10-14: the raw AbortError booked as class=error (ours); 12 of 16
        // error rows in 3d were exactly this 8s abort on the live-API relay.
        throw new Error(`upstream_down: USAspending did not answer within ${FETCH_TIMEOUT_MS / 1000}s (${new URL(url).hostname}); retry shortly.`);
      }
      if (i === 1) throw err;
    }
  }
  throw new Error('Fetch failed after retry');
}

const BASE = 'https://api.usaspending.gov/api/v2';

// Set at the top of callTool from gateway-injected _proxyUrl/_proxyToken. When a
// non-CF relay is configured, POSTs are routed through it (the relay forwards
// method+body to USAspending from a non-CF IP and returns the response verbatim).
let PROXY: { url: string; token: string } | null = null;

async function usaPost(path: string, body: unknown): Promise<unknown> {
  const target = `${BASE}${path}`;
  const res = PROXY
    ? await retryFetch(PROXY.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROXY.token}` },
        body: JSON.stringify({ url: target, method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }),
      })
    : await retryFetch(target, {
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

// /search/spending_by_award/ returns page_metadata as
// {page, hasNext, last_record_unique_id, last_record_sort_value} — there is no
// `total` field on it at all. Reading `page_metadata?.total ?? 0` therefore
// reported "0 results" on every call while handing back a full page of awards
// (Microsoft 2025: we said 0, the real answer is 253). The genuine count lives
// on a separate endpoint, which takes the same filters object.
// Returns null when the count can't be established, so callers fall back to the
// page length rather than to a zero that reads as "no such recipient".
async function awardCount(filters: Record<string, unknown>): Promise<number | null> {
  try {
    const c = (await usaPost('/search/spending_by_award_count/', { filters })) as {
      results?: Record<string, unknown>;
    };
    const n = Object.values(c.results ?? {}).reduce<number>(
      (sum, v) => sum + (typeof v === 'number' ? v : 0),
      0,
    );
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ── Award-row semantics ─────────────────────────────────────────────────
//
// Two things about an award row are not self-evident and were costing callers
// a wrong answer in silence (fleet #3140).
//
// `total_outlays: null` does NOT mean nothing has been paid. Outlays are
// joined from Treasury account (File C) data, and DoD contract awards are
// largely not linked to it: measured 2026-10-15, 157 of Anduril's 159 DoD
// awards carried a null outlay while the one DHS award carried
// $102,177,321.75. The federal-account count endpoint confirms the cause —
// 0 linked accounts for the DoD award CONT_AWD_H9240224F0057_9700_… against
// 206 for the DHS award 70B02C26F00000035. So the null is an absence of
// REPORTING, and a reader treating it as an absence of SPENDING concludes a
// live contract is unpaid. Every row now carries `outlays_reported`, and the
// response says what the null means rather than leaving it to be guessed.
const OUTLAYS_NOTE =
  'total_outlays: null means NOT REPORTED, not zero paid — read `outlays_reported` on each row. ' +
  'Outlays are joined from Treasury account (File C) data and most Department of Defense contract ' +
  'awards are not linked to it, so DoD rows usually carry no outlay figure even where money has been ' +
  'paid. Recent awards lag as well: DoD contract data is published on roughly a 90-day delay.';

// The date filter selects awards ACTIVE in the window — an award that started
// in 2019 and still runs is returned for a 2024-2026 window — and
// `award_amount` is the award's lifetime obligated total, not the amount
// obligated inside the window. Summing award_amount over a window therefore
// overstates window spending, sometimes by years of it.
const PERIOD_NOTE =
  'start_date/end_date select awards ACTIVE during the window, not awards signed in it — awards that ' +
  'began years earlier and are still running are included. `award_amount` is the award\'s LIFETIME ' +
  'obligated total, not the amount obligated during the window, so summing it does not give spending ' +
  'for the period. For money moved inside a date range use usa_spending_trends or usa_spending_by_category.';

/** True when the upstream actually published an outlay figure (0 counts; null does not). */
function outlaysReported(v: unknown): boolean {
  return v !== null && v !== undefined;
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'usa_spending_by_agency',
    description:
      'Break down US federal contract spending by agency for a given fiscal year (default: current year) and optional quarter (1-4). Returns agency names, abbreviations, and dollar amounts from USAspending.gov.',
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
      'Search US federal PROCUREMENT CONTRACTS / government contract awards for goods and services. Use recipient_name for "contracts won by Lockheed Martin"; keywords searches award descriptions/topics, not contractor identity. Dates are optional and default to the last 12 months for "recent" questions. Dates select awards ACTIVE in the window (not signed in it) and award_amount is the award\'s LIFETIME obligation, so do not sum it as spending for the period. Results are paged: 100 per page max — pass `page` (and read `page_metadata.has_next`) to reach the rest. Returns recipient, award amount, outlays (with an outlays_reported flag, since DoD awards usually report none), dates, and contract type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search keywords (e.g., ["cybersecurity", "cloud"] or ["goods", "services"])',
        },
        recipient_name: { type: 'string', description: 'Contractor/recipient name (e.g., "Lockheed Martin"). Use for awards won by a company; do not put company names in keywords.' },
        state: { type: 'string', description: 'Place-of-performance US state, 2-letter code (e.g., "MD", "TX"). Filters to contracts performed in that state.' },
        agency: { type: 'string', description: 'Awarding agency — full toptier name ("Department of Defense") or the common abbreviation (DOD, DHS, VA, HHS, DOE, NASA, GSA, USDA, EPA…), which is expanded for you.' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        naics: { type: 'string', description: 'NAICS code to filter by (e.g., "541512")' },
        set_aside: { type: 'string', description: 'Small-business set-aside filter. Accepts a family name ("HUBZone", "8(a)", "WOSB", "EDWOSB", "SDVOSB", "Veteran", "Small business", "Indian"), a FAR code ("HZC", "8AN", "SDVOSBC"), or the literal USAspending description ("HUBZONE SET-ASIDE"). Matches both the set-aside and sole-source variants of a family.' },
        limit: { type: 'number', description: 'Number of results per page (1-100, default 10)' },
        page: { type: 'number', description: '1-based page number (default 1). total_results can exceed limit; page through with this and read page_metadata.has_next / total_pages to reach every row.' },
      },
      required: [],
    },
  },
  {
    name: 'usa_spending_by_category',
    description:
      'Analyze federal spending by industry, product/service, recipient, or agency. Returns spending totals per category. Use for market research and identifying government contracting opportunities.',
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
      'Answer "what federal contracts did [company] win recently?" and get a contractor\'s federal contract awards. Dates are optional and default to the last 12 months; the response always states the window used.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        recipient_name: { type: 'string', description: 'Recipient/contractor name to search for (e.g., "Lockheed Martin")' },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10)' },
      },
      required: ['recipient_name'],
    },
  },
  {
    name: 'usa_spending_trends',
    description:
      '"How has [agency] contract spending trended over the last N fiscal years?" / "is [agency] spending on X growing?" / "federal spending history for [topic]" — US FEDERAL contract/award spending over time from USAspending.gov, grouped by fiscal year, quarter, or month. Filter by keywords or by federal agency (DHS/Homeland Security, DOD/Defense, HHS, VA, DOE, NASA, State, Treasury). Returns the historical dollar amount per period for trend and budget-forecasting questions. Federal only — for state & county award data use gov_contracts_search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to track spending for (e.g., ["artificial intelligence"])',
        },
        agency: { type: 'string', description: 'Awarding agency name. Use instead of, or alongside, keywords.' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD. Optional — defaults to five years ago; the window actually used comes back under `period`.' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD. Optional — defaults to today.' },
        group: {
          type: 'string',
          description: 'Time grouping: fiscal_year, quarter, or month (default fiscal_year)',
        },
      },
      // Was ['keywords','start_date','end_date'], which meant "how has DHS
      // contract spending trended?" — the question this tool is for — could not
      // be asked without inventing a date range. Dates now default to the last
      // five years and either keywords or agency satisfies the filter.
      required: [],
    },
  },
  {
    name: 'usa_expiring_awards',
    description:
      'Federal contracts EXPIRING soon -- the recompete calendar. "Which VA IT contracts over $10M expire in the next 12 months?" / "what is up for recompete at DHS next year" / "find follow-on opportunities in NAICS 5415" / "whose contract is ending". Returns the incumbent holding each award, its period of performance, obligated dollars, agency, NAICS/PSC, and a usaspending.gov link. Filter by agency, sub-agency, NAICS or PSC prefix, incumbent name, and minimum obligated dollars. Covers awarded CONTRACTS already held by a vendor; for open solicitations still accepting bids use samgov/govcon tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agency: { type: 'string', description: 'Awarding agency, substring match (e.g. "Department of Veterans Affairs", "Defense").' },
        sub_agency: { type: 'string', description: 'Awarding sub-agency, substring match (e.g. "Veterans Health Administration").' },
        naics: { type: 'string', description: 'NAICS code or prefix. Hierarchical: "5415" matches all 6-digit computer-services codes beneath it.' },
        psc: { type: 'string', description: 'Product/Service Code or prefix (e.g. "D3" for IT services).' },
        recipient: { type: 'string', description: 'Incumbent contractor name, substring match.' },
        min_amount: { type: 'number', description: 'Minimum total OBLIGATED dollars on the award (not the ceiling). 10000000 for "over $10M".' },
        months_ahead: { type: 'number', description: 'Window size in months from today (default 12).' },
        limit: { type: 'number', description: 'Max awards to return (default 25, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'usa_incumbent_profile',
    description:
      'Federal contract portfolio for one contractor -- "what does Leidos hold and when does it expire", "which of Booz Allen\'s contracts come up for recompete", incumbent research before a bid. Returns active award count, total obligated, ceiling, expirations at 6/12/18 months, top agencies and NAICS, and the next awards to expire with dates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        recipient: { type: 'string', description: 'Contractor name, substring match (e.g. "Leidos", "Booz Allen").' },
        limit: { type: 'number', description: 'How many upcoming expirations to list (default 10, max 100).' },
      },
      required: ['recipient'],
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Gateway injects _proxyUrl/_proxyToken — USAspending silent-hangs CF egress,
  // so route POSTs through the non-CF relay when configured. See usaPost.
  PROXY = args._proxyUrl && args._proxyToken
    ? { url: String(args._proxyUrl), token: String(args._proxyToken) }
    : null;
  switch (name) {
    case 'usa_spending_by_agency':
      return spendingByAgency(args);
    case 'usa_award_search':
      // api.usaspending.gov silently hangs from CF egress (see commit
      // 4c62f5f), so the keyword-search path uses the award-archive route
      // instead — same return shape, and it always responds. Falls back to
      // the live API if that route is unavailable (env not injected, network
      // blip, etc.).
      {
        const dated = withRecentWindow(args);
        return awardSearchSupabase(dated).catch(() => awardSearch(dated));
      }
    case 'usa_spending_by_category':
      return spendingByCategory(args);
    case 'usa_recipient_profile':
      return recipientProfile(args);
    case 'usa_spending_trends':
      return spendingTrends(args);
    case 'usa_expiring_awards':
      return expiringAwards(args);
    case 'usa_incumbent_profile':
      return incumbentProfile(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Set-aside vocabulary ────────────────────────────────────────────────
//
// The mirror stores USAspending's set-aside DESCRIPTION strings (18 distinct
// values across 777,670 of 1,510,983 rows) in a column named
// `set_aside_code` — the ingest mapped the archive CSV's `type_of_set_aside`,
// which is the description, not the code. So the stored vocabulary is
// "HUBZONE SET-ASIDE", "8A COMPETED", "SDVOSB SOLE SOURCE" — and the old
// exact-match filter meant `set_aside: "HUBZone"` matched nothing while
// answering `total_results: 0` with a straight face.
//
// Callers say "HUBZone", or the FAR code "HZC", or occasionally the literal
// stored string. Map all three onto a regex the RPC applies to
// set_aside_code and set_aside_description alike (migration 040), so this
// keeps working once the corrected ingest puts real codes in one column and
// descriptions in the other.
//
// Each family covers both of its stored variants — the vocabulary splits
// every category into SET-ASIDE and SOLE SOURCE, and someone hunting HUBZone
// work wants both. Patterns are anchored where a family would otherwise
// swallow a narrower one: `^WOMEN OWNED` must not eat the EDWOSB rows, and
// `^VETERAN` must not eat the service-disabled ones.
// `codes` are the FAR set-aside codes for the live USAspending API's
// `set_aside_type_codes` filter. Every one was verified against
// api.usaspending.gov before being listed here — a code the API doesn't
// recognise returns zero results rather than an error, so an unverified
// guess here would reintroduce exactly the bug this file is fixing.
const SET_ASIDE_FAMILIES: Array<{ label: string; aliases: RegExp; pattern: string; codes: string[] }> = [
  { label: 'HUBZone',        aliases: /^(HUBZONE.*|HZ|HZC|HZS)$/,                                    pattern: 'HUBZONE|^HZ[CS]?$', codes: ['HZC', 'HZS'] },
  { label: '8(a)',           aliases: /^(8A.*|8\(A\).*|8AN)$/,                                       pattern: '^8\\(?A\\)?|^8AN?$', codes: ['8A', '8AN'] },
  { label: 'EDWOSB',         aliases: /^(EDWOSB.*|ECONOMICALLY DISADVANTAGED.*)$/,                   pattern: 'ECONOMICALLY DISADVANTAGED WOMEN|^EDWOSB', codes: ['EDWOSB', 'EDWOSBSS'] },
  { label: 'WOSB',           aliases: /^(WOSB.*|WOMEN OWNED.*|WOMEN-OWNED.*)$/,                      pattern: '^WOMEN OWNED|^WOSB', codes: ['WOSB', 'WOSBSS'] },
  { label: 'SDVOSB',         aliases: /^(SDVOSB.*|SERVICE DISABLED VETERAN.*|SERVICE-DISABLED.*)$/,  pattern: 'SERVICE DISABLED VETERAN|^SDVOSB', codes: ['SDVOSBC', 'SDVOSBS'] },
  { label: 'Veteran',        aliases: /^(VETERAN.*|VSA|VSS|VOSB.*)$/,                                pattern: '^VETERAN|^VS[AS]$', codes: ['VSA', 'VSS'] },
  { label: 'Small business', aliases: /^(SMALL BUSINESS.*|SBA|SBP|TOTAL SMALL BUSINESS.*)$/,         pattern: '^SMALL BUSINESS SET ASIDE|^SB[AP]$', codes: ['SBA', 'SBP'] },
  { label: 'Indian',         aliases: /^(BUY INDIAN.*|INDIAN.*|BI|IEE|ISBEE)$/,                      pattern: 'INDIAN', codes: ['BI', 'IEE', 'ISBEE'] },
  { label: 'None',           aliases: /^(NONE|NO SET ASIDE.*|NO SET-ASIDE.*)$/,                      pattern: '^NO SET ASIDE', codes: ['NONE'] },
];

/**
 * Turn what a caller typed into a POSIX regex for the RPC's `~*` match.
 *
 * `known: false` means we could not place the value in the mirror's
 * vocabulary. We still search for it (as a literal), but the caller of this
 * function must NOT report an empty result as authoritative — see the guard
 * in awardSearchSupabase.
 */
// Toptier-agency aliases. USAspending's agency filter wants the toptier NAME
// ("Department of Defense"); the fast-path RPC substring-matches the same
// column. A caller sending the abbreviation every other tool in this pack
// advertises ("DOD", "DHS", "VA", "NASA") got a clean zero on both paths —
// measured 2026-10-04: {keywords:["cybersecurity"], agency:"DOD"} → 0 awards,
// agency:"Department of Defense" → 10. Expand the abbreviation; pass anything
// else through unchanged so a full or partial name still substring-matches.
const AGENCY_ALIASES: Record<string, string> = {
  DOD: 'Department of Defense', DEFENSE: 'Department of Defense', PENTAGON: 'Department of Defense',
  DHS: 'Department of Homeland Security', 'HOMELAND SECURITY': 'Department of Homeland Security',
  VA: 'Department of Veterans Affairs', 'VETERANS AFFAIRS': 'Department of Veterans Affairs',
  HHS: 'Department of Health and Human Services',
  DOE: 'Department of Energy', ENERGY: 'Department of Energy',
  DOJ: 'Department of Justice', JUSTICE: 'Department of Justice',
  DOT: 'Department of Transportation', TRANSPORTATION: 'Department of Transportation',
  DOI: 'Department of the Interior', INTERIOR: 'Department of the Interior',
  DOL: 'Department of Labor', LABOR: 'Department of Labor',
  DOC: 'Department of Commerce', COMMERCE: 'Department of Commerce',
  DOS: 'Department of State', STATE: 'Department of State', 'STATE DEPARTMENT': 'Department of State',
  ED: 'Department of Education', EDUCATION: 'Department of Education',
  USDA: 'Department of Agriculture', AGRICULTURE: 'Department of Agriculture',
  HUD: 'Department of Housing and Urban Development',
  TREASURY: 'Department of the Treasury', 'DEPARTMENT OF TREASURY': 'Department of the Treasury',
  NASA: 'National Aeronautics and Space Administration',
  GSA: 'General Services Administration',
  EPA: 'Environmental Protection Agency',
  SBA: 'Small Business Administration',
  SSA: 'Social Security Administration',
  NSF: 'National Science Foundation',
  USAID: 'Agency for International Development',
  OPM: 'Office of Personnel Management',
  NRC: 'Nuclear Regulatory Commission',
  FCC: 'Federal Communications Commission',
  SEC: 'Securities and Exchange Commission',
};

export function normalizeAgency(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const key = s.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return AGENCY_ALIASES[key] ?? s;
}

function normalizeSetAside(raw: string): { pattern: string; known: boolean; label: string; codes: string[] } {
  const norm = raw.trim().toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  for (const fam of SET_ASIDE_FAMILIES) {
    if (fam.aliases.test(norm)) return { pattern: fam.pattern, known: true, label: fam.label, codes: fam.codes };
  }
  // Unrecognised: search for it literally rather than refusing outright — the
  // vocabulary can grow underneath us — but flag it so a zero result falls
  // through to the live API instead of being served as fact.
  return { pattern: raw.trim().replace(/[\\^$.|?*+()[\]{}]/g, '\\$&'), known: false, label: raw.trim(), codes: [norm.replace(/\s+/g, '')] };
}

async function awardSearchSupabase(args: Record<string, unknown>): Promise<unknown> {
  // The archive RPC has topic search but no recipient-name field. Falling back
  // to it would quietly search descriptions for a company name and miss awards.
  if (args.recipient_name) throw new Error('recipient search requires USAspending API');
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('usaspending: data-store credentials were not injected');
  }
  const kws = args.keywords;
  const keywordPhrase = Array.isArray(kws) ? kws.join(' ') : (kws as string | undefined) ?? null;
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const page = normalizePage(args.page);

  const setAside = args.set_aside ? normalizeSetAside(String(args.set_aside)) : null;
  const naics = args.naics ? String(args.naics) : null;

  // Refuse the query outright rather than asking and then disbelieving the
  // answer. A filter the mirror cannot express doesn't return a wrong answer
  // cheaply — the regex has to scan the whole window before it can report
  // nothing, which blows the 8s statement timeout and lands here anyway, 8s
  // later. Deciding up front makes the fallback deterministic instead of a
  // race between two timeouts, and the live API is the authority on FAR
  // set-aside codes regardless.
  // These two throws are internal control flow — they hand the query to the live
  // API path rather than answering a filter that would silently match nothing.
  // Word them by WHAT is being asked for, never by where it is served from: the
  // hosting-disclosure gate (`pnpm check:hosting-claims`) fails the build on
  // "mirror" in published copy, and a caller has no need to know a copy exists.
  if (setAside && !setAside.known) {
    throw new Error(
      `Cannot evaluate set_aside "${setAside.label}" against the fast path — known families are ` +
        `${SET_ASIDE_FAMILIES.map((f) => f.label).join(', ')}. Falling back to the authoritative ` +
        `source rather than reporting zero awards for a filter that cannot be evaluated here.`,
    );
  }
  if (naics && !/^\d{6}$/.test(naics)) {
    // Same class: naics_code is stored as the full 6-digit code, so a 2- to
    // 5-digit sector prefix matches nothing and would read as "no awards".
    throw new Error(
      `naics "${naics}" is not a 6-digit NAICS code, which is the only form the fast path can ` +
        `match. Falling back to the authoritative source rather than reporting zero awards on it.`,
    );
  }
  if (page > 1) {
    // Same class as the filters below: this path takes a row limit but no
    // offset, so it can only ever serve page 1. Answering page 2 from it would
    // hand back page 1's rows under a different page number — the quietest
    // possible wrong answer. The authoritative source pages properly; send it
    // there rather than inventing an offset here.
    throw new Error(
      `page ${page} cannot be served by the fast path, which has no offset. Falling back to the ` +
        `authoritative source so that paging is coherent rather than repeating page 1.`,
    );
  }
  if (args.state) {
    // The fast path has no place-of-performance column, so `state` was silently
    // DROPPED here: {keywords:["cybersecurity"], state:"MD"} returned the same
    // ten nationwide awards as the unfiltered query, byte for byte (measured
    // 2026-10-04). Wrong-but-non-empty is worse than a fallback — only the
    // live API applies place_of_performance_locations (buildFilters), so hand
    // the query to it rather than answer a filter this path cannot evaluate.
    throw new Error(
      `state "${String(args.state)}" is a place-of-performance filter the fast path cannot evaluate. ` +
        `Falling back to the authoritative source rather than returning nationwide awards as if they were filtered.`,
    );
  }

  const body = {
    p_keywords: keywordPhrase,
    p_agency: normalizeAgency(args.agency),
    p_naics: naics,
    p_set_aside: setAside?.pattern ?? null,
    p_start_date: (args.start_date as string) ?? null,
    p_end_date: (args.end_date as string) ?? null,
    p_limit: limit,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/usaspending_award_search`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw await httpError(res, 'mirror');
    const rows = (await res.json()) as Array<Record<string, unknown>>;

    const awards = rows.map((r) => ({
      award_id: r.award_id ?? null,
      recipient_name: r.recipient_name ?? null,
      award_amount: r.award_amount ?? null,
      total_outlays: r.total_outlays ?? null,
      outlays_reported: outlaysReported(r.total_outlays),
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      awarding_agency: r.awarding_agency ?? null,
      awarding_sub_agency: r.awarding_sub_agency ?? null,
      description: r.description ?? null,
      naics_code: r.naics_code ?? null,
      contract_type: r.contract_type ?? null,
    }));
    // This path reports no catalog total, so `total_results` is the row count
    // in THIS response and must not be read as "that is all there is" — say
    // so rather than let a capped page read as a complete answer.
    const hasNext = awards.length === limit;
    return {
      period: args._period ?? null,
      period_note: PERIOD_NOTE,
      total_results: awards.length,
      total_results_note:
        'total_results here is the number of rows in this response, not a verified catalog total — ' +
        'no total is published for this query shape. has_next says whether more rows exist.',
      limit,
      page: 1,
      page_metadata: {
        page: 1,
        per_page: limit,
        returned: awards.length,
        has_next: hasNext,
        has_previous: false,
        total_results: null,
        total_pages: null,
      },
      awards,
      outlays_note: OUTLAYS_NOTE,
      outlays_unreported_rows: awards.filter((a) => !a.outlays_reported).length,
      _source: 'archive',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildFilters(args: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  if (args.keywords) {
    // USAspending requires filters.keywords to be string[]. A caller passing
    // a bare string slips past the tool's input schema when invoked in-pack
    // (govcon-intel did this with `keywords: companyName`) and the upstream
    // returns an enormous payload as it tries to match every character —
    // JSON.parse then burns 30s+ of CPU and the worker crashes with CF
    // error 1102. Coerce defensively so the upstream sees [string].
    filters.keywords = Array.isArray(args.keywords) ? args.keywords : [args.keywords as string];
  }

  if (args.recipient_name) {
    filters.recipient_search_text = [args.recipient_name as string];
  }

  if (args.start_date && args.end_date) {
    filters.time_period = [
      { start_date: args.start_date as string, end_date: args.end_date as string },
    ];
  }

  if (args.agency) {
    filters.agencies = [
      { type: 'awarding', tier: 'toptier', name: normalizeAgency(args.agency) as string },
    ];
  }

  if (args.naics) {
    filters.naics_codes = [args.naics as string];
  }

  if (args.set_aside) {
    // `set_aside_type` is not a filter USAspending v2 accepts. It doesn't
    // 400 — it is silently DROPPED, so the API cheerfully answered a HUBZone
    // question with all 4.6M contracts. The real key is
    // `set_aside_type_codes`, and it takes FAR codes ("HZC"), not the words a
    // caller types, so map through the family table. Verified live: with the
    // old key the first result is byte-identical to an unfiltered search.
    filters.set_aside_type_codes = normalizeSetAside(String(args.set_aside)).codes;
  }

  // Where the work is performed — lets "procurement contracts in Maryland"
  // actually filter to Maryland. USAspending wants a 2-letter state code.
  if (args.state) {
    const st = String(args.state).trim().toUpperCase().slice(0, 2);
    filters.place_of_performance_locations = [{ country: 'USA', state: st }];
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
  // What /search/spending_by_award/ actually sends. `total` and `limit` were
  // declared here and are not on the wire (see the awardCount comment above);
  // a type that names fields the API never sends is what let
  // `page_metadata?.total ?? 0` look correct while reporting 0 on every call.
  page_metadata?: {
    page?: number;
    hasNext?: boolean;
    hasPrevious?: boolean;
    last_record_unique_id?: number | string | null;
    last_record_sort_value?: string | null;
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
  // `total_metadata` was declared here and does not exist on the wire. A type
  // that describes a field the API never sends makes the code reading it look
  // correct — this one silently produced `undefined ?? 0` on every call
  // (fleet #1082). What the endpoint actually returns is page_metadata, with
  // no total anywhere on it.
  page_metadata?: {
    page?: number;
    next?: number | null;
    previous?: number | null;
    hasNext?: boolean;
    hasPrevious?: boolean;
  };
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
  // USAspending's Spending Explorer REQUIRES a quarter (or period) alongside fy —
  // omitting it returns HTTP 400 "provide either period or quarter". The router
  // often fills only fiscal_year, so default one: a completed FY → Q4 (full-year
  // cumulative); the in-progress FY → the current federal fiscal quarter.
  let quarter = args.quarter ? String(args.quarter) : '';
  if (!quarter) {
    const now = new Date();
    const m = now.getUTCMonth(); // 0=Jan
    const cur = m >= 9 ? { fy: now.getUTCFullYear() + 1, q: 1 } // Oct-Dec
      : m <= 2 ? { fy: now.getUTCFullYear(), q: 2 } // Jan-Mar
      : m <= 5 ? { fy: now.getUTCFullYear(), q: 3 } // Apr-Jun
      : { fy: now.getUTCFullYear(), q: 4 }; // Jul-Sep
    quarter = Number(fiscalYear) < cur.fy ? '4' : String(cur.q);
  }
  const body: Record<string, unknown> = {
    type: 'agency',
    filters: { fy: fiscalYear, quarter },
  };

  const data = (await usaPost('/spending/', body)) as SpendingAgencyResult;

  return {
    fiscal_year: fiscalYear,
    quarter,
    total: data.total ?? null,
    agencies: (data.results ?? []).map((r) => ({
      name: r.name,
      amount: r.amount,
      abbreviation: r.abbreviation ?? null,
    })),
  };
}

async function awardSearch(args: Record<string, unknown>) {
  const dated = withRecentWindow(args);
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const page = normalizePage(args.page);
  const filters = buildFilters(dated);

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
    page,
    sort: 'Award Amount',
    order: 'desc',
  };

  const [data, counted] = await Promise.all([
    usaPost('/search/spending_by_award/', body) as Promise<AwardResult>,
    awardCount(filters),
  ]);
  const rows = data.results ?? [];
  const awards = rows.map((r) => ({
    award_id: r['Award ID'] ?? null,
    recipient_name: r['Recipient Name'] ?? null,
    award_amount: r['Award Amount'] ?? null,
    total_outlays: r['Total Outlays'] ?? null,
    outlays_reported: outlaysReported(r['Total Outlays']),
    start_date: r['Start Date'] ?? null,
    end_date: r['End Date'] ?? null,
    awarding_agency: r['Awarding Agency'] ?? null,
    awarding_sub_agency: r['Awarding Sub Agency'] ?? null,
    description: r['Description'] ?? null,
    naics_code: r['NAICS Code'] ?? null,
    contract_type: r['Contract Award Type'] ?? null,
  }));

  return {
    period: dated._period,
    period_note: PERIOD_NOTE,
    total_results: counted ?? awards.length,
    limit,
    page,
    page_metadata: pageMetadata(page, limit, awards.length, counted, data.page_metadata?.hasNext),
    awards,
    outlays_note: OUTLAYS_NOTE,
    outlays_unreported_rows: awards.filter((a) => !a.outlays_reported).length,
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

  const rows = (data.results ?? []).map((r) => ({
    name: r.name,
    amount: r.amount,
    code: r.code ?? null,
    id: r.id ?? null,
  }));

  return {
    category,
    // `total_metadata` does not exist on this endpoint's response and never
    // did — the real top-level keys are category, spending_level, limit,
    // page_metadata, results, messages, and page_metadata carries only
    // {page, next, previous, hasNext, hasPrevious}. So `total_metadata?.count`
    // was always undefined and `?? 0` turned "we have no total" into a
    // confident zero: the tool reported it had found nothing while handing
    // back $456B of Department of Defense awards, and an agent reading the
    // field whose whole job is to say how much there is concluded the query
    // was empty (fleet #1082).
    //
    // There is no total to report — this endpoint does not publish one, and
    // unlike spending_by_award there is no sibling count endpoint to ask. So
    // say null, the same convention awardCount() already uses here, and give
    // the two numbers that ARE true instead.
    total_count: null,
    total_count_note:
      'USAspending does not publish a total for this endpoint, so no count is claimed. `returned` is the rows in this response and `has_more` says whether further pages exist; raise `limit` (max 100) or page through to see more.',
    returned: rows.length,
    has_more: data.page_metadata?.hasNext ?? null,
    results: rows,
  };
}

async function recipientProfile(args: Record<string, unknown>) {
  const dated = withRecentWindow(args);
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const filters: Record<string, unknown> = {
    // recipient_search_text is USAspending's actual recipient-name filter.
    // `keywords` searches free text across the award INCLUDING the description,
    // so asking for "Microsoft" returned Dell's contracts — their descriptions
    // say "VA MICROSOFT ENTERPRISE LICENSE AGREEMENT". A caller reading this as
    // a recipient profile would attribute Dell's money to Microsoft.
    recipient_search_text: [args.recipient_name as string],
    award_type_codes: ['A', 'B', 'C', 'D'],
  };

  if (dated.start_date && dated.end_date) {
    filters.time_period = [
      { start_date: dated.start_date as string, end_date: dated.end_date as string },
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

  const [data, counted] = await Promise.all([
    usaPost('/search/spending_by_award/', body) as Promise<AwardResult>,
    awardCount(filters),
  ]);
  const rows = data.results ?? [];

  return {
    recipient_name: args.recipient_name,
    period: dated._period,
    total_results: counted ?? rows.length,
    limit,
    awards: rows.map((r) => ({
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

/** 1-based page, defaulting to 1; anything unusable becomes 1 rather than NaN. */
function normalizePage(raw: unknown): number {
  const n = Math.floor(Number(raw ?? 1));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Say where the caller is in the result set and whether anything is left.
 *
 * `has_next` prefers the upstream's own hasNext. When the count endpoint
 * answered we can also derive it, and when neither is available we fall back
 * to "this page came back full", which can be one page pessimistic on an exact
 * multiple — it never claims there is nothing more when there is.
 */
function pageMetadata(
  page: number,
  perPage: number,
  returned: number,
  total: number | null,
  upstreamHasNext: boolean | undefined,
) {
  const derived = total !== null && total !== undefined ? page * perPage < total : returned === perPage;
  return {
    page,
    per_page: perPage,
    returned,
    has_next: upstreamHasNext ?? derived,
    has_previous: page > 1,
    total_results: total ?? null,
    total_pages: total !== null && total !== undefined ? Math.max(1, Math.ceil(total / perPage)) : null,
  };
}

function withRecentWindow(args: Record<string, unknown>): Record<string, unknown> & {
  _period: { start_date: string; end_date: string; defaulted: boolean };
} {
  if (args._period) return args as ReturnType<typeof withRecentWindow>;
  const now = new Date();
  const end = (args.end_date as string | undefined) ?? now.toISOString().slice(0, 10);
  const startDefault = new Date(`${end}T00:00:00Z`);
  startDefault.setUTCFullYear(startDefault.getUTCFullYear() - 1);
  const start = (args.start_date as string | undefined) ?? startDefault.toISOString().slice(0, 10);
  return {
    ...args,
    start_date: start,
    end_date: end,
    _period: { start_date: start, end_date: end, defaulted: !args.start_date || !args.end_date },
  };
}

async function spendingTrends(args: Record<string, unknown>) {
  const group = (args.group as string) ?? 'fiscal_year';
  const validGroups = ['fiscal_year', 'quarter', 'month'];
  if (!validGroups.includes(group)) {
    throw new Error(`Invalid group "${group}". Must be one of: ${validGroups.join(', ')}`);
  }

  if (!args.keywords && !args.agency) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Give at least one of `keywords` (e.g. ["cybersecurity"]) or `agency` (e.g. "Department of Defense"). Unfiltered, this would be all federal spending, which the upstream refuses.',
    };
  }

  // "How has spending on X trended?" carries no dates, and start_date/end_date
  // used to be required — so the most natural phrasing of the question this tool
  // exists to answer failed outright. Default to the last five fiscal years,
  // which is what a trend question means, and say which window was used.
  // Computed per-request: module-scope dates freeze at 1970 in Workers.
  const now = new Date();
  const defaultEnd = now.toISOString().slice(0, 10);
  const defaultStart = `${now.getUTCFullYear() - 5}-01-01`;
  const startDate = (args.start_date as string) ?? defaultStart;
  const endDate = (args.end_date as string) ?? defaultEnd;
  const defaulted = !args.start_date || !args.end_date;

  const filters = buildFilters({ ...args, start_date: startDate, end_date: endDate });

  const body = {
    group,
    filters,
  };

  const data = (await usaPost('/search/spending_over_time/', body)) as TrendsResult;

  return {
    group,
    // Always state the window. A trend is meaningless without knowing the span
    // it covers, and when we picked the span the caller has to be told.
    period: { start_date: startDate, end_date: endDate, defaulted },
    ...(defaulted
      ? { period_note: 'No date range was given, so this covers the last five years. Pass start_date and end_date to choose your own window.' }
      : {}),
    data_points: (data.results ?? []).map((r) => ({
      fiscal_year: r.time_period.fiscal_year,
      quarter: r.time_period.quarter ?? null,
      month: r.time_period.month ?? null,
      amount: r.aggregated_amount,
    })),
  };
}

// ── Recompete calendar ──────────────────────────────────────────────────
//
// Both tools read usaspending_awards_current, the one-row-per-award view built
// in migration 061 -- NOT usaspending_contracts, which is one row per
// transaction. Every modification repeats an award's PIID, so querying the base
// table would report one contract as a dozen and sum its money that many times.

async function mirrorMeta(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await pwFetch(
      `${supabaseUrl}/rest/v1/usaspending_mirror_meta?select=refreshed_at,max_action_date,award_count&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// The mirror's own budget. PostgREST caps the `authenticated` role's
// statement_timeout at 8s, so a client budget above that can only ever wait
// for a server-side kill — 9s is deliberately just past it, close enough that
// a slow query surfaces as our message rather than Postgres's.
const MIRROR_TIMEOUT_MS = 9000;

async function mirrorRpc(
  args: Record<string, unknown>,
  fn: string,
  body: Record<string, unknown>,
): Promise<{ data: unknown; meta: Record<string, unknown> | null }> {
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('usaspending: data-store credentials were not injected');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw await httpError(res, 'mirror');
    const data = await res.json();
    const meta = await mirrorMeta(supabaseUrl, supabaseKey);
    return { data, meta };
  } catch (err) {
    // An AbortError reaches the caller as the runtime's own words — the literal
    // string "The operation was aborted" — which is what every usa_incumbent_
    // profile call returned for as long as that tool was broken (fleet #1078).
    // It names nothing: not that it timed out, not what we were waiting for,
    // not how long, not whether a narrower ask would work. Say all four.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      // Describe WHAT did not answer, never WHERE it is served from — naming a
      // copy tells the caller something they do not need and we do not say
      // (feedback_never_disclose_hosting). check:hosting-claims caught exactly
      // that in the first draft of this message.
      throw new Error(
        `upstream_timeout: USAspending did not return this result within ${MIRROR_TIMEOUT_MS / 1000}s. ` +
          `That is usually a request matching far more awards than it needs — a broad recipient or ` +
          `keyword, or no date bound. Narrow it (a fuller company name, a specific agency, a shorter ` +
          `period) and retry; the same query against a smaller match set normally returns in well ` +
          `under a second.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The mirror's currency comes from the DATA, never from the snapshot filename.
// Those disagreed when this was written: the pinned SNAPSHOT_URL was
// contracts-all-20260506.zip while the table held action dates through
// 2026-08-04. A stated as-of that under-reports by three months is worse than
// none, because callers act on it.
function asOf(meta: Record<string, unknown> | null): Record<string, unknown> {
  return {
    mirror_as_of: meta?.max_action_date ?? null,
    mirror_refreshed_at: meta?.refreshed_at ?? null,
    mirror_award_count: meta?.award_count ?? null,
    coverage_note:
      'Mirror of USAspending contract transactions from FY2023 onward. `mirror_as_of` is the newest action date actually present, not a snapshot label. FPDS reporting lags award activity by roughly six weeks, so an award signed in the last month or two may not appear yet -- absence here is not evidence a contract does not exist. An END DATE can also move: a modification filed after `mirror_as_of` may have extended an award listed here as expiring. Spot-checked against api.usaspending.gov, one $1.4B VA award read 14 months earlier here than upstream for exactly that reason. Follow `usaspending_url` for the live period before acting on a date.',
  };
}

async function expiringAwards(args: Record<string, unknown>): Promise<unknown> {
  const months = Math.min(120, Math.max(1, (args.months_ahead as number) ?? 12));
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 25));
  const { data, meta } = await mirrorRpc(args, 'usaspending_expiring_awards', {
    p_agency: (args.agency as string) ?? null,
    p_sub_agency: (args.sub_agency as string) ?? null,
    p_naics: args.naics != null ? String(args.naics) : null,
    p_psc: args.psc != null ? String(args.psc) : null,
    p_recipient: (args.recipient as string) ?? null,
    p_min_amount: (args.min_amount as number) ?? null,
    p_months_ahead: months,
    p_limit: limit,
  });
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const unknownOptions = rows.filter((r) => r.options_status === 'unknown').length;

  return {
    window: {
      from: new Date().toISOString().slice(0, 10),
      months_ahead: months,
    },
    filters: {
      agency: args.agency ?? null,
      sub_agency: args.sub_agency ?? null,
      naics: args.naics ?? null,
      psc: args.psc ?? null,
      recipient: args.recipient ?? null,
      min_amount: args.min_amount ?? null,
    },
    total_results: rows.length,
    limit,
    awards: rows,
    // An award whose options are not yet exhausted usually gets extended, not
    // recompeted. Saying which rows we cannot judge keeps a caller from
    // treating the whole list as live opportunity.
    options_status_note:
      unknownOptions === rows.length && rows.length > 0
        ? 'options_status is "unknown" for every row: the potential end date was never loaded into the mirror (added in migration 061, populates on the next ingest). Until then this list cannot distinguish a contract with options left -- which will likely be extended, not recompeted -- from one genuinely ending.'
        : `options_status is "unknown" for ${unknownOptions} of ${rows.length} awards; those cannot yet be told apart from option exercises.`,
    grain_note:
      'One row per award (award_unique_key), not per transaction. Dollar figures are the summed obligation across all modifications; min_amount filters on that, not on the ceiling.',
    idv_note:
      'Indefinite delivery vehicles are excluded: they carry no period of performance, so they have no expiry to report.',
    ...asOf(meta),
    _source: 'archive',
  };
}

async function incumbentProfile(args: Record<string, unknown>): Promise<unknown> {
  const recipient = args.recipient != null ? String(args.recipient).trim() : '';
  if (!recipient) throw new Error('usa_incumbent_profile requires a recipient name');
  const { data, meta } = await mirrorRpc(args, 'usaspending_incumbent_profile', {
    p_recipient: recipient,
    p_limit: Math.min(100, Math.max(1, (args.limit as number) ?? 10)),
  });
  const profile = (data ?? {}) as Record<string, unknown>;
  const matched = (profile.matched_recipients as unknown[]) ?? [];

  return {
    ...profile,
    // A substring match on "Booz Allen" can span several registered entities
    // (subsidiaries, name changes, punctuation variants). Naming them lets a
    // caller see whether the totals cover one company or a family of them.
    recipient_match_note:
      matched.length > 1
        ? `Matched ${matched.length} distinct registered recipient names; totals combine all of them.`
        : null,
    ...asOf(meta),
    _source: 'archive',
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
