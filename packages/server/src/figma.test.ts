import { describe, expect, it } from "vitest";
import { parseUploadUrls } from "./figma.ts";

describe("parseUploadUrls", () => {
  it("reads the upload_assets response shape (uploads[].submitUrl + targetNodeId)", () => {
    const res = { uploads: [{ submitUrl: "https://mcp.figma.com/mcp/upload/a/submit?scaleMode=FILL", targetNodeId: "1:8" }], instructions: "…" };
    expect(parseUploadUrls(res)).toEqual([{ url: "https://mcp.figma.com/mcp/upload/a/submit?scaleMode=FILL", nodeId: "1:8" }]);
  });

  it("accepts plain URL arrays and alternative key names", () => {
    expect(parseUploadUrls(["https://x/1", "https://x/2"])).toEqual([{ url: "https://x/1" }, { url: "https://x/2" }]);
    expect(parseUploadUrls([{ uploadUrl: "https://x/3", nodeId: "2:1" }])).toEqual([{ url: "https://x/3", nodeId: "2:1" }]);
    expect(() => parseUploadUrls([{ foo: 1 }])).toThrow(/without a URL/);
  });
});
