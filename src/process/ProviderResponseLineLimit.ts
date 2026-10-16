import { constants } from "node:buffer";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";

/** A provider reply line has outgrown the runtime's maximum string length. */
export class ProviderResponseLineLimitError extends AnalysisResourceConstraintError {
  constructor(provider: "Hopper" | "Ghidra", pendingCodeUnits: number) {
    const name = provider.toLowerCase();
    super(
      `${name}_bridge_response`,
      "memory",
      `A ${provider} bridge response line exceeds the runtime's maximum string length.`,
      {
        boundary: `${name}-bridge-response`,
        pending_code_units: pendingCodeUnits,
        max_string_code_units: constants.MAX_STRING_LENGTH,
      },
      {
        remediationAction:
          "Request a smaller result. The provider connection was closed, so call close_binary, open the target again and retry.",
      },
    );
  }
}
