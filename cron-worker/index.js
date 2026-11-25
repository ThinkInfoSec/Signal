/**
 * Triggers Signal's "Refresh news" workflow every 15 minutes.
 * No fetch handler and no workers.dev route: nothing is reachable from the internet.
 */
const DISPATCH = "https://api.github.com/repos/ThinkInfoSec/Signal/actions/workflows/refresh-news.yml/dispatches";

export async function dispatchNews(env, fetchFn = fetch) {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN secret is not set");
  const res = await fetchFn(DISPATCH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "thinkinfosec-signal-cron",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error(`dispatch failed: HTTP ${res.status}`);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchNews(env));
  },
};
