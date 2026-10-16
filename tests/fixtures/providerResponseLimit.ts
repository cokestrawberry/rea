import { vi } from "vitest";

export const runtime = vi.hoisted(() => ({
  limit: undefined as number | undefined,
}));
vi.mock("node:buffer", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:buffer")>();
  return {
    ...original,
    constants: {
      ...original.constants,
      get MAX_STRING_LENGTH() {
        return runtime.limit ?? original.constants.MAX_STRING_LENGTH;
      },
    },
  };
});
