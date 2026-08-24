# Rate limiting

Every token is limited by a rolling window. When you exceed the window the API answers `429 Too Many Requests` and sets `Retry-After`. Clients are expected to honour that header rather than retrying immediately.

## Limits by plan

| Plan | Requests / minute | Burst |
| --- | --- | --- |
| Free | 60 | 10 |
| Team | 600 | 120 |
| Enterprise | 6000 | 1200 |

## Response headers

- `X-RateLimit-Limit` — the ceiling for the current window
- `X-RateLimit-Remaining` — calls left in the window
  - never negative
  - reset at the boundary, not gradually
- `Retry-After` — seconds to wait, only present on a 429

## Backing off

The reference implementation below applies full jitter. Do not retry more than five times, and do not retry a `4xx` other than `429`.

```ts
async function call(url: string, attempt = 0): Promise<Response> {
	const res = await fetch(url);
	if (res.status !== 429 || attempt >= 5) return res;

	const after = Number(res.headers.get("retry-after") ?? 1);
	const wait = Math.random() * after * 1000;
	await new Promise((r) => setTimeout(r, wait));
	return call(url, attempt + 1);
}
```

2. Read `Retry-After`.
3. Sleep for a jittered fraction of it.
4. Retry at most five times.

See also [error reference](https://docs.widgetworks.dev/api/errors#429) and [the status page](https://status.widgetworks.dev/).