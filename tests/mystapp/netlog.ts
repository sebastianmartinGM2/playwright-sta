import { performance } from 'node:perf_hooks';
import type { Page, Request, Response, TestInfo } from '@playwright/test';

export type NetworkCaptureOptions = {
  captureBodies?: boolean;
  maxBodyChars?: number;
  urlIncludeRegex?: RegExp;
};

export type NetworkEntry = {
  id: number;
  resourceType: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestPostData?: unknown;
  requestStartEpochMs: number;
  requestStartMonotonicMs: number;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  failure?: string;
  durationMs?: number;
};

export function envIsOn(name: string) {
  const raw = (process.env[name] ?? '').trim();
  return raw === '1' || /^true$/i.test(raw);
}

function redactHeaders(headers: Record<string, string>) {
  const blocked = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (blocked.has(key)) continue;
    out[k] = v;
  }
  return out;
}

function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/^bearer\s+/i.test(value)) return '[redacted]';
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactJson(v, depth + 1));

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/(pass(word)?|token|secret|api[-_]?key|authorization|cookie)/i.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redactJson(v, depth + 1);
    }
  }
  return out;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clipText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 12)) + '…[clipped]';
}

export function installNetworkCapture(page: Page, testInfo: TestInfo, options?: NetworkCaptureOptions) {
  const captureBodies = !!options?.captureBodies;
  const maxBodyChars = options?.maxBodyChars ?? 50_000;
  const urlIncludeRegex = options?.urlIncludeRegex;

  let nextId = 1;
  const entries: NetworkEntry[] = [];
  const byRequest = new Map<Request, NetworkEntry>();

  const shouldInclude = (req: Request) => {
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return false;
    const url = req.url();
    if (urlIncludeRegex && !urlIncludeRegex.test(url)) return false;
    return true;
  };

  const onRequest = (req: Request) => {
    if (!shouldInclude(req)) return;
    const entry: NetworkEntry = {
      id: nextId++,
      resourceType: req.resourceType(),
      method: req.method(),
      url: req.url(),
      requestHeaders: redactHeaders(req.headers()),
      requestStartEpochMs: Date.now(),
      requestStartMonotonicMs: performance.now(),
    };

    const postData = req.postData();
    if (postData) {
      const maybeJson = tryParseJson(postData);
      if (maybeJson !== undefined) entry.requestPostData = redactJson(maybeJson);
      else entry.requestPostData = clipText(postData, maxBodyChars);
    }

    entries.push(entry);
    byRequest.set(req, entry);
  };

  const onResponse = async (res: Response) => {
    const req = res.request();
    const entry = byRequest.get(req);
    if (!entry) return;

    entry.responseStatus = res.status();
    entry.responseHeaders = redactHeaders(res.headers());
    entry.durationMs = Math.round(performance.now() - entry.requestStartMonotonicMs);

    if (!captureBodies) return;

    // Headers are typically lowercased in Playwright.
    const contentType = (entry.responseHeaders?.['content-type'] ?? entry.responseHeaders?.['Content-Type'] ?? '').toLowerCase();
    const looksTexty = contentType.includes('application/json') || contentType.startsWith('text/') || contentType.includes('application/problem+json');
    if (!looksTexty) return;

    try {
      const bodyText = await res.text();
      const clipped = clipText(bodyText, maxBodyChars);
      const parsed = tryParseJson(clipped);
      entry.responseBody = parsed !== undefined ? redactJson(parsed) : clipped;
    } catch {
      // ignore body capture errors
    }
  };

  const onRequestFailed = (req: Request) => {
    const entry = byRequest.get(req);
    if (!entry) return;
    entry.failure = req.failure()?.errorText;
    entry.durationMs = Math.round(performance.now() - entry.requestStartMonotonicMs);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const stop = async () => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);

    const json = JSON.stringify(entries, null, 2);
    const outPath = testInfo.outputPath('network.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, json, 'utf8');

    await testInfo.attach('network.json', { body: Buffer.from(json), contentType: 'application/json' });
    await testInfo.attach('network-path.txt', { body: Buffer.from(outPath + '\n'), contentType: 'text/plain' });

    const mdLines = [
      '# Network (fetch/xhr)',
      '',
      '| # | ms | Status | Method | URL |',
      '|---:|---:|---:|---|---|',
      ...entries.map((e) => `| ${e.id} | ${e.durationMs ?? ''} | ${e.responseStatus ?? ''} | ${e.method} | ${e.url} |`),
      '',
    ];
    await testInfo.attach('network.md', { body: Buffer.from(mdLines.join('\n')), contentType: 'text/markdown' });
  };

  return { stop, entries };
}
