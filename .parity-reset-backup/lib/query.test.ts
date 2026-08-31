import { expect, test } from "vitest";
// Imported through the `@` alias on purpose: this also asserts the
// tsconfig/vite/components.json path alias stays wired up.
import { queryClient } from "@/lib/query";

test("queryClient uses the app-wide query defaults", () => {
  const queries = queryClient.getDefaultOptions().queries;
  expect(queries?.staleTime).toBe(30_000);
  expect(queries?.retry).toBe(1);
});
