import { ApiProperty } from "@nestjs/swagger";
import { IsDefined, IsString, MaxLength, MinLength } from "class-validator";

/*
 * 배치 내용(payload)은 모양을 검사하지 않는다 — 마법사 1단계 구성이 화면과 함께 바뀌기
 * 때문이다(임시저장과 같은 판단). 대신 **이름과 크기**는 서비스 층에서 막는다.
 * 이름만 여기서 한 번 더 거르는 이유는, 이름은 목록에 그대로 보이는 사람의 글이라
 * 모양이 바뀔 일이 없기 때문이다.
 *
 * ⚠️ 다만 `additionalProperties` 를 빼면 안 된다 — 그러면 생성되는 API 타입이
 * `Record<string, never>`(속성을 하나도 못 담는 객체)가 되어, 소비자가 정상 payload
 * 조차 표현할 수 없다. "모양을 안 정한다"와 "아무것도 못 담는다"는 다른 말이다.
 */
export class SaveLayoutTemplateDto {
  @ApiProperty({ description: "목록에 보일 배치 이름", maxLength: 40, minLength: 1, type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @ApiProperty({
    additionalProperties: true,
    description: "마법사 1단계가 들고 있던 교실 배치. 서버는 해석하지 않고 그대로 보관한다.",
    type: Object,
  })
  @IsDefined()
  payload!: unknown;
}
