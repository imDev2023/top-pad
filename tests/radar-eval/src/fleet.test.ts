import { describe, expect, it } from "vitest";
import { callsProgram, instructionsOf } from "./fleet";

describe("instructionsOf", () => {
  it("names only the program's own top-level instructions", () => {
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program P invoke [1]",
      "Program log: Instruction: Join",
      "Program Tokenkeg invoke [2]",
      "Program log: Instruction: Transfer",
      "Program Q invoke [1]",
      "Program log: Instruction: Buy",
    ];
    expect(instructionsOf(logs, "P")).toEqual(["Join"]);
  });
});

describe("callsProgram", () => {
  it("finds the program at any depth, and not a name it only starts", () => {
    expect(callsProgram(["Program Q invoke [1]", "Program P invoke [2]"], "P")).toBe(true);
    expect(callsProgram(["Program PX invoke [1]", "Program log: P"], "P")).toBe(false);
  });
});
