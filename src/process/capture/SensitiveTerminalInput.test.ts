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
  expect(redactor.push("login: sword")).toBe("login: ");
  expect(redactor.push("fish\r\n")).toBe("<redacted-input>\r\n");
  expect(redactor.flush()).toBe("");
});

it("releases a held tail that never completes a value", () => {
  const redactor = createSensitiveOutputRedactor(["swordfish"]);
  expect(redactor.push("sw")).toBe("");
  expect(redactor.flush()).toBe("sw");
  expect(redactor.flush()).toBe("");
});

it("does not split a complete value whose suffix begins another value", () => {
  const redactor = createSensitiveOutputRedactor(["abab"]);
  expect(redactor.push("xabab")).toBe("x<redacted-input>");
  expect(redactor.flush()).toBe("");
});

it("waits for the longer value when a shorter one ends a chunk", () => {
  const redactor = createSensitiveOutputRedactor(["ab", "abcd"]);
  expect(redactor.push("xab")).toBe("x");
  expect(redactor.push("cd")).toBe("<redacted-input>");
  expect(redactor.push("xab")).toBe("x");
  expect(redactor.flush()).toBe("<redacted-input>");
});

it("matches values literally", () => {
  const redactor = createSensitiveOutputRedactor(["a.c+(d)"]);
  expect(redactor.push("a.c+(d) abc a.c+(d)")).toBe(
    "<redacted-input> abc <redacted-input>",
  );
});

it("passes output through unchanged without sensitive values", () => {
  const redactor = createSensitiveOutputRedactor([]);
  expect(redactor.push("plain")).toBe("plain");
  expect(redactor.flush()).toBe("");
});
