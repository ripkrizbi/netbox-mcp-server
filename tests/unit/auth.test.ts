import { describe, expect, it } from "vitest";

import { authorizationHeader } from "../../src/auth.js";

describe("authorizationHeader", () => {
  it("uses Token authentication for legacy v1 tokens", () => {
    expect(authorizationHeader("0123456789abcdef"))
      .toBe("Token 0123456789abcdef");
  });

  it("uses Bearer authentication for NetBox v2 tokens", () => {
    const token =
      "nbt_EXAMPLEID001.EXAMPLESECRETdoNotUseThisValueItIsFake00";

    expect(authorizationHeader(token))
      .toBe(`Bearer ${token}`);
  });
});
