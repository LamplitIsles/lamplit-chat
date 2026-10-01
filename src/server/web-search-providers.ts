// Adapted from guionai/web (Apache-2.0); modified for the Lamplit Worker.
import { boundedRequest, isOperationAborted, isRequestTimeout, readResponseText } from "./web-request";
const EXA_BASE_URL = "https://api.exa.ai";
const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";
/** DeepSeek's Anthropic-compatible API root. The provider appends /messages. */
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
const DEEPSEEK_DEFAULT_API_VERSION = "2023-06-01";
const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
const DEEPSEEK_DEFAULT_MAX_USES = 5;
const DEEPSEEK_SEARCH_TOOL_TYPE = "web_search_20250305";
const DEEPSEEK_SEARCH_TOOL_NAME = "web_search";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 10;

export type SearchProvider = "exa" | "brave" | "deepseek";
export type ProviderLabel = "Exa" | "Brave" | "DeepSeek";

export type SearchCredentials = {
  exaApiKey?: string;
  braveApiKey?: string;
  deepseekApiKey?: string;
};

export type SearchResult = {
  title: string;
  link: string;
  snippet: string;
  position: number;
};

export type SearchResponse = {
  provider: ProviderLabel;
  results: SearchResult[];
};

export type SearchInput = {
  query: string;
  provider?: string;
  credentials: SearchCredentials;
  maxResults?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  endpoints?: Partial<Record<SearchProvider, string>>;
  timeoutMs?: number;
};

export async function search(input: SearchInput & {provider: SearchProvider}): Promise<SearchResponse> {
  return input.provider === 'exa' ? searchExa(input) : input.provider === 'brave' ? searchBrave(input) : searchDeepSeek(input);
}
async function searchExa(input: SearchInput): Promise<SearchResponse> {
  const endpoint = `${(input.endpoints?.exa ?? EXA_BASE_URL).replace(/\/$/, "")}/search`;
  const data = await providerRequest(
    input,
    endpoint,
    {
      method: "POST",
      headers: {
        "x-api-key": input.credentials.exaApiKey!,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        numResults: MAX_RESULTS,
        contents: { highlights: true },
      }),
    },
    "Exa",
  );
  const rawResults = asArray(data, "results", "Exa");
  return {
    provider: "Exa",
    results: rawResults.slice(0, MAX_RESULTS).map((value, index) => {
      const result = asRecord(value, "Exa");
      const highlights = Array.isArray(result.highlights)
        ? result.highlights
        : [];
      const first = highlights.find(
        (highlight): highlight is string => typeof highlight === "string",
      );
      const date =
        typeof result.publishedDate === "string" ? result.publishedDate : "";
      const author = typeof result.author === "string" ? result.author : "";
      return {
        title: stringValue(result.title),
        link: stringValue(result.url),
        snippet:
          first ??
          [date, author ? `by ${author}` : ""].filter(Boolean).join(" "),
        position: index + 1,
      };
    }),
  };
}

async function searchBrave(input: SearchInput): Promise<SearchResponse> {
  const base = (input.endpoints?.brave ?? BRAVE_BASE_URL).replace(/\/$/, "");
  const endpoint = `${base}/web/search?q=${encodeURIComponent(input.query)}&count=${MAX_RESULTS}`;
  const data = asRecord(
    await providerRequest(
      input,
      endpoint,
      {
        method: "GET",
        headers: {
          "X-Subscription-Token": input.credentials.braveApiKey!,
          accept: "application/json",
        },
      },
      "Brave",
    ),
    "Brave",
  );
  const web = asRecord(data.web, "Brave");
  const rawResults = asArray(web, "results", "Brave");
  return {
    provider: "Brave",
    results: rawResults.slice(0, MAX_RESULTS).map((value, index) => {
      const result = asRecord(value, "Brave");
      return {
        title: stringValue(result.title),
        link: stringValue(result.url),
        snippet: stringValue(result.description),
        position: index + 1,
      };
    }),
  };
}

/**
 * Performs one DeepSeek web-search tool call through its Anthropic-compatible
 * Messages endpoint. The request shape is intentionally fixed: DeepSeek's
 * server-side web-search tool chooses and ranks the sources, while this
 * adapter only normalizes the structured result blocks and their citations.
 */
