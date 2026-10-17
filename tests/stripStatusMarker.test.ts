import assert from "node:assert/strict";
import { test } from "node:test";
import { stripStatusMarker } from "../src/App/adapters/mdAdapter";

test("strips a leading status marker from the title", () => {
  assert.equal(stripStatusMarker("TODO Write report [d:30m]"), "Write report [d:30m]");
  assert.equal(stripStatusMarker("DOING [#A] Review"), "[#A] Review");
  assert.equal(stripStatusMarker("IN-PROGRESS Draft"), "Draft");
  assert.equal(stripStatusMarker("[DONE] Legacy form"), "Legacy form");
  assert.equal(stripStatusMarker("LATER"), "");
});

test("leaves other leading words alone", () => {
  assert.equal(stripStatusMarker("TODOS for the week"), "TODOS for the week");
  assert.equal(stripStatusMarker("Plain block"), "Plain block");
});
