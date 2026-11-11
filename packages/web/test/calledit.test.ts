import { describe, expect, it } from "vitest";
import { checkUpload, isUploadId, mediaSrc, uploadSrc } from "../src/lib/calledit";

describe("/calledit image helpers", () => {
  it("checks type and the 5 MB limit before uploading", () => {
    expect(checkUpload({ type: "image/png", size: 1000 })).toBeNull();
    expect(checkUpload({ type: "image/webp", size: 5 * 1024 * 1024 })).toBeNull();
    expect(checkUpload({ type: "image/gif", size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
    expect(checkUpload({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPG, WEBP or GIF/);
    expect(checkUpload({ type: "image/jpeg", size: 0 })).toMatch(/empty/);
  });

  it("builds proxied media and upload URLs on the API", () => {
    expect(mediaSrc("https://pbs.twimg.com/media/A.jpg")).toMatch(/\/social\/media\?u=https%3A%2F%2Fpbs\.twimg\.com%2Fmedia%2FA\.jpg$/);
    expect(uploadSrc("abcdefghijklmnop")).toMatch(/\/social\/uploads\/abcdefghijklmnop$/);
    expect(isUploadId("abcdefghijklmnop")).toBe(true);
    expect(isUploadId("../etc")).toBe(false);
    expect(isUploadId(null)).toBe(false);
  });
});
