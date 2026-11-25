const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

// Retry transient server errors without retrying authentication or client errors.
export async function requestWithRetry(request, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let response = await request();
  for (const delay of [500, 1500]) {
    if (!RETRYABLE_STATUSES.has(response.status)) break;
    await wait(delay);
    response = await request();
  }
  return response;
}
