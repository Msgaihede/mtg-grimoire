import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only registers its own `afterEach(cleanup)` when Vitest runs with
// `globals: true`, which this project does not. Without it every render stacks up in the
// same `document.body` and the second test in a file sees two of everything.
afterEach(cleanup);
