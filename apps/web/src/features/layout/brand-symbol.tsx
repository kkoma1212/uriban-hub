// CI v1 칠판 심볼(흰 분필 '우리반' + 노란 분필 밑줄). 원본: 저장소 밖 디자인 시안 CI_v1/svg/symbol.svg
// 글자가 도형으로 바뀐 SVG라 글꼴 없이도 같은 모양이다. 장식이므로 이름은 옆의 '우리반 허브' 글자가 맡는다.
export function BrandSymbol({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <img alt="" aria-hidden="true" className={`shrink-0 ${className}`} src="/brand/symbol.svg" />
  );
}
