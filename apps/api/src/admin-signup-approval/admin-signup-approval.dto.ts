import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsUUID } from "class-validator";
export class IssueAdminSignupApprovalDto {
  @ApiProperty({ format: "email", type: String })
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.normalize("NFC").trim().toLowerCase() : value,
  )
  email!: string;
  @ApiProperty({ enum: ["teacher", "student"], type: String })
  @IsIn(["teacher", "student"])
  role!: "teacher" | "student";
}
export class FindAdminSignupAccountDto extends IssueAdminSignupApprovalDto {}
export class RevokeAdminSignupApprovalDto {
  @ApiProperty({ format: "uuid", type: String })
  @IsUUID()
  id!: string;
}
