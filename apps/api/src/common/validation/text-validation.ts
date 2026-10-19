import { parseFragment } from "parse5";
import { buildMessage, ValidateBy, type ValidationOptions } from "class-validator";

const CODE_POINT_LENGTH = "codePointLength";
const NEW_PASSWORD_TEXT = "newPasswordText";
const PLAIN_TEXT = "plainText";
const FORBIDDEN_PASSWORD_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

interface HtmlNode {
  childNodes?: HtmlNode[];
  tagName?: string;
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function hasHtmlElement(value: string): boolean {
  const root = parseFragment(value) as unknown as HtmlNode;
  const pending: HtmlNode[] = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.tagName !== undefined) return true;
    if (node?.childNodes !== undefined) pending.push(...node.childNodes);
  }

  return false;
}

export function isAllowedPlainText(value: string, allowLineFeed = false): boolean {
  const forbiddenControl = allowLineFeed
    ? /[\u0000-\u0009\u000B-\u001F\u007F\u0085\u2028\u2029]/u
    : /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u;

  return !forbiddenControl.test(value) && !hasHtmlElement(value);
}

export function isAllowedNewPasswordText(value: string): boolean {
  return !FORBIDDEN_PASSWORD_CHARACTER.test(value) && /\p{L}/u.test(value) && /\p{N}/u.test(value);
}

export function CodePointLength(
  minimum: number,
  maximum?: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      constraints: [minimum, maximum],
      name: CODE_POINT_LENGTH,
      validator: {
        defaultMessage: buildMessage(
          (eachPrefix) =>
            maximum === undefined
              ? `${eachPrefix}$property must contain at least $constraint1 Unicode code points`
              : `${eachPrefix}$property must be between $constraint1 and $constraint2 Unicode code points`,
          validationOptions,
        ),
        validate: (value: unknown) =>
          typeof value === "string" &&
          countCodePoints(value) >= minimum &&
          (maximum === undefined || countCodePoints(value) <= maximum),
      },
    },
    validationOptions,
  );
}

export function IsPlainText(
  options: { allowLineFeed?: boolean } = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: PLAIN_TEXT,
      validator: {
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property must be plain text without control characters`,
          validationOptions,
        ),
        validate: (value: unknown) =>
          typeof value === "string" && isAllowedPlainText(value, options.allowLineFeed ?? false),
      },
    },
    validationOptions,
  );
}

export function IsNewPasswordText(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: NEW_PASSWORD_TEXT,
      validator: {
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must contain letters and numbers without invisible or control characters`,
          validationOptions,
        ),
        validate: (value: unknown) => typeof value === "string" && isAllowedNewPasswordText(value),
      },
    },
    validationOptions,
  );
}
