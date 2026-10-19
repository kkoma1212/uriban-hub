import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function PasswordCopyButton({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // 함께 쓰는 학교 기기에서는 클립보드에 비밀번호가 남는다(총검수 B3-11). 요청받은 기능이라 유지하고 알린다.
      setNotice("복사했어요. 함께 쓰는 기기라면 붙여 넣은 뒤 클립보드를 비워 주세요.");
    } catch {
      setCopied(false);
      setNotice("복사 권한을 확인하거나, 비밀번호 보기를 누른 뒤 직접 복사해 주세요.");
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        aria-label={`${label} 복사`}
        className="ui-button ui-button-secondary min-h-11 text-sm"
        disabled={value.length === 0}
        onClick={() => void copy()}
        type="button"
      >
        {copied ? <Check aria-hidden size={16} /> : <Copy aria-hidden size={16} />}
        복사
      </button>
      <span className="text-sm text-app-muted" role="status">
        {notice}
      </span>
    </div>
  );
}
