import { ApiProperty } from "@nestjs/swagger";
import { IsDefined } from "class-validator";

/*
 * 임시저장 본문에는 검사할 모양이 없다 — 마법사가 들고 있던 상태를 그대로 담고,
 * 그 구성은 화면과 함께 바뀐다. 대신 **크기**는 서비스 층에서 막는다. 모양을 여기서
 * 못박으면 화면을 고칠 때마다 서버 DTO가 따라 바뀌어야 하고, 그러면 임시저장이
 * 화면 개선을 붙잡는 족쇄가 된다.
 *
 * ⚠️ 다만 `additionalProperties` 를 빼면 안 된다 — 그러면 생성되는 API 타입이
 * `Record<string, never>`(속성을 하나도 못 담는 객체)가 되어, 소비자가 정상 payload
 * 조차 표현할 수 없다. "모양을 안 정한다"와 "아무것도 못 담는다"는 다른 말이다.
 */
export class SaveLayoutDraftDto {
  @ApiProperty({
    additionalProperties: true,
    description: "마법사가 들고 있던 상태. 서버는 해석하지 않고 그대로 보관한다.",
    type: Object,
  })
  @IsDefined()
  payload!: unknown;
}
