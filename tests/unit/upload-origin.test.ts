import { describe, expect, it } from "vitest";
import { isUploadOriginAllowed } from "@/lib/upload-origin";

describe("upload origin", () => {
  it("accepts same-host http and https only", () => {
    expect(isUploadOriginAllowed("https://watcon.example", "watcon.example")).toBe(true);
    expect(isUploadOriginAllowed("http://localhost:3100", "localhost:3100")).toBe(true);
    expect(isUploadOriginAllowed("https://other.example", "watcon.example")).toBe(false);
    expect(isUploadOriginAllowed("ftp://watcon.example", "watcon.example")).toBe(false);
  });
  it("rejects missing, null and malformed origins without throwing", () => {
    for (const value of [null, "null", "", "garbage", "https://["]) expect(isUploadOriginAllowed(value, "watcon.example")).toBe(false);
    expect(isUploadOriginAllowed("https://watcon.example", null)).toBe(false);
  });
});
