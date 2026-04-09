import test from "node:test";
import assert from "node:assert/strict";
import { hasSessionCookie, resolveCookie } from "../src/auth.js";

test("resolveCookie prefers env over config", () => {
  const result = resolveCookie({
    env: { META_AI_COOKIE: "env-cookie=1" },
    config: { cookie: "config-cookie=1" },
  });
  assert.equal(result.cookie, "env-cookie=1");
  assert.equal(result.source, "env");
});

test("resolveCookie uses config when env is missing", () => {
  const result = resolveCookie({
    env: {},
    config: { cookie: "config-cookie=1" },
  });
  assert.equal(result.cookie, "config-cookie=1");
  assert.equal(result.source, "config");
});

test("resolveCookie returns none when no cookie exists", () => {
  const result = resolveCookie({
    env: {},
    config: {},
  });
  assert.equal(result.cookie, "");
  assert.equal(result.source, "none");
});

test("hasSessionCookie detects ecto_1_sess token", () => {
  assert.equal(hasSessionCookie("datr=a; ecto_1_sess=abc; rd_challenge=x"), true);
  assert.equal(hasSessionCookie("datr=a; rd_challenge=x"), false);
});
