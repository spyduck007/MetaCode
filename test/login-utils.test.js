import test from "node:test";
import assert from "node:assert/strict";
import {
  hasLoggedInMetaSession,
  selectMetaCookies,
  serializeCookieHeader,
} from "../src/login-utils.js";

test("selectMetaCookies dedupes by cookie name and sorts by priority", () => {
  const selected = selectMetaCookies([
    { name: "z_cookie", value: "1" },
    { name: "ecto_1_sess", value: "abc" },
    { name: "datr", value: "datr-1" },
    { name: "datr", value: "datr-2" },
    { name: "rd_challenge", value: "rd-1" },
  ]);

  assert.deepEqual(
    selected.map((cookie) => `${cookie.name}=${cookie.value}`),
    ["datr=datr-2", "rd_challenge=rd-1", "ecto_1_sess=abc", "z_cookie=1"]
  );
});

test("serializeCookieHeader creates valid cookie header string", () => {
  const header = serializeCookieHeader([
    { name: "rd_challenge", value: "rd" },
    { name: "ecto_1_sess", value: "sess" },
    { name: "datr", value: "d" },
  ]);

  assert.equal(header, "datr=d; rd_challenge=rd; ecto_1_sess=sess");
});

test("hasLoggedInMetaSession checks for ecto session cookie", () => {
  assert.equal(hasLoggedInMetaSession([{ name: "ecto_1_sess", value: "a" }]), true);
  assert.equal(hasLoggedInMetaSession([{ name: "datr", value: "a" }]), false);
});