async function searchDeepSeek(input: SearchInput): Promise<SearchResponse> {
  const base = (input.endpoints?.deepseek ?? DEEPSEEK_DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const data = await providerRequest(
    input,
    `${base}/messages`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "x-api-key": input.credentials.deepseekApiKey!,
        authorization: `Bearer ${input.credentials.deepseekApiKey!}`,
        "anthropic-version": DEEPSEEK_DEFAULT_API_VERSION,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "deepseek-harness/0.0.1",
      },
      body: JSON.stringify({
        model: DEEPSEEK_DEFAULT_MODEL,
        max_tokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Perform a web search for the query: ${input.query}`,
              },
            ],
          },
        ],
        tools: [
          {
            type: DEEPSEEK_SEARCH_TOOL_TYPE,
            name: DEEPSEEK_SEARCH_TOOL_NAME,
            max_uses: DEEPSEEK_DEFAULT_MAX_USES,
          },
        ],
      }),
    },
    "DeepSeek",
  );
  return mapDeepSeekResponse(data, input.maxResults);
}

/** Maps DeepSeek's structured web-search blocks into the provider-neutral API. */
export function mapDeepSeekResponse(
  value: unknown,
  maxResults?: number,
): SearchResponse {
  const response = asRecord(value, "DeepSeek");
  const blocks = response.content === undefined ? [] : response.content;
  if (!Array.isArray(blocks))
    throw new Error("deepseek search: malformed response");

  const resultBlocks = blocks.filter(
    (block) => isRecord(block) && block.type === "web_search_tool_result",
  );
  if (resultBlocks.length === 0)
    throw new Error(
      "deepseek search: response contained no web_search_tool_result blocks",
    );

  const citationByUrl = new Map<string, string>();
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "text") continue;
    const citations = block.citations;
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      if (!isRecord(citation)) continue;
      const url = citation.url;
      const citedText = citation.cited_text;
      if (
        typeof url === "string" &&
        url.length > 0 &&
        typeof citedText === "string" &&
        citedText.length > 0 &&
        !citationByUrl.has(url)
      ) {
        citationByUrl.set(url, citedText);
      }
    }
  }

  const seenUrls = new Set<string>();
  const results: SearchResult[] = [];
  for (const block of resultBlocks) {
    const items = (block as Record<string, unknown>).content;
    if (!Array.isArray(items)) throw new Error("deepseek search: tool failed");
    for (const item of items) {
      if (isRecord(item) && item.type === "web_search_tool_result_error") throw new Error("deepseek search: tool failed");
      if (!isRecord(item) || item.type !== "web_search_result") continue;
      const url = item.url;
      if (typeof url !== "string" || url.length === 0 || seenUrls.has(url))
        continue;
      seenUrls.add(url);
      results.push({
        title: stringValue(item.title),
        link: url,
        snippet: citationByUrl.get(url) ?? "",
        position: results.length + 1,
      });
    }
  }

  const limit =
    maxResults === undefined ? MAX_RESULTS : normalizeMaxResults(maxResults);
  return { provider: "DeepSeek", results: results.slice(0, limit) };
}

function normalizeMaxResults(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

async function providerRequest(
  input: SearchInput,
  url: string,
  init: RequestInit,
  provider: ProviderLabel,
): Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return boundedRequest(
    input.fetch,
    url,
    { ...init, redirect: "manual" },
    {
      callerSignal: input.signal,
      timeoutMs,
      timeoutMessage: `search timed out after ${timeoutMs / 1000} seconds`,
    },
    async (response, signal) => {
      if (!response.ok) {
        // Deliberately do not surface remote response bodies: they can contain
        // provider diagnostics or request data, and status is enough to act on.
        throw new Error(
          `${provider.toLowerCase()} search: HTTP ${response.status}`,
        );
      }
      try {
        return JSON.parse(
          await readResponseText(response, 1024 * 1024, signal),
        );
      } catch (error) {
        if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
        throw new Error(
          `${provider.toLowerCase()} search: invalid JSON response`,
        );
      }
    },
  ).catch((error: unknown) => {
    if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
    if (
      error instanceof Error &&
      error.message.startsWith(`${provider.toLowerCase()} search:`)
    )
      throw error;
    throw new Error(`${provider} search request failed`);
  });
}

function asRecord(
  value: unknown,
  provider: ProviderLabel,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${provider.toLowerCase()} search: malformed response`);
  }
  return value as Record<string, unknown>;
}

function asArray(
  value: unknown,
  key: string,
  provider: ProviderLabel,
): unknown[] {
  const record = asRecord(value, provider);
  if (!Array.isArray(record[key]))
    throw new Error(`${provider.toLowerCase()} search: malformed response`);
  return record[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
