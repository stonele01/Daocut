/** Transport compatibility and diagnostics before provider SDKs discard the fetch cause. */
import { Agent, Pool } from 'undici';

/** Preserve model wait times; scope TLS 1.2 compatibility to DeepSeek's official HTTPS endpoint. */
export function createModelDispatcher(waitMs) {
  return new Agent({
    headersTimeout: waitMs, bodyTimeout: waitMs,
    factory: (origin, options) => new Pool(origin, new URL(origin).origin === 'https://api.deepseek.com'
      ? { ...options, connect: { ...options.connect, maxVersion: 'TLSv1.2' } }
      : options),
  });
}
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

/** Error messages and stacks can contain credentials; retain only transport identifiers and nested causes. */
function errorFields(error, seen = new Set(), depth = 0) {
  if (!error || typeof error !== 'object' || seen.has(error) || depth >= 8) return undefined;
  seen.add(error);
  const fields = {};
  if (typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)) fields.name = error.name;
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) fields.code = error.code;
  if (Number.isSafeInteger(error.errno)) fields.errno = error.errno;
  if (typeof error.syscall === 'string' && /^[a-z][a-zA-Z0-9_]{0,39}$/.test(error.syscall)) fields.syscall = error.syscall;
  const cause = errorFields(error.cause, seen, depth + 1);
  if (cause) fields.cause = cause;
  if (Array.isArray(error.errors)) fields.errors = error.errors.slice(0, 8).map((e) => errorFields(e, seen, depth + 1)).filter(Boolean);
  return fields;
}

function requestFields(input, init) {
  const request = {};
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    request.origin = url.origin;
    request.pathname = url.pathname;
  } catch { /* An invalid URL must not be copied into the log. */ }
  const method = init?.method ?? input?.method ?? 'GET';
  if (typeof method === 'string' && METHODS.has(method.toUpperCase())) request.method = method.toUpperCase();
  return request;
}

/** Observe rejection before response headers, without changing the request, response, error, timeout or retry. */
export function networkFetch(fetch, report) {
  return async (input, init) => {
    const startedAt = Date.now();
    try {
      return await fetch(input, init);
    } catch (error) {
      try {
        report({ request: requestFields(input, init), startedAt, ms: Date.now() - startedAt, error: errorFields(error) ?? {} });
      } catch { /* Diagnostics must not replace the transport failure. */ }
      throw error;
    }
  };
}
