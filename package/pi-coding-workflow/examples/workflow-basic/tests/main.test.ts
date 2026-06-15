import assert from "node:assert/strict";
import test from "node:test";
import { greeting } from "../src/main.ts";

test("greeting returns a stable message", () => {
  assert.equal(greeting("pi"), "hello pi");
});
