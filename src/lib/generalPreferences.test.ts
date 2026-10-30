import { expect, test } from "vitest";
import {
  moveNavigationFeature,
  normalizeNavigationOrder,
} from "./generalPreferences";

test("old and malformed preferences preserve every feature once", () => {
  expect(
    normalizeNavigationOrder(["knowledge", "unknown", "knowledge"]),
  ).toEqual(["knowledge", "projects", "learning", "plans", "common-texts"]);
});
test("moving a feature preserves the order and presence of the other entries", () => {
  expect(
    moveNavigationFeature(
      normalizeNavigationOrder(undefined),
      "common-texts",
      "projects",
    ),
  ).toEqual(["common-texts", "projects", "learning", "plans", "knowledge"]);
});
