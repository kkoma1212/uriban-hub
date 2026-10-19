import { describe, expect, it } from "vitest";

import { allowedPictureUrl } from "./social-auth.provider.js";

// 서버가 임의 주소로 요청하지 않게: 각 회사 이미지 서버의 https 주소만 남긴다.
describe("provider profile picture addresses", () => {
  it("keeps only https URLs on the provider's own image hosts", () => {
    expect(allowedPictureUrl("kakao", "https://k.kakaocdn.net/dn/abc/img_640x640.jpg")).toBe(
      "https://k.kakaocdn.net/dn/abc/img_640x640.jpg",
    );
    expect(allowedPictureUrl("google", "https://lh3.googleusercontent.com/a/xyz=s96-c")).toBe(
      "https://lh3.googleusercontent.com/a/xyz=s96-c",
    );
    expect(allowedPictureUrl("kakao", "http://k.kakaocdn.net/dn/abc.jpg")).toBeNull();
    expect(allowedPictureUrl("kakao", "https://lh3.googleusercontent.com/a/xyz")).toBeNull();
    expect(allowedPictureUrl("google", "https://evilgoogleusercontent.com/a")).toBeNull();
    expect(allowedPictureUrl("kakao", "https://127.0.0.1/kakaocdn.net")).toBeNull();
    expect(allowedPictureUrl("kakao", "https://user:pw@k.kakaocdn.net/a.jpg")).toBeNull();
    expect(allowedPictureUrl("kakao", "https://k.kakaocdn.net:8443/a.jpg")).toBeNull();
    expect(allowedPictureUrl("naver", 42)).toBeNull();
  });
});
