import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const bindingValue = (source: string, name: string) =>
  analyzeJavaScriptSemantics(source).bindings.find(
    (binding) => binding.name === name,
  )?.value;

const valueStatus = (source: string) => bindingValue(source, "value")?.status;

describe("JavaScript semantic analysis: conditionally skipped writes", () => {
  it("does not promote a skipped assignment through a later read", () => {
    const ir = analyzeJavaScriptSemantics(
      "let value; if (flag) value = 1; const observed = value;",
    );

    expect(ir.bindings.find(({ name }) => name === "value")?.value.status).toBe(
      "unknown",
    );
    expect(
      ir.bindings.find(({ name }) => name === "observed")?.value.status,
    ).toBe("unknown");
  });

  it("keeps a conditional initializer uncertain while preserving branch joins", () => {
    expect(bindingValue("if (flag) { var value = 1; }", "value")?.status).toBe(
      "unknown",
    );
    expect(
      bindingValue("let value; if (flag) value = 1; else value = 2;", "value"),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("preserves writes that execute on every path and definite writes", () => {
    expect(bindingValue("let value; value = 1;", "value")).toEqual({
      status: "literal",
      value: 1,
    });
    expect(
      bindingValue("let value; do { value = 1; } while (flag);", "value"),
    ).toEqual({ status: "literal", value: 1 });
    expect(bindingValue("let value; if (value = 1) {}", "value")).toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("distinguishes for-loop initializers from potentially skipped updates", () => {
    expect(
      bindingValue("let value; for (value = 1; false;) {}", "value"),
    ).toEqual({ status: "literal", value: 1 });
    expect(
      bindingValue("let value; for (; false; value = 1) {}", "value")?.status,
    ).toBe("unknown");
  });

  it("tracks arguments skipped by optional chains in a call callee", () => {
    for (const call of [
      "foo?.bar(value = 1)",
      "foo?.[key](value = 1)",
      "foo?.bar?.(value = 1)",
      "getThing?.()(value = 1)",
    ])
      expect(bindingValue(`let value; ${call};`, "value")?.status).toBe(
        "unknown",
      );
  });

  it("keeps arguments after a grouped optional expression definite", () => {
    expect(bindingValue("let value; (foo?.bar)(value = 1);", "value")).toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("tracks computed keys skipped by an optional chain before them", () => {
    for (const access of [
      "foo?.bar[value = 1]",
      "foo?.bar.baz[value = 1]",
      "foo?.[key][value = 1]",
    ])
      expect(valueStatus(`let value; ${access};`)).toBe("unknown");
    expect(bindingValue("let value; (foo?.bar)[value = 1];", "value")).toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("tracks right operands skipped by logical assignment", () => {
    for (const operator of ["||=", "&&=", "??="])
      expect(valueStatus(`let value; flag ${operator} (value = 1);`)).toBe(
        "unknown",
      );
    expect(bindingValue("let value; flag += (value = 1);", "value")).toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("tracks defaults skipped by destructuring", () => {
    expect(valueStatus("let value; const {a = (value = 1)} = obj;")).toBe(
      "unknown",
    );
  });

  it("tracks writes skipped by a jump out of a labeled block", () => {
    expect(
      valueStatus("let value; done: { if (flag) break done; value = 1; }"),
    ).toBe("unknown");
    expect(bindingValue("let value; done: { value = 1; }", "value")).toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("tracks writes skipped by a jump out of a do-while body", () => {
    for (const jump of ["break", "continue"])
      expect(
        valueStatus(
          `let value; do { if (flag) ${jump}; value = 1; } while (again);`,
        ),
      ).toBe("unknown");
    expect(
      bindingValue(
        "let value; do { for (;;) { break; } value = 1; } while (again);",
        "value",
      ),
    ).toEqual({ status: "literal", value: 1 });
  });
});
