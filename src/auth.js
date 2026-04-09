export function resolveCookie({ env = process.env, config = {} } = {}) {
  const envCookie = env.META_AI_COOKIE?.trim();
  if (envCookie) {
    return { cookie: envCookie, source: "env" };
  }

  const configCookie = config.cookie?.trim();
  if (configCookie) {
    return { cookie: configCookie, source: "config" };
  }

  return { cookie: "", source: "none" };
}

export function redactCookie(cookie) {
  if (!cookie) return "<empty>";
  if (cookie.length <= 20) return `${cookie.slice(0, 3)}...${cookie.slice(-3)}`;
  return `${cookie.slice(0, 8)}...${cookie.slice(-8)}`;
}

export function hasSessionCookie(cookie) {
  return /(?:^|;\s*)ecto_1_sess=/.test(cookie);
}
