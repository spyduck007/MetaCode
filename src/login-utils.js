const COOKIE_PRIORITY = [
  "datr",
  "dpr",
  "rd_challenge",
  "theme",
  "ecto_1_sess",
  "AMP_MKTG_8f1ede8e9c",
  "AMP_8f1ede8e9c",
  "wd",
];

function isCookieUsable(cookie) {
  return Boolean(cookie?.name && cookie?.value);
}

function compareCookiePriority(left, right) {
  const leftIndex = COOKIE_PRIORITY.indexOf(left.name);
  const rightIndex = COOKIE_PRIORITY.indexOf(right.name);
  const leftPriority = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const rightPriority = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.name.localeCompare(right.name);
}

export function selectMetaCookies(cookies) {
  const deduped = new Map();
  for (const cookie of cookies ?? []) {
    if (!isCookieUsable(cookie)) continue;
    deduped.set(cookie.name, cookie);
  }
  return [...deduped.values()].sort(compareCookiePriority);
}

export function serializeCookieHeader(cookies) {
  const selected = selectMetaCookies(cookies);
  return selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function hasLoggedInMetaSession(cookies) {
  const names = new Set((cookies ?? []).map((cookie) => cookie?.name).filter(Boolean));
  return names.has("ecto_1_sess");
}

