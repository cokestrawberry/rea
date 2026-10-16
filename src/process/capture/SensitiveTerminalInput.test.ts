import { expect, it } from "vitest";

import { parseProcessScenario } from "../../domain/process/processScenario.js";
import {
  createSensitiveOutputRedactor,
  sensitiveTerminalInput,
} from "./SensitiveTerminalInput.js";

const scenarioWithInputs = (
  ...inputs: readonly { data: string; sensitive?: boolean }[]
) =>
  parseProcessScenario({
    executable: "/bin/sh",
    working_directory: "/tmp",
    events: inputs.map((input, index) => ({
      type: "input",
      at_ms: index,
      ...input,
    })),
  });

it("derives the echoed text without the submitting line break", () => {
  expect(
    sensitiveTerminalInput(
      scenarioWithInputs(
        { data: "user@example.test\r", sensitive: true },
        { data: "ordinary\n" },
        { data: "\r", sensitive: true },
      ),
    ),
  ).toEqual({ values: ["user@example.test"], redactable: true });
});

it.each(["a\tb\n", "line1\nline2\n", "\u001b[A"])(
  "reports an input whose echo is rewritten as not exactly redactable: %j",
  (data) => {
    expect(
      sensitiveTerminalInput(scenarioWithInputs({ data, sensitive: true })),
    ).toMatchObject({ redactable: false });
  },
);

it("redacts a value split across PTY chunks", () => {
  const redactor = createSensitiveOutputRedactor(["swordfish"]);
  expect(redactor.push("login: sword", 1).data).toBe("login: ");
  expect(redactor.push("fish\r\n", 1).data).toBe("<redacted-input>\r\n");
  expect(redactor.flush().data).toBe("");
});

it("releases a held tail that never completes a value", () => {
  const redactor = createSensitiveOutputRedactor(["swordfish"]);
  expect(redactor.push("sw", 1).data).toBe("");
  expect(redactor.flush().data).toBe("sw");
  expect(redactor.flush().data).toBe("");
});

it("does not split a complete value whose suffix begins another value", () => {
  const redactor = createSensitiveOutputRedactor(["abab"]);
  expect(redactor.push("xabab", 1).data).toBe("x<redacted-input>");
  expect(redactor.flush().data).toBe("");
});

it("waits for the longer value when a shorter one ends a chunk", () => {
  const redactor = createSensitiveOutputRedactor(["ab", "abcd"]);
  expect(redactor.push("xab", 1).data).toBe("x");
  expect(redactor.push("cd", 1).data).toBe("<redacted-input>");
  expect(redactor.push("xab", 1).data).toBe("x");
  expect(redactor.flush().data).toBe("<redacted-input>");
});

it("matches values literally", () => {
  const redactor = createSensitiveOutputRedactor(["a.c+(d)"]);
  expect(redactor.push("a.c+(d) abc a.c+(d)", 1).data).toBe(
    "<redacted-input> abc <redacted-input>",
  );
});

it("passes output through unchanged without sensitive values", () => {
  const redactor = createSensitiveOutputRedactor([]);
  expect(redactor.push("plain", 1).data).toBe("plain");
  expect(redactor.flush().data).toBe("");
});

it("preserves the reception time of a held tail", () => {
  const redactor = createSensitiveOutputRedactor(["swordfish"]);
  expect(redactor.push("pass: sword", 3)).toEqual({ data: "pass: ", atMs: 3 });
  expect(redactor.push("fin", 7)).toEqual({ data: "swordfin", atMs: 3 });
  expect(redactor.push("sword", 11)).toEqual({ data: "", atMs: 11 });
  expect(redactor.flush()).toEqual({ data: "sword", atMs: 11 });
});
