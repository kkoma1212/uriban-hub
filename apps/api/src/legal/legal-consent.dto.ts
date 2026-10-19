import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDefined, IsObject, IsString, IsUUID, Matches, ValidateNested } from "class-validator";
import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

export class ConsentDocumentReferenceDto {
  @ApiProperty({ format: "uuid", type: String })
  @IsUUID()
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 80, type: String })
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  policy_version!: string;

  @ApiProperty({ pattern: "^[0-9a-f]{64}$", type: String })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/u)
  content_sha256!: string;
}

export class LegalConsentSnapshotDto {
  @ApiProperty({ type: () => ConsentDocumentReferenceDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConsentDocumentReferenceDto)
  terms!: ConsentDocumentReferenceDto;

  @ApiProperty({ type: () => ConsentDocumentReferenceDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConsentDocumentReferenceDto)
  privacy_consent!: ConsentDocumentReferenceDto;

  @ApiProperty({ type: () => ConsentDocumentReferenceDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConsentDocumentReferenceDto)
  privacy_policy!: ConsentDocumentReferenceDto;

  @ApiProperty({ type: () => ConsentDocumentReferenceDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConsentDocumentReferenceDto)
  guardian_consent!: ConsentDocumentReferenceDto;
}

export class LegalConsentBundleDto {
  @ApiProperty({ type: Boolean })
  binding_required!: boolean;

  @ApiProperty({ type: () => LegalConsentSnapshotDto, nullable: true })
  documents!: LegalConsentSnapshotDto | null;
}
