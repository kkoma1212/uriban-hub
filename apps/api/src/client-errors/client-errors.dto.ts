import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString, Matches } from "class-validator";

import {
  CLIENT_ERROR_DEVICES,
  CLIENT_ERROR_ROLES,
  CLIENT_ERROR_SOURCES,
  type ClientErrorReport,
} from "./client-errors.store.js";

/** 오류 종류는 TypeError 같은 이름만 받는다. 오류 문장·코드 위치는 개인 내용이 섞일 수 있어 받지 않는다. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
/** 화면 주소의 모양만(소문자·숫자·-·:·/, 80자). 검색어·해시는 받지 않는다. */
const ROUTE_PATTERN = /^\/[a-z0-9\-/:]{0,79}$/u;

export class ReportClientErrorDto implements ClientErrorReport {
  @ApiProperty({ enum: CLIENT_ERROR_SOURCES })
  @IsIn(CLIENT_ERROR_SOURCES)
  source!: ClientErrorReport["source"];

  @ApiProperty({ pattern: ERROR_NAME_PATTERN.source, type: String })
  @IsString()
  @Matches(ERROR_NAME_PATTERN)
  name!: string;

  @ApiProperty({ pattern: ROUTE_PATTERN.source, type: String })
  @IsString()
  @Matches(ROUTE_PATTERN)
  route!: string;

  @ApiProperty({ enum: CLIENT_ERROR_ROLES })
  @IsIn(CLIENT_ERROR_ROLES)
  role!: ClientErrorReport["role"];

  @ApiProperty({ enum: CLIENT_ERROR_DEVICES })
  @IsIn(CLIENT_ERROR_DEVICES)
  device!: ClientErrorReport["device"];
}
